import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { FocusTracker } from '../src/focus/focusTracker';

describe('FocusTracker - Terminal Priority & Focus Tracking', () => {
  let tracker: FocusTracker;
  const mockVscodeWindow = vscode.window as any;

  beforeEach(() => {
    // Reset mock window state
    mockVscodeWindow.activeTextEditor = null;
    mockVscodeWindow.visibleTextEditors = [];
    mockVscodeWindow.activeTerminal = null;
    mockVscodeWindow.terminals = [];
    if (mockVscodeWindow._activeTextEditorListeners) {
      mockVscodeWindow._activeTextEditorListeners = [];
    }
    if (mockVscodeWindow._activeTerminalListeners) {
      mockVscodeWindow._activeTerminalListeners = [];
    }
  });

  // Scenario 1: Argument-less Snapshot with Active Terminal
  it('resolves active terminal on argument-less snapshot when terminal is active', () => {
    const mockTerminal: any = { name: 'bash' };
    mockVscodeWindow.activeTerminal = mockTerminal;
    mockVscodeWindow.activeTextEditor = null;
    mockVscodeWindow.visibleTextEditors = [];

    tracker = new FocusTracker();

    // Calling snapshot() without arguments must return kind: 'terminal'
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.kind, 'terminal');
    if (snapshot.kind === 'terminal') {
      assert.equal(snapshot.terminal.name, 'bash');
    }

    assert.equal(tracker.getActiveTargetKind(), 'terminal');
    tracker.dispose();
  });

  // Scenario 2: Argument-less Snapshot with Active Editor
  it('resolves active editor on argument-less snapshot with multi-cursor selections', () => {
    const mockDoc: any = {
      uri: vscode.Uri.file('/src/main.ts'),
      fileName: '/src/main.ts',
      languageId: 'typescript',
    };
    const sel1 = new vscode.Selection(1, 0, 1, 5);
    const sel2 = new vscode.Selection(2, 0, 2, 8);
    const mockEditor: any = {
      document: mockDoc,
      selection: sel1,
      selections: [sel1, sel2],
    };

    mockVscodeWindow.activeTextEditor = mockEditor;
    mockVscodeWindow.visibleTextEditors = [mockEditor];
    mockVscodeWindow.activeTerminal = null;

    tracker = new FocusTracker();

    // Calling snapshot() without arguments must return kind: 'editor'
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.kind, 'editor');
    if (snapshot.kind === 'editor') {
      assert.equal(snapshot.documentUri.fsPath, mockDoc.uri.fsPath);
      assert.equal(snapshot.selections.length, 2);
      assert.equal(snapshot.languageId, 'typescript');
    }

    assert.equal(tracker.getActiveTargetKind(), 'editor');
    tracker.dispose();
  });

  // Scenario 3: Editor Blurred, Terminal Present
  it('resolves to active terminal when editor becomes null and terminal exists', () => {
    const mockTerminal: any = { name: 'zsh' };
    const mockDoc: any = {
      uri: vscode.Uri.file('/src/test.ts'),
      fileName: '/src/test.ts',
      languageId: 'typescript',
    };
    const mockEditor: any = {
      document: mockDoc,
      selection: new vscode.Selection(0, 0, 0, 0),
      selections: [new vscode.Selection(0, 0, 0, 0)],
    };

    // Initially editor is active
    mockVscodeWindow.activeTextEditor = mockEditor;
    mockVscodeWindow.visibleTextEditors = [mockEditor];
    mockVscodeWindow.activeTerminal = mockTerminal;

    tracker = new FocusTracker();
    const snap1 = tracker.snapshot();
    assert.equal(snap1.kind, 'editor');

    // Editor is blurred/closed (becomes null) while terminal remains active
    mockVscodeWindow._fireDidChangeActiveTextEditor(null);
    mockVscodeWindow.visibleTextEditors = [];

    // Snapshot must resolve to active terminal without requiring args
    const snap2 = tracker.snapshot();
    assert.equal(snap2.kind, 'terminal');
    if (snap2.kind === 'terminal') {
      assert.equal(snap2.terminal.name, 'zsh');
    }

    tracker.dispose();
  });

  // Scenario 4: Both Present, Terminal Explicitly Focused
  it('prioritizes terminal when both editor and terminal exist and terminal is marked focused', () => {
    const mockTerminal: any = { name: 'Terminal 1' };
    const mockDoc: any = {
      uri: vscode.Uri.file('/path/file.ts'),
      fileName: '/path/file.ts',
      languageId: 'typescript',
    };
    const mockEditor: any = {
      document: mockDoc,
      selection: new vscode.Selection(0, 0, 0, 0),
      selections: [new vscode.Selection(0, 0, 0, 0)],
    };

    mockVscodeWindow.activeTerminal = mockTerminal;
    mockVscodeWindow.activeTextEditor = mockEditor;
    mockVscodeWindow.visibleTextEditors = [mockEditor];

    tracker = new FocusTracker();
    tracker.markTerminalFocused();

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.kind, 'terminal');
    if (snapshot.kind === 'terminal') {
      assert.equal(snapshot.terminal.name, 'Terminal 1');
    }

    tracker.dispose();
  });

  // Scenario 4b: Both Present, Editor Explicitly Focused
  it('prioritizes editor when both editor and terminal exist and editor is marked focused', () => {
    const mockTerminal: any = { name: 'Terminal 1' };
    const mockDoc: any = {
      uri: vscode.Uri.file('/path/file.ts'),
      fileName: '/path/file.ts',
      languageId: 'typescript',
    };
    const mockEditor: any = {
      document: mockDoc,
      selection: new vscode.Selection(0, 0, 0, 0),
      selections: [new vscode.Selection(0, 0, 0, 0)],
    };

    mockVscodeWindow.activeTerminal = mockTerminal;
    mockVscodeWindow.activeTextEditor = mockEditor;
    mockVscodeWindow.visibleTextEditors = [mockEditor];

    tracker = new FocusTracker();
    tracker.markEditorFocused();

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.kind, 'editor');

    tracker.dispose();
  });

  // Scenario 5: Backward Compatibility with Explicit Hint
  it('respects explicit targetHint "terminal" and "editor" for backward compatibility', () => {
    const mockTerminal: any = { name: 'Integrated Terminal' };
    const mockDoc: any = {
      uri: vscode.Uri.file('/path/file.ts'),
      fileName: '/path/file.ts',
      languageId: 'typescript',
    };
    const mockEditor: any = {
      document: mockDoc,
      selection: new vscode.Selection(0, 0, 0, 0),
      selections: [new vscode.Selection(0, 0, 0, 0)],
    };

    mockVscodeWindow.activeTerminal = mockTerminal;
    mockVscodeWindow.activeTextEditor = mockEditor;
    mockVscodeWindow.visibleTextEditors = [mockEditor];

    tracker = new FocusTracker();

    const snapTerminal = tracker.snapshot('terminal');
    assert.equal(snapTerminal.kind, 'terminal');
    if (snapTerminal.kind === 'terminal') {
      assert.equal(snapTerminal.terminal.name, 'Integrated Terminal');
    }

    const snapEditor = tracker.snapshot('editor');
    assert.equal(snapEditor.kind, 'editor');

    tracker.dispose();
  });

  // Scenario 6: Argument-less Snapshot with Neither Present
  it('returns kind: "none" when neither editor nor terminal is present', () => {
    mockVscodeWindow.activeTerminal = null;
    mockVscodeWindow.activeTextEditor = null;
    mockVscodeWindow.visibleTextEditors = [];

    tracker = new FocusTracker();
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.kind, 'none');
    assert.equal(tracker.getActiveTargetKind(), 'none');

    tracker.dispose();
  });

  // Scenario 7: Fallback to Visible Text Editor when activeTextEditor is null
  it('resolves visible editor when active editor is null and lastFocusedKind was editor', () => {
    const mockDoc: any = {
      uri: vscode.Uri.file('/src/secondary.ts'),
      fileName: '/src/secondary.ts',
      languageId: 'typescript',
    };
    const mockEditor: any = {
      document: mockDoc,
      selection: new vscode.Selection(5, 0, 5, 0),
      selections: [new vscode.Selection(5, 0, 5, 0)],
    };

    mockVscodeWindow.activeTerminal = null;
    mockVscodeWindow.activeTextEditor = null;
    mockVscodeWindow.visibleTextEditors = [mockEditor];

    tracker = new FocusTracker();
    tracker.markEditorFocused();

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.kind, 'editor');
    if (snapshot.kind === 'editor') {
      assert.equal(snapshot.documentUri.fsPath, mockDoc.uri.fsPath);
    }

    tracker.dispose();
  });

  // Scenario 8: Snapshot Clearing and Caching Lifecycle
  it('clears active snapshot via clearSnapshot()', () => {
    const mockTerminal: any = { name: 'Terminal' };
    mockVscodeWindow.activeTerminal = mockTerminal;

    tracker = new FocusTracker();
    tracker.markTerminalFocused();

    const snap1 = tracker.getOrSnapshot();
    assert.equal(snap1.kind, 'terminal');

    tracker.clearSnapshot();
    mockVscodeWindow.activeTerminal = null;

    const snap2 = tracker.getOrSnapshot();
    assert.equal(snap2.kind, 'none');

    tracker.dispose();
  });
});

