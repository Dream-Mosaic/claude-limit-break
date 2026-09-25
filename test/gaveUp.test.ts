import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GaveUpState,
  GAVE_UP_ICON,
  describeGaveUp,
  gaveUpNotice,
  budgetRefusalNotice,
  type GaveUpCause,
} from '../src/gaveUp';

const A = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const B = '7f2a9c41-8b3d-4e5f-9a01-6c7d8e9f0a1b';

const rec = (sessionId: string, cause: GaveUpCause, atMs = 1000, cwd: string | undefined = '/work/app') => ({
  sessionId,
  cwd,
  cause,
  atMs,
});

test('recording a failure keeps it, with its folder, cause and time', () => {
  const s = new GaveUpState();
  s.record(rec(A, 'cwd', 1234));
  assert.deepEqual(s.list(), [{ sessionId: A, cwd: '/work/app', cause: 'cwd', atMs: 1234 }]);
});

test('the first failure of a cause for a session asks to warn; the same cause again does not', () => {
  // Controller ruling 1: warn-once is keyed on (sessionId, cause).
  const s = new GaveUpState();
  assert.equal(s.record(rec(A, 'stall')), true);
  assert.equal(s.record(rec(A, 'stall', 2000)), false, 'the same failure again must stay quiet');
});

test('a different cause for the same session warns again', () => {
  const s = new GaveUpState();
  assert.equal(s.record(rec(A, 'cwd')), true);
  assert.equal(s.record(rec(A, 'launcher')), true, 'a new cause is news');
});

test('the same cause for a different session warns', () => {
  const s = new GaveUpState();
  assert.equal(s.record(rec(A, 'stall')), true);
  assert.equal(s.record(rec(B, 'stall')), true, 'warn-once is per session, not per window');
});

test('one record per session: the newest failure replaces the older one', () => {
  const s = new GaveUpState();
  s.record(rec(A, 'cwd', 1000));
  s.record(rec(A, 'launcher', 2000));
  assert.deepEqual(
    s.list().map((r) => [r.sessionId, r.cause, r.atMs]),
    [[A, 'launcher', 2000]],
  );
});

test('a repeated failure still refreshes the record even though it does not warn', () => {
  const s = new GaveUpState();
  s.record(rec(A, 'stall', 1000));
  s.record(rec(A, 'stall', 5000));
  assert.equal(s.list()[0]?.atMs, 5000, 'the tooltip should say when it last gave up');
});

test('list is oldest first', () => {
  const s = new GaveUpState();
  s.record(rec(B, 'stall', 3000));
  s.record(rec(A, 'cwd', 1000));
  assert.deepEqual(s.list().map((r) => r.sessionId), [A, B]);
});

test('a detection for a session clears its record and its warn-once memory', () => {
  // Controller ruling 2.
  const s = new GaveUpState();
  s.record(rec(A, 'stall'));
  s.record(rec(B, 'stall'));
  s.detected(A);
  assert.deepEqual(s.list().map((r) => r.sessionId), [B], 'only that session is cleared');
  assert.equal(s.record(rec(A, 'stall')), true, 'after a new detection the same failure is news again');
  assert.equal(s.record(rec(B, 'stall')), false, 'the other session still remembers it warned');
});

test('a launched resume clears the record but not the warn-once memory', () => {
  // Ruling 2: "a resume that LAUNCHES clears it too (a later stall can record
  // it again)" - record it, but it has already been warned about since the
  // last detection, so it stays quiet.
  const s = new GaveUpState();
  s.record(rec(A, 'stall'));
  s.launched(A);
  assert.deepEqual(s.list(), []);
  assert.equal(s.record(rec(A, 'stall')), false, 'a later stall records again, quietly');
  assert.equal(s.list().length, 1, 'but it is recorded again');
});

test('clearAll (Cancel) drops every record and every warn-once memory', () => {
  // Ruling 3.
  const s = new GaveUpState();
  s.record(rec(A, 'stall'));
  s.record(rec(B, 'cwd'));
  s.clearAll();
  assert.deepEqual(s.list(), []);
  assert.equal(s.record(rec(A, 'stall')), true, 'after Cancel, a failure starts from a clean slate');
});

