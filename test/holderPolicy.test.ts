import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOnFire, manualResumeWarning, buildResumePrompt } from '../src/holderPolicy';

const SHORT = '0b3d1f66';

// ---------------------------------------------------------------------------
// decideOnFire: scheduler.onFire's decision, before it ever calls resume().
//
// Status-driven per the controller's mid-task correction: an IDLE panel
// resumes as normal (the product's main use case - someone leaves a panel
// idle at a limit and walks away); a panel or terminal that is busy or
// waiting drops the job silently (no spawn, no remember, no notice); an idle
// terminal defers to autoContinueOn.
// ---------------------------------------------------------------------------

test('decideOnFire resumes as today when nobody holds the session', () => {
  const decision = decideOnFire({ kind: 'none' }, true, SHORT);
  assert.equal(decision.resume, true);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
});

test('decideOnFire resumes as today when the listing failed, but logs a warning about it', () => {
  // Failing closed here would silently stop every resume on a machine where
  // `claude agents` misbehaves - 'unknown' must still resume, just be logged
  // as a listing failure.
  const decision = decideOnFire('unknown', true, SHORT);
  assert.equal(decision.resume, true);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
  assert.equal(decision.logLevel, 'warn');
  assert.match(decision.logMessage ?? '', /could not list/i);
});

test('decideOnFire resumes an IDLE panel as normal - the product\'s main use case', () => {
  const decision = decideOnFire({ kind: 'panel', pid: 111, bridged: false, status: 'idle' }, true, SHORT);
  assert.equal(decision.resume, true);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined, 'must not notify instead of spawning');
});

