import * as vscode from 'vscode';
import { FocusSnapshot, EditorSnapshot } from '../focus/focusTracker';
import { AutoSpacer } from './autoSpacer';
import { extLog } from '../logger';

export class TextDispatcher {
  /**
   * Calculates the end position after inserting text starting at startPos.
   * Accurately calculates line and character coordinates across multiple lines.
   */
  public static calculateEndPosition(
    startPos: vscode.Position,
    text: string
  ): vscode.Position {
    const lines = text.split(/\r?\n/);
    const endLine = startPos.line + lines.length - 1;
    const endChar =
      lines.length === 1
        ? startPos.character + lines[0].length
        : lines[lines.length - 1].length;
    return new vscode.Position(endLine, endChar);
  }

  /**
   * Computes updated cursor selections for single or multiple cursors after text insertion.
   * Tracks line and character deltas for subsequent selections in the document.
   */
  public static computeNewSelections(
    selections: readonly vscode.Selection[],
    document: { lineAt: (line: number) => { text: string } },
    text: string,
    isCode: boolean
  ): vscode.Selection[] {
    if (!selections || selections.length === 0) {
      return [new vscode.Selection(0, 0, 0, 0)];
    }

    if (selections.length === 1) {
      const sel = selections[0];
      const insertPos = sel.isEmpty ? sel.active : sel.start;
      const formattedText = AutoSpacer.format(document, insertPos, text, isCode);
      const lines = formattedText.split(/\r?\n/);
      const baseLine = sel.isEmpty ? insertPos.line : sel.start.line;
      const baseChar = sel.isEmpty ? insertPos.character : sel.start.character;
      const endLine = baseLine + lines.length - 1;
      const endChar =
        lines.length === 1
          ? baseChar + lines[0].length
          : lines[lines.length - 1].length;
      const endPos = new vscode.Position(endLine, endChar);
      return [new vscode.Selection(endPos, endPos)];
    }

    // Sort selections in document order to track cumulative deltas
    const indexed = selections.map((sel, idx) => ({ sel, idx }));
    indexed.sort((a, b) => a.sel.start.compareTo(b.sel.start));

    const newSelectionsByIndex: vscode.Selection[] = [];
    let lineDelta = 0;
    let lastOrigLine = -1;
    let charDeltaOnLine = 0;

    for (const { sel, idx } of indexed) {
      const origStart = sel.isEmpty ? sel.active : sel.start;
      const origEnd = sel.isEmpty ? sel.active : sel.end;

      if (origStart.line !== lastOrigLine) {
        lastOrigLine = origStart.line;
        charDeltaOnLine = 0;
      }

      const currentStartLine = origStart.line + lineDelta;
      const currentStartChar = origStart.character + charDeltaOnLine;

      const formattedText = AutoSpacer.format(document, origStart, text, isCode);
      const lines = formattedText.split(/\r?\n/);

      const endLine = currentStartLine + lines.length - 1;
      const endChar =
        lines.length === 1
          ? currentStartChar + lines[0].length
          : lines[lines.length - 1].length;

      const endPos = new vscode.Position(endLine, endChar);
      newSelectionsByIndex[idx] = new vscode.Selection(endPos, endPos);

      // Update deltas for subsequent cursors
      const linesRemoved = origEnd.line - origStart.line;
      const linesAdded = lines.length - 1;

      if (linesAdded === 0 && linesRemoved === 0) {
        const replacedLen = origEnd.character - origStart.character;
        charDeltaOnLine += formattedText.length - replacedLen;
        lastOrigLine = origStart.line;
      } else {
        lineDelta += linesAdded - linesRemoved;
        charDeltaOnLine = endChar - origEnd.character;
        lastOrigLine = origEnd.line;
      }
    }

    return selections.map((_, idx) => newSelectionsByIndex[idx]);
  }

  /**
   * Dispatches transcribed text to the targeted editor or terminal.
   */
  public static async dispatch(
    text: string,
    snapshot: FocusSnapshot
  ): Promise<boolean> {
    if (!text || text.trim().length === 0) {
      extLog('WARN', 'Dispatch called with empty text');
      return false;
    }

    const voxConfig = vscode.workspace.getConfiguration('voxcode');
    const codeModeEnabled = voxConfig.get<boolean>('codeMode', true);
    const terminalAutoSubmit = voxConfig.get<boolean>('terminalAutoSubmit', false);

    extLog('INFO', 'Dispatching transcribed text', {
      textLength: text.length,
      snapshotKind: snapshot.kind,
      codeModeEnabled,
    });
    extLog('DEBUG', 'Dispatch text content', { text });

    // 1. Dispatch based on snapshot target
    if (snapshot.kind === 'editor') {
      return this.dispatchToEditor(text, snapshot, codeModeEnabled);
    } else if (snapshot.kind === 'terminal') {
      return this.dispatchToTerminal(text, snapshot.terminal, terminalAutoSubmit);
    }

    // 2. Fallback: Check activeTextEditor or visibleTextEditors
    const fallbackEditor =
      vscode.window.activeTextEditor ||
      (vscode.window.visibleTextEditors.length > 0
        ? vscode.window.visibleTextEditors[0]
        : null);

    if (fallbackEditor) {
      extLog('INFO', 'Using fallback editor for dispatch', {
        file: fallbackEditor.document.fileName,
      });
      const selections =
        fallbackEditor.selections.length > 0
          ? fallbackEditor.selections
          : [fallbackEditor.selection];
      const fallbackSnapshot: EditorSnapshot = {
        kind: 'editor',
        editor: fallbackEditor,
        documentUri: fallbackEditor.document.uri,
        selection: fallbackEditor.selection,
        selections: selections.map((s) => new vscode.Selection(s.anchor, s.active)),
        languageId: fallbackEditor.document.languageId,
      };
      return this.dispatchToEditor(text, fallbackSnapshot, codeModeEnabled);
    } else if (vscode.window.activeTerminal) {
      extLog('INFO', 'Using fallback terminal for dispatch', {
        terminal: vscode.window.activeTerminal.name,
      });
      return this.dispatchToTerminal(
        text,
        vscode.window.activeTerminal,
        terminalAutoSubmit
      );
    }

    extLog('WARN', 'No editor or terminal found to receive text');
    return false;
  }

