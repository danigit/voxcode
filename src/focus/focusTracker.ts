import * as vscode from 'vscode';
import { extLog } from '../logger';

export type FocusTargetKind = 'editor' | 'terminal' | 'none';

export interface EditorSnapshot {
  kind: 'editor';
  editor: vscode.TextEditor;
  documentUri: vscode.Uri;
  selection: vscode.Selection;
  selections: readonly vscode.Selection[];
  languageId: string;
}

export interface TerminalSnapshot {
  kind: 'terminal';
  terminal: vscode.Terminal;
}

export interface NoneSnapshot {
  kind: 'none';
}

export type FocusSnapshot = EditorSnapshot | TerminalSnapshot | NoneSnapshot;

export class FocusTracker implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private lastFocusedKind: FocusTargetKind = 'none';
  private currentSnapshot: FocusSnapshot | null = null;

  constructor() {
    // Listen to active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.lastFocusedKind = 'editor';
          extLog('DEBUG', 'Active text editor changed', { file: editor.document.fileName });
        } else {
          // If editor is null, do NOT immediately set lastFocusedKind to 'none'
          // if an active terminal is present.
          if (vscode.window.activeTerminal) {
            this.lastFocusedKind = 'terminal';
            extLog('DEBUG', 'Active text editor cleared, active terminal present -> set lastFocusedKind to terminal');
          } else {
            this.lastFocusedKind = 'none';
            extLog('DEBUG', 'Active text editor cleared, set lastFocusedKind to none');
          }
        }
      })
    );

    // Listen to editor selection/cursor changes (fires on EVERY click and typing)
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor) {
          this.lastFocusedKind = 'editor';
        }
      })
    );

    // Listen to visible editor changes
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        if (editors.length > 0 && this.lastFocusedKind === 'editor') {
          this.lastFocusedKind = 'editor';
        }
      })
    );

    // Listen to active terminal changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (terminal) {
          this.lastFocusedKind = 'terminal';
          extLog('DEBUG', 'Active terminal changed', { name: terminal.name });
        }
      })
    );

    // Listen to terminal open events
    if (vscode.window.onDidOpenTerminal) {
      this.disposables.push(
        vscode.window.onDidOpenTerminal((terminal) => {
          if (terminal) {
            this.lastFocusedKind = 'terminal';
            extLog('DEBUG', 'Terminal opened', { name: terminal.name });
          }
        })
      );
    }

    // Listen to terminal state changes if available
    if (vscode.window.onDidChangeTerminalState) {
      this.disposables.push(
        vscode.window.onDidChangeTerminalState((terminal) => {
          if (terminal) {
            this.lastFocusedKind = 'terminal';
            extLog('DEBUG', 'Terminal state changed', { name: terminal.name });
          }
        })
      );
    }

    // Initialize initial state
    if (vscode.window.activeTextEditor) {
      this.lastFocusedKind = 'editor';
    } else if (vscode.window.activeTerminal) {
      this.lastFocusedKind = 'terminal';
    }
  }

  /**
   * Notifies tracker that terminal was focused (e.g. from keybinding/command).
   */
  public markTerminalFocused(): void {
    this.lastFocusedKind = 'terminal';
  }

  /**
   * Notifies tracker that editor was focused.
   */
  public markEditorFocused(): void {
    this.lastFocusedKind = 'editor';
  }

  /**
   * Public diagnostic helper to inspect current focus target without modifying state.
   */
  public getActiveTargetKind(): FocusTargetKind {
    const activeTerminal = vscode.window.activeTerminal;
    const activeEditor = vscode.window.activeTextEditor;

    if (this.lastFocusedKind === 'terminal' && activeTerminal) {
      return 'terminal';
    }
    if (this.lastFocusedKind === 'editor') {
      if (activeEditor || (vscode.window.visibleTextEditors && vscode.window.visibleTextEditors.length > 0)) {
        return 'editor';
      }
    }
    if (!activeEditor && activeTerminal) {
      return 'terminal';
    }
    if (activeEditor || (vscode.window.visibleTextEditors && vscode.window.visibleTextEditors.length > 0)) {
      return 'editor';
    }
    if (activeTerminal) {
      return 'terminal';
    }
    return 'none';
  }

  /**
   * Captures a snapshot of the current focus target and selections.
   */
  public snapshot(targetHint?: 'editor' | 'terminal'): FocusSnapshot {
    if (targetHint) {
      this.lastFocusedKind = targetHint;
    }

    const activeTerminal = vscode.window.activeTerminal;
    const activeEditor = vscode.window.activeTextEditor;

    // 1. Dynamic terminal resolution:
    // If targetHint is explicitly 'terminal', OR if targetHint is undefined and:
    // - lastFocusedKind === 'terminal' and activeTerminal is present, OR
    // - activeTextEditor is null/undefined and activeTerminal is present.
    const shouldTargetTerminal =
      targetHint === 'terminal' ||
      (!targetHint && Boolean(activeTerminal) && (this.lastFocusedKind === 'terminal' || !activeEditor));

    if (shouldTargetTerminal && activeTerminal) {
      this.currentSnapshot = {
        kind: 'terminal',
        terminal: activeTerminal,
      };
      extLog('INFO', 'Captured terminal snapshot', {
        terminal: activeTerminal.name,
      });
      return this.currentSnapshot;
    }

    // 2. Dynamic editor resolution:
    // If targetHint is explicitly 'editor' OR targetHint is undefined:
    // Resolve active editor, or the first visible text editor if an editor was focused or visible.
    const targetEditor =
      activeEditor ||
      (this.lastFocusedKind === 'editor' && vscode.window.visibleTextEditors && vscode.window.visibleTextEditors.length > 0
        ? vscode.window.visibleTextEditors[0]
        : null) ||
      (vscode.window.visibleTextEditors && vscode.window.visibleTextEditors.length > 0
        ? vscode.window.visibleTextEditors[0]
        : null);

    if ((targetHint === 'editor' || !targetHint) && targetEditor) {
      const selections =
        targetEditor.selections && targetEditor.selections.length > 0
          ? targetEditor.selections
          : [targetEditor.selection];

      this.currentSnapshot = {
        kind: 'editor',
        editor: targetEditor,
        documentUri: targetEditor.document.uri,
        selection: new vscode.Selection(targetEditor.selection.anchor, targetEditor.selection.active),
        selections: selections.map((s) => new vscode.Selection(s.anchor, s.active)),
        languageId: targetEditor.document.languageId,
      };
      extLog('INFO', 'Captured multi-cursor editor snapshot', {
        file: targetEditor.document.fileName,
        cursorCount: selections.length,
      });
      return this.currentSnapshot;
    }

    // Fallback if targetHint was undefined and activeTerminal exists
    if (!targetHint && activeTerminal) {
      this.currentSnapshot = {
        kind: 'terminal',
        terminal: activeTerminal,
      };
      extLog('INFO', 'Captured terminal snapshot (fallback)', {
        terminal: activeTerminal.name,
      });
      return this.currentSnapshot;
    }

    // 3. Fallback: Neither editor nor terminal can be resolved.
    this.currentSnapshot = { kind: 'none' };
    extLog('WARN', 'Captured empty snapshot (no editor or terminal focused)');
    return this.currentSnapshot;
  }

  /**
   * Returns the current active snapshot, or creates a new one if none exists.
   */
  public getOrSnapshot(targetHint?: 'editor' | 'terminal'): FocusSnapshot {
    if (this.currentSnapshot && this.currentSnapshot.kind !== 'none') {
      return this.currentSnapshot;
    }
    return this.snapshot(targetHint);
  }

  /**
   * Clears the active snapshot upon transaction completion.
   */
  public clearSnapshot(): void {
    this.currentSnapshot = null;
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.currentSnapshot = null;
  }
}
