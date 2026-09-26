import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { AutoSpacer } from '../src/injector/autoSpacer';

describe('AutoSpacer - Code Mode Formatting', () => {
  it('suppresses sentence-initial capitalization for identifiers', () => {
    assert.equal(AutoSpacer.formatTextForCodeMode('User_id'), 'user_id');
    assert.equal(AutoSpacer.formatTextForCodeMode('CalculateTotal'), 'calculateTotal');
    assert.equal(AutoSpacer.formatTextForCodeMode('Function'), 'function');
    assert.equal(AutoSpacer.formatTextForCodeMode('HTTPClient'), 'HTTPClient');
    assert.equal(AutoSpacer.formatTextForCodeMode('SQL'), 'SQL');
    assert.equal(AutoSpacer.formatTextForCodeMode('URL'), 'URL');
    assert.equal(AutoSpacer.formatTextForCodeMode('API'), 'API');
  });

  it('suppresses trailing periods in code mode', () => {
    assert.equal(AutoSpacer.formatTextForCodeMode('user_id.'), 'user_id');
    assert.equal(AutoSpacer.formatTextForCodeMode('const count = 10.'), 'const count = 10');
    assert.equal(AutoSpacer.formatTextForCodeMode('return true...'), 'return true...');
  });

  it('handles empty and whitespace strings gracefully', () => {
    assert.equal(AutoSpacer.formatTextForCodeMode(''), '');
    assert.equal(AutoSpacer.formatTextForCodeMode('   '), '   ');
  });
});

describe('AutoSpacer - Prose vs Code Document Detection', () => {
  it('identifies prose documents', () => {
    for (const lang of ['markdown', 'plaintext', 'git-commit', 'log']) {
      const mockDoc = { languageId: lang };
      assert.equal(AutoSpacer.isCodeDocument(mockDoc, true), false);
    }
  });

  it('identifies code documents', () => {
    for (const lang of ['typescript', 'javascript', 'python', 'rust', 'go', 'c', 'html']) {
      const mockDoc = { languageId: lang };
      assert.equal(AutoSpacer.isCodeDocument(mockDoc, true), true);
    }
  });

  it('returns false when codeMode is disabled in settings', () => {
    const mockDoc = { languageId: 'typescript' };
    assert.equal(AutoSpacer.isCodeDocument(mockDoc, false), false);
  });
});

describe('AutoSpacer - Character Context Auto-Spacing', () => {
  function createMockDocument(lineText: string) {
    return {
      lineAt: (_line: number) => ({ text: lineText }),
    };
  }

  function mockPosition(char: number) {
    return { line: 0, character: char };
  }

  it('does not prepend space at the start of a line', () => {
    const doc = createMockDocument('');
    const pos = mockPosition(0);
    assert.equal(AutoSpacer.computeSpacing(doc, pos, 'hello'), 'hello');
  });

  it('prepends space after non-whitespace operators', () => {
    // "count =" cursor is at index 7 (after '=')
    const doc = createMockDocument('count =');
    const pos = mockPosition(7);
    assert.equal(AutoSpacer.computeSpacing(doc, pos, '10'), ' 10');
  });

  it('does not prepend space if already preceded by space', () => {
    // "count = " cursor is at index 8 (after ' ')
    const doc = createMockDocument('count = ');
    const pos = mockPosition(8);
    assert.equal(AutoSpacer.computeSpacing(doc, pos, '10'), '10');
  });

  it('does not prepend space if preceded by opening parenthesis or bracket', () => {
    const docParen = createMockDocument('func(');
    assert.equal(AutoSpacer.computeSpacing(docParen, mockPosition(5), 'arg'), 'arg');

    const docBracket = createMockDocument('arr[');
    assert.equal(AutoSpacer.computeSpacing(docBracket, mockPosition(4), '0'), '0');

    const docQuote = createMockDocument('const s = "');
    assert.equal(AutoSpacer.computeSpacing(docQuote, mockPosition(11), 'text'), 'text');
  });

  it('does not prepend space if speech starts with punctuation', () => {
    const doc = createMockDocument('hello');
    const pos = mockPosition(5);
    assert.equal(AutoSpacer.computeSpacing(doc, pos, ', world'), ', world');
    assert.equal(AutoSpacer.computeSpacing(doc, pos, '. More text'), '. More text');
    assert.equal(AutoSpacer.computeSpacing(doc, pos, ') next'), ') next');
  });

  it('does not double space if speech input already starts with a space', () => {
    const doc = createMockDocument('count =');
    const pos = mockPosition(7);
    assert.equal(AutoSpacer.computeSpacing(doc, pos, ' 10'), ' 10');
  });

  it('handles format pipeline end-to-end', () => {
    const doc = createMockDocument('let user =');
    const pos = mockPosition(10);
    assert.equal(
      AutoSpacer.format(doc, pos, 'User_profile_id.', true),
      ' user_profile_id'
    );
  });
});
