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
import type { AgentRow, HolderRecord } from '../src/liveSessions';

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
    /** What the real watcher filters on (#2). Recorded so a test can read it back. */
    readonly getScope?: () => { mode: string; folders: readonly string[] },
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

/** What the fake GitHub call returns, and what it was asked for. */
let latestReleaseTag: string | undefined;
const fetchCalls: string[] = [];

stubModule('./updateCheck', {
  ...(require('../src/updateCheck') as Record<string, unknown>),
  fetchLatestReleaseTag: (url?: string) => {
    fetchCalls.push(url ?? 'default');
    return Promise.resolve(latestReleaseTag);
  },
});

/**
 * What `claude agents --json` reports for the duration of one test, consumed
 * by `agentRowsDetector`'s fake below - Task 2's onFire holder check and its
 * busy-folder-peers coordination check, and a manual resume's live-holder
 * check, all read this. Default: no other processes, so every existing test
 * that never sets this (nearly all of them) sees the same "nobody else is
 * running" world it always has - classifyHolder/busyFolderPeers on an empty
 * list is 'none' / no peers either way.
 */
let fakeAgentRows: AgentRow[] | 'unknown' = [];

/**
 * What `readSessionRecord` reports for a pid, for the duration of one test -
 * the entrypoint/bridge label half of classifyHolder's liveness/label split
 * (see liveSessions.ts). Keyed by pid. classifyHolder only ever asks for a
 * pid `fakeAgentRows` already vouched for as live, so an unset pid (the
 * default) correctly reads as "no record", same as a real machine with no
 * file for that pid.
 */
const sessionRecordFor = new Map<number, HolderRecord>();

stubModule('./liveSessions', {
  ...(require('../src/liveSessions') as Record<string, unknown>),
  livePanelDetector: () => (sessionId: string, ourPid: number | undefined) => {
    detectorCalls.push({ sessionId, ourPid });
    return livePanelSessions.has(sessionId);
  },
  agentRowsDetector: () => () => fakeAgentRows,
});

stubModule('./sessionRegistry', {
  ...(require('../src/sessionRegistry') as Record<string, unknown>),
  readSessionRecord: (_dir: string, pid: number) => sessionRecordFor.get(pid),
});

/** Whether Claude Code's own auto-continue is on, for the duration of one test. Default true, matching the real default (see autoContinue.ts). */
let autoContinueOn = true;

stubModule('./autoContinue', {
  autoContinueEnabled: () => autoContinueOn,
});

/**
 * Where the fake trust module says the CLI's config lives, and how many times
 * it has actually been read. A test that cares about the mtime cache points
 * this at a real temp file: the re-check is skipped on an unchanged mtime, and
 * the only way to see that skip is to count the reads.
 */
let trustConfigPath = '/fake/.claude.json';
/** Which spelling the fake trust module reports as the one on record, per cwd. */
const trustedSpellingFor = new Map<string, string>();
const trustReads = { count: 0 };

