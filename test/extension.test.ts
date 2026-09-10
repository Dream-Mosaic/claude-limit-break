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

const SESSION = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const SESSION_B = '7f2a9c41-8b3d-4e5f-9a01-6c7d8e9f0a1b';

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

  /**
   * Pretend a usage limit was detected for `sessionId`, resetting at
   * `resumeAt`. This runs through the real policy and the real scheduler; the
   * transcript path does not exist, which resolveSession treats as an unknown
   * size, so the budget check passes.
   */
  limitFor(sessionId: string, resumeAt: Date): void {
    this.hitEmitter.fire({
      detection: { resumeAt, text: 'Claude AI usage limit reached. Try again in 5 hours' },
      cwd: '/projects/example',
      file: `/h/.claude/projects/p/${sessionId}.jsonl`,
    });
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

/**
 * Which folders count as trusted for the CLI, for the duration of one test.
 * 'all' is the default so that every existing test - none of which exercises
 * trust - sees the same behaviour it always has. A test that cares sets this
 * to a Set (only members are trusted) and restores 'all' in its `finally`.
 *
 * A stub, not the real module, for the same reason ./sound and
 * ./transcriptWatcher are stubbed: extension.ts would otherwise read the
 * *real* ~/.claude.json through the real fs.readFileSync it composes with
 * these functions, which must never happen from a test.
 */
let trustedCwds: Set<string> | 'all' = 'all';

stubModule('./transcriptWatcher', { TranscriptWatcher: FakeWatcher });
stubModule('./sound', { playAlertSound: (o: { file?: string } = {}) => sounds.push(o) });
stubModule('./trust', {
  isFolderTrusted: (cwd: string) => trustedCwds === 'all' || trustedCwds.has(cwd),
  readClaudeUserConfig: () => undefined,
  defaultClaudeConfigPath: () => '/fake/.claude.json',
});

// Required, not imported: the stubs above must be registered first, and a
// compiled `import` would hoist its require() above them.
const { activate, isInsideWorkspace } =
  require('../src/extension') as typeof import('../src/extension');

// A path with a separator and no .cmd/.bat/.ps1 extension resolves as-is on
// every platform, so the resume path never touches PATH or the filesystem.
const LAUNCHER = '/opt/claude/bin/claude';
const WORKSPACE = path.join(os.tmpdir(), 'clb-workspace');
const PROMPT = 'Continue where you left off.';

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

/** Long enough for the scheduler's one-second tick to see an elapsed deadline. */
const oneTick = () => new Promise((r) => setTimeout(r, 1400));
const flush = () => new Promise((r) => setTimeout(r, 0));

const offers = () => vscodeFake.info.filter((m) => m.items.includes('Resume Now'));
const argsOf = (index: number) =>
  (vscodeFake.terminals[index]?.options as { shellArgs: string[] } | undefined)?.shellArgs;

/** autoResume off, no jitter, and a launcher that needs no PATH lookup. */
const manualConfig = () => ({
  autoResume: false,
  claudeCommand: LAUNCHER,
  randomDelayMinMinutes: 0,
  randomDelayMaxMinutes: 0,
});

const pastJob = () => {
  const resumeAtMs = Date.now() - 1000;
  return {
    sessionId: SESSION,
    transcript: `/h/p/${SESSION}.jsonl`,
    cwd: '/projects/example',
    prompt: PROMPT,
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
    await oneTick();
    assert.equal(store.get('claudeLimitBuster.pending'), undefined, 'the scheduler must have consumed it');
    assert.equal(vscodeFake.terminals.length, 0, 'autoResume is off; nothing may launch on its own');

    const offer = offers()[0];
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
    assert.deepEqual(opts.shellArgs, ['--resume', SESSION, PROMPT]);

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

test('a notification resumes the session it names, not whichever came ready last', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    watcher.limitFor(SESSION, new Date(Date.now() - 1000));
    await oneTick();
    const first = offers()[0];
    assert.ok(first, 'the first session must have offered a manual resume');
    assert.ok(
      first.message.includes(SESSION.slice(0, 8)),
      `the offer must name its session; got "${first.message}"`,
    );

    // A second, unrelated session comes ready while the first offer is still
    // on screen and unanswered. It must not take the first one's place.
    watcher.limitFor(SESSION_B, new Date(Date.now() - 1000));
    await oneTick();
    assert.equal(offers().length, 2, 'both sessions must have been offered');
    assert.equal(vscodeFake.terminals.length, 0, 'neither may have launched on its own');

    // Accept the FIRST offer.
    first.answer('Resume Now');
    await flush();
    assert.equal(vscodeFake.terminals.length, 1, 'accepting one offer resumes one session');
    assert.deepEqual(
      argsOf(0),
      ['--resume', SESSION, PROMPT],
      'the first offer must resume the session it named, not the one that fired last',
    );

    // The second is untouched, and still reachable from the command.
    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow, 'resumeNow must be registered');
    resumeNow();
    assert.equal(vscodeFake.terminals.length, 2, 'the second session must still be recoverable');
    assert.deepEqual(argsOf(1), ['--resume', SESSION_B, PROMPT]);
  } finally {
    teardown(ctx);
  }
});

