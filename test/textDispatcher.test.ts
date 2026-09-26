import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { TextDispatcher } from '../src/injector/textDispatcher';
import { FocusSnapshot, EditorSnapshot, TerminalSnapshot } from '../src/focus/focusTracker';

describe('TextDispatcher - Cursor Advancement Math', () => {
  it('calculates end position for single-line text', () => {
    const start = new vscode.Position(5, 10);
    const end = TextDispatcher.calculateEndPosition(start, 'hello');
    assert.equal(end.line, 5);
    assert.equal(end.character, 15);
  });

  it('calculates end position across multiple lines', () => {
    const start = new vscode.Position(2, 8);
    const end = TextDispatcher.calculateEndPosition(start, 'line1\nline2');
    assert.equal(end.line, 3);
    assert.equal(end.character, 5); // 'line2'.length
  });

  it('calculates end position for multi-line text with CRLF', () => {
    const start = new vscode.Position(10, 0);
    const end = TextDispatcher.calculateEndPosition(start, 'foo\r\nbar\r\nbaz123');
    assert.equal(end.line, 12);
    assert.equal(end.character, 6); // 'baz123'.length
  });
});

describe('TextDispatcher - Multi-Cursor Selection Calculation', () => {
  function createMockDocument(lines: string[]) {
    return {
      lineAt: (line: number) => ({ text: lines[line] || '' }),
    };
  }

  it('advances a single selection cleanly to the end of inserted text', () => {
    const doc = createMockDocument(['let x = ']);
    const sel = new vscode.Selection(new vscode.Position(0, 8), new vscode.Position(0, 8));
    const newSels = TextDispatcher.computeNewSelections([sel], doc, '42', true);

    assert.equal(newSels.length, 1);
    assert.equal(newSels[0].active.line, 0);
    assert.equal(newSels[0].active.character, 10); // '42'.length is 2, 8 + 2 = 10
  });

  it('advances multiple selections across different lines', () => {
    const doc = createMockDocument(['first = ', 'second = ']);
    const sel1 = new vscode.Selection(new vscode.Position(0, 8), new vscode.Position(0, 8));
    const sel2 = new vscode.Selection(new vscode.Position(1, 9), new vscode.Position(1, 9));

    const newSels = TextDispatcher.computeNewSelections([sel1, sel2], doc, 'val', true);

    assert.equal(newSels.length, 2);
    // Line 0 cursor
    assert.equal(newSels[0].active.line, 0);
    assert.equal(newSels[0].active.character, 11); // 8 + 3
    // Line 1 cursor
    assert.equal(newSels[1].active.line, 1);
    assert.equal(newSels[1].active.character, 12); // 9 + 3
  });

  it('advances multiple selections on the same line with character delta shift', () => {
    const doc = createMockDocument(['a , b ']);
    // Cursor 1 at index 2 (after 'a '), Cursor 2 at index 6 (after 'b ')
    const sel1 = new vscode.Selection(new vscode.Position(0, 2), new vscode.Position(0, 2));
    const sel2 = new vscode.Selection(new vscode.Position(0, 6), new vscode.Position(0, 6));

    // Inserting '123' at both cursors (preceded by spaces, so length is exactly 3)
    const newSels = TextDispatcher.computeNewSelections([sel1, sel2], doc, '123', true);

    assert.equal(newSels.length, 2);
    // First cursor ends at 2 + 3 = 5
    assert.equal(newSels[0].active.line, 0);
    assert.equal(newSels[0].active.character, 5);
    // Second cursor originally at 6, shifted by +3 from first insertion -> starts at 9, ends at 9 + 3 = 12
    assert.equal(newSels[1].active.line, 0);
    assert.equal(newSels[1].active.character, 12);
  });

  it('handles multi-line text inserted across multiple cursors', () => {
    const doc = createMockDocument(['first', 'second']);
    const sel1 = new vscode.Selection(new vscode.Position(0, 5), new vscode.Position(0, 5));
    const sel2 = new vscode.Selection(new vscode.Position(1, 6), new vscode.Position(1, 6));

    // Inserting 2 lines: "alpha\nbeta"
    const newSels = TextDispatcher.computeNewSelections([sel1, sel2], doc, 'alpha\nbeta', true);

    assert.equal(newSels.length, 2);
    // First cursor: line 0 -> line 1, char 4 ("beta".length)
    assert.equal(newSels[0].active.line, 1);
    assert.equal(newSels[0].active.character, 4);
    // Second cursor: original line 1 + lineDelta(1) = line 2 -> ends at line 3, char 4
    assert.equal(newSels[1].active.line, 3);
    assert.equal(newSels[1].active.character, 4);
  });

  it('handles multi-line selection replacements across multiple cursors', () => {
    const doc = createMockDocument(['line 0', 'line 1', 'line 2', 'line 3']);
    // sel1 replaces lines 0-1 (from line 0 char 0 to line 1 char 6) with single line 'hello'
    const sel1 = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(1, 6));
    // sel2 is at line 2 char 6
    const sel2 = new vscode.Selection(new vscode.Position(2, 6), new vscode.Position(2, 6));

    const newSels = TextDispatcher.computeNewSelections([sel1, sel2], doc, 'hello', true);

    assert.equal(newSels.length, 2);
    // First cursor ends at line 0, char 5 ('hello'.length)
    assert.equal(newSels[0].active.line, 0);
    assert.equal(newSels[0].active.character, 5);
    // Second cursor: linesRemoved was 1, linesAdded was 0 -> lineDelta is -1.
    // Original line 2 + lineDelta(-1) = line 1
    assert.equal(newSels[1].active.line, 1);
  });
});

