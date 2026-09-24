import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOnFire, manualResumeWarning } from '../src/holderPolicy';

const SHORT = '0b3d1f66';

// ---------------------------------------------------------------------------
// decideOnFire: scheduler.onFire's decision, before it ever calls resume().
// ---------------------------------------------------------------------------

test('decideOnFire resumes as today when nobody holds the session', () => {
  const decision = decideOnFire({ kind: 'none' }, true, SHORT);
  assert.equal(decision.resume, true);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
});

test('decideOnFire resumes as today when the listing failed, but logs a warning about it', () => {
  // Failing closed here would silently stop every resume on a machine where
  // `claude agents` misbehaves - the brief is explicit that 'unknown' must
  // still resume, just be logged as a listing failure.
  const decision = decideOnFire('unknown', true, SHORT);
  assert.equal(decision.resume, true);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
  assert.equal(decision.logLevel, 'warn');
  assert.match(decision.logMessage ?? '', /could not list/i);
});

test('decideOnFire never spawns for a panel holder, and offers a Resume in Terminal Anyway button', () => {
  const decision = decideOnFire({ kind: 'panel', pid: 111, bridged: false }, true, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, true);
  assert.ok(decision.notice, 'must show a notice naming the panel');
  assert.equal(decision.notice?.button, 'Resume in Terminal Anyway');
  assert.match(decision.notice?.message ?? '', /claude panel/i);
  assert.doesNotMatch(decision.notice?.message ?? '', /remote control/i);
});

test('decideOnFire mentions Remote Control for a bridged panel', () => {
  const decision = decideOnFire({ kind: 'panel', pid: 111, bridged: true }, true, SHORT);
  assert.match(decision.notice?.message ?? '', /remote control/i);
});

test('decideOnFire leaves a terminal holder alone, unremembered, when auto-continue is on', () => {
  const decision = decideOnFire({ kind: 'terminal', pid: 222 }, true, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
  assert.match(decision.logMessage ?? '', /auto-continue/i);
});

test('decideOnFire offers Resume in Terminal Anyway for a terminal holder when auto-continue is off', () => {
  const decision = decideOnFire({ kind: 'terminal', pid: 222 }, false, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, true);
  assert.ok(decision.notice);
  assert.equal(decision.notice?.button, 'Resume in Terminal Anyway');
  assert.match(decision.notice?.message ?? '', /terminal/i);
});

test('decideOnFire treats a busy session elsewhere in the folder the same as a panel', () => {
  const decision = decideOnFire({ kind: 'busy-elsewhere' }, true, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, true);
  assert.ok(decision.notice);
  assert.equal(decision.notice?.button, 'Resume in Terminal Anyway');
  assert.match(decision.notice?.message ?? '', /another active claude session/i);
});

test('every user-facing decideOnFire notice is prefixed like the rest of the extension', () => {
  for (const holder of [
    { kind: 'panel' as const, pid: 1, bridged: false },
    { kind: 'terminal' as const, pid: 1 },
    { kind: 'busy-elsewhere' as const },
  ]) {
    const decision = decideOnFire(holder, false, SHORT);
    assert.match(decision.notice?.message ?? '', /^Claude Limit Buster:/);
  }
});

// ---------------------------------------------------------------------------
// manualResumeWarning: the modal shown by the resumeNow command and the
// off-autoResume "Resume Now" notification button.
// ---------------------------------------------------------------------------

test('manualResumeWarning is silent when nobody holds the session', () => {
  assert.equal(manualResumeWarning({ kind: 'none' }, SHORT), undefined);
});

test('manualResumeWarning is silent when the listing failed', () => {
  // Consistent with decideOnFire: not knowing is not a reason to block a
  // resume the user explicitly asked for by hand.
  assert.equal(manualResumeWarning('unknown', SHORT), undefined);
});

test('manualResumeWarning names a panel and offers Resume Anyway', () => {
  const warning = manualResumeWarning({ kind: 'panel', pid: 1, bridged: false }, SHORT);
  assert.ok(warning);
  assert.equal(warning?.button, 'Resume Anyway');
  assert.match(warning?.message ?? '', /claude panel/i);
  assert.match(warning?.message ?? '', /fork/i);
});

test('manualResumeWarning names a terminal, not a panel, when that is the holder', () => {
  const warning = manualResumeWarning({ kind: 'terminal', pid: 1 }, SHORT);
  assert.ok(warning);
  assert.match(warning?.message ?? '', /terminal/i);
  assert.doesNotMatch(warning?.message ?? '', /panel/i);
});