stubModule('./trust', {
  // Spread first so the real (pure) normalizeProjectPath is available too -
  // liveSessions.ts's busyFolderPeers imports it from this same './trust'
  // specifier, and a fully-replaced stub would leave it undefined. Every
  // property below is still faked exactly as before, since object spread
  // order means these overrides win.
  ...(require('../src/trust') as Record<string, unknown>),
  isFolderTrusted: (cwd: string) => trustedCwds === 'all' || trustedCwds.has(cwd),
  readClaudeUserConfig: () => {
    trustReads.count += 1;
    return undefined;
  },
  defaultClaudeConfigPath: () => trustConfigPath,
  trustedSpelling: (cwd: string) => trustedSpellingFor.get(cwd),
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

/** A job whose deadline has not arrived, so it stays pending. */
const futureJob = () => ({ ...pastJob(), resumeAtMs: Date.now() + 3_600_000, baseResumeAtMs: Date.now() + 3_600_000 });

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
    await resumeNow();

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
    await resumeNow();
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
    await resumeNow();
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

    await resumeNow();
    assert.equal(vscodeFake.terminals.length, 1);
    assert.deepEqual(
      argsOf(0),
      ['--resume', SESSION_B, PROMPT],
      'the job still counting down is the one "Resume Now" means',
    );

    // Resuming the scheduler's job must not have discarded the ready one.
    await resumeNow();
    assert.equal(vscodeFake.terminals.length, 2, 'the ready job must survive the first resume');
    assert.deepEqual(argsOf(1), ['--resume', SESSION, PROMPT]);

    await resumeNow();
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
    await resumeNow();
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
    await resumeNow();
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
    await resumeNow();
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

    await resumeNow();
    assert.equal(vscodeFake.terminals.length, 0, 'a missing cwd must not launch a terminal');
    assert.equal(vscodeFake.errors.length, 1);

    // If cancel() had already run, the job would be gone and this second call
    // would report "nothing pending" instead of failing the same way again.
    await resumeNow();
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

    await resumeNow();
    assert.deepEqual(argsOf(0), ['--resume', SESSION_B, PROMPT], 'the soonest session goes first');

    await resumeNow();
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

    await resumeNow();
    assert.equal(vscodeFake.terminals.length, 0, 'a missing cwd must not launch a terminal');
    assert.equal(vscodeFake.errors.length, 1);

    await resumeNow();
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
    await resumeNow();
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

test('the status bar menu offers the three commands and runs the one picked', async () => {
  // Issue #3: the click used to be a bare destructive action.
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const menu = vscodeFake.commands.get('claudeLimitBuster.statusBarMenu');
    assert.ok(menu, 'the menu command must be registered');
    vscodeFake.quickPickAnswer = 'Show Log';
    await menu();
    const offered = vscodeFake.quickPicks[0];
    assert.ok(offered, 'a quick pick must have been shown');
    assert.deepEqual(
      offered.items.map((i) => i.label).sort(),
      ['Cancel Pending Resume', 'Resume Now', 'Show Log'],
    );
    assert.equal(vscodeFake.shownChannels, 1, 'picking Show Log must open the log');
  } finally {
    teardown(ctx);
  }
});

test('the menu can cancel, and only when that is what was picked', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const store = new Map<string, unknown>([['claudeLimitBuster.pending', futureJob()]]);
  const ctx = contextOver(store);
  start(ctx);
  try {
    const menu = vscodeFake.commands.get('claudeLimitBuster.statusBarMenu')!;
    vscodeFake.quickPickAnswer = undefined; // dismissed with Escape
    await menu();
    assert.ok(store.get('claudeLimitBuster.pending'), 'dismissing must not cancel anything');
    vscodeFake.quickPickAnswer = 'Cancel Pending Resume';
    await menu();
    assert.equal(store.get('claudeLimitBuster.pending'), undefined, 'picking cancel must cancel');
  } finally {
    teardown(ctx);
  }
});

test('the trust warning clears once the folder is trusted mid-countdown', async () => {
  // Issue #8, finding 2: folderTrusted is computed once at schedule time and
  // rendered for the life of the countdown. The warning exists to make the
  // user trust the folder DURING the countdown - so the one state change the
  // feature is designed to cause was the one it could not see.
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, autoResume: false, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  trustedCwds = new Set<string>();
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    FakeWatcher.latest?.limitFor(SESSION, new Date(Date.now() + 3_600_000));
    await flush();
    const tooltip = () => (vscodeFake.statusBarItems[0]?.tooltip as { value: string } | undefined)?.value ?? '';
    assert.match(tooltip(), /not trusted/i, 'setup: it must warn while the folder is untrusted');

    trustedCwds = 'all';
    await oneTick();
    assert.ok(!/not trusted/i.test(tooltip()), `the warning must clear: ${tooltip()}`);
  } finally {
    trustedCwds = 'all';
    teardown(ctx);
  }
});

