import * as vscode from 'vscode';
import { AutoSpacer } from '../injector/autoSpacer';

export class GhostTextManager implements vscode.Disposable {
  private decorationType: vscode.TextEditorDecorationType;
  private currentEditor: vscode.TextEditor | null = null;

  constructor() {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorGhostText.foreground'),
        fontStyle: 'italic',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  /**
   * Renders faint italic ghost text after each active cursor.
   * Anchors to snapshot selections if provided to prevent ghost text jumping.
   */
  public update(
    text: string,
    editor?: vscode.TextEditor,
    snapshotSelections?: readonly vscode.Selection[]
  ): void {
    const targetEditor = editor || vscode.window.activeTextEditor;
    if (!targetEditor) {
      return;
    }

    this.currentEditor = targetEditor;

    if (!text || text.trim().length === 0) {
      this.clear(targetEditor);
      return;
    }

    const trimmedText = text.trim();
    const targetSelections =
      snapshotSelections && snapshotSelections.length > 0
        ? snapshotSelections
        : targetEditor.selections;

    const decorationOptions: vscode.DecorationOptions[] = targetSelections.map(
      (selection) => {
        const insertPos = selection.active;
        const spacedText = AutoSpacer.computeSpacing(
          targetEditor.document,
          insertPos,
          trimmedText
        );
        return {
          range: new vscode.Range(insertPos, insertPos),
          renderOptions: {
            after: {
              contentText: spacedText,
            },
          },
        };
      }
    );

    targetEditor.setDecorations(this.decorationType, decorationOptions);
  }

  /**
   * Clears ghost text decorations from the given editor or all visible editors.
   */
  public clear(editor?: vscode.TextEditor): void {
    if (editor) {
      editor.setDecorations(this.decorationType, []);
    } else if (this.currentEditor) {
      this.currentEditor.setDecorations(this.decorationType, []);
      this.currentEditor = null;
    }

    // Safety clear on all visible editors to avoid orphaned decorations
    vscode.window.visibleTextEditors.forEach((ed) => {
      ed.setDecorations(this.decorationType, []);
    });
  }

  public dispose(): void {
    this.clear();
    this.decorationType.dispose();
  }
}
