import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeStub } from './helpers/vscode';
import { randomJitterMs } from '../src/randomDelay';

installVscodeStub();

const { ResumeScheduler } = require('../src/scheduler') as typeof import('../src/scheduler');
import type { PendingJob, MementoLike } from '../src/scheduler';

const silent = { info() {}, warn() {}, error() {} };

function memento(seed?: Record<string, unknown>): MementoLike {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: <T>(k: string) => store.get(k) as T | undefined,
    update: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
  };
}

const job = (resumeAtMs: number): PendingJob => ({
  sessionId: '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234',
  transcript: '/h/p/0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl',
  prompt: 'continue',
  resumeAtMs,
  baseResumeAtMs: resumeAtMs,
  jitterMs: 0,
  reason: 'limit',
});

test('scheduling stores the job', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  assert.equal(s.schedule(job(Date.now() + 60_000)), true);
  assert.equal(s.current?.sessionId, '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234');
});

test('a later deadline never replaces an earlier one still counting down', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const early = Date.now() + 60_000;
  s.schedule(job(early));
  assert.equal(s.schedule(job(Date.now() + 600_000)), false);
  assert.equal(s.current?.resumeAtMs, early);
});

test('an identical deadline for the same session is accepted, not ignored', (t) => {
  // Issue #12 boundary: `job.resumeAtMs > existing.resumeAtMs` in schedule().
  // An exact tie is not "later", so a repeat notice naming the same deadline
  // must still be accepted - `>` allows it; `>=` would wrongly drop it.
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const at = Date.now() + 60_000;
  s.schedule(job(at));
  assert.equal(s.schedule(job(at)), true, 'an exact-tie deadline must not be treated as "later"');
});

test('an earlier deadline does replace a later one', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  s.schedule(job(Date.now() + 600_000));
  const sooner = Date.now() + 60_000;
  assert.equal(s.schedule(job(sooner)), true);
  assert.equal(s.current?.resumeAtMs, sooner);
});

test('a pending job survives reconstruction from the memento', (t) => {
  const m = memento();
  const first = new ResumeScheduler(m, silent);
  t.after(() => first.dispose());
  first.schedule(job(Date.now() + 60_000));
  assert.equal(new ResumeScheduler(m, silent).current?.prompt, 'continue');
});

test('a legacy stored job without baseResumeAtMs/jitterMs is migrated on reconstruction', () => {
  const resumeAtMs = Date.now() + 60_000;
  type LegacyJob = Omit<PendingJob, 'baseResumeAtMs' | 'jitterMs'>;
  const legacy: LegacyJob = {
    sessionId: '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234',
    transcript: '/h/p/0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl',
    prompt: 'continue',
    resumeAtMs,
    reason: 'limit',
  };
  const s = new ResumeScheduler(memento({ 'claudeLimitBuster.pending': legacy }), silent);
  assert.equal(s.current?.baseResumeAtMs, resumeAtMs);
  assert.equal(s.current?.jitterMs, 0);
});

test('cancel clears the pending job', () => {
  const s = new ResumeScheduler(memento(), silent);
  s.schedule(job(Date.now() + 60_000));
  s.cancel();
  assert.equal(s.current, undefined);
});

test('a deadline that passed while VS Code was closed fires on the first tick', async () => {
  const past = job(Date.now() - 1000);
  const s = new ResumeScheduler(memento({ 'claudeLimitBuster.pending': past }), silent);
  const fired: PendingJob[] = [];
  s.onFire((j) => fired.push(j));
  s.start();
  await new Promise((r) => setTimeout(r, 1200));
  s.dispose();
  assert.equal(fired.length, 1, 'a deadline missed while closed must still fire');
});

test('jitter stays inside its window', () => {
  for (let i = 0; i < 200; i++) {
    const ms = randomJitterMs(5, 30);
    assert.ok(ms >= 5 * 60_000 && ms <= 30 * 60_000, String(ms));
  }
});

test('a zero window produces no jitter', () => {
  assert.equal(randomJitterMs(0, 0), 0);
});