test('decideOnFire drops the job silently for a BUSY panel - no spawn, no remember, no notice', () => {
  const decision = decideOnFire({ kind: 'panel', pid: 111, bridged: false, status: 'busy' }, true, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
  assert.match(decision.logMessage ?? '', /busy/i);
});

test('decideOnFire drops the job silently for a WAITING panel too', () => {
  const decision = decideOnFire({ kind: 'panel', pid: 111, bridged: false, status: 'waiting' }, true, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
  assert.match(decision.logMessage ?? '', /waiting/i);
});

test('decideOnFire mentions Remote Control in the log line for a bridged, busy panel', () => {
  const decision = decideOnFire({ kind: 'panel', pid: 111, bridged: true, status: 'busy' }, true, SHORT);
  assert.match(decision.logMessage ?? '', /remote control/i);
});

test('decideOnFire does not mention Remote Control when the busy panel is not bridged', () => {
  const decision = decideOnFire({ kind: 'panel', pid: 111, bridged: false, status: 'busy' }, true, SHORT);
  assert.doesNotMatch(decision.logMessage ?? '', /remote control/i);
});

test('decideOnFire treats an unreported panel status as IDLE (fail open) - resumes as normal', () => {
  // Fix round 1, controller ruling: an unknown or missing status counts as
  // idle, not "not idle". Goal 2 is to resume unattended, and a listing
  // failure ('unknown') already resumes rather than blocking - a single row
  // with no readable status must not be treated more cautiously than that.
  const decision = decideOnFire({ kind: 'panel', pid: 111, bridged: false, status: undefined }, true, SHORT);
  assert.equal(decision.resume, true);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
});

test('decideOnFire drops the job silently for a BUSY terminal, regardless of auto-continue', () => {
  const decision = decideOnFire({ kind: 'terminal', pid: 222, status: 'busy' }, true, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
});

test('decideOnFire drops the job silently for a WAITING terminal, regardless of auto-continue', () => {
  const decision = decideOnFire({ kind: 'terminal', pid: 222, status: 'waiting' }, false, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
});

test('decideOnFire leaves an IDLE terminal alone, unremembered, when auto-continue is on', () => {
  const decision = decideOnFire({ kind: 'terminal', pid: 222, status: 'idle' }, true, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
  assert.match(decision.logMessage ?? '', /auto-continue/i);
});

test('decideOnFire offers Resume in Terminal Anyway for an IDLE terminal when auto-continue is off', () => {
  const decision = decideOnFire({ kind: 'terminal', pid: 222, status: 'idle' }, false, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, true);
  assert.ok(decision.notice);
  assert.equal(decision.notice?.button, 'Resume in Terminal Anyway');
  assert.match(decision.notice?.message ?? '', /terminal/i);
});

// ---------------------------------------------------------------------------
// Fix round 1, item 2: an unreported TERMINAL status must be evaluated as
// idle too (fail open) - same isIdleStatus helper as the panel case, and the
// same two outcomes as an explicitly idle terminal, one per autoContinueOn.
// ---------------------------------------------------------------------------

test('decideOnFire treats an unreported terminal status as IDLE (fail open) - auto-continue on leaves it alone', () => {
  const decision = decideOnFire({ kind: 'terminal', pid: 222, status: undefined }, true, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, false);
  assert.equal(decision.notice, undefined);
  assert.match(decision.logMessage ?? '', /auto-continue/i);
});

test('decideOnFire treats an unreported terminal status as IDLE (fail open) - auto-continue off notifies and remembers', () => {
  const decision = decideOnFire({ kind: 'terminal', pid: 222, status: undefined }, false, SHORT);
  assert.equal(decision.resume, false);
  assert.equal(decision.remember, true);
  assert.ok(decision.notice);
  assert.equal(decision.notice?.button, 'Resume in Terminal Anyway');
  assert.match(decision.notice?.message ?? '', /terminal/i);
});

test('every user-facing decideOnFire notice is prefixed like the rest of the extension', () => {
  const decision = decideOnFire({ kind: 'terminal', pid: 1, status: 'idle' }, false, SHORT);
  assert.match(decision.notice?.message ?? '', /^Limit Break:/);
});

// ---------------------------------------------------------------------------
// manualResumeWarning: the modal shown by the resumeNow command and the
// off-autoResume "Resume Now" notification button.
//
// Per the same correction: an idle panel needs no modal. Every other live
// holder still warns - busy/waiting of either kind, or any terminal.
// ---------------------------------------------------------------------------

test('manualResumeWarning is silent when nobody holds the session', () => {
  assert.equal(manualResumeWarning({ kind: 'none' }, SHORT), undefined);
});

test('manualResumeWarning is silent when the listing failed', () => {
  // Consistent with decideOnFire: not knowing is not a reason to block a
  // resume the user explicitly asked for by hand.
  assert.equal(manualResumeWarning('unknown', SHORT), undefined);
});

test('manualResumeWarning is silent for an idle panel', () => {
  assert.equal(manualResumeWarning({ kind: 'panel', pid: 1, bridged: false, status: 'idle' }, SHORT), undefined);
});

test('manualResumeWarning is silent for a panel with an unreported status too (fail open)', () => {
  assert.equal(manualResumeWarning({ kind: 'panel', pid: 1, bridged: false, status: undefined }, SHORT), undefined);
});

test('manualResumeWarning names a panel and offers Resume Anyway when the panel is busy', () => {
  const warning = manualResumeWarning({ kind: 'panel', pid: 1, bridged: false, status: 'busy' }, SHORT);
  assert.ok(warning);
  assert.equal(warning?.button, 'Resume Anyway');
  assert.match(warning?.message ?? '', /claude panel/i);
  assert.match(warning?.message ?? '', /fork/i);
});

test('manualResumeWarning warns for a waiting panel too', () => {
  assert.ok(manualResumeWarning({ kind: 'panel', pid: 1, bridged: false, status: 'waiting' }, SHORT));
});

test('manualResumeWarning warns for an IDLE terminal - unlike an idle panel, there is no auto-resync for it', () => {
  const warning = manualResumeWarning({ kind: 'terminal', pid: 1, status: 'idle' }, SHORT);
  assert.ok(warning);
  assert.match(warning?.message ?? '', /terminal/i);
  assert.doesNotMatch(warning?.message ?? '', /panel/i);
});

test('manualResumeWarning warns for a busy terminal', () => {
  assert.ok(manualResumeWarning({ kind: 'terminal', pid: 1, status: 'busy' }, SHORT));
});

// ---------------------------------------------------------------------------
// buildResumePrompt: appends a coordination sentence when a DIFFERENT
// session is busy or waiting in the same folder (liveSessions.ts's
// busyFolderPeers). Replaces the original "block and notify" treatment of
// that case per the controller's second ruling: resume anyway, and tell the
// resumed model to coordinate, since this extension cannot message another
// session itself.
// ---------------------------------------------------------------------------

test('buildResumePrompt returns exactly the user prompt when there are no busy peers', () => {
  assert.equal(buildResumePrompt('Continue where you left off.', []), 'Continue where you left off.');
});

test('buildResumePrompt appends a sentence naming one busy peer by its name', () => {
  const prompt = buildResumePrompt('Continue where you left off.', [{ pid: 42, name: 'refactor-auth' }]);
  assert.match(prompt, /^Continue where you left off\./);
  assert.match(prompt, /Another Claude session is working in this folder: refactor-auth\./);
  assert.match(prompt, /message it with SendMessage to coordinate who does what/);
});

test('buildResumePrompt falls back to the pid when a peer has no name', () => {
  const prompt = buildResumePrompt('Continue.', [{ pid: 42, name: undefined }]);
  assert.match(prompt, /working in this folder: 42\./);
});

test('buildResumePrompt names every peer, not just the first', () => {
  const prompt = buildResumePrompt('Continue.', [
    { pid: 1, name: 'alpha' },
    { pid: 2, name: 'beta' },
  ]);
  assert.match(prompt, /working in this folder: alpha, beta\./);
});