describe('TextDispatcher - Target Dispatching', () => {
  it('returns false when text is empty or only whitespace', async () => {
    const snapshot: FocusSnapshot = { kind: 'none' };
    const resEmpty = await TextDispatcher.dispatch('', snapshot);
    const resSpaces = await TextDispatcher.dispatch('   ', snapshot);

    assert.equal(resEmpty, false);
    assert.equal(resSpaces, false);
  });

  it('dispatches to terminal with autoSubmit flag', async () => {
    let sentText = '';
    let sentAutoSubmit: boolean | undefined;

    const mockTerminal: any = {
      name: 'Bash',
      sendText: (text: string, autoSubmit?: boolean) => {
        sentText = text;
        sentAutoSubmit = autoSubmit;
      },
    };

    const snapshot: TerminalSnapshot = {
      kind: 'terminal',
      terminal: mockTerminal,
    };

    const result = await TextDispatcher.dispatch('git status', snapshot);
    assert.equal(result, true);
    assert.equal(sentText, 'git status');
    assert.equal(typeof sentAutoSubmit, 'boolean');
  });

  it('dispatches to editor and invokes multi-cursor edit', async () => {
    let editCallbackInvoked = false;
    const insertedOps: { pos: vscode.Position; text: string }[] = [];

    const mockDoc: any = {
      uri: vscode.Uri.file('/path/to/test.ts'),
      fileName: '/path/to/test.ts',
      languageId: 'typescript',
      isClosed: false,
      lineAt: () => ({ text: '' }),
    };

    const sel1 = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const sel2 = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));

    const mockEditor: any = {
      document: mockDoc,
      selection: sel1,
      selections: [sel1, sel2],
      edit: async (callback: (builder: any) => void) => {
        editCallbackInvoked = true;
        const builder = {
          insert: (pos: vscode.Position, text: string) => {
            insertedOps.push({ pos, text });
          },
          replace: () => {},
        };
        callback(builder);
        return true;
      },
    };

    const snapshot: EditorSnapshot = {
      kind: 'editor',
      editor: mockEditor,
      documentUri: mockDoc.uri,
      selection: sel1,
      selections: [sel1, sel2],
      languageId: 'typescript',
    };

    const result = await TextDispatcher.dispatch('testText', snapshot);
    assert.equal(result, true);
    assert.equal(editCallbackInvoked, true);
    assert.equal(insertedOps.length, 2);
    assert.equal(mockEditor.selections.length, 2);
  });
});
