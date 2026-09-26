import type * as vscode from 'vscode';

export const PROSE_LANGUAGE_IDS = new Set<string>([
  'markdown',
  'plaintext',
  'git-commit',
  'git-rebase',
  'log',
  'scminput',
  'restructuredtext',
  'latex',
]);

const PUNCTUATION_START_REGEX = /^[.,!?:;)\]}>"'’”—\-]/;
const OPENING_DELIMITERS = new Set<string>(['(', '[', '{', '<', '"', "'", '`']);

export class AutoSpacer {
  /**
   * Determines if a document should be treated as code vs prose.
   */
  public static isCodeDocument(
    document: { languageId: string },
    codeModeEnabled: boolean
  ): boolean {
    if (!codeModeEnabled) {
      return false;
    }
    const lang = document.languageId.toLowerCase();
    return !PROSE_LANGUAGE_IDS.has(lang);
  }

  /**
   * Adjusts text for Code Mode:
   * - Suppresses sentence-initial auto-capitalization (e.g., "User_id" -> "user_id").
   * - Suppresses trailing period insertion (e.g., "user_id." -> "user_id").
   */
  public static formatTextForCodeMode(text: string): string {
    if (!text) {
      return text;
    }

    let result = text;

    // 1. Suppress sentence-initial capitalization if text is Titlecase (e.g. "Function" -> "function"),
    // but preserve acronyms (e.g. "HTTPClient", "SQL", "URL", "API").
    if (/^[A-Z][a-z]/.test(result) && !/^[A-Z]{2,}/.test(result)) {
      result = result.charAt(0).toLowerCase() + result.slice(1);
    }

    // 2. Suppress trailing period (but preserve ellipsis '...')
    if (result.endsWith('.') && !result.endsWith('...')) {
      result = result.replace(/\.+$/, '');
    }

    return result;
  }

  /**
   * Inspects character immediately preceding cursor and prepends space if:
   * - Preceded by non-whitespace character.
   * - Preceding character is not an opening delimiter (e.g. '(', '[', '{', '"', etc.).
   * - Speech does not start with punctuation.
   * - Cursor is not at the beginning of the line.
   */
  public static computeSpacing(
    document: { lineAt: (line: number) => { text: string } },
    position: { line: number; character: number },
    text: string
  ): string {
    if (!text || position.character === 0) {
      return text;
    }

    if (text.startsWith(' ')) {
      return text;
    }

    // Check speech start character
    const trimmedSpeech = text.trimStart();
    if (!trimmedSpeech || PUNCTUATION_START_REGEX.test(trimmedSpeech)) {
      return text;
    }

    // Check preceding character using lineAt
    const lineText = document.lineAt(position.line).text;
    const charBefore = lineText.charAt(position.character - 1);

    // If already preceded by whitespace, no space needed
    if (!charBefore || /\s/.test(charBefore)) {
      return text;
    }

    // If preceded by opening delimiter like '(', '[', '{', '"', do not add space
    if (OPENING_DELIMITERS.has(charBefore)) {
      return text;
    }

    // Preceded by non-whitespace (e.g., "=", "+", "a", "1", ":") -> prepend space
    return ' ' + text;
  }

  /**
   * Full pipeline combining code mode formatting and cursor context auto-spacing.
   * Guaranteed never to throw an exception.
   */
  public static format(
    document: { lineAt: (line: number) => { text: string }; languageId?: string },
    position: { line: number; character: number },
    rawText: string,
    isCodeMode: boolean
  ): string {
    try {
      let processed = rawText;
      if (isCodeMode) {
        processed = this.formatTextForCodeMode(processed);
      }
      return this.computeSpacing(document, position, processed);
    } catch {
      return rawText;
    }
  }
}

