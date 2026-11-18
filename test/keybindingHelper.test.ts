import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_TOGGLE_COMMAND,
  KeybindingManager,
  UNASSIGNED_LABEL,
  formatKeyLabel,
  getDefaultKeyLabel,
  getFallbackKeybindingsPaths,
  normalizeKeySequence,
  parseKeybindingsJsonc,
  resolveKeybindingsPath,
  resolveToggleDictationLabel,
  stripJsonc,
} from '../src/keybindingHelper';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('KeybindingHelper - JSONC Comment & Trailing Comma Stripping', () => {
  it('strips single-line and multi-line comments while preserving strings', () => {
    const jsonc = `\uFEFF// Header comment
[
  /* Multi-line
     comment block */
  {
    "key": "ctrl+/", // inline comment
    "command": "${DEFAULT_TOGGLE_COMMAND}",
    "when": "/* not a comment */ // also not a comment",
  },
]`;

    const entries = parseKeybindingsJsonc(jsonc);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, 'ctrl+/');
    assert.equal(entries[0].command, DEFAULT_TOGGLE_COMMAND);
    assert.equal(entries[0].when, '/* not a comment */ // also not a comment');
  });

  it('handles nested trailing commas and commas inside strings', () => {
    const jsonc = `[
      {
        "key": "f8",
        "command": "${DEFAULT_TOGGLE_COMMAND}",
        "args": { "note": "keep, ] and , }", },
      },
    ]`;

    const stripped = stripJsonc(jsonc);
    const parsed = JSON.parse(stripped);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].args.note, 'keep, ] and , }');
  });

  it('returns empty array for empty, comment-only, or invalid JSONC files', () => {
    assert.deepEqual(parseKeybindingsJsonc(''), []);
    assert.deepEqual(parseKeybindingsJsonc('// Place your key bindings here\n/* none */\n'), []);
    assert.deepEqual(parseKeybindingsJsonc('{ "not": "an array" }'), []);
    assert.deepEqual(parseKeybindingsJsonc('[ { broken json '), []);
    assert.deepEqual(parseKeybindingsJsonc('[ [], null, "str", 42 ]'), []);
  });
});

describe('KeybindingHelper - Key Label Formatting & Normalization', () => {
  it('formats common keys, modifiers, and chords cleanly', () => {
    assert.equal(formatKeyLabel('pausebreak', 'win32'), 'Pause');
    assert.equal(formatKeyLabel('ctrl+alt+v', 'win32'), 'Ctrl+Alt+V');
    assert.equal(formatKeyLabel('ctrl+shift+space', 'win32'), 'Ctrl+Shift+Space');
    assert.equal(formatKeyLabel('cmd+option+v', 'darwin'), 'Cmd+Option+V');
    assert.equal(formatKeyLabel('cmd+alt+v', 'darwin'), 'Cmd+Option+V');
    assert.equal(formatKeyLabel('ctrl+k ctrl+v', 'win32'), 'Ctrl+K Ctrl+V');
    assert.equal(formatKeyLabel('f8', 'linux'), 'F8');
    assert.equal(formatKeyLabel('ctrl++', 'win32'), 'Ctrl++');
  });

  it('normalizes modifier ordering and aliases for comparison', () => {
    assert.equal(normalizeKeySequence('alt+ctrl+v'), normalizeKeySequence('Ctrl+Alt+V'));
    assert.equal(normalizeKeySequence('cmd+option+v'), normalizeKeySequence('command+alt+v'));
    assert.equal(normalizeKeySequence('pause'), normalizeKeySequence('pausebreak'));
  });
});