describe('Custom Keybindings without args - Real World Scenarios', () => {
  let tracker: FocusTracker;
  const mockVscodeWindow = vscode.window as any;

  beforeEach(() => {
    mockVscodeWindow.activeTextEditor = null;
    mockVscodeWindow.visibleTextEditors = [];
    mockVscodeWindow.activeTerminal = null;
    mockVscodeWindow.terminals = [];
    if (mockVscodeWindow._activeTextEditorListeners) {
      mockVscodeWindow._activeTextEditorListeners = [];
    }
    if (mockVscodeWindow._activeTerminalListeners) {
      mockVscodeWindow._activeTerminalListeners = [];
    }
  });

  it('handles custom keybinding in terminal where args are stripped (args === undefined)', () => {
    const mockTerminal: any = { name: 'PowerShell 7' };
    mockVscodeWindow.activeTerminal = mockTerminal;
    mockVscodeWindow.activeTextEditor = null;

    tracker = new FocusTracker();

    // In VS Code GUI keybinding customization, args is stripped, passing undefined
    const simulatedArgs: any = undefined;
    const snapshot = tracker.snapshot(simulatedArgs?.target);

    assert.equal(snapshot.kind, 'terminal');
    if (snapshot.kind === 'terminal') {
      assert.equal(snapshot.terminal.name, 'PowerShell 7');
    }
    tracker.dispose();
  });

  it('handles custom keybinding in editor where args are stripped (args === undefined)', () => {
    const mockDoc: any = {
      uri: vscode.Uri.file('/path/to/script.py'),
      fileName: '/path/to/script.py',
      languageId: 'python',
    };
    const mockEditor: any = {
      document: mockDoc,
      selection: new vscode.Selection(10, 4, 10, 4),
      selections: [new vscode.Selection(10, 4, 10, 4)],
    };

    mockVscodeWindow.activeTextEditor = mockEditor;
    mockVscodeWindow.visibleTextEditors = [mockEditor];
    mockVscodeWindow.activeTerminal = { name: 'Background terminal' };

    tracker = new FocusTracker();
    // User was working in editor, editor has focus
    const simulatedArgs: any = undefined;
    const snapshot = tracker.snapshot(simulatedArgs?.target);

    assert.equal(snapshot.kind, 'editor');
    if (snapshot.kind === 'editor') {
      assert.equal(snapshot.documentUri.fsPath, mockDoc.uri.fsPath);
    }
    tracker.dispose();
  });

  it('handles switching between editor and terminal when triggering custom shortcuts', () => {
    const mockTerminal: any = { name: 'Terminal Aider' };
    const mockDoc: any = {
      uri: vscode.Uri.file('/app.ts'),
      fileName: '/app.ts',
      languageId: 'typescript',
    };
    const mockEditor: any = {
      document: mockDoc,
      selection: new vscode.Selection(0, 0, 0, 0),
      selections: [new vscode.Selection(0, 0, 0, 0)],
    };

    mockVscodeWindow.activeTextEditor = mockEditor;
    mockVscodeWindow.visibleTextEditors = [mockEditor];
    mockVscodeWindow.activeTerminal = mockTerminal;

    tracker = new FocusTracker();

    // 1. User presses keybinding in editor
    let snap = tracker.snapshot(undefined);
    assert.equal(snap.kind, 'editor');
    tracker.clearSnapshot();

    // 2. User clicks into terminal (terminal active event fires)
    mockVscodeWindow._fireDidChangeActiveTerminal(mockTerminal);
    mockVscodeWindow.activeTextEditor = null;

    // 3. User presses custom keybinding (no args) in terminal
    snap = tracker.snapshot(undefined);
    assert.equal(snap.kind, 'terminal');
    if (snap.kind === 'terminal') {
      assert.equal(snap.terminal.name, 'Terminal Aider');
    }
    tracker.dispose();
  });
});