test('resumeNow takes the counting-down job first and keeps the ready one', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    // One job ready: elapsed, fired, and held for a manual resume.
    watcher.limitFor(SESSION, new Date(Date.now() - 1000));
    await oneTick();
    assert.equal(offers().length, 1, 'the first session must be waiting to be resumed by hand');

    // A second job still counting down.
    watcher.limitFor(SESSION_B, new Date(Date.now() + 600_000));

    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow, 'resumeNow must be registered');

    resumeNow();
    assert.equal(vscodeFake.terminals.length, 1);
    assert.deepEqual(
      argsOf(0),
      ['--resume', SESSION_B, PROMPT],
      'the job still counting down is the one "Resume Now" means',
    );

    // Resuming the scheduler's job must not have discarded the ready one.
    resumeNow();
    assert.equal(vscodeFake.terminals.length, 2, 'the ready job must survive the first resume');
    assert.deepEqual(argsOf(1), ['--resume', SESSION, PROMPT]);

    resumeNow();
    assert.equal(vscodeFake.terminals.length, 2, 'both sources are empty now');
    assert.ok(vscodeFake.info.some((m) => m.message.includes('nothing pending')));
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

test('a stale offer cannot resume a session the command already resumed', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    watcher.limitFor(SESSION, new Date(Date.now() - 1000));
    await oneTick();
    const offer = offers()[0];
    assert.ok(offer, 'the session must have offered a manual resume');

    // Resume it from the command palette, leaving the notification on screen.
    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow, 'resumeNow must be registered');
    resumeNow();
    assert.equal(vscodeFake.terminals.length, 1, 'the command resumes it once');
    assert.deepEqual(argsOf(0), ['--resume', SESSION, PROMPT]);

    // Now answer the offer that is still sitting there. The job is gone, so
    // this must not start a second Claude on the same session.
    offer.answer('Resume Now');
    await flush();
    assert.equal(
      vscodeFake.terminals.length,
      1,
      'a stale offer must not launch a second resume for a session already resumed',
    );
    assert.ok(
      vscodeFake.info.some((m) => m.message.includes('already resumed or cancelled')),
      'the stale click must say why nothing happened rather than doing nothing',
    );
  } finally {
    teardown(ctx);
  }
});

test('an untrusted folder is called out while the countdown is still running, not at fire time', () => {
  resetVscodeFake();
  vscodeFake.config = { autoResume: false, claudeCommand: LAUNCHER };
  trustedCwds = new Set(); // nothing is trusted
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    // A deadline well in the future: this is the schedule-time notice, fired
    // the moment the limit is detected, long before any cooldown elapses -
    // the user is still here to trust the folder, unlike at fire time (#5).
    watcher.limitFor(SESSION, new Date(Date.now() + 600_000));

    const notice = vscodeFake.info.find((m) => m.message.includes('resuming at'));
    assert.ok(notice, `expected a schedule notice; saw ${JSON.stringify(vscodeFake.info)}`);
    assert.match(
      notice.message,
      /not trusted/i,
      `the schedule notice must call out the untrusted folder; got "${notice.message}"`,
    );

    // The countdown pill's tooltip carries the same warning for as long as it
    // is ticking, not just in the one-shot notification.
    const bar = vscodeFake.statusBarItems[0];
    const tooltip = bar?.tooltip as { value: string } | undefined;
    assert.match(
      tooltip?.value ?? '',
      /not trusted/i,
      `expected the status bar tooltip to warn too; got ${JSON.stringify(tooltip?.value)}`,
    );

    assert.ok(
      vscodeFake.outputLines.some((l) => /not trusted/i.test(l)),
      'the untrusted folder must also reach the log, for when notify is off',
    );
  } finally {
    trustedCwds = 'all';
    teardown(ctx);
  }
});

test('a trusted folder gets the ordinary schedule notice, with no trust warning anywhere', () => {
  resetVscodeFake();
  vscodeFake.config = { autoResume: false, claudeCommand: LAUNCHER };
  trustedCwds = new Set(['/projects/example']);
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    watcher.limitFor(SESSION, new Date(Date.now() + 600_000));

    const notice = vscodeFake.info.find((m) => m.message.includes('resuming at'));
    assert.ok(notice, `expected a schedule notice; saw ${JSON.stringify(vscodeFake.info)}`);
    assert.doesNotMatch(notice.message, /not trusted/i);

    const bar = vscodeFake.statusBarItems[0];
    const tooltip = bar?.tooltip as { value: string } | undefined;
    assert.doesNotMatch(tooltip?.value ?? '', /not trusted/i);
  } finally {
    trustedCwds = 'all';
    teardown(ctx);
  }
});
