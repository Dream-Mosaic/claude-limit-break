import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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

// Only an entry Claude Code flagged may arm a timer.
test('an unflagged assistant entry describing a limit does not arm a timer', () => {
  const line = entry({
    type: 'assistant',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

// Scope filtering: with no scope injected the watcher covers the whole projects tree.

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

// pruneOffsets is pure and Map-free, so it needs no filesystem.

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

// A fork's transcript starts with a copy of the old one, original timestamps
// intact: notices from it must read as history, not as new limits.

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
  // Synthetic notices can lack the usual bookkeeping fields;
  // a missing timestamp must not make a live limit disappear.
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
  // "resets 10am" read at 10:03 is a limit that has just lifted: resume now,
  // do not roll the clock time forward to tomorrow.
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

// quotaLimits.resetsAt: the reset as an epoch number, which avoids misreading
// the text (zones, DST, dates, rollover past a time that just went by).

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
  // The structured field is decisive: once rejected, the text must not decide
  // instead, even if it would resolve to a valid, currently-due limit.
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
  // The structured field only decides when present as a number; otherwise the
  // text is read.
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

test('a structured reset beyond maxWait is offer-only, the same as a parsed one', () => {
  // A structured reset gets exactly the outcomes a parsed one does. make()
  // reports 24h, so 30 hours out is offered at the reset, never automatic.
  const resetsAt = Date.now() + 30 * 3_600_000;
  const out = make().inspectLine(quotaEntry(resetsAt, "You've hit your session limit · resets in 30 hours"), FILE);
  assert.equal(out.limit?.detection.offerOnly, true, 'a 30-hour-out structured reset must not arm a 24h-capped automatic resume');
});

// RESET_GRACE_MS boundary, both sides, via quotaLimits.resetsAt. The real clock
// keeps running, so this uses seconds of headroom; the exact edge is pinned in
// limitParser.test.ts.

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

// MAX_OVERLOAD_AGE_MS boundary, both sides, with headroom for the running clock.

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

// The sleep/stream-interruption render obeys the same age rule as every other overload render.
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

// Untrusted text that merely looks like a limit banner must not arm a timer;
// a flagged real banner does.

const SUBAGENT_FILE =
  '/home/u/.claude/projects/c--projects-example/subagents/9f1e2d3c-4b1a-4c9e-8a1e-2a5d6e8c9999.jsonl';

test('a subagent file never arms a limit timer, even quoting a real banner verbatim (real false positive)', () => {
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
  // Non-flagged, non-user entry: the shape that reaches the untrusted candidate loop.
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
  // `error` without isApiErrorMessage/rate_limit makes an apiError that is not
  // flagged, so it reaches the untrusted candidate loop.
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

// Flagged entries are exempt from every veto, subagent-file included: a subagent
// that genuinely hits the limit must still arm.

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

// Overload-detection rules, wired through inspectLine.

test('an in-flight retry does not report overload, even from a flagged entry', () => {
  // Claude Code is already retrying: a flagged entry that carries the
  // countdown is still not a stop.
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { content: 'API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10' },
  });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

test('every "Retrying in" form is ignored, with or without an attempt counter', () => {
  for (const text of [
    'API Error (529 {"type":"error"}) · Retrying in 12s',
    'API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10',
    'API Error (529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}) · Retrying in 1 seconds… (attempt 1/10)',
  ]) {
    const line = entry({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', message: { content: text } });
    const out = make().inspectLine(line, FILE);
    assert.equal(out.overload, undefined, text);
    assert.equal(out.limit, undefined, text);
  }
});

test('the transient-429 render (a flagged entry) schedules an overload retry, not a limit timer', () => {
  // Must never arm a usage-limit timer, on either path; it routes to overload.
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    message: { content: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited' },
  });
  const out = make().inspectLine(line, FILE);
  assert.equal(out.limit, undefined, 'must not arm a usage-limit timer');
  assert.ok(out.overload, 'must be routed to overload');
  assert.equal(out.overload.detection.rule, 'transient-429');
});

test('a sleep-interruption render (a flagged entry) schedules an overload retry', () => {
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'server_error',
    message: { content: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.' },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.overload, 'must be routed to overload');
  assert.equal(out.overload.detection.rule, 'stream-interrupted');
});

// The untrusted-text vetoes (quoted text, tool results) apply to the overload
// rules too. Flagged entries stay exempt.

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

// A flagged transient-429 entry that also carries quotaLimits routes to overload:
// the quotaLimits branch is skipped when the entry's own text is a transient-429
// render, whatever quotaLimits.status says.

test('a flagged transient-429 entry WITH quotaLimits still routes to overload, not a limit timer', () => {
  // quotaLimits.status "allowed" with a plausible future resetsAt.
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
  // Positive control: a genuine limit banner with quotaLimits still wins via the structured field.
  const resetsAt = Date.now() + 2 * 3_600_000;
  const out = make().inspectLine(quotaEntry(resetsAt, "You've hit your session limit · resets in 5 hours"), FILE);
  assert.ok(out.limit, 'a genuine quotaLimits entry must still arm via the structured field');
  assert.equal(out.overload, undefined);
});

// The subagent-file veto also covers the overload path's untrusted-text rules.
// Flagged entries stay exempt.

test('an unflagged assistant note in a subagents/ file does not schedule an overload retry', () => {
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

// Every transient render Claude Code documents, as the text of the flagged entry
// it is written in, is an overload, never a limit.

const STATUS_LINK = 'If it persists, check https://status.claude.com.';

/** [render, `error`, `apiErrorStatus`] as Claude Code writes each. */
const FLAGGED_RENDERS: [string, string, number | undefined][] = [
  [`API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. ${STATUS_LINK}`, 'server_error', 529],
  [`API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. ${STATUS_LINK}`, 'server_error', 500],
  [`API Error: Overloaded. This is a server-side issue, usually temporary — try again in a moment. ${STATUS_LINK}`, 'server_error', 529],
  [`API Error: Request rejected (429) · this may be a temporary capacity issue. ${STATUS_LINK}`, 'rate_limit', 429],
  ['API Error: Server is temporarily limiting requests (not your usage limit)', 'rate_limit', 429],
  ['API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited', 'rate_limit', 429],
  ['API Error: No response from API (waited 3m, then 10m on the retry). If a proxy or gateway on your network holds responses until they complete, raise API_TIMEOUT_MS or CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS to wait longer.', 'server_error', undefined],
  ['API Error: Connection to the API was lost (ECONNRESET). This is usually temporary — try again.', 'server_error', undefined],
  ['Request timed out', 'server_error', undefined],
  ['API Error: Server error mid-response. The response above may be incomplete.', 'server_error', undefined],
  ['API Error: Connection lost mid-response. The response above may be incomplete.', 'server_error', undefined],
  ['API Error: Your computer went to sleep mid-response. The response above may be incomplete.', 'server_error', undefined],
  ['API Error: The response stopped arriving. The response above may be incomplete.', 'server_error', undefined],
  ['API Error: Part of the response never arrived. The response above may be incomplete.', 'server_error', undefined],
  ['API Error: The response stream was malformed. The response above may be incomplete.', 'server_error', undefined],
];

/** A synthetic API-error entry, the way Claude Code writes one. */
const flaggedEntry = (text: string, error: string, apiErrorStatus?: number, extra: Record<string, unknown> = {}) =>
  entry({
    type: 'assistant',
    isApiErrorMessage: true,
    error,
    ...(apiErrorStatus === undefined ? {} : { apiErrorStatus }),
    timestamp: new Date().toISOString(),
    cwd: '/projects/example',
    sessionId: '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234',
    message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
    ...extra,
  });

for (const [render, error, status] of FLAGGED_RENDERS) {
  test(`a flagged entry carrying the documented render is an overload, not a limit: ${render.slice(0, 56)}`, () => {
    const out = make().inspectLine(flaggedEntry(render, error, status), FILE);
    assert.equal(out.limit, undefined, 'never a usage limit');
    assert.ok(out.overload, 'an overload');
  });
}

test('a flagged 429 capacity render WITH rejected quotaLimits is still not a limit', () => {
  // Claude Code never writes quotaLimits on this entry; the skip is belt and
  // braces, and must hold for the "Request rejected (429)" render too.
  const line = flaggedEntry(
    `API Error: Request rejected (429) · this may be a temporary capacity issue. ${STATUS_LINK}`,
    'rate_limit',
    429,
    { quotaLimits: { status: 'rejected', resetsAt: Math.floor((Date.now() + 3_600_000) / 1000), rateLimitType: 'five_hour' } },
  );
  const out = make().inspectLine(line, FILE);
  assert.equal(out.limit, undefined);
  assert.ok(out.overload);
});

// Not transient, so no resume - a flagged entry included.
const NOT_TRANSIENT: [string, string, number][] = [
  ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'authentication_failed', 401],
  ["There's an issue with the selected model (claude-x). It may not exist or you may not have access to it. Run --model to pick a different model.", 'invalid_request', 404],
  ['API Error: Usage credits required for 1M context · turn on usage credits at claude.ai/settings/usage, or use --model to switch to standard context', 'invalid_request', 400],
  ["You've hit your monthly spend limit · raise it at claude.ai/settings/usage", 'rate_limit', 429],
];
for (const [text, error, status] of NOT_TRANSIENT) {
  test(`a flagged entry that is not transient produces no overload and no resume: ${text.slice(0, 50)}`, () => {
    const out = make().inspectLine(flaggedEntry(text, error, status), FILE);
    assert.equal(out.overload, undefined);
    assert.equal(out.limit, undefined);
  });
}

// Overloads are read only from an entry Claude Code marked as an API error; an
// unflagged entry is someone TALKING ABOUT an error.

const RENDER_ON_ITS_OWN_LINE = `API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. ${STATUS_LINK}`;

test('an unflagged assistant entry with a render on its own line does not arm an overload', () => {
  for (const render of [RENDER_ON_ITS_OWN_LINE, 'API Error: Request timed out.', 'API Error: 529 Overloaded']) {
    const line = entry({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `That failed again:\n${render}\nI will wait.` }] },
    });
    assert.equal(make().inspectLine(line, FILE).overload, undefined, render);
  }
});

test('an unflagged assistant entry that is exactly a render does not arm an overload', () => {
  const line = entry({ type: 'assistant', message: { content: 'API Error: Request timed out.' } });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

test('a tool_result holding grep -n output of the renders does not arm an overload', () => {
  const grep = `113:API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. ${STATUS_LINK}`;
  const line = entry({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_10', content: grep }] },
  });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
  const plain = entry({
    type: 'assistant',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_11', content: RENDER_ON_ITS_OWN_LINE }] },
  });
  assert.equal(make().inspectLine(plain, FILE).overload, undefined);
});

test('a user message pasting a render does not arm an overload', () => {
  const line = entry({ type: 'user', message: { content: RENDER_ON_ITS_OWN_LINE } });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

for (const prose of [
  'npm install failed: fetch failed (proxy). I will retry with the registry mirror.',
  'All the tests pass except one case where the request timed out.',
  'The staging endpoint returned Internal server error for the upload, so I skipped it.',
  'Earlier we saw API Error: 529 Overloaded, but the retry succeeded.',
]) {
  test(`unflagged assistant prose does not arm an overload retry: ${prose.slice(0, 32)}`, () => {
    const line = entry({ type: 'assistant', message: { content: [{ type: 'text', text: prose }] } });
    assert.equal(make().inspectLine(line, FILE).overload, undefined, prose);
  });
}

test('a flagged entry keeps full recall, with no API Error head needed', () => {
  const line = entry({ type: 'assistant', isApiErrorMessage: true, message: { content: 'Request timed out.' } });
  assert.equal(make().inspectLine(line, FILE).overload?.detection.rule, 'timeout');
});

test('an overload hit carries its entry timestamp, the identity every window shares', () => {
  const ts = new Date(Date.now() - 60_000).toISOString();
  const line = entry({ type: 'assistant', isApiErrorMessage: true, timestamp: ts, message: { content: 'API Error: 529 Overloaded' } });
  assert.equal(make().inspectLine(line, FILE).overload?.entryTimestampMs, new Date(ts).getTime());
});

test('an overload hit from an entry with no timestamp carries none', () => {
  const line = entry({ type: 'assistant', isApiErrorMessage: true, message: { content: 'API Error: 529 Overloaded' } });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.overload);
  assert.equal(out.overload.entryTimestampMs, undefined);
});

// The limit type travels with the detection, so the fire decision can tell limits
// native auto-continue covers (five_hour) from those it never continues (weekly,
// Opus, Sonnet, Fable, usage credit).

const typedQuotaEntry = (rateLimitType: unknown, text = "You've hit your limit · resets in 5 hours") =>
  entry({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    timestamp: new Date().toISOString(),
    cwd: '/projects/example',
    quotaLimits: {
      status: 'rejected',
      resetsAt: Math.floor((Date.now() + 2 * 3_600_000) / 1000),
      ...(rateLimitType === undefined ? {} : { rateLimitType }),
    },
    message: { content: [{ type: 'text', text }] },
  });

test('a flagged five-hour quotaLimits entry carries rateLimitType five_hour', () => {
  const out = make().inspectLine(typedQuotaEntry('five_hour'), FILE);
  assert.equal(out.limit?.detection.rule, 'quota-limits');
  assert.equal(out.limit?.detection.rateLimitType, 'five_hour');
});

test('a flagged seven_day quotaLimits entry carries rateLimitType seven_day', () => {
  const out = make().inspectLine(typedQuotaEntry('seven_day'), FILE);
  assert.equal(out.limit?.detection.rule, 'quota-limits');
  assert.equal(out.limit?.detection.rateLimitType, 'seven_day');
});

test('a quotaLimits entry whose rateLimitType is missing or not a string leaves the type undefined', () => {
  for (const type of [undefined, 7, null, { a: 1 }]) {
    const out = make().inspectLine(typedQuotaEntry(type), FILE);
    assert.equal(out.limit?.detection.rule, 'quota-limits');
    assert.equal(out.limit?.detection.rateLimitType, undefined, JSON.stringify(type));
    assert.equal(Object.hasOwn(out.limit!.detection, 'rateLimitType'), false);
  }
});

test('the text path maps "weekly limit" to seven_day and "session limit" to five_hour', () => {
  for (const [label, type] of [
    ['weekly', 'seven_day'],
    ['session', 'five_hour'],
    ['Opus', 'seven_day_opus'],
  ]) {
    const line = entry({
      type: 'assistant',
      isApiErrorMessage: true,
      error: 'rate_limit',
      apiErrorStatus: 429,
      timestamp: new Date().toISOString(),
      message: { content: [{ type: 'text', text: `You've hit your ${label} limit · resets in 5 hours` }] },
    });
    const out = make().inspectLine(line, FILE);
    assert.equal(out.limit?.detection.rule !== 'quota-limits', true, 'setup: no quotaLimits, so this is the text path');
    assert.equal(out.limit?.detection.rateLimitType, type, label);
  }
});

test('the text path leaves the type undefined when the notice names none', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.limit);
  assert.equal(out.limit.detection.rateLimitType, undefined);
});


// An empty quotaLimits.rateLimitType reads as absent; an absent one falls back
// to the label in the entry's own text.
test('a quotaLimits entry with an empty rateLimitType leaves the type undefined', () => {
  const out = make().inspectLine(typedQuotaEntry(''), FILE);
  assert.equal(out.limit?.detection.rule, 'quota-limits');
  assert.equal(Object.hasOwn(out.limit!.detection, 'rateLimitType'), false);
});

test('a quotaLimits entry with no usable rateLimitType takes the type from its own text', () => {
  for (const type of [undefined, '', 7]) {
    const weekly = make().inspectLine(typedQuotaEntry(type, "You've hit your weekly limit · resets in 5 hours"), FILE);
    assert.equal(weekly.limit?.detection.rule, 'quota-limits', 'setup: the structured path');
    assert.equal(weekly.limit?.detection.rateLimitType, 'seven_day', String(type));
  }
});

test('the structured rateLimitType wins over a different label in the text', () => {
  const out = make().inspectLine(typedQuotaEntry('five_hour', "You've hit your weekly limit · resets in 5 hours"), FILE);
  assert.equal(out.limit?.detection.rateLimitType, 'five_hour');
});

test('a quotaLimits entry whose text names no type and whose field has none leaves it undefined', () => {
  const out = make().inspectLine(typedQuotaEntry(undefined, 'Something went wrong with your plan limits'), FILE);
  assert.equal(out.limit?.detection.rule, 'quota-limits');
  assert.equal(Object.hasOwn(out.limit!.detection, 'rateLimitType'), false);
});

// A usage limit is read only from an entry Claude Code flagged
// (isApiErrorMessage: true); unflagged prose must not arm a timer.

const C1_PROSE = [
  "The session hit its usage limit and resets at 2:10am, so I'll pick this up after that.",
  'I hit the GitHub API rate limit. Try again in 45 minutes and it should work.',
  "You've hit your session limit, resets 11pm. I'll stop here.",
];

for (const prose of C1_PROSE) {
  test(`unflagged assistant text does not arm a limit: ${prose.slice(0, 40)}`, () => {
    const line = entry({ type: 'assistant', message: { content: [{ type: 'text', text: prose }] } });
    assert.equal(make().inspectLine(line, FILE).limit, undefined, prose);
  });
}

test('an unflagged thinking block does not arm a limit', () => {
  const line = entry({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: C1_PROSE[1], signature: 'sig' }] },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('an unflagged tool_use input does not arm a limit', () => {
  const line = entry({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'toolu_c1', name: 'Bash', input: { command: 'sleep 2700', description: C1_PROSE[1] } }],
    },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('an unflagged entry marked only by error: rate_limit or status 429 does not arm a limit', () => {
  for (const marks of [{ error: 'rate_limit' }, { apiErrorStatus: 429 }, { status: 429 }]) {
    const line = entry({ type: 'assistant', ...marks, message: { content: "You've hit your session limit · resets 11pm" } });
    assert.equal(make().inspectLine(line, FILE).limit, undefined, JSON.stringify(marks));
  }
});

test('a flagged real render still arms a limit (positive control)', () => {
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    message: { content: [{ type: 'text', text: "You've hit your session limit · resets 11pm (America/Chicago)" }] },
  });
  assert.ok(make().inspectLine(line, FILE).limit);
});

// An overload, too, only from isApiErrorMessage: true - a bare `error` string or a 5xx status does not admit an entry.
test('an unflagged entry with a top-level error string or a 529 status does not arm an overload', () => {
  for (const marks of [{ error: 'server_error' }, { apiErrorStatus: 529 }, { status: 529 }]) {
    const line = entry({ type: 'assistant', ...marks, message: { content: 'API Error: 529 Overloaded' } });
    const out = make().inspectLine(line, FILE);
    assert.equal(out.overload, undefined, JSON.stringify(marks));
    assert.equal(out.limit, undefined, JSON.stringify(marks));
  }
});

// A usage limit hit DURING COMPACTION: a failed /compact is written UNFLAGGED as a
// `system`/`local_command` entry whose content is
// `<local-command-stderr>Error during compaction: You've hit your ...`. Only Claude
// Code writes `system` entries, so admitting exactly this shape is safe.

const COMPACT_TEXT = "You've hit your session limit · resets 8:30pm (America/Chicago)";
const compactContent = (text = COMPACT_TEXT) => `<local-command-stderr>Error during compaction: ${text}</local-command-stderr>`;

/** The real entry shape, with a fresh timestamp so its reset is live. */
const compactionEntry = (over: Record<string, unknown> = {}, ts = new Date(Date.now() - 60_000).toISOString()) => ({
  parentUuid: '966d7dcf-bf64-490d-a4f5-cdb4be3ee1a8',
  isSidechain: false,
  type: 'system',
  subtype: 'local_command',
  content: compactContent(),
  level: 'info',
  timestamp: ts,
  uuid: 'e7466dc8-f37f-4842-b810-4b8381491b9a',
  isMeta: false,
  userType: 'external',
  entrypoint: 'claude-vscode',
  cwd: 'C:/Users/thegr/Dream-Mosaic/Projects/limit-break',
  sessionId: '05690955-d99d-46e1-bc06-109e58dadc2f',
  version: '2.1.267',
  gitBranch: 'main',
  ...over,
});

test('a usage limit hit during compaction arms a limit, typed from its label', () => {
  const out = make().inspectLine(entry(compactionEntry()), FILE);
  assert.ok(out.limit, 'the unflagged compaction failure must be detected');
  assert.equal(out.limit.detection.rateLimitType, 'five_hour', 'session -> five_hour');
  assert.equal(out.limit.detection.rule, 'clock-reset');
  assert.equal(out.limit.cwd, 'C:/Users/thegr/Dream-Mosaic/Projects/limit-break');
  assert.equal(out.limit.file, FILE);
  const hoursOut = (out.limit.detection.resumeAt.getTime() - Date.now()) / 3_600_000;
  assert.ok(hoursOut > 0 && hoursOut <= 24, `resumeAt ${hoursOut}h out`);
  assert.ok(!out.limit.detection.text.includes('local-command-stderr'), 'the tags are stripped');
  assert.ok(!out.limit.detection.text.includes('Error during compaction'), 'and so is the prefix');
});

test('the compaction text is read as trusted, so a relative reset works too', () => {
  const out = make().inspectLine(entry(compactionEntry({ content: compactContent("You've hit your weekly limit · resets in 5 hours") })), FILE);
  assert.ok(out.limit);
  assert.equal(out.limit.detection.rateLimitType, 'seven_day');
});

test('an unrecognised limit label leaves rateLimitType undefined', () => {
  const out = make().inspectLine(entry(compactionEntry({ content: compactContent("You've hit your org limit · resets in 5 hours") })), FILE);
  assert.ok(out.limit);
  assert.equal(Object.hasOwn(out.limit.detection, 'rateLimitType'), false);
});

test('a fork copy of an old compaction failure is history, not a limit (stale-reset rule)', () => {
  // Stale timestamp: that 8:30pm reset passed long ago.
  const out = make().inspectLine(entry(compactionEntry({}, '2026-09-11T21:49:45.839Z')), FILE);
  assert.equal(out.limit, undefined);
});

// One mutation per match condition: each of these is the real entry with
// exactly one condition broken.
test('type must be system', () => {
  for (const type of ['user', 'assistant', 'progress']) {
    assert.equal(make().inspectLine(entry(compactionEntry({ type })), FILE).limit, undefined, type);
  }
});

test('subtype must be local_command', () => {
  for (const subtype of ['informational', 'api_error', 'compact_boundary', undefined]) {
    assert.equal(make().inspectLine(entry(compactionEntry({ subtype })), FILE).limit, undefined, String(subtype));
  }
});

test('content must be a string', () => {
  const blocks = [{ type: 'text', text: compactContent() }];
  for (const content of [blocks, { text: compactContent() }, 42, null]) {
    assert.equal(make().inspectLine(entry(compactionEntry({ content })), FILE).limit, undefined, JSON.stringify(content));
  }
});

test('content must START with the stderr tag and the compaction prefix', () => {
  const bad = [
    // stdout, not stderr
    `<local-command-stdout>Error during compaction: ${COMPACT_TEXT}</local-command-stdout>`,
    // the same words, not at the start
    `Note: <local-command-stderr>Error during compaction: ${COMPACT_TEXT}</local-command-stderr>`,
    // a different error under the same tag
    `<local-command-stderr>Compaction failed: ${COMPACT_TEXT}</local-command-stderr>`,
    // the prefix without its tag
    `Error during compaction: ${COMPACT_TEXT}`,
    // bare text
    COMPACT_TEXT,
  ];
  for (const content of bad) {
    assert.equal(make().inspectLine(entry(compactionEntry({ content })), FILE).limit, undefined, content);
  }
});

test('the text must name a usage limit', () => {
  for (const text of ['Conversation too long. Press esc twice to go up a few messages and try again.', 'Request timed out after 120 seconds', 'Not enough messages to compact.']) {
    const out = make().inspectLine(entry(compactionEntry({ content: compactContent(text) })), FILE);
    assert.equal(out.limit, undefined, text);
  }
});

test('user prose, an assistant message and a tool result quoting the compaction line never arm', () => {
  const quoted = compactContent();
  const shapes = [
    { type: 'user', message: { role: 'user', content: quoted } },
    { type: 'assistant', message: { content: [{ type: 'text', text: quoted }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: quoted }] } },
    // Even dressed as the system entry, a type other than system is not one.
    { type: 'user', subtype: 'local_command', content: quoted },
  ];
  for (const shape of shapes) {
    assert.equal(make().inspectLine(entry({ ...shape, cwd: 'C:/p', timestamp: new Date().toISOString() }), FILE).limit, undefined, JSON.stringify(shape).slice(0, 60));
  }
});

test('a limit-named compaction failure with no parseable reset time arms nothing and warns, naming session and text', () => {
  const warnings: string[] = [];
  const w = new TranscriptWatcher(() => 24, () => 5, { info() {}, warn: (m: string) => warnings.push(m), error() {} });
  const out = w.inspectLine(entry(compactionEntry({ content: compactContent("You've hit your session limit") })), FILE);
  assert.equal(out.limit, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234/);
  assert.match(warnings[0]!, /You've hit your session limit/);
  assert.match(warnings[0]!, /no parseable reset time/);
});

test('a STALE reset is history and does not claim "no parseable reset time"', () => {
  const warnings: string[] = [];
  const w = new TranscriptWatcher(() => 24, () => 5, { info() {}, warn: (m: string) => warnings.push(m), error() {} });
  assert.equal(w.inspectLine(entry(compactionEntry({}, '2026-09-11T21:49:45.839Z')), FILE).limit, undefined);
  // Never silent - but as history, once per file, not as a miss.
  assert.equal(w.inspectLine(entry(compactionEntry({}, '2026-09-11T21:49:45.839Z')), FILE).limit, undefined);
  assert.equal(warnings.length, 1, `saw ${JSON.stringify(warnings)}`);
  assert.match(warnings[0]!, /^Usage limit during compaction in session 0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234 reset at /);
  assert.match(warnings[0]!, /history/);
  assert.doesNotMatch(warnings[0]!, /no parseable reset time/);
});

test('an unrelated compaction failure does not warn about a reset time', () => {
  const warnings: string[] = [];
  const w = new TranscriptWatcher(() => 24, () => 5, { info() {}, warn: (m: string) => warnings.push(m), error() {} });
  w.inspectLine(entry(compactionEntry({ content: compactContent('Conversation too long.') })), FILE);
  assert.deepEqual(warnings, []);
});

test('outside the watch scope a compaction failure is ignored like any other entry', () => {
  const w = new TranscriptWatcher(() => 24, () => 5, silent, () => ({ mode: 'workspace', folders: ['C:/elsewhere'] }));
  assert.equal(w.inspectLine(entry(compactionEntry()), FILE).limit, undefined);
});

// Claude Code's native auto-continue status lines are observed (armed and cancelled).

const nativeLine = (content: unknown, over: Record<string, unknown> = {}) =>
  entry({
    parentUuid: '966972dc-f14b-4f93-a0a0-75b00c0410f2',
    isSidechain: false,
    type: 'system',
    subtype: 'informational',
    content,
    isMeta: false,
    timestamp: '2026-09-23T11:58:48.136Z',
    uuid: 'a033b426-bcef-4fd3-9953-0b9a7cebb303',
    level: 'notice',
    userType: 'external',
    entrypoint: 'cli',
    cwd: 'C:/Users/thegr/Dream-Mosaic/Projects/limit-break',
    sessionId: 'fd493448-9183-45bd-865d-ea2ccb227021',
    version: '2.1.278',
    ...over,
  });

const NATIVE_ARMED = 'Usage limit reached · continuing automatically at 11:10am · esc or type to cancel';
const NATIVE_CANCELLED =
  'Automatic continue cancelled · Claude Code exited during the wait, so the task will not resume on its own when the usage limit resets (send a prompt after the reset to continue)';

test('inspectLine reports armed, cancelled and fired status lines, and arms nothing from them', () => {
  const cases: [string, string][] = [
    [NATIVE_ARMED, 'armed'],
    ['Usage limit reached again · continuing automatically at 4:10pm · esc or type to cancel', 'armed'],
    [NATIVE_CANCELLED, 'cancelled'],
    ['Usage limit reset · continuing automatically', 'fired'],
  ];
  for (const [content, kind] of cases) {
    const out = make().inspectLine(nativeLine(content), FILE);
    assert.equal(out.nativeStatus?.status.kind, kind, content);
    assert.equal(out.nativeStatus?.status.text, content);
    assert.equal(out.nativeStatus?.file, FILE);
    assert.equal(out.nativeStatus?.cwd, 'C:/Users/thegr/Dream-Mosaic/Projects/limit-break');
    assert.equal(out.limit, undefined, 'a status line is not a limit: ' + content);
    assert.equal(out.overload, undefined, content);
  }
});

test('the same words in a user entry, an assistant entry or another subtype are not status', () => {
  const shapes = [
    nativeLine(NATIVE_ARMED, { type: 'user' }),
    nativeLine(NATIVE_ARMED, { type: 'assistant' }),
    nativeLine(NATIVE_CANCELLED, { subtype: 'local_command' }),
    nativeLine([{ type: 'text', text: NATIVE_CANCELLED }]),
    entry({ type: 'user', message: { role: 'user', content: NATIVE_CANCELLED } }),
  ];
  for (const line of shapes) {
    assert.equal(make().inspectLine(line, FILE).nativeStatus, undefined, line.slice(0, 80));
  }
});

test('outside the watch scope a status line is ignored like any other entry', () => {
  const w = new TranscriptWatcher(() => 24, () => 5, silent, () => ({ mode: 'workspace', folders: ['C:/elsewhere'] }));
  assert.equal(w.inspectLine(nativeLine(NATIVE_ARMED), FILE).nativeStatus, undefined);
});

test('a scan fires onNativeStatus for each status line, ahead of a limit in the same batch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-native-scan-'));
  try {
    const file = path.join(dir, '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl');
    fs.writeFileSync(
      file,
      nativeLine(NATIVE_ARMED) + '\n' +
        entry({ type: 'assistant', isApiErrorMessage: true, cwd: 'C:/p', message: { content: 'Claude AI usage limit reached. Try again in 5 hours' } }) + '\n' +
        nativeLine(NATIVE_CANCELLED) + '\n',
    );
    const w = make();
    const seen: string[] = [];
    let limits = 0;
    w.onNativeStatus((h: { status: { kind: string } }) => seen.push(h.status.kind));
    w.onHit(() => limits++);
    await (w as unknown as { scanFile(f: string): Promise<void> }).scanFile(file);
    // The limit does not hide the cancel line that follows it in the batch.
    assert.deepEqual(seen, ['armed', 'cancelled']);
    assert.equal(limits, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a scan of status lines alone reports every one, in order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-native-scan-'));
  try {
    const file = path.join(dir, '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl');
    fs.writeFileSync(
      file,
      nativeLine(NATIVE_ARMED) + '\n' + nativeLine(NATIVE_CANCELLED) + '\n' + nativeLine('Usage limit reset · continuing automatically') + '\n',
    );
    const w = make();
    const seen: string[] = [];
    w.onNativeStatus((h: { status: { kind: string } }) => seen.push(h.status.kind));
    await (w as unknown as { scanFile(f: string): Promise<void> }).scanFile(file);
    assert.deepEqual(seen, ['armed', 'cancelled', 'fired']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with two limits in one batch the FIRST still decides (unchanged by the status-line pass)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-native-scan-'));
  try {
    const file = path.join(dir, '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl');
    const limitLine = (hours: number) =>
      entry({ type: 'assistant', isApiErrorMessage: true, cwd: 'C:/p', message: { content: `Claude AI usage limit reached. Try again in ${hours} hours` } });
    fs.writeFileSync(file, limitLine(5) + '\n' + limitLine(3) + '\n');
    const w = make();
    const hits: string[] = [];
    w.onHit((h: { detection: { text: string } }) => hits.push(h.detection.text));
    await (w as unknown as { scanFile(f: string): Promise<void> }).scanFile(file);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!, /in 5 hours/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the /rate-limit-options "Don\'t continue automatically" user entry and the log-only lines are reported too (binary-derived strings)', () => {
  const wait = 'Automatic continue cancelled. Your session will wait for you instead; /rate-limit-options can arm it again.';
  const userEntry = entry({
    type: 'user',
    message: { role: 'user', content: `<local-command-stdout>${wait}</local-command-stdout>` },
    cwd: 'C:/p',
    timestamp: new Date().toISOString(),
  });
  const out = make().inspectLine(userEntry, FILE);
  assert.deepEqual(out.nativeStatus?.status, { kind: 'cancelled', text: wait });
  assert.equal(out.limit, undefined);
  const other = make().inspectLine(nativeLine('Usage limit available again · continuing now'), FILE);
  assert.equal(other.nativeStatus?.status.kind, 'other');
});

// scanFile batch priority: a limit outranks everything else in the batch, and one
// bad line cannot drop a recorded limit.

type ScanCounts = { hits: number; overloads: number; inputs: number };

/** Write `lines` as one batch to a fresh transcript and scan it once. */
async function scanBatch(lines: string[], watcher = make()): Promise<ScanCounts> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-batch-'));
  try {
    const file = path.join(dir, '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const counts: ScanCounts = { hits: 0, overloads: 0, inputs: 0 };
    watcher.onHit(() => counts.hits++);
    watcher.onOverload(() => counts.overloads++);
    watcher.onInputNeeded(() => counts.inputs++);
    await (watcher as unknown as { scanFile(f: string): Promise<void> }).scanFile(file);
    return counts;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const batchOverload = () =>
  entry({ type: 'assistant', isApiErrorMessage: true, cwd: 'C:/p', timestamp: new Date().toISOString(), message: { content: 'API Error: 529 Overloaded' } });
const batchLimit = () =>
  entry({ type: 'assistant', isApiErrorMessage: true, cwd: 'C:/p', timestamp: new Date().toISOString(), message: { content: 'Claude AI usage limit reached. Try again in 5 hours' } });
const batchTurnEnd = () => entry({ type: 'assistant', cwd: 'C:/p', message: { stop_reason: 'end_turn', content: 'Done.' } });

test('a limit outranks every overload and turn end in the same batch', async () => {
  const counts = await scanBatch([batchOverload(), batchLimit(), batchOverload(), batchTurnEnd()]);
  assert.deepEqual(counts, { hits: 1, overloads: 0, inputs: 0 });
});

test('a limit that comes first or last in the batch outranks the same way', async () => {
  assert.deepEqual(await scanBatch([batchLimit(), batchOverload(), batchTurnEnd()]), { hits: 1, overloads: 0, inputs: 0 });
  assert.deepEqual(await scanBatch([batchTurnEnd(), batchOverload(), batchLimit()]), { hits: 1, overloads: 0, inputs: 0 });
});

test('an overload in the batch suppresses the turn end ("your turn" would be a lie)', async () => {
  const counts = await scanBatch([batchOverload(), batchTurnEnd()]);
  assert.deepEqual(counts, { hits: 0, overloads: 1, inputs: 0 });
});

test('a turn end on its own still reports input needed (control)', async () => {
  assert.deepEqual(await scanBatch([batchTurnEnd()]), { hits: 0, overloads: 0, inputs: 1 });
});

test('a line that is valid JSON but not an object is not an entry', () => {
  for (const line of ['null', '7', '"text"', '[1,2]', 'true']) {
    assert.deepEqual(make().inspectLine(line, FILE), {}, line);
  }
});

test('a limit already recorded in a batch still fires when a later line is JSON null', async () => {
  const counts = await scanBatch([batchLimit(), 'null', '[1]', batchTurnEnd()]);
  assert.deepEqual(counts, { hits: 1, overloads: 0, inputs: 0 });
});

test('a line that makes inspectLine throw is skipped and logged, and the batch still fires its limit', async () => {
  const warnings: string[] = [];
  const w = new TranscriptWatcher(() => 24, () => 5, { info() {}, warn: (m: string) => warnings.push(m), error() {} });
  const real = w.inspectLine.bind(w);
  (w as unknown as { inspectLine: typeof w.inspectLine }).inspectLine = (line: string, file: string) => {
    if (line.includes('BOOM')) {
      throw new Error('boom');
    }
    return real(line, file);
  };
  const counts = await scanBatch([batchLimit(), entry({ type: 'user', message: { content: 'BOOM' } }), batchTurnEnd()], w);
  assert.deepEqual(counts, { hits: 1, overloads: 0, inputs: 0 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Cannot inspect a line/);
});

const warnWatcher = () => {
  const warnings: string[] = [];
  return { warnings, w: new TranscriptWatcher(() => 24, () => 5, { info() {}, warn: (m: string) => warnings.push(m), error() {} }) };
};
const flaggedText = (text: string, over: Record<string, unknown> = {}) =>
  entry({ type: 'assistant', isApiErrorMessage: true, cwd: 'C:/p', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text }] }, ...over });

test('a flagged entry that reads as a usage limit with no parseable reset time arms nothing and warns', () => {
  const { w, warnings } = warnWatcher();
  const out = w.inspectLine(flaggedText("You've hit your session limit"), FILE);
  assert.equal(out.limit, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234/);
  assert.match(warnings[0]!, /You've hit your session limit/);
  assert.match(warnings[0]!, /no parseable reset time/);
});

test('it warns once per entry even when the text repeats in several fields', () => {
  const { w, warnings } = warnWatcher();
  w.inspectLine(flaggedText("You've hit your session limit", { error: "You've hit your session limit", detail: "You've hit your session limit" }), FILE);
  assert.equal(warnings.length, 1);
});

test('a flagged limit that parses does not warn (control)', () => {
  const { w, warnings } = warnWatcher();
  assert.ok(w.inspectLine(flaggedText("You've hit your session limit · resets in 5 hours"), FILE).limit);
  assert.deepEqual(warnings, []);
});

test('a flagged limit with a readable but STALE reset is history, not a miss (warned once, as history)', () => {
  const { w, warnings } = warnWatcher();
  const stale = flaggedText("You've hit your session limit · resets in 5 hours", { timestamp: hoursAgo(20) });
  assert.equal(w.inspectLine(stale, FILE).limit, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /history/);
  assert.doesNotMatch(warnings[0]!, /no parseable reset time/);
});

test('a flagged overload does NOT warn, including one that names a limit and one too old to act on', () => {
  const { w, warnings } = warnWatcher();
  assert.ok(w.inspectLine(flaggedText('API Error: 529 Overloaded'), FILE).overload);
  const transient = flaggedText('API Error: Server is temporarily limiting requests (not your usage limit) \u00b7 Rate limited', { error: 'rate_limit', apiErrorStatus: 429 });
  assert.ok(w.inspectLine(transient, FILE).overload, 'routed to overload');
  const oldTransient = flaggedText('API Error: Server is temporarily limiting requests (not your usage limit) \u00b7 Rate limited', {
    error: 'rate_limit',
    apiErrorStatus: 429,
    timestamp: new Date(Date.now() - 2 * MAX_OVERLOAD_AGE_MS).toISOString(),
  });
  assert.equal(w.inspectLine(oldTransient, FILE).overload, undefined, 'too old to retry');
  assert.deepEqual(warnings, []);
});

test('a flagged entry that is not about a limit does not warn, and neither does unflagged prose', () => {
  const { w, warnings } = warnWatcher();
  w.inspectLine(flaggedText('No response requested.'), FILE);
  w.inspectLine(entry({ type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your session limit" }] } }), FILE);
  w.inspectLine(entry({ type: 'user', message: { content: "my usage limit resets at 3pm, right?" } }), FILE);
  assert.deepEqual(warnings, []);
});

test('a long file-sized string in a flagged entry is not read for the warning either', () => {
  const { w, warnings } = warnWatcher();
  w.inspectLine(flaggedText("You've hit your session limit " + 'x'.repeat(500)), FILE);
  assert.deepEqual(warnings, []);
});

// The structured path's three outcomes; no limit that is detected but not
// scheduled goes unlogged.

test('a structured weekly reset beyond maxWaitHours is picked up as offer-only, type intact', () => {
  const resetsAt = Date.now() + 3 * 86_400_000;
  const line = entry({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    timestamp: new Date().toISOString(),
    cwd: '/projects/example',
    quotaLimits: { status: 'rejected', resetsAt: Math.floor(resetsAt / 1000), rateLimitType: 'seven_day' },
    message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 4, 1am (America/Chicago)" }] },
  });
  const { w, warnings } = warnWatcher();
  const out = w.inspectLine(line, FILE);
  assert.ok(out.limit, 'a weekly limit is no longer dropped');
  assert.equal(out.limit.detection.offerOnly, true);
  assert.equal(out.limit.detection.rateLimitType, 'seven_day');
  assert.equal(out.limit.detection.resumeAt.getTime(), Math.floor(resetsAt / 1000) * 1000);
  assert.deepEqual(warnings, []);
});

test('a structured reset within maxWaitHours carries no offerOnly key', () => {
  const out = make().inspectLine(quotaEntry(Date.now() + 2 * 3_600_000, "You've hit your session limit · resets 3pm"), FILE);
  assert.ok(out.limit);
  assert.equal(Object.hasOwn(out.limit.detection, 'offerOnly'), false);
});

test('a structured reset more than 8 days out arms nothing and warns, naming the session and the reason', () => {
  const { w, warnings } = warnWatcher();
  const out = w.inspectLine(quotaEntry(Date.now() + 9 * 86_400_000, "You've hit your weekly limit"), FILE);
  assert.equal(out.limit, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234/);
  assert.match(warnings[0]!, /more than 8 days out/);
});

test('a structured reset in the past warns as history, once per file however many copies the fork holds', () => {
  const { w, warnings } = warnWatcher();
  const written = new Date(Date.now() - 12 * 3_600_000);
  const stale = quotaEntry(written.getTime() + 3_600_000, "You've hit your session limit · resets 1am", written);
  assert.equal(w.inspectLine(stale, FILE).limit, undefined);
  assert.equal(w.inspectLine(stale, FILE).limit, undefined);
  assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0]!, /0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234/);
  assert.match(warnings[0]!, /history/);
  assert.doesNotMatch(warnings[0]!, /no parseable reset time/);
  const OTHER = FILE.replace('0b3d1f66', '1c4e2a77');
  w.inspectLine(stale, OTHER);
  assert.equal(warnings.length, 2, 'another file (another fork) gets its own one warning');
});

test('a stale TEXT reset warns once per file too, and shares the once with the structured path', () => {
  const { w, warnings } = warnWatcher();
  const stale = flaggedText("You've hit your session limit · resets in 5 hours", { timestamp: hoursAgo(20) });
  w.inspectLine(stale, FILE);
  w.inspectLine(stale, FILE);
  const written = new Date(Date.now() - 12 * 3_600_000);
  w.inspectLine(quotaEntry(written.getTime() + 3_600_000, 'x limit', written), FILE);
  assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0]!, /history/);
});

test('an absurd text reset warns every time it is seen (it is not fork history)', () => {
  const { w, warnings } = warnWatcher();
  const far = flaggedText(`You've hit your session limit, resets at ${new Date(Date.now() + 20 * 86_400_000).toISOString()}`);
  assert.equal(w.inspectLine(far, FILE).limit, undefined);
  w.inspectLine(far, FILE);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /more than 8 days out/);
});

test('the offsets prune forgets a file it no longer tracks, so its warn-once memory does not grow forever', () => {
  const { w, warnings } = warnWatcher();
  const written = new Date(Date.now() - 12 * 3_600_000);
  const stale = quotaEntry(written.getTime() + 3_600_000, 'x limit', written);
  w.inspectLine(stale, FILE);
  (w as unknown as { prune(files: readonly string[]): void }).prune([]);
  w.inspectLine(stale, FILE);
  assert.equal(warnings.length, 2, 'a file pruned and met again is a new file');
});

// The dated weekly-limit text (written with no quotaLimits on older builds), on
// both the flagged and the compaction path.

/** "Oct 4" for an instant `days` from now, as Claude Code's Zd renders it in Chicago. */
const chicagoDate = (days: number) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' }).formatToParts(
    new Date(Date.now() + days * 86_400_000),
  );
  return `${parts.find((p) => p.type === 'month')!.value} ${parts.find((p) => p.type === 'day')!.value}`;
};

test('a flagged weekly limit in the dated form, with no quotaLimits, is picked up as offer-only', () => {
  const { w, warnings } = warnWatcher();
  const out = w.inspectLine(
    flaggedText(`You've hit your weekly limit · resets ${chicagoDate(3)}, 1am (America/Chicago)`, { error: 'rate_limit' }),
    FILE,
  );
  assert.ok(out.limit, `not picked up; warnings: ${JSON.stringify(warnings)}`);
  assert.equal(out.limit.detection.offerOnly, true);
  assert.equal(out.limit.detection.rateLimitType, 'seven_day');
  const daysOut = (out.limit.detection.resumeAt.getTime() - Date.now()) / 86_400_000;
  assert.ok(daysOut > 1.5 && daysOut < 3.5, `expected ~2-3 days out, got ${daysOut.toFixed(2)}`);
  assert.deepEqual(warnings, []);
});

test('a compaction failure at a weekly limit is picked up too', () => {
  const out = make().inspectLine(
    entry(compactionEntry({ content: compactContent(`You've hit your weekly limit · resets ${chicagoDate(3)} at 9am (America/Chicago)`) })),
    FILE,
  );
  assert.ok(out.limit);
  assert.equal(out.limit.detection.offerOnly, true);
});

test('a dated weekly limit with no zone arms nothing and warns that the zone is missing', () => {
  const { w, warnings } = warnWatcher();
  assert.equal(w.inspectLine(flaggedText(`You've hit your weekly limit · resets ${chicagoDate(3)}, 1am`), FILE).limit, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /no parseable reset time \(a dated reset with no time zone\)/);
  assert.match(warnings[0]!, /0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234/);
});

test('a real dated-reset line met today in a fork is history: not picked up, one warning', () => {
  // Real line, less the usage block.
  const real = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-31T04:55:10.016Z',
    message: { model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your weekly limit · resets Aug 4, 1am (America/Chicago)" }] },
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    cwd: 'C:\\Users\\thegr\\Dream-Mosaic\\Projects\\unwritten-chronicles\\.claude\\worktrees\\feat+scrollback-filter-rebuild',
    sessionId: '1e8a6fb6-15d6-4acd-b0c5-fc5baec78f32',
    version: '2.1.220',
  });
  const { w, warnings } = warnWatcher();
  assert.equal(w.inspectLine(real, FILE).limit, undefined);
  assert.equal(w.inspectLine(real, FILE).limit, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /reset at 2026-08-04T06:00:00\.000Z/);
  assert.match(warnings[0]!, /history/);
});
