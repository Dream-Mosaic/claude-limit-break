import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FakeEventEmitter,
  installVscodeStub,
  resetVscodeFake,
  stubModule,
  vscodeFake,
} from './helpers/vscode';

installVscodeStub();

/**
 * Stands in for the real transcript watcher, which would otherwise walk
 * ~/.claude/projects and leave an fs.watch and a poll timer running for the
 * length of the suite. The extension only ever consumes its events, so a fake
 * that lets the test fire them by hand exercises the same handlers.
 */
class FakeWatcher {
  static latest: FakeWatcher | undefined;

  private readonly hitEmitter = new FakeEventEmitter<unknown>();
  private readonly overloadEmitter = new FakeEventEmitter<unknown>();
  private readonly inputEmitter = new FakeEventEmitter<{ cwd?: string; file: string }>();

  readonly onHit = this.hitEmitter.event;
  readonly onOverload = this.overloadEmitter.event;
  readonly onInputNeeded = this.inputEmitter.event;

  started = false;

  constructor(
    readonly getMaxWaitHours: () => number,
    readonly getPollSeconds: () => number,
    readonly log: unknown,
  ) {
    FakeWatcher.latest = this;
  }

  /** Pretend a Claude turn just ended in `cwd`. */
  endTurnIn(cwd: string | undefined): void {
    this.inputEmitter.fire({ cwd, file: `/h/p/${SESSION}.jsonl` });
  }

  async start(): Promise<void> {
    this.started = true;
  }

  dispose(): void {
    this.hitEmitter.dispose();
    this.overloadEmitter.dispose();
    this.inputEmitter.dispose();
  }
}

/** Records chimes instead of spawning a media player. */
const sounds: { file?: string }[] = [];

stubModule('./transcriptWatcher', { TranscriptWatcher: FakeWatcher });
stubModule('./sound', { playAlertSound: (o: { file?: string } = {}) => sounds.push(o) });

// Required, not imported: the stubs above must be registered first, and a
// compiled `import` would hoist its require() above them.
const { activate, isInsideWorkspace } =
  require('../src/extension') as typeof import('../src/extension');

const SESSION = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
// A path with a separator and no .cmd/.bat/.ps1 extension resolves as-is on
// every platform, so the resume path never touches PATH or the filesystem.
const LAUNCHER = '/opt/claude/bin/claude';
const WORKSPACE = path.join(os.tmpdir(), 'clb-workspace');

interface FakeContext {
  subscriptions: { dispose(): void }[];
  globalState: {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
  };
}

function contextOver(store: Map<string, unknown>): FakeContext {
  return {
    subscriptions: [],
    globalState: {
      get: <T>(k: string) => store.get(k) as T | undefined,
      update: (k, v) => {
        store.set(k, v);
        return Promise.resolve();
      },
    },
  };
}

const start = (ctx: FakeContext) =>
  activate(ctx as unknown as Parameters<typeof activate>[0]);

const teardown = (ctx: FakeContext) => {
  for (const d of ctx.subscriptions) {
    d.dispose();
  }
};

const pastJob = () => {
  const resumeAtMs = Date.now() - 1000;
  return {
    sessionId: SESSION,
    transcript: `/h/p/${SESSION}.jsonl`,
    cwd: '/projects/example',
    prompt: 'Continue where you left off.',
    resumeAtMs,
    baseResumeAtMs: resumeAtMs,
    jitterMs: 0,
    reason: 'limit' as const,
  };
};

