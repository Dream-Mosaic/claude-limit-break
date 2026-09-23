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
  /** VS Code resolves the shell's pid asynchronously; so does this. */
  processId: Promise<number | undefined>;
  show(): void;
  dispose(): void;
}

/**
 * One recorded information message. `answer` settles the promise the extension
 * is awaiting, so a test can leave an offer open - firing other events while it
 * hangs - and accept it later, which is the only way to reproduce a second
 * session coming ready before the first notification is clicked.
 */
export interface FakeInfoMessage {
  message: string;
  items: string[];
  answer(item?: string): void;
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
 * Stands in for `vscode.TabInputWebview`. Real code tells a webview tab
 * apart from any other kind of tab with `instanceof`, so the fake has to be
 * a real class the extension's `instanceof` check can see - a plain
 * `{viewType}` object would silently fail that check and every reopen-offer
 * test would see zero webview tabs no matter what was set up.
 */
export class FakeTabInputWebview {
  constructor(public viewType: string) {}
}

export interface FakeTab {
  input: unknown;
  label: string;
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
  info: [] as FakeInfoMessage[],
  warnings: [] as string[],
  /** Warnings that carried action buttons, answerable like info messages. */
  warningOffers: [] as FakeInfoMessage[],
  errors: [] as string[],
  terminals: [] as FakeTerminal[],
  /** What a created terminal reports as its process id. */
  terminalPid: 4242 as number | undefined,
  statusBarItems: [] as FakeStatusBarItem[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  /** What `vscode.window.tabGroups.all` reports, flattened to one group. */
  tabs: [] as FakeTab[],
  /** Quick picks shown, in call order, and the label the next one answers with. */
  /** Settings the extension wrote back, by key. */
  configUpdates: new Map<string, unknown>(),
  /** URLs handed to env.openExternal. */
  openedExternal: [] as string[],
  quickPicks: [] as { items: { label: string }[] }[],
  quickPickAnswer: undefined as string | undefined,
  /** How many times the output channel was shown. */
  shownChannels: 0,
  /** Tabs `tabGroups.close` has removed, in call order, for assertions. */
  closedTabs: [] as FakeTab[],
};

export function resetVscodeFake(): void {
  vscodeFake.config = {};
  vscodeFake.workspaceFolders = undefined;
  vscodeFake.outputLines = [];
  vscodeFake.info = [];
  vscodeFake.warnings = [];
  vscodeFake.warningOffers = [];
  vscodeFake.errors = [];
  vscodeFake.terminals = [];
  vscodeFake.terminalPid = 4242;
  vscodeFake.statusBarItems = [];
  vscodeFake.commands = new Map();
  vscodeFake.configUpdates = new Map();
  vscodeFake.openedExternal = [];
  vscodeFake.quickPicks = [];
  vscodeFake.quickPickAnswer = undefined;
  vscodeFake.shownChannels = 0;
  vscodeFake.tabs = [];
  vscodeFake.closedTabs = [];
}

const fakeVscode = {
  EventEmitter: FakeEventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ThemeColor: FakeThemeColor,
  MarkdownString: FakeMarkdownString,
  TabInputWebview: FakeTabInputWebview,
  env: {
    openExternal: (uri: unknown) => {
      vscodeFake.openedExternal.push(String((uri as { value?: string }).value ?? uri));
      return Promise.resolve(true);
    },
  },
  Uri: { parse: (value: string) => ({ value }) },
  window: {
    tabGroups: {
      get all() {
        // One flattened group: nothing here cares which editor group a tab
        // lives in, only whether it exists at all.
        return [{ tabs: vscodeFake.tabs }];
      },
      close: (tab: FakeTab) => {
        vscodeFake.tabs = vscodeFake.tabs.filter((t) => t !== tab);
        vscodeFake.closedTabs.push(tab);
        return Promise.resolve(true);
      },
    },
    createOutputChannel: (_name: string) => ({
      appendLine: (line: string) => vscodeFake.outputLines.push(line),
      show: () => {
        vscodeFake.shownChannels += 1;
      },
      dispose: () => {},
    }),
    // Answers with whatever a test parked in quickPickAnswer, matched back to
    // the item the extension offered - so a test names a label rather than an
    // index, and reordering the menu cannot silently change what it picks.
    showQuickPick: (items: { label: string }[]) => {
      vscodeFake.quickPicks.push({ items });
      const picked = items.find((i) => i.label === vscodeFake.quickPickAnswer);
      return Promise.resolve(picked);
    },
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
        processId: Promise.resolve(vscodeFake.terminalPid),
        show() {
          this.shown += 1;
        },
        dispose() {},
      };
      vscodeFake.terminals.push(terminal);
      return terminal;
    },
    showInformationMessage: (message: string, ...items: string[]) => {
      let settle: (item: string | undefined) => void = () => {};
      const answered = new Promise<string | undefined>((r) => {
        settle = r;
      });
      vscodeFake.info.push({ message, items, answer: (item?: string) => settle(item) });
      return answered;
    },
    // Mirrors showInformationMessage: a warning can carry action buttons
    // too, and the budget refusal offers one. `warnings` stays a string
    // array so the tests that only read messages keep working.
    showWarningMessage: (message: string, ...items: string[]) => {
      vscodeFake.warnings.push(message);
      let settle: (item: string | undefined) => void = () => {};
      const answered = new Promise<string | undefined>((r) => {
        settle = r;
      });
      vscodeFake.warningOffers.push({ message, items, answer: (item?: string) => settle(item) });
      return answered;
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
    // Real getCommands() lists thousands of built-ins; the fake only ever
    // needs to answer "is this specific id known", so it reports whatever a
    // test registered or set directly on vscodeFake.commands.
    getCommands: (_filterInternal?: boolean) => Promise.resolve([...vscodeFake.commands.keys()]),
  },
  workspace: {
    getConfiguration: (_section: string) => ({
      get: <T>(key: string, fallback: T): T =>
        key in vscodeFake.config ? (vscodeFake.config[key] as T) : fallback,
      // Recorded rather than applied: a test asserts what the extension tried
      // to write, and the value it reads back stays whatever the test set.
      update: (key: string, value: unknown) => {
        vscodeFake.configUpdates.set(key, value);
        return Promise.resolve();
      },
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