test('resumeMode headless actually launches headless', async () => {
  // The setting has been declared since 0.1.0 while extension.ts logged
  // "not yet implemented" and resumed interactively anyway. A setting that
  // quietly does something other than what it says is worse than one that
  // does not exist.
  resetVscodeFake();
  vscodeFake.config = {
    claudeCommand: LAUNCHER,
    resumeMode: 'headless',
    headlessPermissionMode: 'acceptEdits',
    randomDelayMinMinutes: 0,
    randomDelayMaxMinutes: 0,
  };
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    const args = argsOf(0);
    assert.ok(args, 'a terminal must have launched');
    assert.ok(args.includes('-p'), `headless must pass -p: ${JSON.stringify(args)}`);
    assert.deepEqual(
      [args[args.indexOf('--output-format') + 1], args[args.indexOf('--permission-mode') + 1]],
      ['json', 'acceptEdits'],
    );
    assert.ok(
      !vscodeFake.outputLines.some((l) => l.includes('not yet implemented')),
      'and it must stop claiming it is unimplemented',
    );
  } finally {
    teardown(ctx);
  }
});

test('the default resume stays interactive', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    const args = argsOf(0);
    assert.ok(args);
    assert.ok(!args.includes('-p'), `interactive must not pass -p: ${JSON.stringify(args)}`);
    assert.ok(args.includes('--resume'));
  } finally {
    teardown(ctx);
  }
});

test('a refused resume offers to go ahead anyway, and honours the answer', async () => {
  // The budget guard refused a real 11.2 MB session at ~2,007,179 estimated
  // tokens - a number the session's own usage records put nearer 432,163. A
  // guard that can only say no, on an estimate that can be this wrong, takes
  // the decision away from the person whose session it is.
  resetVscodeFake();
  const transcript = path.join(os.tmpdir(), `${SESSION}.jsonl`);
  fs.writeFileSync(transcript, 'x'.repeat(100_000));
  vscodeFake.config = {
    claudeCommand: LAUNCHER,
    maxResumeTokens: 1,
    randomDelayMinMinutes: 0,
    randomDelayMaxMinutes: 0,
  };
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    FakeWatcher.latest?.limitFor(SESSION, new Date(Date.now() - 1000), REAL_CWD, transcript);
    await flush();
    const offer = vscodeFake.warningOffers.find((w) => w.message.includes('estimated'));
    assert.ok(offer, `expected a refusal offering a way through; saw ${JSON.stringify(vscodeFake.warnings)}`);
    assert.ok(offer.items.includes('Resume anyway'));
    assert.equal(vscodeFake.terminals.length, 0, 'nothing may launch before the answer');

    offer.answer('Resume anyway');
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 1, 'answering yes must resume it');
  } finally {
    teardown(ctx);
    fs.rmSync(transcript, { force: true });
  }
});

test('a refusal that is dismissed resumes nothing', async () => {
  resetVscodeFake();
  const transcript = path.join(os.tmpdir(), `${SESSION}.jsonl`);
  fs.writeFileSync(transcript, 'x'.repeat(100_000));
  vscodeFake.config = { claudeCommand: LAUNCHER, maxResumeTokens: 1, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    FakeWatcher.latest?.limitFor(SESSION, new Date(Date.now() - 1000), REAL_CWD, transcript);
    await flush();
    const offer = vscodeFake.warningOffers.find((w) => w.message.includes('estimated'));
    assert.ok(offer, 'setup: the refusal must have been offered');
    // Dismissed, the same as closing the notification. Only an explicit yes
    // may lift the cap - anything else leaves the refusal standing.
    offer.answer(undefined);
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 0);
  } finally {
    teardown(ctx);
    fs.rmSync(transcript, { force: true });
  }
});

