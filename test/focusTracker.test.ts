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
  });

  it('prioritizes terminal when terminal is explicitly marked as focused', () => {
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

  it('prioritizes terminal when targetHint "terminal" is passed to snapshot', () => {
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

    tracker = new FocusTracker();

    const snapshot = tracker.snapshot('terminal');
    assert.equal(snapshot.kind, 'terminal');
    if (snapshot.kind === 'terminal') {
      assert.equal(snapshot.terminal.name, 'Integrated Terminal');
    }

    tracker.dispose();
  });

  it('captures editor snapshot with multi-cursor selections when editor is focused', () => {
    const mockDoc: any = {
      uri: vscode.Uri.file('/src/app.ts'),
      fileName: '/src/app.ts',
      languageId: 'typescript',
    };
    const sel1 = new vscode.Selection(1, 2, 1, 2);
    const sel2 = new vscode.Selection(3, 4, 3, 4);
    const mockEditor: any = {
      document: mockDoc,
      selection: sel1,
      selections: [sel1, sel2],
    };

    mockVscodeWindow.activeTextEditor = mockEditor;
    mockVscodeWindow.visibleTextEditors = [mockEditor];

    tracker = new FocusTracker();
    tracker.markEditorFocused();

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.kind, 'editor');
    if (snapshot.kind === 'editor') {
      assert.equal(snapshot.selections.length, 2);
      assert.equal(snapshot.languageId, 'typescript');
    }

    tracker.dispose();
  });

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

  it('does not route to background terminal when editor is blurred', () => {
    const mockTerminal: any = { name: 'Background Terminal' };
    mockVscodeWindow.activeTerminal = mockTerminal;
    mockVscodeWindow.activeTextEditor = null;
    mockVscodeWindow.visibleTextEditors = [];

    tracker = new FocusTracker();
    // Simulate editor blur / settings opened without explicit terminal focus
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.kind, 'none');

    tracker.dispose();
  });
});