test('a reversed window is treated as a window, not an error', () => {
  const lo = 5 * 60_000;
  const hi = 30 * 60_000;
  let observedMax = 0;
  for (let i = 0; i < 500; i++) {
    const ms = randomJitterMs(30, 5);
    assert.ok(ms >= lo && ms <= hi, `outside [5m, 30m]: ${ms}`);
    observedMax = Math.max(observedMax, ms);
  }
  // Staying inside the band is also true of an implementation that read the
  // reversed window as empty and returned the lower bound - or zero - every
  // time. Spanning it is not.
  assert.ok(
    observedMax > lo,
    `every one of 500 draws was the lower bound (${observedMax}); the band is not being used`,
  );
});

// --- More than one session -------------------------------------------------
//
// A usage limit belongs to the account, not to a session, so every session that
// is working when it lands hits it at once. On the machine this was written on,
// 16 of 61 real limit episodes had two or three sessions reporting the same
// reset within minutes. One slot for all of them resumed only one.

const SESSION_A = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const SESSION_B = '7f2a9c41-8b3d-4e5f-9a01-6c7d8e9f0a1b';

const jobFor = (sessionId: string, resumeAtMs: number): PendingJob => ({
  ...job(resumeAtMs),
  sessionId,
  transcript: `/h/p/${sessionId}.jsonl`,
});

test('a second session is scheduled alongside the first, not instead of it', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const now = Date.now();
  assert.equal(s.schedule(jobFor(SESSION_A, now + 60_000)), true);
  assert.equal(s.schedule(jobFor(SESSION_B, now + 30_000)), true);
  assert.deepEqual(
    s.jobs.map((j) => j.sessionId),
    [SESSION_B, SESSION_A],
    'both sessions must be pending, soonest first',
  );
  assert.equal(s.current?.sessionId, SESSION_B, 'current is the soonest job');
});

test('another session with a later deadline is kept, not ignored', (t) => {
  // The dedupe rule - a later deadline never replaces an earlier one - exists
  // so repeated notices for ONE cooldown cannot push that resume out. Applied
  // across sessions it silently discards a different session's resume.
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const now = Date.now();
  s.schedule(jobFor(SESSION_A, now + 60_000));
  assert.equal(s.schedule(jobFor(SESSION_B, now + 600_000)), true);
  assert.equal(s.jobs.length, 2);
});

test('every due job fires once, whichever session it belongs to', async (t) => {
  const past = Date.now() - 1000;
  const s = new ResumeScheduler(
    memento({ 'claudeLimitBuster.pending': [jobFor(SESSION_A, past), jobFor(SESSION_B, past)] }),
    silent,
  );
  t.after(() => s.dispose());
  const fired: string[] = [];
  s.onFire((j) => fired.push(j.sessionId));
  s.start();
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual([...fired].sort(), [SESSION_A, SESSION_B].sort());
  assert.deepEqual(s.jobs, [], 'nothing is left pending once both have fired');
});

test('several pending jobs survive reconstruction from the memento', (t) => {
  const m = memento();
  const first = new ResumeScheduler(m, silent);
  t.after(() => first.dispose());
  const now = Date.now();
  first.schedule(jobFor(SESSION_A, now + 60_000));
  first.schedule(jobFor(SESSION_B, now + 120_000));
  assert.deepEqual(
    new ResumeScheduler(m, silent).jobs.map((j) => j.sessionId),
    [SESSION_A, SESSION_B],
  );
});

test('cancelling one session leaves the others counting down', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const now = Date.now();
  s.schedule(jobFor(SESSION_A, now + 60_000));
  s.schedule(jobFor(SESSION_B, now + 120_000));
  s.cancel(SESSION_A);
  assert.deepEqual(s.jobs.map((j) => j.sessionId), [SESSION_B]);
});

test('cancel with no session named clears every pending job', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const now = Date.now();
  s.schedule(jobFor(SESSION_A, now + 60_000));
  s.schedule(jobFor(SESSION_B, now + 120_000));
  s.cancel();
  assert.deepEqual(s.jobs, []);
  assert.equal(s.current, undefined);
});