test('an unchanged config is not re-parsed on every tick', async () => {
  // The skip exists because ~/.claude.json grows with every project opened and
  // this runs once a second. With the config path pointed at a file that never
  // exists - as it was - fs.statSync throws every time, the skip never runs,
  // and no test could tell whether it worked.
  resetVscodeFake();
  const configFile = path.join(os.tmpdir(), `clb-trust-${Date.now()}.json`);
  fs.writeFileSync(configFile, '{}');
  trustConfigPath = configFile;
  trustedCwds = new Set<string>();
  trustReads.count = 0;
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    FakeWatcher.latest?.limitFor(SESSION, new Date(Date.now() + 3_600_000));
    await flush();
    const afterSchedule = trustReads.count;
    await oneTick();
    assert.equal(trustReads.count, afterSchedule, 'an unchanged mtime must not cost a re-parse');

    // Touching the file is what a trust decision does; the answer is read again.
    fs.writeFileSync(configFile, '{"projects":{}}');
    await oneTick();
    assert.ok(trustReads.count > afterSchedule, 'a changed mtime must be re-read');
  } finally {
    trustConfigPath = '/fake/.claude.json';
    trustedCwds = 'all';
    teardown(ctx);
    fs.rmSync(configFile, { force: true });
  }
});

test('each session gets its own trust re-check, not one cache for the window', async () => {
  // onChange only ever reports the soonest job, so with a single shared mtime
  // a second session's first check could land on an mtime another session had
  // already recorded - and never be read at all.
  resetVscodeFake();
  const configFile = path.join(os.tmpdir(), `clb-trust2-${Date.now()}.json`);
  fs.writeFileSync(configFile, '{}');
  trustConfigPath = configFile;
  trustedCwds = new Set<string>();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    FakeWatcher.latest?.limitFor(SESSION, new Date(Date.now() + 3_600_000));
    await oneTick();
    // A second session, sooner than the first, so it becomes the one the
    // status bar shows. Scheduling it costs exactly two reads: the check
    // scheduling does itself, and this session's first re-check. A cache
    // shared across sessions makes the second one disappear, because the
    // mtime has not moved since the first session's check.
    const before = trustReads.count;
    FakeWatcher.latest?.limitFor(SESSION_B, new Date(Date.now() + 1_800_000));
    await flush();
    assert.ok(
      trustReads.count - before >= 2,
      `the newly-soonest session must get its own first check: ${trustReads.count - before} read(s)`,
    );
  } finally {
    trustConfigPath = '/fake/.claude.json';
    trustedCwds = 'all';
    teardown(ctx);
    fs.rmSync(configFile, { force: true });
  }
});

