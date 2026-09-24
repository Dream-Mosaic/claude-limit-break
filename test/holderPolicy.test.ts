import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOnFire, manualResumeWarning, classifyFireHolder, fireHolderDetector } from '../src/holderPolicy';
import type { AgentRow } from '../src/liveSessions';

const SHORT = '0b3d1f66';
const SESSION = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const OTHER = '9a1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e';

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

// ---------------------------------------------------------------------------
// classifyFireHolder: composes classifyHolder and busyFolderHolder (from
// liveSessions.ts) into the single FireHolder scheduler.onFire needs, off one
// `claude agents --json` snapshot.
// ---------------------------------------------------------------------------

const row = (over: Partial<AgentRow> & { pid: number; sessionId: string }): AgentRow => ({ kind: 'interactive', ...over });

test('classifyFireHolder reports a panel directly, without checking the folder', () => {
  const rows = [row({ pid: 111, sessionId: SESSION })];
  const holder = classifyFireHolder(rows, SESSION, '/work/app', 'linux', () => ({
    sessionId: SESSION,
    entrypoint: 'claude-vscode',
  }));
  assert.deepEqual(holder, { kind: 'panel', pid: 111, bridged: false });
});

test('classifyFireHolder reports a terminal directly, without checking the folder', () => {
  const rows = [row({ pid: 111, sessionId: SESSION })];
  const holder = classifyFireHolder(rows, SESSION, '/work/app', 'linux', () => ({
    sessionId: SESSION,
    entrypoint: 'cli',
  }));
  assert.deepEqual(holder, { kind: 'terminal', pid: 111 });
});

test('classifyFireHolder reports none when nobody is on this session and there is no cwd to check', () => {
  const holder = classifyFireHolder([], SESSION, undefined, 'linux', () => undefined);
  assert.deepEqual(holder, { kind: 'none' });
});

test('classifyFireHolder falls back to busy-elsewhere when nobody is on this session but another is busy in the same folder', () => {
  const rows = [row({ pid: 555, sessionId: OTHER, cwd: '/work/app', status: 'busy' })];
  const holder = classifyFireHolder(rows, SESSION, '/work/app', 'linux', () => undefined);
  assert.deepEqual(holder, { kind: 'busy-elsewhere' });
});

test('classifyFireHolder reports none when nobody is on this session and the folder is quiet', () => {
  const rows = [row({ pid: 555, sessionId: OTHER, cwd: '/work/app', status: 'idle' })];
  const holder = classifyFireHolder(rows, SESSION, '/work/app', 'linux', () => undefined);
  assert.deepEqual(holder, { kind: 'none' });
});

// ---------------------------------------------------------------------------
// fireHolderDetector: the impure wrapper scheduler.onFire actually calls -
// mirrors liveSessions.ts's holderDetector, but 'unknown' on a listing
// failure and a folder-aware classification on 'none'.
// ---------------------------------------------------------------------------

test('fireHolderDetector delegates to classifyFireHolder over the real listing', () => {
  const rowsJson = JSON.stringify([{ pid: 111, kind: 'interactive', sessionId: SESSION }]);
  const detect = fireHolderDetector(
    () => rowsJson,
    () => ({ sessionId: SESSION, entrypoint: 'claude-vscode' }),
  );
  assert.deepEqual(detect(SESSION, '/work/app', 'linux'), { kind: 'panel', pid: 111, bridged: false });
});

test('fireHolderDetector reports unknown when the listing cannot be run', () => {
  const detect = fireHolderDetector(
    () => {
      throw new Error('ENOENT');
    },
    () => undefined,
  );
  assert.equal(detect(SESSION, '/work/app', 'linux'), 'unknown');
});