  /**
   * Executes multi-cursor text injection into the targeted editor.
   * Respects split editor panes and advances all cursors cleanly to the end of inserted text.
   */
  private static async dispatchToEditor(
    text: string,
    snapshot: EditorSnapshot,
    codeModeEnabled: boolean
  ): Promise<boolean> {
    const documentUri = snapshot.documentUri;

    // Resolve active/visible editor for this document
    const editor =
      vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === documentUri.toString()
      ) ||
      snapshot.editor ||
      vscode.window.activeTextEditor;

    const selections =
      snapshot.selections && snapshot.selections.length > 0
        ? snapshot.selections
        : snapshot.selection
        ? [snapshot.selection]
        : editor?.selections || [new vscode.Selection(0, 0, 0, 0)];

    const document = editor?.document;
    const isCode = document
      ? AutoSpacer.isCodeDocument(document, codeModeEnabled)
      : codeModeEnabled;

    if (!editor || !document || document.isClosed) {
      extLog(
        'WARN',
        'Target editor/document is closed or unavailable, attempting workspace.applyEdit',
        {
          uri: documentUri.toString(),
        }
      );
      return this.applyWorkspaceEditDirectly(documentUri, text, selections, isCode);
    }

    extLog(
      'INFO',
      `Injecting into "${document.fileName}" across ${selections.length} cursor(s)`,
      {
        cursorCount: selections.length,
        isCode,
      }
    );

    // Primary path: editor.edit (atomic 1-step undo)
    try {
      const editSuccess = await editor.edit(
        (editBuilder) => {
          for (const sel of selections) {
            const insertPos = sel.isEmpty ? sel.active : sel.start;
            const formattedText = AutoSpacer.format(document, insertPos, text, isCode);
            if (sel.isEmpty) {
              editBuilder.insert(insertPos, formattedText);
            } else {
              editBuilder.replace(sel, formattedText);
            }
          }
        },
        {
          undoStopBefore: true,
          undoStopAfter: true,
        }
      );

      extLog('INFO', 'editor.edit execution completed', { editSuccess });

      if (editSuccess) {
        // Advance all cursor positions to the end of inserted text
        const newSelections = this.computeNewSelections(
          selections,
          document,
          text,
          isCode
        );
        editor.selections = newSelections;
        return true;
      }
      extLog('WARN', 'editor.edit returned false; falling back to workspace.applyEdit');
    } catch (err: any) {
      extLog('WARN', 'editor.edit threw exception; falling back to workspace.applyEdit', {
        error: err?.message || String(err),
      });
    }

    // Fallback path: workspace.applyEdit (direct buffer edit, immune to focus issues)
    return this.applyWorkspaceEditDirectly(documentUri, text, selections, isCode);
  }

  /**
   * Applies edits directly to the text document via workspace.applyEdit.
   */
  private static async applyWorkspaceEditDirectly(
    documentUri: vscode.Uri,
    text: string,
    selections: readonly vscode.Selection[],
    isCode: boolean
  ): Promise<boolean> {
    try {
      const doc = await vscode.workspace.openTextDocument(documentUri);
      // Pre-compute new selections BEFORE applying the workspace edit so it reads the unmutated document
      const newSelections = this.computeNewSelections(selections, doc, text, isCode);
      const wsEdit = new vscode.WorkspaceEdit();

      for (const sel of selections) {
        const insertPos = sel.isEmpty ? sel.active : sel.start;
        const formattedText = AutoSpacer.format(doc, insertPos, text, isCode);

        if (sel.isEmpty) {
          wsEdit.insert(documentUri, insertPos, formattedText);
        } else {
          wsEdit.replace(documentUri, sel, formattedText);
        }
      }

      const applied = await vscode.workspace.applyEdit(wsEdit);
      extLog('INFO', 'workspace.applyEdit executed', { applied });

      if (applied) {
        const visibleEditor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === documentUri.toString()
        );
        if (visibleEditor) {
          visibleEditor.selections = newSelections;
        }
      }

      return applied;
    } catch (err: any) {
      extLog('ERROR', 'workspace.applyEdit failed with error', {
        error: err?.message || String(err),
      });
      return false;
    }
  }

  /**
   * Dispatches text to the active terminal.
   */
  private static dispatchToTerminal(
    text: string,
    terminal: vscode.Terminal,
    autoSubmit: boolean
  ): boolean {
    try {
      terminal.sendText(text, autoSubmit);
      extLog('INFO', `Sent text to terminal "${terminal.name}"`, {
        textLength: text.length,
        autoSubmit,
      });
      extLog('DEBUG', 'Terminal text content', { text });
      return true;
    } catch (err: any) {
      extLog('ERROR', 'Failed to send text to terminal', {
        error: err?.message || String(err),
      });
      return false;
    }
  }
}
