import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { installVscodeStub } from './helpers/vscode';

installVscodeStub();

const { TranscriptWatcher, isInScope, pruneOffsets, MAX_OFFSET_IDLE_MS, MAX_OFFSET_ENTRIES, MAX_OVERLOAD_AGE_MS } =
  require('../src/transcriptWatcher') as typeof import('../src/transcriptWatcher');
const { RESET_GRACE_MS } = require('../src/parsers/limitParser') as typeof import('../src/parsers/limitParser');

const FILE = '/home/u/.claude/projects/c--projects-example/0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl';
const silent = { info() {}, warn() {}, error() {} };
const make = () => new TranscriptWatcher(() => 24, () => 5, silent);

const entry = (o: Record<string, unknown>) => JSON.stringify(o);

test('a flagged rate-limit entry arms a timer', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    cwd: 'C:\\projects\\example',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.limit, 'flagged entry must be detected');
  assert.equal(out.limit.cwd, 'C:\\projects\\example');
  assert.equal(out.limit.file, FILE);
});

test('a partially written line is ignored rather than throwing', () => {
  assert.deepEqual(make().inspectLine('{"type":"assis', FILE), {});
});

test('a sibling timestamp field is not misread as a reset time', () => {
  const line = entry({
    type: 'assistant',
    timestamp: '2026-08-03T18:00:00Z',
    message: { content: 'I finished reading limitParser.ts' },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('a user pasting a 529 does not arm a retry', () => {
  const line = entry({
    type: 'user',
    message: { content: 'I keep seeing API Error: 529 Overloaded, what does that mean?' },
  });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

test('an assistant end_turn reports input needed', () => {
  const line = entry({ type: 'assistant', message: { stop_reason: 'end_turn', content: 'Done.' } });
  assert.ok(make().inspectLine(line, FILE).inputNeeded);
});

test('long strings in an entry are skipped as file contents, not banners', () => {
  const line = entry({
    type: 'assistant',
    message: { content: 'Usage limit reached. Try again in 5 hours. ' + 'x'.repeat(500) },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('an ordinary user question about limits does not arm a timer', () => {
  const questions = [
    'my usage limit resets at 3pm right?',
    'why does my session limit reset at 1:40am instead of midnight?',
    'what happens when I hit the usage limit - does it try again in 5 hours?',
    'is the rate limit reached message the one that says try again in 2 hours?',
  ];
  for (const q of questions) {
    const line = entry({ type: 'user', message: { content: q } });
    assert.equal(make().inspectLine(line, FILE).limit, undefined, q);
  }
});

test('an assistant entry describing a limit still arms a timer', () => {
  const line = entry({
    type: 'assistant',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  assert.ok(make().inspectLine(line, FILE).limit);
});

// ---------------------------------------------------------------------------
// Scope filtering (issue #2). The watcher's root stays the whole
// ~/.claude/projects tree - that default is not up for debate here - but a
// caller can now inject a narrower scope, and machine mode (what every
// existing test above exercises via make(), which passes no scope at all)
// must stay exactly as it is today.
// ---------------------------------------------------------------------------

test('machine mode is in scope no matter the cwd or folders', () => {
  assert.equal(isInScope(undefined, { mode: 'machine', folders: [] }), true);
  assert.equal(isInScope('/anywhere', { mode: 'machine', folders: ['/work/app'] }), true);
});

test('workspace mode is a bounded, case-insensitive path comparison', () => {
  const root = path.join(os.tmpdir(), 'clb-ws');
  const scope = (folders: string[]) => ({ mode: 'workspace' as const, folders });
  assert.equal(isInScope(root, scope([root])), true, 'the folder itself is inside it');
  assert.equal(isInScope(path.join(root, 'a', 'b'), scope([root])), true, 'a descendant is inside');
  assert.equal(isInScope(root.toUpperCase(), scope([root])), true, 'casing must not decide it');
  assert.equal(isInScope(`${root}-old`, scope([root])), false, 'a shared prefix is not containment');
  assert.equal(isInScope(path.join(os.tmpdir(), 'other'), scope([root])), false, 'elsewhere is outside');
  assert.equal(isInScope(undefined, scope([root])), false, 'an unknown cwd is not inside anything');
  assert.equal(isInScope(root, scope([])), false, 'a scope with no folders owns nothing');
});

test('workspace mode discards a limit hit outside the workspace before detection', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    cwd: '/elsewhere/project',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const watcher = new TranscriptWatcher(() => 24, () => 5, silent, () => ({ mode: 'workspace', folders: ['/work/app'] }));
  assert.deepEqual(watcher.inspectLine(line, FILE), {});
});

test('workspace mode keeps a limit hit inside the workspace', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    cwd: '/work/app',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const watcher = new TranscriptWatcher(() => 24, () => 5, silent, () => ({ mode: 'workspace', folders: ['/work/app'] }));
  assert.ok(watcher.inspectLine(line, FILE).limit);
});

test('workspace mode discards an ended turn outside the workspace', () => {
  const line = entry({ type: 'assistant', cwd: '/elsewhere', message: { stop_reason: 'end_turn', content: 'Done.' } });
  const watcher = new TranscriptWatcher(() => 24, () => 5, silent, () => ({ mode: 'workspace', folders: ['/work/app'] }));
  assert.equal(watcher.inspectLine(line, FILE).inputNeeded, undefined);
});

test('a caller passing no scope gets machine mode, unchanged from today', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    cwd: '/nowhere/near/a/workspace',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  assert.ok(make().inspectLine(line, FILE).limit);
});

// ---------------------------------------------------------------------------
// Bounded offsets (issue #2). offsets holds one entry per file ever seen and
// the projects tree only grows, so pruneOffsets decides what survives a pass.
// It is pure and Map-free - see its doc comment in src/transcriptWatcher.ts
// for where the bound numbers come from - so this needs no filesystem.
// ---------------------------------------------------------------------------

test('pruneOffsets drops a file no longer on disk', () => {
  const now = 1_000_000;
  const entries = new Map([['/a.jsonl', { offset: 10, lastActivity: now }]]);
  const survivors = pruneOffsets(entries, new Set(), now);
  assert.equal(survivors.size, 0);
});

test('pruneOffsets drops a file idle past the bound and keeps one within it', () => {
  const now = 10_000_000;
  const entries = new Map([
    ['/stale.jsonl', { offset: 10, lastActivity: now - MAX_OFFSET_IDLE_MS - 1 }],
    ['/fresh.jsonl', { offset: 10, lastActivity: now - 1 }],
  ]);
  const existing = new Set(['/stale.jsonl', '/fresh.jsonl']);
  const survivors = pruneOffsets(entries, existing, now);
  assert.deepEqual([...survivors.keys()], ['/fresh.jsonl']);
});

test('pruneOffsets enforces a hard cap by evicting the oldest activity first', () => {
  const now = 5_000;
  const entries = new Map([
    ['/one.jsonl', { offset: 1, lastActivity: 100 }],
    ['/two.jsonl', { offset: 1, lastActivity: 200 }],
    ['/three.jsonl', { offset: 1, lastActivity: 300 }],
  ]);
  const existing = new Set(entries.keys());
  const survivors = pruneOffsets(entries, existing, now, MAX_OFFSET_IDLE_MS, 2);
  assert.deepEqual([...survivors.keys()].sort(), ['/three.jsonl', '/two.jsonl']);
});

test('the idle bound and the hard cap match what the comments in src claim', () => {
  assert.equal(MAX_OFFSET_IDLE_MS, 30 * 24 * 60 * 60 * 1000, 'thirty days');
  assert.equal(MAX_OFFSET_ENTRIES, 2000, 'the hard backstop');
});

// ---------------------------------------------------------------------------
// Old notices replayed into a new file.
//
// Forking a conversation writes a new transcript that starts with a copy of
// the old one, every line keeping its original timestamp - observed on
// 2026-09-23 in ba15a9ef, a fork whose copied lines still carry dates from
// 2026-09-10. The watcher meets that file for the first time and reads its
// tail, so last night's "resets 1am" arrived as if it were new. Resolved
// against the time of reading, 1am had already passed today, so it rolled to
// tomorrow's 1am and armed an 18-hour countdown for a limit that had lifted
// ten hours earlier.
// ---------------------------------------------------------------------------

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

test('a limit notice whose reset passed before it was read is ignored', () => {
  // Written 20 hours ago with a 5-hour wait: that limit lifted 15 hours ago.
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    timestamp: hoursAgo(20),
    cwd: '/projects/example',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('a notice is resolved against when it was written, not when it was read', () => {
  // Written an hour ago with a 5-hour wait: the reset is 4 hours from now,
  // not 5. Resolving against the time of reading would pad it by the delay.
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    timestamp: hoursAgo(1),
    cwd: '/projects/example',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.limit, 'a limit still in force must be detected');
  const resumeAt = out.limit.detection.resumeAt;
  assert.ok(resumeAt);
  const hoursOut = (resumeAt.getTime() - Date.now()) / 3_600_000;
  assert.ok(hoursOut > 3.9 && hoursOut < 4.1, `expected ~4h out, got ${hoursOut.toFixed(2)}h`);
});

test('a fresh notice behaves exactly as it always has', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    timestamp: new Date().toISOString(),
    cwd: '/projects/example',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.limit);
  const hoursOut = (out.limit.detection.resumeAt!.getTime() - Date.now()) / 3_600_000;
  assert.ok(hoursOut > 4.9 && hoursOut < 5.1);
});

test('an entry with no timestamp is resolved against now, as before', () => {
  // Synthetic notices have been seen without the usual bookkeeping fields;
  // missing a timestamp must not make a live limit disappear.
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    cwd: '/projects/example',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  assert.ok(make().inspectLine(line, FILE).limit);
});

test('an entry with an unparseable timestamp falls back to now, same as a missing one', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    timestamp: 'not-a-real-date',
    cwd: '/projects/example',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.limit, 'a garbled timestamp must not make a live limit disappear');
  const hoursOut = (out.limit.detection.resumeAt.getTime() - Date.now()) / 3_600_000;
  assert.ok(hoursOut > 4.9 && hoursOut < 5.1, `expected ~5h out, got ${hoursOut.toFixed(2)}h`);
});

test('an old server error replayed into a new file does not trigger a retry', () => {
  // An overload has no reset time to go stale by, so age is the test: a 529
  // from last night is not a reason to resume a fork this morning.
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    timestamp: hoursAgo(10),
    cwd: '/projects/example',
    message: { content: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
  });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

test('a reset that passed minutes ago still resumes, and resumes now', () => {
  // The other side of the staleness rule. "resets 10am" read at 10:03 is a
  // session sitting stopped at a limit that has just lifted - it needs
  // resuming, not ignoring, and it certainly does not need to wait until
  // 10am tomorrow, which is what rolling the clock time forward used to do.
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    timestamp: new Date(Date.now() - (5 * 60 + 3) * 60_000).toISOString(),
    cwd: '/projects/example',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.limit, 'a limit that lifted three minutes ago must still be acted on');
  assert.ok(out.limit.detection.resumeAt.getTime() <= Date.now(), 'and it is due now, not tomorrow');
});

// ---------------------------------------------------------------------------
// quotaLimits.resetsAt - the reset time, as a number.
//
// Every rate-limit entry in this project's transcripts carries it: 20 of 20
// in 05690955, checked 2026-09-23. The newest has resetsAt 1790197800, which
// is 4:10pm America/Chicago, beside text reading "resets 4:10pm
// (America/Chicago)". Reading the number sidesteps every way the text can be
// misread - zones, DST (#10), calendar dates, and the rollover past a time
// that has just gone by.
// ---------------------------------------------------------------------------

const quotaEntry = (resetsAtMs: number, text: string, written = new Date()) =>
  entry({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    timestamp: written.toISOString(),
    cwd: '/projects/example',
    quotaLimits: { status: 'rejected', resetsAt: Math.floor(resetsAtMs / 1000), rateLimitType: 'five_hour' },
    message: { content: [{ type: 'text', text }] },
  });

test('the structured reset time wins over the text', () => {
  const resetsAt = Date.now() + 2 * 3_600_000;
  // Text that would parse to a different time, to show which one was used.
  const out = make().inspectLine(quotaEntry(resetsAt, "You've hit your session limit · resets in 5 hours"), FILE);
  assert.ok(out.limit);
  assert.equal(Math.round(out.limit.detection.resumeAt.getTime() / 1000), Math.floor(resetsAt / 1000));
});

test('the structured reset time works when the text cannot be parsed at all', () => {
  const resetsAt = Date.now() + 3_600_000;
  const out = make().inspectLine(quotaEntry(resetsAt, 'Something went wrong with your plan limits'), FILE);
  assert.ok(out.limit, 'the number alone is enough');
});

test('a structured reset hours in the past is history, not an event', () => {
  const written = new Date(Date.now() - 12 * 3_600_000);
  const resetsAt = written.getTime() + 3_600_000; // lifted 11 hours ago
  assert.equal(make().inspectLine(quotaEntry(resetsAt, "You've hit your session limit · resets 1am", written), FILE).limit, undefined);
});

test('a structured reset that fails its own check does not fall back to a text-parsed one', () => {
  // The authoritative field is decisive, not merely a first guess: rejected,
  // it must not hand the decision to the text, even when the text alone
  // would have resolved to a perfectly valid, currently-due limit.
  const written = new Date(Date.now() - 20 * 3_600_000); // 20 hours ago
  const resetsAt = written.getTime() + 3_600_000; // structured: lifted 19 hours ago, history
  // Text, resolved against the same 20-hour-old basis, lands almost exactly
  // now - independently valid, and different from the structured value.
  const out = make().inspectLine(
    quotaEntry(resetsAt, "You've hit your session limit. Try again in 20 hours", written),
    FILE,
  );
  assert.equal(out.limit, undefined, 'a rejected structured reset must not defer to the text');
});

test('a structured reset time is only trusted on an entry Claude Code flagged', () => {
  // quotaLimits on an ordinary assistant turn is not a limit event - the field
  // alone must not be enough to arm anything.
  const line = entry({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    cwd: '/projects/example',
    quotaLimits: { status: 'allowed', resetsAt: Math.floor((Date.now() + 3_600_000) / 1000) },
    message: { content: [{ type: 'text', text: 'Here is the refactor you asked for.' }] },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('a flagged entry whose quotaLimits has no numeric resetsAt falls back to the text', () => {
  // The authoritative field only decides anything when it is actually there
  // as a number; otherwise a flagged entry is still a limit event and the
  // text is exactly what today's (pre-quotaLimits) detection already reads.
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    timestamp: new Date().toISOString(),
    cwd: '/projects/example',
    quotaLimits: { status: 'rejected' }, // no resetsAt at all
    message: { content: [{ type: 'text', text: "You've hit your session limit. Try again in 2 hours" }] },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.limit, 'the text must still be read when the number is absent');
  const hoursOut = (out.limit.detection.resumeAt.getTime() - Date.now()) / 3_600_000;
  assert.ok(hoursOut > 1.9 && hoursOut < 2.1, `expected ~2h out, got ${hoursOut.toFixed(2)}h`);
});

test('a structured reset far beyond maxWait is rejected, the same as a parsed one', () => {
  // "Keep maxWait semantics": a structured reset is not exempt from the same
  // absurd-result cap a parsed one has always had. make() reports 24h.
  const resetsAt = Date.now() + 30 * 3_600_000;
  const out = make().inspectLine(quotaEntry(resetsAt, "You've hit your session limit · resets in 30 hours"), FILE);
  assert.equal(out.limit, undefined, 'a 30-hour-out structured reset must not arm a 24h-capped timer');
});

// ---------------------------------------------------------------------------
// RESET_GRACE_MS boundary, both sides. Exercised through quotaLimits.resetsAt
// because it is a bare epoch comparison against the real clock, with no
// zone/DST/rollover machinery in the way. The exact millisecond edge is
// pinned separately, deterministically, against a fixed `now` in
// resolveStructuredReset's own unit tests (test/parsers/limitParser.test.ts) -
// resetsAt here is epoch *seconds* and the real clock is genuinely running
// between this line and the moment inspectLine reads Date.now(), so this
// integration-level pair uses a few seconds of headroom on each side rather
// than the exact edge, to demonstrate the wiring without being racy.
// ---------------------------------------------------------------------------

const GRACE_TEST_MARGIN_MS = 5_000;

test('RESET_GRACE_MS boundary: still comfortably inside the grace window resumes', () => {
  const resetsAt = Date.now() - RESET_GRACE_MS + GRACE_TEST_MARGIN_MS;
  const out = make().inspectLine(quotaEntry(resetsAt, 'irrelevant text'), FILE);
  assert.ok(out.limit, 'a reset just inside the grace window is due now, not history');
});

test('RESET_GRACE_MS boundary: just past the grace window is history', () => {
  const resetsAt = Date.now() - RESET_GRACE_MS - GRACE_TEST_MARGIN_MS;
  const out = make().inspectLine(quotaEntry(resetsAt, 'irrelevant text'), FILE);
  assert.equal(out.limit, undefined, 'a reset just past the grace window must not resume');
});

// ---------------------------------------------------------------------------
// MAX_OVERLOAD_AGE_MS boundary, both sides. Same headroom rationale as above:
// the entry's timestamp is fixed at construction, but the age comparison
// itself happens against Date.now() inside inspectLine a moment later.
// ---------------------------------------------------------------------------

const overloadLine = (age: number) =>
  entry({
    type: 'assistant',
    isApiErrorMessage: true,
    timestamp: new Date(Date.now() - age).toISOString(),
    cwd: '/projects/example',
    message: { content: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
  });

test('MAX_OVERLOAD_AGE_MS boundary: still comfortably inside the age limit retries', () => {
  const out = make().inspectLine(overloadLine(MAX_OVERLOAD_AGE_MS - GRACE_TEST_MARGIN_MS), FILE);
  assert.ok(out.overload, 'an overload just inside MAX_OVERLOAD_AGE_MS is not yet too old');
});

test('MAX_OVERLOAD_AGE_MS boundary: just past the age limit does not retry', () => {
  const out = make().inspectLine(overloadLine(MAX_OVERLOAD_AGE_MS + GRACE_TEST_MARGIN_MS), FILE);
  assert.equal(out.overload, undefined, 'an overload just past MAX_OVERLOAD_AGE_MS must not retry');
});

// The new sleep/stream-interruption render must obey the same age rule as
// every other overload render (Task 4a constraint: "the new overload renders
// obey it too").
const sleepLine = (age: number) =>
  entry({
    type: 'assistant',
    isApiErrorMessage: true,
    timestamp: new Date(Date.now() - age).toISOString(),
    cwd: '/projects/example',
    message: { content: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.' },
  });

test('the sleep-interruption render also obeys MAX_OVERLOAD_AGE_MS', () => {
  const fresh = make().inspectLine(sleepLine(MAX_OVERLOAD_AGE_MS - GRACE_TEST_MARGIN_MS), FILE);
  assert.ok(fresh.overload, 'a sleep-interruption notice just inside MAX_OVERLOAD_AGE_MS is not yet too old');
  const stale = make().inspectLine(sleepLine(MAX_OVERLOAD_AGE_MS + GRACE_TEST_MARGIN_MS), FILE);
  assert.equal(stale.overload, undefined, 'an old sleep-interruption notice must not retry');
});

// ---------------------------------------------------------------------------
// Task 3 (synthesis A3): untrusted text that merely LOOKS like a limit
// banner must not arm a timer. Three real false positives from 2026-09-23:
// a subagent note quoting a banner, a usage-percentage status line, and a
// `grep` result quoting a banner. Each is used here verbatim (or, for the
// grep case, a realistic reconstruction - the brief gives no exact text) as
// a negative case, alongside a flagged real banner as a positive case.
// ---------------------------------------------------------------------------

const SUBAGENT_FILE =
  '/home/u/.claude/projects/c--projects-example/subagents/9f1e2d3c-4b1a-4c9e-8a1e-2a5d6e8c9999.jsonl';

test('a subagent file never arms a limit timer, even quoting a real banner verbatim (real false positive)', () => {
  // Captured verbatim, 2026-09-23, from a subagent checkpoint note.
  const line = entry({
    type: 'assistant',
    message: { content: '…You have used up your monthly limit. Try again in 3 hours' },
  });
  assert.equal(make().inspectLine(line, SUBAGENT_FILE).limit, undefined);
});

test('a subagent file still reports turn-end and overload - only limit detection is skipped', () => {
  // The veto is scoped to limits: a subagent that hits the limit stops its
  // parent, whose own transcript records it, but a subagent's turn ending or
  // failing over is still real information this watcher already reports.
  const turnEndLine = entry({ type: 'assistant', message: { stop_reason: 'end_turn', content: 'Done.' } });
  assert.ok(
    make().inspectLine(turnEndLine, SUBAGENT_FILE).inputNeeded,
    'turn-end must still be reported for a subagent file',
  );

  const overloadLine2 = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { content: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' },
  });
  assert.ok(
    make().inspectLine(overloadLine2, SUBAGENT_FILE).overload,
    'overload must still be reported for a subagent file',
  );
});

test('a percentage-usage status line does not arm a timer (real false positive)', () => {
  // Captured verbatim, 2026-09-23. Non-flagged, non-user entry: the shape
  // that reaches the untrusted candidate loop today.
  const line = entry({
    type: 'assistant',
    message: { content: "You've used 91% of your session limit · resets 12:40pm" },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('the same percentage text still arms once Claude Code flags the entry (positive control)', () => {
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { content: "You've used 91% of your session limit · resets 12:40pm" },
  });
  assert.ok(make().inspectLine(line, FILE).limit, 'a flagged entry is unaffected by the percentage veto');
});

test('a grep result quoting a banner, inside a tool_result block, does not arm a timer (real false positive)', () => {
  // Reconstructed: the brief names this false positive but gives no exact
  // text. `error` (not isApiErrorMessage/rate_limit) makes the entry an
  // apiError without flagging it as a rate-limit event, so it still reaches
  // the untrusted candidate loop, same as a genuine failed-tool-call entry
  // would.
  const line = entry({
    type: 'user',
    error: 'tool execution failed',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01',
          content: 'docs/PRIOR-ART.md:277:Claude AI usage limit reached. Try again in 5 hours',
        },
      ],
    },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('plain banner wording inside a tool_result block does not arm a timer, even with no quoting marks', () => {
  // Isolates the structural tool-result veto from the textual grep-prefix
  // veto: this text has no `%`, no backtick, no `>`, no "file:line:" prefix
  // at all - only its position inside a tool_result block should stop it.
  const line = entry({
    type: 'user',
    error: 'tool execution failed',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_02', content: 'Claude AI usage limit reached. Try again in 5 hours' },
      ],
    },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('a grep-style "file:line:" quote in an ordinary assistant message does not arm a timer', () => {
  // Isolates the textual grep-prefix veto from the structural tool-result
  // veto: this text is plain assistant content, not inside a tool_result.
  const line = entry({
    type: 'assistant',
    message: { content: 'docs/PRIOR-ART.md:277:Claude AI usage limit reached. Try again in 5 hours' },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('plain banner wording under a top-level toolUseResult field does not arm a timer', () => {
  // Real transcripts carry the tool's raw output under this sibling field,
  // separate from the message.content tool_result block - Claude Code's own
  // record of what happened, not a notice it is delivering now.
  const line = entry({
    type: 'user',
    error: 'tool execution failed',
    toolUseResult: 'Claude AI usage limit reached. Try again in 5 hours',
    message: { content: 'ok' },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('a flagged real banner still arms a timer (positive case)', () => {
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { content: "You've hit your session limit · resets 12:40am (America/Chicago)" },
  });
  assert.ok(make().inspectLine(line, FILE).limit);
});

// ---------------------------------------------------------------------------
// Fix round 1: the subagent-file veto must not swallow a FLAGGED entry. A
// subagent that genuinely hits the limit still writes Claude Code's own
// rate-limit marker into its own file, and that must still arm - only an
// unflagged note merely quoting what happened is vetoed. Flagged entries are
// exempt from every veto in this module, subagent-file included.
// ---------------------------------------------------------------------------

test('a flagged banner in a subagents/ file still arms a timer', () => {
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { content: "You've hit your session limit · resets 12:40am (America/Chicago)" },
  });
  assert.ok(make().inspectLine(line, SUBAGENT_FILE).limit, 'a flagged entry must not be dropped by the subagent-file veto');
});

test('a flagged quotaLimits.resetsAt entry in a subagents/ file still arms a timer', () => {
  const resetsAt = Date.now() + 2 * 3_600_000;
  const out = make().inspectLine(quotaEntry(resetsAt, "You've hit your session limit · resets in 2 hours"), SUBAGENT_FILE);
  assert.ok(out.limit, 'a flagged quotaLimits.resetsAt entry must not be dropped by the subagent-file veto');
  assert.equal(Math.round(out.limit.detection.resumeAt.getTime() / 1000), Math.floor(resetsAt / 1000));
});

// ---------------------------------------------------------------------------
// Task 4a: the three new overload-detection rules, wired through inspectLine.
// ---------------------------------------------------------------------------

test('an in-flight retry does not report overload, even from a flagged entry', () => {
  // Ruling 2: the in-flight-retry exclusion applies on both paths - Claude
  // Code is already retrying either way, flagged or not.
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { content: 'API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10' },
  });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

test('an in-flight retry from an unflagged entry also does not report overload', () => {
  const line = entry({
    type: 'assistant',
    message: { content: 'API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10' },
  });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

test('the transient-429 render (non-flagged, non-user entry) schedules an overload retry, not a limit timer', () => {
  // Ruling 1: this message must never arm a usage-limit timer, on either
  // path. Routing it to overload gives it the overload treatment instead.
  const line = entry({
    type: 'assistant',
    message: { content: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited' },
  });
  const out = make().inspectLine(line, FILE);
  assert.equal(out.limit, undefined, 'must not arm a usage-limit timer');
  assert.ok(out.overload, 'must be routed to overload');
  assert.equal(out.overload.detection.rule, 'transient-429');
});

test('a sleep-interruption render (non-flagged, non-user entry) schedules an overload retry', () => {
  const line = entry({
    type: 'assistant',
    message: { content: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.' },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.overload, 'must be routed to overload');
  assert.equal(out.overload.detection.rule, 'stream-interrupted');
});

// ---------------------------------------------------------------------------
// Task 4a constraint: the untrusted-text rules from Task 3 (quoted text, tool
// results) must keep working for the new overload rules too - a quoted or
// tool-result copy of any of these strings on the untrusted path must not
// schedule anything. Flagged entries stay exempt, same as every other veto
// in this module.
// ---------------------------------------------------------------------------

test('a quoted copy of the sleep-interruption render inside a tool_result block does not schedule an overload retry', () => {
  const line = entry({
    type: 'user',
    error: 'tool execution failed',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_03',
          content: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
        },
      ],
    },
  });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

test('a grep-style quoted copy of the transient-429 render does not schedule an overload retry', () => {
  const line = entry({
    type: 'assistant',
    message: {
      content: 'docs/notes.md:12:API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    },
  });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

test('a flagged entry is exempt from the new tool-result/quoted vetoes on the overload path', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_04',
          content: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
        },
      ],
    },
  });
  assert.ok(
    make().inspectLine(line, FILE).overload,
    'a flagged entry must still fire even from text inside a tool_result block',
  );
});

// ---------------------------------------------------------------------------
// Task 4a fix round 1 (review finding #1, Important): the quotaLimits branch
// (line ~452) used to return before any text was ever read, so a flagged
// transient-429 entry that also happens to carry quotaLimits (the research
// doc says every rate_limit entry does) was read as a usage limit instead of
// routed to overload - exactly the outcome ruling 1 forbids. Ruling: skip
// the quotaLimits branch outright when the entry's own text is a
// transient-429 render, regardless of quotaLimits.status.
// ---------------------------------------------------------------------------

test('a flagged transient-429 entry WITH quotaLimits still routes to overload, not a limit timer (fix round 1, finding #1)', () => {
  // Verbatim shape from the review finding: quotaLimits.status "allowed" (not
  // "rejected"), a plausible future resetsAt - the kind of entry Claude Code
  // could plausibly write for a transient-429.
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    quotaLimits: { status: 'allowed', resetsAt: Math.floor((Date.now() + 3 * 3_600_000) / 1000) },
    message: {
      content: [
        { type: 'text', text: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited' },
      ],
    },
  });
  const out = make().inspectLine(line, FILE);
  assert.equal(out.limit, undefined, 'must not be read as a usage limit via quotaLimits');
  assert.ok(out.overload, 'must be routed to overload');
  assert.equal(out.overload.detection.rule, 'transient-429');
});

test('an ordinary flagged quotaLimits entry is unaffected by the transient-429 skip', () => {
  // Positive control: a genuine limit banner with quotaLimits must keep
  // winning via the structured field, exactly as before.
  const resetsAt = Date.now() + 2 * 3_600_000;
  const out = make().inspectLine(quotaEntry(resetsAt, "You've hit your session limit · resets in 5 hours"), FILE);
  assert.ok(out.limit, 'a genuine quotaLimits entry must still arm via the structured field');
  assert.equal(out.overload, undefined);
});

// ---------------------------------------------------------------------------
// Task 4a fix round 1 (review finding #3, Important): the subagent-file veto
// was applied to the limit path (line ~446) but never extended to the
// overload path's new untrusted-text vetoes, so an unflagged assistant note
// in a subagents/ file quoting one of the new overload renders still armed a
// retry. Flagged entries stay exempt, same as every other veto here.
// ---------------------------------------------------------------------------

test('an unflagged assistant note in a subagents/ file does not schedule an overload retry (fix round 1, finding #3)', () => {
  const line = entry({
    type: 'assistant',
    message: { content: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.' },
  });
  assert.equal(make().inspectLine(line, SUBAGENT_FILE).overload, undefined);
});

test('a flagged banner in a subagents/ file still schedules an overload retry (positive control)', () => {
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { content: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.' },
  });
  assert.ok(
    make().inspectLine(line, SUBAGENT_FILE).overload,
    'a flagged entry must not be dropped by the subagent-file veto',
  );
});
