import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { extLog } from './logger';

export const DEFAULT_TOGGLE_COMMAND = 'voxcode.toggleDictation';
export const UNASSIGNED_LABEL = '(Unassigned)';

const SUPPORTED_EDITOR_PROFILES = [
  'Code',
  'Code - Insiders',
  'Cursor',
  'VSCodium',
  'Windsurf',
] as const;

const MODIFIER_ORDER: Record<string, number> = {
  ctrl: 0,
  shift: 1,
  alt: 2,
  cmd: 3,
  win: 4,
  super: 5,
  meta: 6,
};

const NORMALIZATION_ALIASES: Record<string, string> = {
  control: 'ctrl',
  option: 'alt',
  opt: 'alt',
  command: 'cmd',
  esc: 'escape',
  pause: 'pausebreak',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
};

const SPECIAL_KEY_LABELS: Record<string, string> = {
  pausebreak: 'Pause',
  pause: 'Pause',
  space: 'Space',
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  tab: 'Tab',
  capslock: 'CapsLock',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  up: 'Up',
  uparrow: 'Up',
  down: 'Down',
  downarrow: 'Down',
  left: 'Left',
  leftarrow: 'Left',
  right: 'Right',
  rightarrow: 'Right',
  printscreen: 'PrintScreen',
  scrolllock: 'ScrollLock',
  numlock: 'NumLock',
  numpad_add: 'Numpad+',
  numpad_subtract: 'Numpad-',
  numpad_multiply: 'Numpad*',
  numpad_divide: 'Numpad/',
  numpad_decimal: 'Numpad.',
  numpad_enter: 'NumpadEnter',
  oem_1: ';',
  oem_plus: '=',
  oem_comma: ',',
  oem_minus: '-',
  oem_period: '.',
  oem_2: '/',
  oem_3: '`',
  oem_4: '[',
  oem_5: '\\',
  oem_6: ']',
  oem_7: "'",
  plus: '+',
};

export interface KeybindingEntry {
  key?: string;
  win?: string;
  mac?: string;
  linux?: string;
  command?: string;
  when?: string;
  args?: unknown;
}

export interface KeybindingPathOptions {
  globalStoragePath?: string;
  keybindingsPath?: string;
  platform?: NodeJS.Platform;
  appDataDir?: string;
  homeDir?: string;
  xdgConfigHome?: string;
}

export interface KeybindingManagerOptions extends KeybindingPathOptions {
  watch?: boolean;
  debounceMs?: number;
  commandId?: string;
}

/**
 * Strips UTF-8 BOM, single-line (`//`) and multi-line (`/* *\/`) comments,
 * and trailing commas from JSONC text while preserving string literals verbatim.
 */
export function stripJsonc(input: string): string {
  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  // Pass 1: Remove comments outside string literals
  let withoutComments = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = i + 1 < source.length ? source[i + 1] : '';

    if (inString) {
      withoutComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      withoutComments += ch;
      continue;
    }

    // Single-line comment
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') {
        i++;
      }
      // Re-emit newline if present
      if (i < source.length) {
        withoutComments += source[i];
      }
      continue;
    }

    // Multi-line comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && i + 1 < source.length && source[i + 1] === '/') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    withoutComments += ch;
  }

  // Pass 2: Remove trailing commas before `]` or `}` outside string literals
  let result = '';
  inString = false;
  escaped = false;

  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i];

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (
        j < withoutComments.length &&
        (withoutComments[j] === ' ' ||
          withoutComments[j] === '\t' ||
          withoutComments[j] === '\n' ||
          withoutComments[j] === '\r')
      ) {
        j++;
      }
      if (
        j < withoutComments.length &&
        (withoutComments[j] === ']' || withoutComments[j] === '}')
      ) {
        // Skip trailing comma
        continue;
      }
    }

    result += ch;
  }

  return result;
}

/**
 * Parses JSONC keybindings file content into validated KeybindingEntry records.
 * Returns an empty array if content is empty, invalid, or not an array.
 */