describe('KeybindingHelper - Override Precedence & Evaluation', () => {
  it('falls back to platform defaults when no overrides exist', () => {
    assert.equal(getDefaultKeyLabel('win32'), 'Ctrl+Alt+V');
    assert.equal(getDefaultKeyLabel('linux'), 'Ctrl+Alt+V');
    assert.equal(getDefaultKeyLabel('darwin'), 'Cmd+Option+V');

    assert.equal(resolveToggleDictationLabel([], 'win32'), 'Ctrl+Alt+V');
    assert.equal(resolveToggleDictationLabel([], 'darwin'), 'Cmd+Option+V');
  });

  it('resolves positive override regardless of removal rule order', () => {
    // Order produced by VS Code Keyboard Shortcuts UI: new rule first, removal second
    const uiOrder = [
      { key: 'f8', command: DEFAULT_TOGGLE_COMMAND },
      { key: 'ctrl+alt+v', command: `-${DEFAULT_TOGGLE_COMMAND}` },
    ];
    assert.equal(resolveToggleDictationLabel(uiOrder, 'win32'), 'F8');

    // Manual order: removal first, new rule second
    const manualOrder = [
      { key: 'ctrl+alt+v', command: `-${DEFAULT_TOGGLE_COMMAND}` },
      { key: 'pausebreak', command: DEFAULT_TOGGLE_COMMAND },
    ];
    assert.equal(resolveToggleDictationLabel(manualOrder, 'win32'), 'Pause');
  });

  it('displays (Unassigned) when default is removed without replacement', () => {
    const winRemoved = [{ key: 'ctrl+alt+v', command: `-${DEFAULT_TOGGLE_COMMAND}` }];
    assert.equal(resolveToggleDictationLabel(winRemoved, 'win32'), UNASSIGNED_LABEL);

    const macRemoved = [{ key: 'cmd+option+v', command: `-${DEFAULT_TOGGLE_COMMAND}` }];
    assert.equal(resolveToggleDictationLabel(macRemoved, 'darwin'), UNASSIGNED_LABEL);

    const blanketRemoved = [{ command: `-${DEFAULT_TOGGLE_COMMAND}` }];
    assert.equal(resolveToggleDictationLabel(blanketRemoved, 'linux'), UNASSIGNED_LABEL);
  });

  it('respects platform-specific key fields (win, mac, linux)', () => {
    const entries = [
      {
        key: 'f8',
        win: 'f9',
        mac: 'cmd+shift+space',
        linux: 'ctrl+shift+space',
        command: DEFAULT_TOGGLE_COMMAND,
      },
    ];

    assert.equal(resolveToggleDictationLabel(entries, 'win32'), 'F9');
    assert.equal(resolveToggleDictationLabel(entries, 'darwin'), 'Cmd+Shift+Space');
    assert.equal(resolveToggleDictationLabel(entries, 'linux'), 'Ctrl+Shift+Space');
  });

  it('ignores removal rules targeted exclusively to other platforms', () => {
    const macOnlyRemoval = [{ mac: 'cmd+alt+v', command: `-${DEFAULT_TOGGLE_COMMAND}` }];
    assert.equal(resolveToggleDictationLabel(macOnlyRemoval, 'win32'), 'Ctrl+Alt+V');
    assert.equal(resolveToggleDictationLabel(macOnlyRemoval, 'linux'), 'Ctrl+Alt+V');
    assert.equal(resolveToggleDictationLabel(macOnlyRemoval, 'darwin'), UNASSIGNED_LABEL);

    const winOnlyRemoval = [{ win: 'ctrl+alt+v', command: `-${DEFAULT_TOGGLE_COMMAND}` }];
    assert.equal(resolveToggleDictationLabel(winOnlyRemoval, 'darwin'), 'Cmd+Option+V');
    assert.equal(resolveToggleDictationLabel(winOnlyRemoval, 'linux'), 'Ctrl+Alt+V');
    assert.equal(resolveToggleDictationLabel(winOnlyRemoval, 'win32'), UNASSIGNED_LABEL);
  });

  it('handles multiple overrides and subsequent removal of custom binding', () => {
    const entries = [
      { key: 'f8', command: DEFAULT_TOGGLE_COMMAND },
      { key: 'ctrl+shift+space', command: DEFAULT_TOGGLE_COMMAND },
      { key: 'ctrl+shift+space', command: `-${DEFAULT_TOGGLE_COMMAND}` },
    ];
    assert.equal(resolveToggleDictationLabel(entries, 'win32'), 'F8');
  });
});