test('clearing a session with nothing recorded is harmless and reports no change', () => {
  const s = new GaveUpState();
  assert.equal(s.detected(A), false);
  assert.equal(s.launched(A), false);
  assert.equal(s.clearAll(), false);
  s.record(rec(A, 'stall'));
  assert.equal(s.launched(A), true, 'a change the status bar must re-render for');
});

test('list returns copies, so a caller cannot edit the state behind it', () => {
  const s = new GaveUpState();
  s.record(rec(A, 'stall'));
  const [first] = s.list();
  assert.ok(first);
  first.cause = 'cwd';
  assert.equal(s.list()[0]?.cause, 'stall');
});

test('the icon is circle-slash', () => {
  // Pinned (controller ruling 4). See the comment on GAVE_UP_ICON for why
  // this one and not $(warning) or $(error).
  assert.equal(GAVE_UP_ICON, '$(circle-slash)');
});

test('each cause describes itself differently in the tooltip line', () => {
  const causes: GaveUpCause[] = ['stall', 'launcher', 'cwd', 'budget'];
  const lines = causes.map((c) => describeGaveUp(rec(A, c)));
  assert.equal(new Set(lines).size, causes.length, `causes must read differently: ${JSON.stringify(lines)}`);
  for (const line of lines) {
    assert.ok(line.includes(A.slice(0, 8)), `a line must name the session: ${line}`);
    assert.ok(line.includes('/work/app'), `a line must name the folder: ${line}`);
  }
  assert.match(describeGaveUp(rec(A, 'stall')), /stall/i);
  assert.match(describeGaveUp(rec(A, 'launcher')), /claude executable/i);
  assert.match(describeGaveUp(rec(A, 'cwd')), /no longer exists/i);
  assert.match(describeGaveUp(rec(A, 'budget')), /budget/i);
});

test('a tooltip line for a session with no folder says so rather than printing undefined', () => {
  // Built directly: rec()'s default parameter would turn an explicit
  // undefined back into '/work/app'.
  const line = describeGaveUp({ sessionId: A, cause: 'stall', atMs: 1000 });
  assert.doesNotMatch(line, /undefined/);
  assert.match(line, /no folder/);
});

test('each failure notice names its cause and what to do about it', () => {
  const stall = gaveUpNotice({ cause: 'stall', sessionId: A, cwd: '/work/app', folderTrusted: true });
  const launcher = gaveUpNotice({ cause: 'launcher', sessionId: A, cwd: '/work/app' });
  const cwd = gaveUpNotice({ cause: 'cwd', sessionId: A, cwd: '/work/app' });
  for (const n of [stall, launcher, cwd]) {
    assert.ok(n.includes(A.slice(0, 8)), `a notice must name the session: ${n}`);
  }
  assert.match(stall, /stalled/i);
  assert.match(stall, /terminal/i, 'the stall notice points at the terminal to look at');
  assert.match(launcher, /claude executable/i);
  assert.match(launcher, /claudeLimitBuster\.claudeCommand/, 'the launcher notice names the setting to fix');
  assert.match(cwd, /no longer exists/i);
  assert.ok(cwd.includes('/work/app'), 'the missing-folder notice names the folder');
  assert.match(cwd, /Resume Now/, 'the missing-folder notice says how to retry');
});

test('the stall notice blames the trust prompt only when the folder was untrusted', () => {
  const untrusted = gaveUpNotice({ cause: 'stall', sessionId: A, cwd: '/w', folderTrusted: false });
  const trusted = gaveUpNotice({ cause: 'stall', sessionId: A, cwd: '/w', folderTrusted: true });
  const unknown = gaveUpNotice({ cause: 'stall', sessionId: A, cwd: '/w' });
  assert.match(untrusted, /not trusted/i);
  assert.doesNotMatch(trusted, /not trusted/i);
  assert.doesNotMatch(unknown, /not trusted/i);
});

test('the budget refusal names the session, the numbers and both ways through', () => {
  const n = budgetRefusalNotice(A, 'Resuming this session is estimated at ~9 tokens, over the 1 limit.');
  assert.ok(n.includes(A.slice(0, 8)));
  assert.match(n, /estimated at ~9 tokens/);
  assert.match(n, /Resume anyway/);
  assert.match(n, /claudeLimitBuster\.maxResumeTokens/);
});