export function parseKeybindingsJsonc(content: string): KeybindingEntry[] {
  const cleaned = stripJsonc(content).trim();
  if (!cleaned) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      extLog('WARN', 'keybindings.json root value is not an array');
      return [];
    }
    return parsed.filter(
      (item): item is KeybindingEntry =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
    );
  } catch (err: any) {
    extLog('WARN', 'Failed to parse keybindings.json JSONC content', {
      error: err?.message,
    });
    return [];
  }
}

function splitChordStroke(stroke: string): string[] {
  const trimmed = stroke.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed === '+') {
    return ['+'];
  }

  const parts = trimmed.split('+');
  const tokens: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (part.length > 0) {
      tokens.push(part);
    } else if (i === parts.length - 1 && parts[i - 1] === '') {
      // Handles trailing `+` key like `ctrl++`
      tokens.push('+');
    }
  }

  return tokens;
}

/**
 * Normalizes a raw keybinding sequence into a canonical form for rule comparison
 * (case-insensitive, alias-normalized, canonical modifier ordering per stroke).
 */
export function normalizeKeySequence(rawKey: string): string {
  const strokes = rawKey.trim().split(/\s+/).filter(Boolean);
  const normalizedStrokes = strokes.map((stroke) => {
    const tokens = splitChordStroke(stroke).map((t) => {
      const lower = t.toLowerCase();
      return NORMALIZATION_ALIASES[lower] ?? lower;
    });

    const modifiers: string[] = [];
    const keys: string[] = [];

    for (const tok of tokens) {
      if (tok in MODIFIER_ORDER) {
        if (!modifiers.includes(tok)) {
          modifiers.push(tok);
        }
      } else {
        keys.push(tok);
      }
    }

    modifiers.sort((a, b) => MODIFIER_ORDER[a] - MODIFIER_ORDER[b]);
    return [...modifiers, ...keys].join('+');
  });

  return normalizedStrokes.join(' ');
}

function formatKeyToken(token: string, platform: NodeJS.Platform): string {
  const lower = token.toLowerCase();

  switch (lower) {
    case 'ctrl':
    case 'control':
      return 'Ctrl';
    case 'shift':
      return 'Shift';
    case 'alt':
      return platform === 'darwin' ? 'Option' : 'Alt';
    case 'option':
    case 'opt':
      return 'Option';
    case 'cmd':
    case 'command':
      return 'Cmd';
    case 'win':
    case 'super':
      if (platform === 'darwin') {
        return 'Cmd';
      }
      return platform === 'linux' ? 'Super' : 'Win';
    case 'meta':
      return platform === 'darwin' ? 'Cmd' : 'Meta';
  }

  if (lower in SPECIAL_KEY_LABELS) {
    return SPECIAL_KEY_LABELS[lower];
  }

  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    return lower.toUpperCase();
  }

  if (/^numpad([0-9])$/.test(lower)) {
    return `Numpad${lower.slice(6)}`;
  }

  if (lower.length === 1) {
    return lower.toUpperCase();
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Formats a raw VS Code keybinding string (e.g. `pausebreak`, `ctrl+k ctrl+v`)
 * into a clean human-readable shortcut label.
 */
export function formatKeyLabel(
  rawKey: string,
  platform: NodeJS.Platform = process.platform
): string {
  const strokes = rawKey.trim().split(/\s+/).filter(Boolean);
  if (strokes.length === 0) {
    return '';
  }

  return strokes
    .map((stroke) =>
      splitChordStroke(stroke)
        .map((token) => formatKeyToken(token, platform))
        .join('+')
    )
    .join(' ');
}

export function getDefaultRawKey(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'cmd+alt+v' : 'ctrl+alt+v';
}

export function getDefaultKeyLabel(platform: NodeJS.Platform = process.platform): string {
  return formatKeyLabel(getDefaultRawKey(platform), platform);
}

function getPlatformRawKey(entry: KeybindingEntry, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') {
    return typeof entry.win === 'string' ? entry.win : entry.key;
  }
  if (platform === 'darwin') {
    return typeof entry.mac === 'string' ? entry.mac : entry.key;
  }
  return typeof entry.linux === 'string' ? entry.linux : entry.key;
}