test('a small live context beats a huge byte count', async () => {
  // The whole point of reading the transcript's usage record: an 11.2 MB file
  // whose live context is 432,163 tokens must not be refused on 2,007,179.
  resetVscodeFake();
  const transcript = path.join(os.tmpdir(), `${SESSION}.jsonl`);
  const usage = JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: 2, cache_read_input_tokens: 24_591, cache_creation_input_tokens: 40_000 } },
  });
  fs.writeFileSync(transcript, `${'x'.repeat(2_000_000)}\n${usage}\n`);
  vscodeFake.config = {
    claudeCommand: LAUNCHER,
    maxResumeTokens: 100_000,
    randomDelayMinMinutes: 0,
    randomDelayMaxMinutes: 0,
  };
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    FakeWatcher.latest?.limitFor(SESSION, new Date(Date.now() - 1000), REAL_CWD, transcript);
    await oneTick();
    assert.deepEqual(
      vscodeFake.warningOffers.filter((w) => w.message.includes('estimated')),
      [],
      'the byte count would have refused this',
    );
    assert.equal(vscodeFake.terminals.length, 1, 'the usage record says it fits, so it resumes');
  } finally {
    teardown(ctx);
    fs.rmSync(transcript, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Wiring for #1 (update check) and #2 (watch scope).
// ---------------------------------------------------------------------------

test('the watcher is given this window folders and the configured scope', async () => {
  resetVscodeFake();
  vscodeFake.config = { watchScope: 'workspace' };
  vscodeFake.workspaceFolders = [{ uri: { fsPath: REAL_CWD } }];
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    const scope = FakeWatcher.latest?.getScope?.();
    assert.ok(scope, 'the watcher must be constructed with a scope');
    assert.equal(scope.mode, 'workspace');
    assert.deepEqual(scope.folders, [REAL_CWD]);
  } finally {
    teardown(ctx);
  }
});

test('the scope defaults to machine-wide, which is what it has always been', async () => {
  resetVscodeFake();
  vscodeFake.config = {};
  const ctx = contextOver(new Map());
  start(ctx);
  try {
    assert.equal(FakeWatcher.latest?.getScope?.().mode, 'machine');
  } finally {
    teardown(ctx);
  }
});

test('the first run offers the update check once, and enabling it writes the setting', async () => {
  resetVscodeFake();
  vscodeFake.config = {};
  const store = new Map<string, unknown>();
  const ctx = contextOver(store);
  start(ctx);
  try {
    await flush();
    const prompt = vscodeFake.info.find((m) => m.message.includes('newer release'));
    assert.ok(prompt, `expected the one-time offer; saw ${JSON.stringify(vscodeFake.info.map((m) => m.message))}`);
    assert.deepEqual(prompt.items, ['Enable', 'Not now', 'Never ask']);
    prompt.answer('Enable');
    await flush();
    assert.equal(vscodeFake.configUpdates.get('checkForUpdates'), true, 'Enable must turn it on');
  } finally {
    teardown(ctx);
  }
});

test('the offer is never made twice, whatever the answer was', async () => {
  resetVscodeFake();
  vscodeFake.config = {};
  const store = new Map<string, unknown>();
  const first = contextOver(store);
  start(first);
  await flush();
  vscodeFake.info.find((m) => m.message.includes('newer release'))?.answer('Not now');
  await flush();
  teardown(first);

  const before = vscodeFake.info.length;
  const second = contextOver(store);
  start(second);
  try {
    await flush();
    assert.equal(
      vscodeFake.info.slice(before).filter((m) => m.message.includes('newer release')).length,
      0,
      'a second activation must not ask again',
    );
  } finally {
    teardown(second);
  }
});

test('with checking enabled, a newer release is reported once', async () => {
  resetVscodeFake();
  vscodeFake.config = { checkForUpdates: true };
  latestReleaseTag = 'v9.9.9';
  const store = new Map<string, unknown>([['claudeLimitBuster.updateCheck.firstRunPromptAnswer', 'enable']]);
  const ctx = contextOver(store);
  start(ctx);
  try {
    await flush();
    await flush();
    const news = vscodeFake.info.find((m) => m.message.includes('9.9.9'));
    assert.ok(news, `expected a release notice; saw ${JSON.stringify(vscodeFake.info.map((m) => m.message))}`);
    news.answer('Dismiss');
    await flush();
    assert.equal(store.get('claudeLimitBuster.updateCheck.dismissedVersion'), 'v9.9.9');
  } finally {
    latestReleaseTag = undefined;
    teardown(ctx);
  }
});

test('nothing is fetched while the setting is off', async () => {
  resetVscodeFake();
  vscodeFake.config = {};
  fetchCalls.length = 0;
  const store = new Map<string, unknown>([['claudeLimitBuster.updateCheck.firstRunPromptAnswer', 'never']]);
  const ctx = contextOver(store);
  start(ctx);
  try {
    await flush();
    await flush();
    assert.deepEqual(fetchCalls, [], 'an outbound request nobody asked for');
  } finally {
    teardown(ctx);
  }
});

test('the resume launches from the spelling of the folder the CLI has trusted', async () => {
  // The CLI looks its trust record up by exact key. A panel session records
  // its cwd with the drive letter VS Code reports; trusting the folder from a
  // terminal records another spelling. Launching with the trusted spelling is
  // what makes the CLI find the record the user created - both are the same
  // directory, so this chooses a name, never a different folder.
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const recorded = REAL_CWD + path.sep; // a distinct string naming the same directory
  trustedSpellingFor.set(recorded, REAL_CWD);
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob(recorded)]]));
  start(ctx);
  try {
    await oneTick();
    const opts = vscodeFake.terminals[0]?.options as { cwd?: string } | undefined;
    assert.equal(opts?.cwd, REAL_CWD);
  } finally {
    trustedSpellingFor.clear();
    teardown(ctx);
  }
});

