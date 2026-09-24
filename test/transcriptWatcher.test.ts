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