test('with autoResume off, a fired job stays recoverable instead of vanishing', async () => {
  resetVscodeFake();
  vscodeFake.config = { autoResume: false, claudeCommand: LAUNCHER };
  const store = new Map<string, unknown>([['claudeLimitBuster.pending', pastJob()]]);
  const ctx = contextOver(store);
  start(ctx);
  try {
    // The scheduler's first tick sees an elapsed deadline and consumes it,
    // clearing its own state before firing. That ordering is deliberate, so
    // the job only survives if extension.ts holds on to it.
    await new Promise((r) => setTimeout(r, 1400));
    assert.equal(store.get('claudeLimitBuster.pending'), undefined, 'the scheduler must have consumed it');
    assert.equal(vscodeFake.terminals.length, 0, 'autoResume is off; nothing may launch on its own');

    const offer = vscodeFake.info.find((m) => m.items.includes('Resume Now'));
    assert.ok(offer, `no Resume Now offer was made; saw ${JSON.stringify(vscodeFake.info)}`);

    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow, 'resumeNow must be registered');
    resumeNow();

    assert.equal(
      vscodeFake.info.filter((m) => m.message.includes('nothing pending')).length,
      0,
      'the job the scheduler dropped must not be reported as gone',
    );
    assert.equal(vscodeFake.terminals.length, 1, 'resumeNow must have resumed it');
    const opts = vscodeFake.terminals[0]?.options as { shellPath: string; shellArgs: string[] };
    assert.equal(opts.shellPath, LAUNCHER, 'never a shell');
    assert.deepEqual(opts.shellArgs, ['--resume', SESSION, 'Continue where you left off.']);

    // And it is consumed exactly once.
    resumeNow();
    assert.equal(vscodeFake.terminals.length, 1, 'a consumed job must not resume twice');
    assert.ok(
      vscodeFake.info.some((m) => m.message.includes('nothing pending')),
      'the second call has nothing left to resume',
    );
  } finally {
    teardown(ctx);
  }
});

test('the chime fires only for a turn in this window, and only while enabled', () => {
  resetVscodeFake();
  sounds.length = 0;
  vscodeFake.config = { autoResume: false };
  vscodeFake.workspaceFolders = [{ uri: { fsPath: WORKSPACE } }];
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    // Control: without this the rest could pass by never chiming at all.
    watcher.endTurnIn(path.join(WORKSPACE, 'src'));
    assert.equal(sounds.length, 1, 'a turn in this workspace must chime');

    // The watcher is global, so most turns it reports belong to other projects.
    watcher.endTurnIn(path.join(os.tmpdir(), 'clb-elsewhere'));
    assert.equal(sounds.length, 1, 'a turn in another project must not chime');

    // A separator boundary, not a bare startsWith.
    watcher.endTurnIn(`${WORKSPACE}-old`);
    assert.equal(sounds.length, 1, 'a sibling folder sharing a prefix must not chime');

    watcher.endTurnIn(undefined);
    assert.equal(sounds.length, 1, 'an entry with no cwd cannot be placed, so it must not chime');

    vscodeFake.config = { autoResume: false, enabled: false };
    watcher.endTurnIn(path.join(WORKSPACE, 'src'));
    assert.equal(sounds.length, 1, 'enabled:false must silence the chime');

    vscodeFake.config = { autoResume: false, alertSound: false };
    watcher.endTurnIn(path.join(WORKSPACE, 'src'));
    assert.equal(sounds.length, 1, 'alertSound:false must silence the chime');
  } finally {
    teardown(ctx);
  }
});

test('workspace containment is a bounded, case-insensitive path comparison', () => {
  const root = path.join(os.tmpdir(), 'clb-ws');
  assert.equal(isInsideWorkspace(root, [root]), true, 'the folder itself is inside it');
  assert.equal(isInsideWorkspace(path.join(root, 'a', 'b'), [root]), true, 'a descendant is inside');
  assert.equal(isInsideWorkspace(root.toUpperCase(), [root]), true, 'casing must not decide it');
  assert.equal(isInsideWorkspace(`${root}-old`, [root]), false, 'a shared prefix is not containment');
  assert.equal(isInsideWorkspace(path.join(os.tmpdir(), 'other'), [root]), false, 'elsewhere is outside');
  assert.equal(isInsideWorkspace(undefined, [root]), false, 'an unknown cwd is not inside anything');
  assert.equal(isInsideWorkspace(root, []), false, 'a window with no folders owns nothing');
});