/**
 * Evaluates keybinding rules sequentially (starting from the extension's default)
 * and returns the active formatted shortcut label, or `(Unassigned)` if removed
 * without replacement.
 */
export function resolveToggleDictationLabel(
  entries: KeybindingEntry[],
  platform: NodeJS.Platform = process.platform,
  commandId: string = DEFAULT_TOGGLE_COMMAND
): string {
  const defaultRaw = getDefaultRawKey(platform);
  let activeBindings: Array<{ raw: string; normalized: string }> = [
    { raw: defaultRaw, normalized: normalizeKeySequence(defaultRaw) },
  ];

  const removalCommand = `-${commandId}`;

  for (const entry of entries) {
    if (!entry || typeof entry.command !== 'string') {
      continue;
    }

    const rawKey = getPlatformRawKey(entry, platform);

    if (entry.command === commandId) {
      if (typeof rawKey === 'string' && rawKey.trim().length > 0) {
        const trimmed = rawKey.trim();
        const normalized = normalizeKeySequence(trimmed);
        // Move to end so the most recent matching positive rule takes display precedence
        activeBindings = activeBindings.filter((b) => b.normalized !== normalized);
        activeBindings.push({ raw: trimmed, normalized });
      }
    } else if (entry.command === removalCommand) {
      if (typeof rawKey === 'string' && rawKey.trim().length > 0) {
        const targetNorm = normalizeKeySequence(rawKey.trim());
        activeBindings = activeBindings.filter((b) => b.normalized !== targetNorm);
      } else {
        const hasOtherPlatformKey = [entry.key, entry.win, entry.mac, entry.linux].some(
          (k) => typeof k === 'string' && k.trim().length > 0
        );
        if (!hasOtherPlatformKey) {
          activeBindings = [];
        }
      }
    }
  }

  if (activeBindings.length === 0) {
    return UNASSIGNED_LABEL;
  }

  const active = activeBindings[activeBindings.length - 1];
  const formatted = formatKeyLabel(active.raw, platform);
  return formatted || UNASSIGNED_LABEL;
}

/**
 * Builds the ordered list of fallback `keybindings.json` paths across
 * supported VS Code-based editors for the given platform.
 */
export function getFallbackKeybindingsPaths(options?: KeybindingPathOptions): string[] {
  const platform = options?.platform ?? process.platform;
  const homeDir = options?.homeDir ?? os.homedir();
  const candidates: string[] = [];

  for (const appName of SUPPORTED_EDITOR_PROFILES) {
    if (platform === 'win32') {
      const appData =
        options?.appDataDir ?? process.env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming');
      candidates.push(path.join(appData, appName, 'User', 'keybindings.json'));
    } else if (platform === 'darwin') {
      candidates.push(
        path.join(homeDir, 'Library', 'Application Support', appName, 'User', 'keybindings.json')
      );
    } else {
      const xdgConfig =
        options?.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config');
      candidates.push(path.join(xdgConfig, appName, 'User', 'keybindings.json'));
    }
  }

  return candidates;
}

/**
 * Resolves the active `keybindings.json` path starting from `globalStoragePath`
 * (`../../keybindings.json`) with fallbacks across supported editor profiles.
 */
