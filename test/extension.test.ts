import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stallVerdict as realStallVerdict } from '../src/stallWatch';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FakeEventEmitter,
  FakeTabInputWebview,
  installVscodeStub,
  resetVscodeFake,
  stubModule,
  vscodeFake,
  type FakeTab,
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
   *
   * `cwd` defaults to a directory that genuinely exists on disk (REAL_CWD):
   * resume() now stats it for real, via node:fs, so a test that expects a
   * resume to actually launch needs a real path, not a placeholder string.
   */
  limitFor(sessionId: string, resumeAt: Date, cwd: string = REAL_CWD, file?: string): void {
    this.hitEmitter.fire({
      detection: { resumeAt, text: 'Claude AI usage limit reached. Try again in 5 hours' },
      cwd,
      // `file` is overridable so a stall test can point at a real transcript
      // it controls: the stall check stats this path for growth.
      file: file ?? `/h/.claude/projects/p/${sessionId}.jsonl`,
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
// The real 60s grace would make every stall test take a minute. The verdict
// logic itself is the real one - only the wait is shortened.
stubModule('./stallWatch', { GRACE_MS: 300, stallVerdict: realStallVerdict });

/**
 * Which sessions a panel is holding open, for the duration of one test, and a
 * record of what the extension asked about. The real detector shells out to
 * `claude agents --json` and reads ~/.claude/sessions, so letting it run for
 * real here would make the suite depend on whichever Claude Code processes
 * happen to be running on the machine at the time - including this one.
 */
let livePanelSessions = new Set<string>();
const detectorCalls: { sessionId: string; ourPid: number | undefined }[] = [];

stubModule('./liveSessions', {
  livePanelDetector: () => (sessionId: string, ourPid: number | undefined) => {
    detectorCalls.push({ sessionId, ourPid });
    return livePanelSessions.has(sessionId);
  },
});

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
/** The pid the fake terminal reports, i.e. the resume this extension launched. */
const TERMINAL_PID = 4242;
const PROMPT = 'Continue where you left off.';

// resume() now checks the cwd on the real filesystem before launching, so
// fixtures that expect a launch need a directory that is actually there.
// os.tmpdir() always exists; the "missing" one is a path under it that is
// never created.
const REAL_CWD = os.tmpdir();
const MISSING_CWD = path.join(os.tmpdir(), 'clb-does-not-exist', SESSION);

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

const pastJob = (cwd: string = REAL_CWD) => {
  const resumeAtMs = Date.now() - 1000;
  return {
    sessionId: SESSION,
    transcript: `/h/p/${SESSION}.jsonl`,
    cwd,
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

const TRANSCRIPT = `/h/.claude/projects/p/${SESSION}.jsonl`;

test('an autoResume that lands on a deleted folder is refused, blames the right path, and keeps the job', async () => {
  resetVscodeFake();
  vscodeFake.config = {
    autoResume: true,
    claudeCommand: LAUNCHER,
    randomDelayMinMinutes: 0,
    randomDelayMaxMinutes: 0,
  };
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    watcher.limitFor(SESSION, new Date(Date.now() - 1000), MISSING_CWD);
    await oneTick();

    assert.equal(vscodeFake.terminals.length, 0, 'createTerminal must never be reached for a missing cwd');
    assert.ok(
      !vscodeFake.outputLines.some((l) => l.includes(`Resumed ${SESSION}`)),
      'nothing may claim the resume succeeded when it never launched',
    );
    assert.ok(
      vscodeFake.errors.some((m) => m.includes(MISSING_CWD) && m.includes(SESSION.slice(0, 8))),
      `no error named the missing folder and the session; saw ${JSON.stringify(vscodeFake.errors)}`,
    );
    assert.ok(
      vscodeFake.outputLines.some((l) => l.includes(MISSING_CWD) && l.includes(TRANSCRIPT)),
      'the log must name both the missing path and the transcript it came from',
    );

    // The job must have been kept, not dropped: it is reachable from Resume
    // Now instead of vanishing with the scheduler's own pre-fire cleanup.
    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow, 'resumeNow must be registered');
    resumeNow();
    assert.equal(
      vscodeFake.info.filter((m) => m.message.includes('nothing pending')).length,
      0,
      'a resume that never launched must not make the job disappear',
    );
    assert.equal(vscodeFake.errors.length, 2, 'the retry must fail the same way, not silently do nothing');
    assert.equal(vscodeFake.terminals.length, 0, 'still no terminal');
  } finally {
    teardown(ctx);
  }
});

test('an autoResume whose cwd is a file, not a directory, is refused rather than handed to createTerminal (#8)', async () => {
  // fs.existsSync (the old predicate) is true for a regular file, so this
  // used to reach vscode.window.createTerminal, which does not throw on a
  // bad cwd - it fails asynchronously, inside the terminal process, in
  // exactly the way this whole check exists to avoid (#4). statSync(...).
  // isDirectory() is the only check that actually distinguishes the two.
  resetVscodeFake();
  vscodeFake.config = {
    autoResume: true,
    claudeCommand: LAUNCHER,
    randomDelayMinMinutes: 0,
    randomDelayMaxMinutes: 0,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-file-cwd-'));
  const fileCwd = path.join(dir, 'not-a-directory');
  fs.writeFileSync(fileCwd, 'a regular file, not a project folder');
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    watcher.limitFor(SESSION, new Date(Date.now() - 1000), fileCwd);
    await oneTick();

    assert.equal(vscodeFake.terminals.length, 0, 'createTerminal must never be reached for a cwd that is a file');
    assert.ok(
      vscodeFake.errors.some((m) => m.includes(fileCwd) && m.includes(SESSION.slice(0, 8))),
      `no error named the file path and the session; saw ${JSON.stringify(vscodeFake.errors)}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    teardown(ctx);
  }
});

test('accepting a Resume Now offer into a deleted folder puts the job back rather than discarding it', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    watcher.limitFor(SESSION, new Date(Date.now() - 1000), MISSING_CWD);
    await oneTick();
    const offer = offers()[0];
    assert.ok(offer, 'the session must have offered a manual resume');

    offer.answer('Resume Now');
    await flush();

    assert.equal(vscodeFake.terminals.length, 0, 'a missing cwd must not launch a terminal');
    assert.ok(
      vscodeFake.errors.some((m) => m.includes(MISSING_CWD)),
      `no error named the missing folder; saw ${JSON.stringify(vscodeFake.errors)}`,
    );

    // Answering the offer claims the job by removing it from readyJobs before
    // resume() runs; since the launch never started, that claim must be
    // undone rather than left to quietly lose the job.
    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow, 'resumeNow must be registered');
    resumeNow();
    assert.equal(
      vscodeFake.info.filter((m) => m.message.includes('nothing pending')).length,
      0,
      'the offer failing must not have discarded the job it claimed',
    );
    assert.equal(vscodeFake.errors.length, 2, 'the retry must fail the same way, not silently do nothing');
  } finally {
    teardown(ctx);
  }
});

test('resumeNow does not cancel the counting-down job until a resume has actually launched', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    // Still counting down: resumeNow must reach it via scheduler.current, the
    // same branch that used to call scheduler.cancel() before knowing whether
    // resume() would even start.
    watcher.limitFor(SESSION, new Date(Date.now() + 600_000), MISSING_CWD);

    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow, 'resumeNow must be registered');

    resumeNow();
    assert.equal(vscodeFake.terminals.length, 0, 'a missing cwd must not launch a terminal');
    assert.equal(vscodeFake.errors.length, 1);

    // If cancel() had already run, the job would be gone and this second call
    // would report "nothing pending" instead of failing the same way again.
    resumeNow();
    assert.equal(vscodeFake.errors.length, 2, 'the job must still be there to fail on again');
    assert.equal(
      vscodeFake.info.filter((m) => m.message.includes('nothing pending')).length,
      0,
      'the counting-down job must not have been cancelled out from under a failed resume',
    );
    assert.equal(vscodeFake.terminals.length, 0);
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
  // REAL_CWD is what limitFor() defaults to. This test was written against a
  // '/projects/example' placeholder that issue #4 replaced, because resume()
  // now stats the cwd and needs one that genuinely exists.
  trustedCwds = new Set([REAL_CWD]);
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

test('a resume whose transcript never grows is reported as a stall, not left logged as a success', async () => {
  resetVscodeFake();
  vscodeFake.config = {
    autoResume: true,
    claudeCommand: LAUNCHER,
    randomDelayMinMinutes: 0,
    randomDelayMaxMinutes: 0,
  };
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    // The default transcript path does not exist, so it cannot grow - the same
    // shape as a resume that stopped at Claude's trust prompt and wrote nothing.
    watcher.limitFor(SESSION, new Date(Date.now() - 1000));
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 1, 'the resume must have launched for this test to mean anything');

    await new Promise((r) => setTimeout(r, 600));

    assert.ok(
      vscodeFake.warnings.some((m) => m.includes(SESSION.slice(0, 8))),
      `expected a stall warning naming the session; saw ${JSON.stringify(vscodeFake.warnings)}`,
    );
    assert.ok(
      vscodeFake.outputLines.some((l) => /did not|stall/i.test(l) && l.includes(SESSION)),
      `expected the stall to reach the log; saw ${JSON.stringify(vscodeFake.outputLines)}`,
    );
  } finally {
    teardown(ctx);
  }
});

test('a resume whose transcript grows is confirmed, and warns about nothing', async () => {
  resetVscodeFake();
  vscodeFake.config = {
    autoResume: true,
    claudeCommand: LAUNCHER,
    randomDelayMinMinutes: 0,
    randomDelayMaxMinutes: 0,
  };
  // The filename must be the session id: resolveSession validates it is
  // uuid-shaped before handing it to a CLI as an argv element.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-stall-'));
  const transcript = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(transcript, 'one line\n');
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    watcher.limitFor(SESSION, new Date(Date.now() - 1000), REAL_CWD, transcript);

    // Wait for the launch itself rather than a fixed delay: the grace
    // period starts when the terminal is created, so the growth has to
    // land inside it.
    const deadline = Date.now() + 4000;
    while (vscodeFake.terminals.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(vscodeFake.terminals.length, 1, 'the resume must have launched');

    // What a working resume does: append to the transcript it was resumed into.
    fs.appendFileSync(transcript, 'a turn the resumed session wrote\n');
    await new Promise((r) => setTimeout(r, 600));

    assert.deepEqual(vscodeFake.warnings, [], 'a resume that produced work must not be called a stall');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    teardown(ctx);
  }
});

test('two sessions that hit the same limit are both resumed', async () => {
  // The usage limit is account-wide, so this is the ordinary case, not an edge
  // one: every session working when it lands reports it within seconds.
  resetVscodeFake();
  vscodeFake.config = {
    autoResume: true,
    claudeCommand: LAUNCHER,
    randomDelayMinMinutes: 0,
    randomDelayMaxMinutes: 0,
  };
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    const reset = new Date(Date.now() - 1000);
    watcher.limitFor(SESSION, reset);
    watcher.limitFor(SESSION_B, reset);
    await oneTick();

    const resumed = vscodeFake.terminals.map(
      (t) => (t.options as { shellArgs: string[] }).shellArgs[1],
    );
    assert.deepEqual(
      [...resumed].sort(),
      [SESSION, SESSION_B].sort(),
      `both sessions must be resumed; got ${JSON.stringify(resumed)}`,
    );
  } finally {
    teardown(ctx);
  }
});

test('resumeNow on one counting-down session leaves the other one counting down', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    watcher.limitFor(SESSION, new Date(Date.now() + 600_000));
    watcher.limitFor(SESSION_B, new Date(Date.now() + 300_000));

    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow, 'resumeNow must be registered');

    resumeNow();
    assert.deepEqual(argsOf(0), ['--resume', SESSION_B, PROMPT], 'the soonest session goes first');

    resumeNow();
    assert.equal(vscodeFake.terminals.length, 2, 'the other session must still have been counting down');
    assert.deepEqual(argsOf(1), ['--resume', SESSION, PROMPT]);
  } finally {
    teardown(ctx);
  }
});

test('Resume Now from the palette into a deleted folder keeps a job that was waiting to be started by hand', async () => {
  // The fourth resume() call site. The other three - autoResume, the offer
  // button, and a job still counting down - already keep their job when the
  // launch fails. This one takes the job from the ready list, and nothing
  // pinned that it only lets go once a terminal has actually launched.
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const watcher = FakeWatcher.latest;
    assert.ok(watcher, 'activate must have constructed a watcher');

    watcher.limitFor(SESSION, new Date(Date.now() - 1000), MISSING_CWD);
    await oneTick();
    assert.ok(offers()[0], 'the job must be waiting to be started by hand');

    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow, 'resumeNow must be registered');

    resumeNow();
    assert.equal(vscodeFake.terminals.length, 0, 'a missing cwd must not launch a terminal');
    assert.equal(vscodeFake.errors.length, 1);

    resumeNow();
    assert.equal(vscodeFake.errors.length, 2, 'the job must still be there to fail on again');
    assert.equal(
      vscodeFake.info.filter((m) => m.message.includes('nothing pending')).length,
      0,
      'a failed launch from the palette must not have discarded the ready job',
    );
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// Issue #7: a resumed session whose panel tab is still open on its pre-resume
// state. Typing into that tab forks the transcript and abandons the resumed
// turn (docs/research/2026-09-20-panel-fork-experiment.md), so the tab has to
// be reopened - or the user warned - before that keystroke.
// ---------------------------------------------------------------------------

const REOPEN_COMMAND = 'claude-vscode.reopenClosedSession';

const claudeTab = (label = 'Claude Code'): FakeTab => ({
  input: new FakeTabInputWebview('mainThreadWebview-claudeVSCodePanel-1'),
  label,
});

const staleNotices = () => vscodeFake.info.filter((m) => m.message.includes('panel tab'));

/** Resume SESSION for real, so the extension records it as one of its own. */
async function resumeSession(): Promise<void> {
  const watcher = FakeWatcher.latest;
  assert.ok(watcher, 'activate must have constructed a watcher');
  watcher.limitFor(SESSION, new Date(Date.now() - 1000), REAL_CWD);
  await oneTick();
  assert.equal(vscodeFake.terminals.length, 1, 'setup: the session must have been resumed');
}

const staleSetup = (opts: { onStale?: string; tabs?: FakeTab[]; livePanel?: boolean } = {}) => {
  resetVscodeFake();
  vscodeFake.config = {
    claudeCommand: LAUNCHER,
    randomDelayMinMinutes: 0,
    randomDelayMaxMinutes: 0,
    ...(opts.onStale ? { onStale: opts.onStale } : {}),
  };
  vscodeFake.workspaceFolders = [{ uri: { fsPath: REAL_CWD } }];
  vscodeFake.tabs = opts.tabs ?? [claudeTab()];
  vscodeFake.commands.set(REOPEN_COMMAND, () => undefined);
  livePanelSessions = new Set(opts.livePanel === false ? [] : [SESSION]);
  detectorCalls.length = 0;
};

test('warns before the user can type into a resumed session stale panel tab', async () => {
  staleSetup();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    await resumeSession();
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    const notices = staleNotices();
    assert.equal(notices.length, 1, 'exactly one notice for the one stale tab');
    assert.match(notices[0]!.message, /before you type/i);
    assert.equal(notices[0]!.items[0], 'Reopen session tab');
    assert.equal(vscodeFake.closedTabs.length, 0, 'notify must not close anything unasked');
  } finally {
    teardown(ctx);
  }
});

test('says nothing when no panel holds the session', async () => {
  staleSetup({ livePanel: false });
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    await resumeSession();
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    assert.deepEqual(staleNotices(), []);
  } finally {
    teardown(ctx);
  }
});

test('says nothing for a session this extension did not resume', async () => {
  // onInputNeeded fires for every turn in every session on the machine. A
  // panel session nobody resumed has no stale tab to warn about.
  staleSetup();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    assert.deepEqual(staleNotices(), []);
    assert.deepEqual(detectorCalls, [], 'and it must not even go looking');
  } finally {
    teardown(ctx);
  }
});

test('excludes its own resume terminal when asking who else holds the session', async () => {
  // The resumed `claude` is itself a live interactive process on that
  // session. Counting it would make every resume warn about itself.
  staleSetup();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    await resumeSession();
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    assert.equal(detectorCalls.length, 1);
    assert.equal(detectorCalls[0]!.sessionId, SESSION);
    assert.equal(detectorCalls[0]!.ourPid, TERMINAL_PID);
  } finally {
    teardown(ctx);
  }
});

test('clicking the button closes the tab and reopens the session', async () => {
  staleSetup();
  const reopened: string[] = [];
  const ctx = contextOver(new Map());
  start(ctx);
  vscodeFake.commands.set(REOPEN_COMMAND, () => {
    reopened.push(REOPEN_COMMAND);
  });
  try {
    await resumeSession();
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    const notice = staleNotices()[0];
    assert.ok(notice);
    notice.answer('Reopen session tab');
    await flush();
    assert.equal(vscodeFake.closedTabs.length, 1, 'the stale tab must be closed');
    assert.deepEqual(reopened, [REOPEN_COMMAND]);
  } finally {
    teardown(ctx);
  }
});

test('onStale reopen closes and reopens the tab without asking', async () => {
  staleSetup({ onStale: 'reopen' });
  const reopened: string[] = [];
  vscodeFake.commands.set(REOPEN_COMMAND, () => {
    reopened.push(REOPEN_COMMAND);
  });
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    await resumeSession();
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    assert.equal(vscodeFake.closedTabs.length, 1);
    assert.deepEqual(reopened, [REOPEN_COMMAND]);
    const notice = staleNotices()[0];
    assert.ok(notice, 'and it still says what it did');
    assert.equal(notice.items.length, 0, 'with nothing left to press');
  } finally {
    teardown(ctx);
  }
});

test('warns without a button when the tab is not in this window', async () => {
  // vscode.window.tabGroups only sees this window. A panel tab in another one
  // cannot be closed from here, and that is the case most likely to be typed
  // into, so the warning still has to arrive.
  staleSetup({ tabs: [] });
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    await resumeSession();
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    const notices = staleNotices();
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.message, /before you type/i);
    assert.equal(notices[0]!.items.length, 0);
  } finally {
    teardown(ctx);
  }
});

test('does not act on a guess when several Claude tabs are open', async () => {
  // Nothing ties a tab to a session id - #7 - so with two candidates the
  // right one cannot be identified, and closing the wrong one would lose a
  // different conversation's tab.
  staleSetup({ onStale: 'reopen', tabs: [claudeTab('Claude Code'), claudeTab('Claude Code 2')] });
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    await resumeSession();
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    assert.equal(vscodeFake.closedTabs.length, 0, 'no tab may be closed on a guess');
    assert.match(staleNotices()[0]!.message, /before you type/i);
  } finally {
    teardown(ctx);
  }
});

test('the chime being off does not silence the warning', async () => {
  staleSetup();
  vscodeFake.config = { ...vscodeFake.config, alertSound: false };
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    await resumeSession();
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    assert.equal(staleNotices().length, 1);
  } finally {
    teardown(ctx);
  }
});

test('logs the webview tabs it saw when none of them is a Claude panel', async () => {
  // The viewType match is `includes('claudeVSCodePanel')` and was verified
  // against a synthetic webview, not the real panel (#7). If Claude Code ever
  // changes that string, the feature quietly degrades to a text-only warning -
  // so the tabs it looked at have to be visible somewhere, or diagnosing that
  // means guessing.
  staleSetup({ tabs: [{ input: new FakeTabInputWebview('mainThreadWebview-someOtherPanel'), label: 'Other' }] });
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    await resumeSession();
    FakeWatcher.latest?.endTurnIn(REAL_CWD);
    await flush();
    assert.ok(
      vscodeFake.outputLines.some((l) => l.includes('someOtherPanel')),
      `no log line named the tabs seen: ${JSON.stringify(vscodeFake.outputLines.slice(-3))}`,
    );
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// Issue #11: a job waiting for Resume Now must survive a window reload. This
// matters more since #7: reopening the window is the remedy recommended for a
// stale panel tab, so the advice would otherwise destroy the very job it is
// given alongside.
// ---------------------------------------------------------------------------

const READY_KEY = 'claudeLimitBuster.ready';

test('a job waiting for Resume Now survives a reload', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const store = new Map<string, unknown>([['claudeLimitBuster.pending', pastJob()]]);
  const first = contextOver(store);
  start(first);
  await oneTick();
  assert.ok(offers()[0], 'setup: the job must have been offered for manual resume');
  assert.equal(vscodeFake.terminals.length, 0, 'setup: autoResume is off');
  // A reload is exactly this: every subscription disposed, then activate again
  // over the same globalState.
  teardown(first);

  const second = contextOver(store);
  start(second);
  try {
    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow');
    assert.ok(resumeNow);
    resumeNow();
    await flush();
    assert.equal(
      vscodeFake.info.filter((m) => m.message.includes('nothing pending')).length,
      0,
      'the job was waiting before the reload and must still be there after it',
    );
    assert.equal(vscodeFake.terminals.length, 1, 'Resume Now must launch the restored job');
  } finally {
    teardown(second);
  }
});

test('a restored job carries the session it was scheduled for', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const store = new Map<string, unknown>([['claudeLimitBuster.pending', pastJob()]]);
  const first = contextOver(store);
  start(first);
  await oneTick();
  teardown(first);

  const second = contextOver(store);
  start(second);
  try {
    vscodeFake.commands.get('claudeLimitBuster.resumeNow')!();
    await flush();
    assert.ok(
      argsOf(0)?.includes(SESSION),
      `the restored resume must name the same session: ${JSON.stringify(argsOf(0))}`,
    );
  } finally {
    teardown(second);
  }
});

test('a job resumed by hand is not left behind for the next window', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const store = new Map<string, unknown>([['claudeLimitBuster.pending', pastJob()]]);
  const ctx = contextOver(store);
  start(ctx);
  try {
    await oneTick();
    vscodeFake.commands.get('claudeLimitBuster.resumeNow')!();
    await flush();
    assert.equal(vscodeFake.terminals.length, 1, 'setup: it must have resumed');
    assert.equal(store.get(READY_KEY), undefined, 'a claimed job must not be persisted');
  } finally {
    teardown(ctx);
  }
});

test('cancelling clears the waiting jobs from storage too', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const store = new Map<string, unknown>([['claudeLimitBuster.pending', pastJob()]]);
  const ctx = contextOver(store);
  start(ctx);
  try {
    await oneTick();
    assert.ok(store.get(READY_KEY), 'setup: the waiting job must have been persisted');
    vscodeFake.commands.get('claudeLimitBuster.cancel')!();
    await flush();
    assert.equal(store.get(READY_KEY), undefined, 'cancel must not leave it to come back on reload');
  } finally {
    teardown(ctx);
  }
});