test('with no trusted spelling on record, the recorded cwd is used as it was', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    const opts = vscodeFake.terminals[0]?.options as { cwd?: string } | undefined;
    assert.equal(opts?.cwd, REAL_CWD);
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// Task 2: never start a second writer on a live session.
//
// `fakeAgentRows` stands in for `claude agents --json`; `sessionRecordFor`
// stands in for the per-pid `~/.claude/sessions/<pid>.json` record. Both
// default to "nobody else is running anything", so every test above this
// section runs exactly as it did before this task existed.
// ---------------------------------------------------------------------------

/** SESSION's row, live via the fake listing, holding the session with the given entrypoint and status. */
const holderRow = (entrypoint: string, status: string, over: Partial<AgentRow> = {}): void => {
  fakeAgentRows = [{ pid: 111, kind: 'interactive', sessionId: SESSION, status, ...over }];
  sessionRecordFor.set(111, { sessionId: SESSION, entrypoint });
};

const clearHolders = () => {
  fakeAgentRows = [];
  sessionRecordFor.clear();
};

test('scheduler.onFire resumes as normal when the only other process is an IDLE panel', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  holderRow('claude-vscode', 'idle');
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 1, 'an idle panel is the main use case - it must not block the resume');
    assert.equal(
      vscodeFake.info.filter((m) => m.items.includes('Resume in Terminal Anyway')).length,
      0,
      'must not notify instead of spawning',
    );
  } finally {
    clearHolders();
    teardown(ctx);
  }
});

test('scheduler.onFire silently drops the job when the only other process is a BUSY panel', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  holderRow('claude-vscode', 'busy');
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 0, 'a busy panel already holds the session');
    // Not the raw message count: a fresh activation also offers the
    // first-run "check for updates?" prompt, which is unrelated noise here.
    // The thing under test is that nothing NAMES this job at all.
    assert.equal(
      vscodeFake.info.filter((m) => m.items.includes('Resume in Terminal Anyway')).length,
      0,
      'a busy holder drops silently - no notification naming this job',
    );
    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow')!;
    await resumeNow();
    assert.ok(
      vscodeFake.info.some((m) => /nothing pending/.test(m.message)),
      'the dropped job must not have been remembered for manual resume',
    );
  } finally {
    clearHolders();
    teardown(ctx);
  }
});

test('scheduler.onFire silently drops the job when the only other process is a WAITING terminal', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  holderRow('cli', 'waiting');
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 0);
    assert.equal(
      vscodeFake.info.filter((m) => m.items.includes('Resume in Terminal Anyway')).length,
      0,
      'a waiting terminal drops silently too',
    );
  } finally {
    clearHolders();
    teardown(ctx);
  }
});

test('scheduler.onFire leaves an IDLE terminal alone when Claude Code auto-continue is on', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  autoContinueOn = true;
  holderRow('cli', 'idle');
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 0, 'auto-continue is already going to pick this session back up');
    assert.equal(
      vscodeFake.info.filter((m) => m.items.includes('Resume in Terminal Anyway')).length,
      0,
      'auto-continue being on means there is nothing to offer',
    );
  } finally {
    autoContinueOn = true;
    clearHolders();
    teardown(ctx);
  }
});

