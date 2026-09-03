import Module from 'node:module';

export class FakeEventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    } };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      l(e);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

// ---------------------------------------------------------------------------
// Recording fakes for the slice of the VS Code API that activate() touches.
//
// Everything below is additive: EventEmitter above is unchanged, and the tests
// that only need it are unaffected by any of it.
// ---------------------------------------------------------------------------

export interface FakeTerminal {
  options: unknown;
  shown: number;
  show(): void;
  dispose(): void;
}

export interface FakeStatusBarItem {
  alignment: number;
  priority: number;
  command?: string;
  name?: string;
  text: string;
  tooltip?: unknown;
  backgroundColor?: unknown;
  visible: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}

class FakeMarkdownString {
  value: string;
  constructor(value?: string, readonly supportThemeIcons?: boolean) {
    this.value = value ?? '';
  }
  appendMarkdown(text: string): FakeMarkdownString {
    this.value += text;
    return this;
  }
}

class FakeThemeColor {
  constructor(readonly id: string) {}
}

/**
 * The mutable state behind the fake `vscode` module: what the extension reads,
 * and what it did. Set the inputs before calling `activate`, assert on the
 * recordings afterwards, and call {@link resetVscodeFake} between tests.
 */
export const vscodeFake = {
  /** Values readSettings() sees. Keys are unprefixed, e.g. `autoResume`. */
  config: {} as Record<string, unknown>,
  /** What `vscode.workspace.workspaceFolders` returns. */
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  outputLines: [] as string[],
  info: [] as { message: string; items: string[] }[],
  warnings: [] as string[],
  errors: [] as string[],
  terminals: [] as FakeTerminal[],
  statusBarItems: [] as FakeStatusBarItem[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  /** Chooses an offered item, so a notification's action can be exercised. */
  answerInfo: undefined as
    | ((message: string, items: string[]) => string | undefined)
    | undefined,
};

export function resetVscodeFake(): void {
  vscodeFake.config = {};
  vscodeFake.workspaceFolders = undefined;
  vscodeFake.outputLines = [];
  vscodeFake.info = [];
  vscodeFake.warnings = [];
  vscodeFake.errors = [];
  vscodeFake.terminals = [];
  vscodeFake.statusBarItems = [];
  vscodeFake.commands = new Map();
  vscodeFake.answerInfo = undefined;
}

const fakeVscode = {
  EventEmitter: FakeEventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: FakeThemeColor,
  MarkdownString: FakeMarkdownString,
  window: {
    createOutputChannel: (_name: string) => ({
      appendLine: (line: string) => vscodeFake.outputLines.push(line),
      show: () => {},
      dispose: () => {},
    }),
    createStatusBarItem: (alignment: number, priority: number): FakeStatusBarItem => {
      const item: FakeStatusBarItem = {
        alignment,
        priority,
        text: '',
        visible: false,
        show() {
          this.visible = true;
        },
        hide() {
          this.visible = false;
        },
        dispose() {},
      };
      vscodeFake.statusBarItems.push(item);
      return item;
    },
    createTerminal: (options: unknown): FakeTerminal => {
      const terminal: FakeTerminal = {
        options,
        shown: 0,
        show() {
          this.shown += 1;
        },
        dispose() {},
      };
      vscodeFake.terminals.push(terminal);
      return terminal;
    },
    showInformationMessage: (message: string, ...items: string[]) => {
      vscodeFake.info.push({ message, items });
      return Promise.resolve(vscodeFake.answerInfo?.(message, items));
    },
    showWarningMessage: (message: string) => {
      vscodeFake.warnings.push(message);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (message: string) => {
      vscodeFake.errors.push(message);
      return Promise.resolve(undefined);
    },
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      vscodeFake.commands.set(id, handler);
      return { dispose: () => vscodeFake.commands.delete(id) };
    },
    executeCommand: (id: string, ...args: unknown[]) => {
      const handler = vscodeFake.commands.get(id);
      return handler
        ? Promise.resolve(handler(...args))
        : Promise.reject(new Error(`no such command: ${id}`));
    },
  },
  workspace: {
    getConfiguration: (_section: string) => ({
      get: <T>(key: string, fallback: T): T =>
        key in vscodeFake.config ? (vscodeFake.config[key] as T) : fallback,
    }),
    get workspaceFolders() {
      return vscodeFake.workspaceFolders;
    },
  },
};

/** Extra modules to intercept, keyed by the exact string passed to require(). */
const extraModules = new Map<string, unknown>();

/**
 * Intercepts `require('vscode')` so extension modules load under plain Node.
 * Call once, at the top of any test file that imports a module touching the
 * VS Code API. Idempotent.
 */
export function installVscodeStub(): void {
  const mod = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
    __stubbed?: boolean;
  };
  if (mod.__stubbed) {
    return;
  }
  const original = mod._load;
  mod._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return fakeVscode;
    }
    if (extraModules.has(request)) {
      return extraModules.get(request);
    }
    return original.call(this, request, parent, isMain);
  };
  mod.__stubbed = true;
}

/**
 * Intercept one more module, by the *exact* string its importer passes to
 * `require`. Register before the importing module is loaded — which for a
 * compiled `import` means before the `require()` that pulls it in, so the
 * importer has to be `require`d rather than imported.
 *
 * Used to keep `activate()` off the real filesystem and off the real audio
 * player: `./transcriptWatcher` becomes a fake whose events the test fires by
 * hand, and `./sound` becomes a recorder. Both strings are unique to
 * `src/extension.ts`, so nothing else is affected.
 */
export function stubModule(request: string, exports: unknown): void {
  installVscodeStub();
  extraModules.set(request, exports);
}