export function resolveKeybindingsPath(options?: KeybindingPathOptions): string | null {
  if (options?.keybindingsPath) {
    return options.keybindingsPath;
  }

  if (options?.globalStoragePath) {
    const primary = path.resolve(options.globalStoragePath, '..', '..', 'keybindings.json');
    if (fs.existsSync(primary) || fs.existsSync(path.dirname(primary))) {
      return primary;
    }
  }

  const fallbacks = getFallbackKeybindingsPaths(options);
  for (const candidate of fallbacks) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Manages reading, caching, watching, and formatting the active keybinding
 * label for `voxcode.toggleDictation`.
 */
export class KeybindingManager implements vscode.Disposable {
  private readonly targetPath: string | null;
  private readonly platform: NodeJS.Platform;
  private readonly commandId: string;
  private readonly debounceMs: number;

  private cachedLabel: string | null = null;
  private cachedMtimeMs: number | null = null;
  private lastNotifiedLabel: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(label: string) => void>();
  private disposed = false;

  constructor(options: KeybindingManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.commandId = options.commandId ?? DEFAULT_TOGGLE_COMMAND;
    this.debounceMs = options.debounceMs ?? 100;
    this.targetPath = resolveKeybindingsPath({
      ...options,
      platform: this.platform,
    });

    this.lastNotifiedLabel = this.getToggleDictationLabel();

    if (options.watch !== false && this.targetPath) {
      this.startWatching();
    }
  }

  public getKeybindingsFilePath(): string | null {
    return this.targetPath;
  }

  public getToggleDictationLabel(): string {
    const currentMtime = this.readFileMtime();
    if (this.cachedLabel !== null && this.cachedMtimeMs === currentMtime) {
      return this.cachedLabel;
    }
    return this.readAndEvaluate(currentMtime);
  }

  public invalidateCache(): void {
    this.cachedLabel = null;
    this.cachedMtimeMs = null;
  }

  public refresh(): string {
    const currentMtime = this.readFileMtime();
    const nextLabel = this.readAndEvaluate(currentMtime);

    if (this.lastNotifiedLabel !== null && nextLabel !== this.lastNotifiedLabel) {
      this.lastNotifiedLabel = nextLabel;
      for (const listener of this.listeners) {
        try {
          listener(nextLabel);
        } catch (err: any) {
          extLog('WARN', 'Error in keybinding change listener', { error: err?.message });
        }
      }
    }

    return nextLabel;
  }

  public onDidChangeKeybinding(listener: (label: string) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  private readFileMtime(): number {
    if (!this.targetPath) {
      return -1;
    }
    try {
      return fs.statSync(this.targetPath).mtimeMs;
    } catch {
      return -1;
    }
  }

  private readAndEvaluate(mtimeMs: number): string {
    let label = getDefaultKeyLabel(this.platform);

    if (this.targetPath && mtimeMs !== -1) {
      try {
        const content = fs.readFileSync(this.targetPath, 'utf8');
        const entries = parseKeybindingsJsonc(content);
        label = resolveToggleDictationLabel(entries, this.platform, this.commandId);
      } catch (err: any) {
        extLog('WARN', 'Failed to read keybindings.json; falling back to default label', {
          path: this.targetPath,
          error: err?.message,
        });
      }
    }

    this.cachedLabel = label;
    this.cachedMtimeMs = mtimeMs;
    return label;
  }

  private startWatching(): void {
    if (!this.targetPath || this.disposed) {
      return;
    }

    const parentDir = path.dirname(this.targetPath);
    const targetName = path.basename(this.targetPath);

    if (!fs.existsSync(parentDir)) {
      return;
    }

    try {
      this.watcher = fs.watch(parentDir, { persistent: false }, (_eventType, filename) => {
        if (this.disposed) {
          return;
        }

        if (filename) {
          const changedName = filename.toString();
          const matches =
            this.platform === 'win32'
              ? changedName.toLowerCase() === targetName.toLowerCase()
              : changedName === targetName;
          if (!matches) {
            return;
          }
        }

        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          if (!this.disposed) {
            this.refresh();
          }
        }, this.debounceMs);

        if (typeof this.debounceTimer.unref === 'function') {
          this.debounceTimer.unref();
        }
      });

      this.watcher.on('error', (err: any) => {
        extLog('WARN', 'Keybinding file watcher error', { error: err?.message });
      });
    } catch (err: any) {
      extLog('WARN', 'Could not start watcher on keybindings directory', {
        dir: parentDir,
        error: err?.message,
      });
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
    }
    this.listeners.clear();
  }
}