test('scheduler.onFire remembers and offers Resume in Terminal Anyway for an IDLE terminal when auto-continue is off', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  autoContinueOn = false;
  holderRow('cli', 'idle');
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 0, 'not yet - the button has not been clicked');
    const offer = vscodeFake.info.find((m) => m.items.includes('Resume in Terminal Anyway'));
    assert.ok(offer, `no offer was made; saw ${JSON.stringify(vscodeFake.info)}`);
    offer.answer('Resume in Terminal Anyway');
    await flush();
    assert.equal(vscodeFake.terminals.length, 1, 'the button claims the job and resumes it');
  } finally {
    autoContinueOn = true;
    clearHolders();
    teardown(ctx);
  }
});

test('scheduler.onFire resumes anyway, with a coordination sentence, when a DIFFERENT session is busy in the same folder', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  // A different sessionId, busy, in the same folder as the job (REAL_CWD,
  // pastJob()'s default cwd) - nobody is on THIS session, so classifyHolder
  // alone would say 'none' and resume unmodified; busyFolderPeers is what
  // finds this row and feeds the coordination prompt.
  fakeAgentRows = [
    { pid: 999, kind: 'interactive', sessionId: SESSION_B, cwd: REAL_CWD, status: 'busy', name: 'other-session' },
  ];
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 1, 'this is "resume anyway", not a block');
    const prompt = argsOf(0)?.[2];
    assert.match(prompt ?? '', /other-session/, 'the peer must be named in the resumed prompt');
    assert.match(prompt ?? '', /SendMessage/, 'the resumed model must be told how to coordinate');
    assert.ok(prompt?.startsWith(PROMPT), `the user's own prompt must still lead: ${prompt}`);
    assert.ok(
      vscodeFake.info.some((m) => m.message.includes('other-session')),
      'the person is told too, non-blockingly',
    );
  } finally {
    clearHolders();
    teardown(ctx);
  }
});

test('scheduler.onFire does not touch the prompt when the folder is quiet', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(argsOf(0)?.[2], PROMPT, 'no busy peers - the prompt must be exactly the user\'s own');
  } finally {
    teardown(ctx);
  }
});

test('resumeNow shows a modal fork warning for a busy holder; declining leaves it unresumed', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  holderRow('claude-vscode', 'busy');
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', futureJob()]]));
  start(ctx);
  try {
    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow')!;
    const pending = resumeNow();
    await flush();
    const modal = vscodeFake.warningOffers.find((w) => w.modal);
    assert.ok(modal, 'a busy panel must warn modally before a manual resume');
    assert.equal(modal.items[0], 'Resume Anyway');
    assert.match(modal.message, /fork/i);
    assert.equal(vscodeFake.terminals.length, 0, 'must not resume before the modal is answered');
    modal.answer(undefined);
    await pending;
    assert.equal(vscodeFake.terminals.length, 0, 'declining the modal must not launch anything');
  } finally {
    clearHolders();
    teardown(ctx);
  }
});

test('resumeNow proceeds after Resume Anyway is clicked on the modal', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  holderRow('claude-vscode', 'busy');
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', futureJob()]]));
  start(ctx);
  try {
    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow')!;
    const pending = resumeNow();
    await flush();
    const modal = vscodeFake.warningOffers.find((w) => w.modal);
    assert.ok(modal);
    modal.answer('Resume Anyway');
    await pending;
    assert.equal(vscodeFake.terminals.length, 1, 'Resume Anyway must still launch the resume');
  } finally {
    clearHolders();
    teardown(ctx);
  }
});

test('resumeNow shows no modal for an idle panel - it is not a live conflict', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  holderRow('claude-vscode', 'idle');
  const ctx = contextOver(new Map([['claudeLimitBuster.pending', futureJob()]]));
  start(ctx);
  try {
    const resumeNow = vscodeFake.commands.get('claudeLimitBuster.resumeNow')!;
    await resumeNow();
    await flush();
    assert.equal(vscodeFake.warningOffers.length, 0, 'an idle panel needs no modal');
    assert.equal(vscodeFake.terminals.length, 1, 'and the resume proceeds directly');
  } finally {
    clearHolders();
    teardown(ctx);
  }
});