describe('KeybindingHelper - Path Resolution', () => {
  it('resolves keybindings.json relative to globalStoragePath including custom profiles', () => {
    const root = createTempDir('voxcode_kb_path_');
    try {
      const profileUserDir = path.join(root, 'Code', 'User', 'profiles', 'work');
      const globalStorage = path.join(profileUserDir, 'globalStorage', 'voxcode.voxcode');
      fs.mkdirSync(globalStorage, { recursive: true });
      const expectedKeybindings = path.join(profileUserDir, 'keybindings.json');
      fs.writeFileSync(expectedKeybindings, '[]', 'utf8');

      const resolved = resolveKeybindingsPath({ globalStoragePath: globalStorage });
      assert.equal(resolved, expectedKeybindings);
    } finally {
      cleanupDir(root);
    }
  });

  it('falls back across supported editor profiles when globalStoragePath is absent', () => {
    const root = createTempDir('voxcode_kb_fallback_');
    try {
      const cursorUser = path.join(root, 'Cursor', 'User');
      fs.mkdirSync(cursorUser, { recursive: true });
      const cursorKb = path.join(cursorUser, 'keybindings.json');
      fs.writeFileSync(cursorKb, '[]', 'utf8');

      const resolved = resolveKeybindingsPath({
        platform: 'win32',
        appDataDir: root,
        homeDir: root,
      });
      assert.equal(resolved, cursorKb);

      const macCandidates = getFallbackKeybindingsPaths({
        platform: 'darwin',
        homeDir: '/Users/tester',
      });
      assert.ok(
        macCandidates.includes(
          path.join('/Users/tester', 'Library', 'Application Support', 'Code', 'User', 'keybindings.json')
        )
      );
      assert.ok(
        macCandidates.includes(
          path.join('/Users/tester', 'Library', 'Application Support', 'Cursor', 'User', 'keybindings.json')
        )
      );

      const linuxCandidates = getFallbackKeybindingsPaths({
        platform: 'linux',
        homeDir: '/home/tester',
        xdgConfigHome: '/home/tester/.config',
      });
      assert.ok(
        linuxCandidates.includes(
          path.join('/home/tester/.config', 'Code', 'User', 'keybindings.json')
        )
      );
      assert.ok(
        linuxCandidates.includes(
          path.join('/home/tester/.config', 'VSCodium', 'User', 'keybindings.json')
        )
      );
    } finally {
      cleanupDir(root);
    }
  });

  it('keeps primary User/keybindings.json path when User dir exists even before file creation', () => {
    const root = createTempDir('voxcode_kb_new_');
    try {
      const vscodeUserDir = path.join(root, 'Code', 'User');
      const globalStorage = path.join(vscodeUserDir, 'globalStorage', 'voxcode.voxcode');
      fs.mkdirSync(globalStorage, { recursive: true });

      // Create another editor's keybindings.json to verify it is NOT mistakenly selected
      const cursorUserDir = path.join(root, 'Cursor', 'User');
      fs.mkdirSync(cursorUserDir, { recursive: true });
      fs.writeFileSync(path.join(cursorUserDir, 'keybindings.json'), '[]', 'utf8');

      const resolved = resolveKeybindingsPath({
        globalStoragePath: globalStorage,
        platform: 'win32',
        appDataDir: root,
      });
      assert.equal(resolved, path.join(vscodeUserDir, 'keybindings.json'));
    } finally {
      cleanupDir(root);
    }
  });
});

describe('KeybindingManager - Caching, Watching & Live Updates', () => {
  it('reads JSONC keybindings, detects disk edits, and fires change events', async () => {
    const root = createTempDir('voxcode_kb_mgr_');
    let manager: KeybindingManager | null = null;

    try {
      const userDir = path.join(root, 'Code', 'User');
      const globalStorage = path.join(userDir, 'globalStorage', 'voxcode.voxcode');
      fs.mkdirSync(globalStorage, { recursive: true });
      const kbPath = path.join(userDir, 'keybindings.json');

      manager = new KeybindingManager({
        globalStoragePath: globalStorage,
        platform: 'win32',
        debounceMs: 30,
      });

      // Initially no keybindings.json -> default
      assert.equal(manager.getToggleDictationLabel(), 'Ctrl+Alt+V');

      const observedChanges: string[] = [];
      const sub = manager.onDidChangeKeybinding((label) => {
        observedChanges.push(label);
      });

      // Create keybindings.json with custom shortcut
      fs.writeFileSync(
        kbPath,
        `// Custom VoxCode shortcut
[
  {
    "key": "ctrl+shift+space",
    "command": "${DEFAULT_TOGGLE_COMMAND}",
  },
  {
    "key": "ctrl+alt+v",
    "command": "-${DEFAULT_TOGGLE_COMMAND}",
  },
]`,
        'utf8'
      );

      // Wait briefly for fs.watch debounce
      await waitForCondition(() => observedChanges.length >= 1, 2000);
      assert.equal(observedChanges[observedChanges.length - 1], 'Ctrl+Shift+Space');
      assert.equal(manager.getToggleDictationLabel(), 'Ctrl+Shift+Space');

      // Update file to unassign shortcut
      fs.writeFileSync(
        kbPath,
        JSON.stringify([{ key: 'ctrl+alt+v', command: `-${DEFAULT_TOGGLE_COMMAND}` }]),
        'utf8'
      );

      await waitForCondition(() => observedChanges.length >= 2, 2000);
      assert.equal(observedChanges[observedChanges.length - 1], UNASSIGNED_LABEL);
      assert.equal(manager.getToggleDictationLabel(), UNASSIGNED_LABEL);

      // Verify dispose() stops emitting further change notifications
      manager.dispose();
      fs.writeFileSync(
        kbPath,
        JSON.stringify([{ key: 'f9', command: DEFAULT_TOGGLE_COMMAND }]),
        'utf8'
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(observedChanges.length, 2);

      sub.dispose();
    } finally {
      manager?.dispose();
      cleanupDir(root);
    }
  });
});

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
