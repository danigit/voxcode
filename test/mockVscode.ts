// Mock vscode module for standalone node:test suite

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}

  public compareTo(other: Position): number {
    if (this.line < other.line) {
      return -1;
    }
    if (this.line > other.line) {
      return 1;
    }
    if (this.character < other.character) {
      return -1;
    }
    if (this.character > other.character) {
      return 1;
    }
    return 0;
  }

  public isBefore(other: Position): boolean {
    return this.compareTo(other) < 0;
  }

  public isAfter(other: Position): boolean {
    return this.compareTo(other) > 0;
  }

  public isEqual(other: Position): boolean {
    return this.compareTo(other) === 0;
  }
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(
    a: Position | number,
    b: Position | number,
    c?: number,
    d?: number
  ) {
    if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number' && typeof d === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a as Position;
      this.end = b as Position;
    }
  }

  public get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
}

export class Selection extends Range {
  public readonly anchor: Position;
  public readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorChar: number, activeLine: number, activeChar: number);
  constructor(
    a: Position | number,
    b: Position | number,
    c?: number,
    d?: number
  ) {
    if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number' && typeof d === 'number') {
      super(a, b, c, d);
      this.anchor = new Position(a, b);
      this.active = new Position(c, d);
    } else {
      const anchor = a as Position;
      const active = b as Position;
      if (anchor.isBefore(active)) {
        super(anchor, active);
      } else {
        super(active, anchor);
      }
      this.anchor = anchor;
      this.active = active;
    }
  }

  public get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

export class Uri {
  constructor(public readonly fsPath: string) {}

  public static file(pathStr: string): Uri {
    return new Uri(pathStr);
  }

  public static parse(str: string): Uri {
    return new Uri(str);
  }

  public toString(): string {
    return this.fsPath;
  }
}

export class Disposable {
  constructor(private callOnDispose: () => any) {}

  public dispose(): void {
    if (this.callOnDispose) {
      this.callOnDispose();
    }
  }

  public static from(...disposables: { dispose(): any }[]): Disposable {
    return new Disposable(() => {
      disposables.forEach((d) => d.dispose());
    });
  }
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export enum DecorationRangeBehavior {
  OpenOpen = 0,
  ClosedClosed = 1,
  OpenClosed = 2,
  ClosedOpen = 3,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class WorkspaceEdit {
  public operations: { type: 'insert' | 'replace' | 'delete'; uri: Uri; posOrRange: any; text?: string }[] = [];

  public insert(uri: Uri, position: Position, newText: string): void {
    this.operations.push({ type: 'insert', uri, posOrRange: position, text: newText });
  }

  public replace(uri: Uri, range: Range | Selection, newText: string): void {
    this.operations.push({ type: 'replace', uri, posOrRange: range, text: newText });
  }

  public delete(uri: Uri, range: Range): void {
    this.operations.push({ type: 'delete', uri, posOrRange: range });
  }
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export const mockWindow = {
  activeTextEditor: null as any,
  visibleTextEditors: [] as any[],
  activeTerminal: null as any,
  terminals: [] as any[],
  state: { focused: true },

  onDidChangeActiveTextEditor(cb: any): Disposable {
    return new Disposable(() => {});
  },
  onDidChangeTextEditorSelection(cb: any): Disposable {
    return new Disposable(() => {});
  },
  onDidChangeVisibleTextEditors(cb: any): Disposable {
    return new Disposable(() => {});
  },
  onDidChangeActiveTerminal(cb: any): Disposable {
    return new Disposable(() => {});
  },
  onDidChangeTerminalState(cb: any): Disposable {
    return new Disposable(() => {});
  },
  createStatusBarItem(): any {
    return {
      text: '',
      tooltip: '',
      command: '',
      backgroundColor: undefined,
      show() {},
      dispose() {},
    };
  },
  createOutputChannel(name: string, options?: any): any {
    return {
      name,
      append(value: string) {},
      appendLine(value: string) {},
      clear() {},
      show() {},
      hide() {},
      info() {},
      warn() {},
      error() {},
      debug() {},
      trace() {},
      dispose() {},
    };
  },
  createTextEditorDecorationType(): any {
    return {
      dispose() {},
    };
  },
  withProgress: async <T>(options: any, task: (progress: any) => Promise<T>): Promise<T> => {
    return task({ report: () => {} });
  },
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
};

export const window = mockWindow;

export const mockWorkspace = {
  name: 'test-workspace',
  isTrusted: true,
  getConfiguration(section?: string) {
    return {
      get(key: string, defaultVal: any) {
        return defaultVal;
      },
      update: async () => {},
    };
  },
  async openTextDocument(uri: Uri) {
    return {
      uri,
      fileName: uri.fsPath,
      languageId: 'typescript',
      isClosed: false,
      lineAt(line: number) {
        return { text: '' };
      },
    };
  },
  async applyEdit(wsEdit: WorkspaceEdit) {
    return true;
  },
  onDidChangeConfiguration(cb: any): Disposable {
    return new Disposable(() => {});
  },
};

export const workspace = mockWorkspace;

export const mockCommands = {
  registerCommand(id: string, cb: any): Disposable {
    return new Disposable(() => {});
  },
  async executeCommand(id: string, ...args: any[]): Promise<any> {
    return undefined;
  },
};

export const commands = mockCommands;

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
