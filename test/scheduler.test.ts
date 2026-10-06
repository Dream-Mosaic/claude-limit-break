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
  const s = new ResumeScheduler(memento({ 'claudeLimitBreak.pending': legacy }), silent);
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
  const s = new ResumeScheduler(memento({ 'claudeLimitBreak.pending': past }), silent);
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
    memento({ 'claudeLimitBreak.pending': [jobFor(SESSION_A, past), jobFor(SESSION_B, past)] }),
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

// --- Same-reset re-detection (Task 10) --------------------------------------
//
// planResume rolls a fresh random jitter on every detection (randomDelay.ts),
// so a repeated "usage limit" notice for the SAME un-jittered reset
// (baseResumeAtMs) produces a DIFFERENT resumeAtMs each time. On 2026-09-24 a
// re-detection re-rolled a smaller jitter and moved a window's resume from
// 2:27:19 to 2:20:11 - the old dedupe only blocked a LATER resumeAtMs
// replacing an earlier one, so a smaller re-roll for the same reset slipped
// through and replaced it. The fix: once a job is scheduled for a reset,
// SAME sessionId + SAME baseResumeAtMs must never be replaced by a
// re-detection, whichever way its re-rolled jitter happens to move.

const jobWithBase = (sessionId: string, baseResumeAtMs: number, resumeAtMs: number): PendingJob => ({
  ...jobFor(sessionId, resumeAtMs),
  baseResumeAtMs,
});

test('a re-detection of the same reset with a smaller re-rolled jitter does not move the resume earlier', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const base = Date.now() + 60_000;
  const firstResumeAt = base + 20 * 60_000; // first jitter roll: +20m
  s.schedule(jobWithBase(SESSION_A, base, firstResumeAt));
  const secondResumeAt = base + 5 * 60_000; // re-detection, smaller re-roll: +5m
  assert.equal(
    s.schedule(jobWithBase(SESSION_A, base, secondResumeAt)),
    false,
    'a re-detection of the same reset must be dropped, not accepted',
  );
  assert.equal(s.current?.resumeAtMs, firstResumeAt, 'the original jitter roll must be kept');
});

test('a re-detection of the same reset with a larger re-rolled jitter also does not move the resume', (t) => {
  // The pre-existing guard already caught the "later" direction (a strictly
  // later resumeAtMs was already ignored) - this pins that it still holds
  // once the fix is keyed on baseResumeAtMs rather than resumeAtMs alone.
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const base = Date.now() + 60_000;
  const firstResumeAt = base + 5 * 60_000;
  s.schedule(jobWithBase(SESSION_A, base, firstResumeAt));
  const secondResumeAt = base + 20 * 60_000;
  assert.equal(s.schedule(jobWithBase(SESSION_A, base, secondResumeAt)), false);
  assert.equal(s.current?.resumeAtMs, firstResumeAt);
});

test('a genuinely new reset (different baseResumeAtMs) still replaces an earlier one, same as before', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const now = Date.now();
  s.schedule(jobWithBase(SESSION_A, now + 600_000, now + 600_000));
  const soonerBase = now + 60_000;
  assert.equal(s.schedule(jobWithBase(SESSION_A, soonerBase, soonerBase)), true);
  assert.equal(s.current?.resumeAtMs, soonerBase);
});

// Task 4c (R4): the limit type is part of the job the memento holds, so it
// survives a window reload; a job persisted without it reads as undefined.
test('a job keeps its rateLimitType across reconstruction from the memento', (t) => {
  const m = memento();
  const first = new ResumeScheduler(m, silent);
  t.after(() => first.dispose());
  first.schedule({ ...job(Date.now() + 60_000), rateLimitType: 'seven_day' });
  const second = new ResumeScheduler(m, silent);
  t.after(() => second.dispose());
  assert.equal(second.current?.rateLimitType, 'seven_day');
});

// Final fix wave A, A9: a re-detection of the same reset that the dedupe
// drops can still carry the limit type the first detection could not read
// (a text-only notice first, the flagged quotaLimits entry second). The
// existing job adopts it, persisted; its schedule stays exactly as it was.
test('a dropped re-detection of the same reset hands its rateLimitType to a job that had none', (t) => {
  // Serialised on write, as VS Code's globalState is: the plain memento()
  // stores the job objects themselves, so an in-place change would read back
  // as persisted even if it never was.
  const stored = new Map<string, string>();
  const m: MementoLike = {
    get: <T>(k: string) => (stored.has(k) ? (JSON.parse(stored.get(k)!) as T) : undefined),
    update: (k, v) => {
      stored.set(k, JSON.stringify(v));
      return Promise.resolve();
    },
  };
  const s = new ResumeScheduler(m, silent);
  t.after(() => s.dispose());
  const base = Date.now() + 60_000;
  const firstResumeAt = base + 5 * 60_000;
  s.schedule(jobWithBase(SESSION_A, base, firstResumeAt));
  for (const secondResumeAt of [base + 20 * 60_000, base + 2 * 60_000]) {
    assert.equal(
      s.schedule({ ...jobWithBase(SESSION_A, base, secondResumeAt), rateLimitType: 'seven_day' }),
      false,
      'the re-detection itself is still dropped',
    );
  }
  assert.equal(s.current?.rateLimitType, 'seven_day');
  assert.equal(s.current?.resumeAtMs, firstResumeAt, 'the schedule is unchanged');
  assert.equal(s.current?.baseResumeAtMs, base, 'the deadline is unchanged');
  const reloaded = new ResumeScheduler(m, silent);
  t.after(() => reloaded.dispose());
  assert.equal(reloaded.current?.rateLimitType, 'seven_day', 'the adopted type is persisted');
});

test('a dropped re-detection never overwrites a rateLimitType the job already has', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const base = Date.now() + 60_000;
  s.schedule({ ...jobWithBase(SESSION_A, base, base + 5 * 60_000), rateLimitType: 'five_hour' });
  s.schedule({ ...jobWithBase(SESSION_A, base, base + 20 * 60_000), rateLimitType: 'seven_day' });
  assert.equal(s.current?.rateLimitType, 'five_hour');
});

test('a dropped later deadline for a DIFFERENT reset does not hand over its rateLimitType', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const base = Date.now() + 60_000;
  s.schedule(jobWithBase(SESSION_A, base, base));
  assert.equal(s.schedule({ ...jobWithBase(SESSION_A, base + 600_000, base + 600_000), rateLimitType: 'seven_day' }), false);
  assert.equal(s.current?.rateLimitType, undefined);
});

// Wave A fix round 1 (review C1): a dropped same-reset re-detection also
// hands over its detection-time transcript size. The re-detection is newer
// evidence of where the stop is; keeping the first one's baseline is what let
// a retry that hit the same limit again read as "continued".
test('a dropped re-detection of the same reset refreshes the detection baseline of the job, persisted', (t) => {
  const stored = new Map<string, string>();
  const m: MementoLike = {
    get: <T>(k: string) => (stored.has(k) ? (JSON.parse(stored.get(k)!) as T) : undefined),
    update: (k, v) => {
      stored.set(k, JSON.stringify(v));
      return Promise.resolve();
    },
  };
  const s = new ResumeScheduler(m, silent);
  t.after(() => s.dispose());
  const base = Date.now() + 60_000;
  const firstResumeAt = base + 5 * 60_000;
  s.schedule({ ...jobWithBase(SESSION_A, base, firstResumeAt), transcriptBytesAtDetection: 500 });
  assert.equal(s.schedule({ ...jobWithBase(SESSION_A, base, base + 20 * 60_000), transcriptBytesAtDetection: 900 }), false);
  assert.equal(s.current?.transcriptBytesAtDetection, 900);
  assert.equal(s.current?.resumeAtMs, firstResumeAt, 'the schedule is unchanged');
  const reloaded = new ResumeScheduler(m, silent);
  t.after(() => reloaded.dispose());
  assert.equal(reloaded.current?.transcriptBytesAtDetection, 900, 'persisted');
});

test('a re-detection with no readable size leaves the baseline alone, and a different reset never touches it', (t) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const base = Date.now() + 60_000;
  s.schedule({ ...jobWithBase(SESSION_A, base, base + 5 * 60_000), transcriptBytesAtDetection: 500 });
  s.schedule(jobWithBase(SESSION_A, base, base + 20 * 60_000));
  assert.equal(s.current?.transcriptBytesAtDetection, 500, 'no size: nothing to hand over');
  s.schedule({ ...jobWithBase(SESSION_A, base + 600_000, base + 600_000), transcriptBytesAtDetection: 900 });
  assert.equal(s.current?.transcriptBytesAtDetection, 500, 'a later, different reset is not this stop');
});

test('a job persisted without rateLimitType reads back with it undefined', (t) => {
  const m = memento({ 'claudeLimitBreak.pending': [job(Date.now() + 60_000)] });
  const s = new ResumeScheduler(m, silent);
  t.after(() => s.dispose());
  assert.ok(s.current);
  assert.equal(s.current.rateLimitType, undefined);
});

// Wave B, B8 (wave A re-review, m-new-2): the baseline refresh is logged, as
// A9's type adoption is, so a skip that follows can be traced to it.
test('a refreshed detection baseline is logged, once, with the old and new size; an unchanged or absent size is not', (t) => {
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn() {}, error() {} };
  const s = new ResumeScheduler(memento(), log);
  t.after(() => s.dispose());
  const base = Date.now() + 60_000;
  s.schedule({ ...jobWithBase(SESSION_A, base, base + 5 * 60_000), transcriptBytesAtDetection: 500 });
  const refreshLines = () => lines.filter((l) => l.includes('detection baseline'));
  s.schedule({ ...jobWithBase(SESSION_A, base, base + 20 * 60_000), transcriptBytesAtDetection: 900 });
  assert.equal(refreshLines().length, 1, `saw ${JSON.stringify(lines)}`);
  assert.ok(refreshLines()[0]!.includes(SESSION_A) && refreshLines()[0]!.includes('500') && refreshLines()[0]!.includes('900'));
  s.schedule({ ...jobWithBase(SESSION_A, base, base + 20 * 60_000), transcriptBytesAtDetection: 900 });
  s.schedule(jobWithBase(SESSION_A, base, base + 20 * 60_000));
  assert.equal(refreshLines().length, 1, 'the same size, or no size, changes nothing and logs nothing');
});

// ---------------------------------------------------------------------------
// Wave D fix round 1, Important 1 (the user's decision, 2026-10-02): the
// latest detection decides. A same-reset re-detection (bases within
// RESET_GRACE_MS) that is automatic makes an offer-only job automatic,
// whatever the jitter rolled; an offer-only re-detection changes nothing; an
// automatic job never becomes offer-only for the same reset.
// ---------------------------------------------------------------------------

const offerJob = (base: number, resumeAt: number): PendingJob => ({ ...jobWithBase(SESSION_A, base, resumeAt), offerOnly: true });

/** A scheduler with its upgrade events recorded. */
const upgrading = (t: { after(fn: () => void): void }) => {
  const s = new ResumeScheduler(memento(), silent);
  t.after(() => s.dispose());
  const upgraded: PendingJob[] = [];
  s.onUpgrade((j) => upgraded.push(j));
  return { s, upgraded };
};

test('F1: zero jitter, same reset: an automatic re-detection upgrades the offer-only job in place', (t) => {
  const { s, upgraded } = upgrading(t);
  const base = Date.now() + 20 * 3_600_000;
  assert.equal(s.schedule(offerJob(base, base)), true);
  assert.equal(s.schedule(jobWithBase(SESSION_A, base, base)), false, 'not a new schedule: the job already there is upgraded');
  assert.equal(s.jobs.length, 1);
  assert.equal(Object.hasOwn(s.current!, 'offerOnly'), false, 'automatic now, the key gone rather than false');
  assert.equal(s.current!.resumeAtMs, base, 'its fire time is kept');
  assert.equal(upgraded.length, 1);
  assert.equal(upgraded[0]!.sessionId, SESSION_A);
});

test('F1: a base 1s earlier with an earlier jitter roll still upgrades, and keeps the first fire time', (t) => {
  const { s, upgraded } = upgrading(t);
  const base = Date.now() + 20 * 3_600_000;
  s.schedule(offerJob(base, base + 20 * 60_000));
  assert.equal(s.schedule(jobWithBase(SESSION_A, base - 1000, base - 1000 + 5 * 60_000)), false);
  assert.equal(s.current!.offerOnly, undefined);
  assert.equal(s.current!.resumeAtMs, base + 20 * 60_000);
  assert.equal(s.current!.baseResumeAtMs, base, 'the claim key (from the base) stays put');
  assert.equal(upgraded.length, 1);
});

test('F1: with default jitter the upgrade is deterministic, whichever way the rolls fall', (t) => {
  for (let i = 0; i < 20; i++) {
    const { s, upgraded } = upgrading(t);
    const base = Date.now() + 20 * 3_600_000;
    s.schedule(offerJob(base, base + randomJitterMs(5, 30)));
    s.schedule(jobWithBase(SESSION_A, base, base + randomJitterMs(5, 30)));
    assert.equal(s.current!.offerOnly, undefined, `roll ${i}`);
    assert.equal(upgraded.length, 1, `roll ${i}`);
  }
});

test('F1: the upgrade is persisted', (t) => {
  // Serialised on write, as globalState is: a store holding the live job
  // objects would show the upgrade whether or not it was ever written.
  const saved = new Map<string, string>();
  const store: MementoLike = {
    get: <T>(k: string) => (saved.has(k) ? (JSON.parse(saved.get(k)!) as T) : undefined),
    update: (k, v) => {
      saved.set(k, JSON.stringify(v));
      return Promise.resolve();
    },
  };
  const s = new ResumeScheduler(store, silent);
  t.after(() => s.dispose());
  const base = Date.now() + 20 * 3_600_000;
  s.schedule(offerJob(base, base));
  s.schedule(jobWithBase(SESSION_A, base, base));
  const stored = store.get<PendingJob[]>('claudeLimitBreak.pending');
  assert.equal(stored?.[0]?.offerOnly, undefined);
});

test('F1: an offer-only re-detection of an offer-only job changes nothing, whatever the jitter', (t) => {
  const { s, upgraded } = upgrading(t);
  const base = Date.now() + 3 * 86_400_000;
  const first = offerJob(base, base + 10 * 60_000);
  s.schedule(first);
  for (const again of [offerJob(base, base + 10 * 60_000), offerJob(base - 1000, base - 1000), offerJob(base, base + 25 * 60_000)]) {
    assert.equal(s.schedule(again), false);
  }
  assert.equal(s.current, first, 'the very same job object is kept');
  assert.equal(upgraded.length, 0);
});

test('F1: an automatic job never becomes offer-only for the same reset', (t) => {
  const { s, upgraded } = upgrading(t);
  const base = Date.now() + 20 * 3_600_000;
  s.schedule(jobWithBase(SESSION_A, base, base));
  assert.equal(s.schedule(offerJob(base, base)), false);
  assert.equal(s.schedule(offerJob(base - 1000, base - 1000)), false);
  assert.equal(s.current!.offerOnly, undefined);
  assert.equal(upgraded.length, 0);
});

test('F1: a different reset (bases further apart than the grace) is not an upgrade', (t) => {
  const { s, upgraded } = upgrading(t);
  const base = Date.now() + 3 * 86_400_000;
  s.schedule(offerJob(base, base));
  // A five-hour limit hit meanwhile resets sooner: it replaces the weekly job as before.
  const sooner = Date.now() + 2 * 3_600_000;
  assert.equal(s.schedule(jobWithBase(SESSION_A, sooner, sooner)), true);
  assert.equal(s.current!.baseResumeAtMs, sooner);
  assert.equal(upgraded.length, 0);
});

// ---------------------------------------------------------------------------
// Wave D fix round 2, N1: every same-reset re-detection - the upgrade and the
// offer-only no-op included - adopts the limit type onto an untyped job (A9)
// and moves the stop baseline to the newest detection (wave A, C1).
// ---------------------------------------------------------------------------

test('F2: an upgrade adopts the type and the newer baseline, and persists both', (t) => {
  const saved = new Map<string, string>();
  const store: MementoLike = {
    get: <T>(k: string) => (saved.has(k) ? (JSON.parse(saved.get(k)!) as T) : undefined),
    update: (k, v) => {
      saved.set(k, JSON.stringify(v));
      return Promise.resolve();
    },
  };
  const s = new ResumeScheduler(store, silent);
  t.after(() => s.dispose());
  const base = Date.now() + 20 * 3_600_000;
  s.schedule({ ...offerJob(base, base + 10 * 60_000), transcriptBytesAtDetection: 500 });
  s.schedule({ ...jobWithBase(SESSION_A, base - 1000, base + 2 * 60_000), rateLimitType: 'seven_day', transcriptBytesAtDetection: 900 });
  const stored = store.get<PendingJob[]>('claudeLimitBreak.pending')![0]!;
  assert.equal(stored.offerOnly, undefined, 'upgraded');
  assert.equal(stored.rateLimitType, 'seven_day');
  assert.equal(stored.transcriptBytesAtDetection, 900);
  assert.equal(stored.resumeAtMs, base + 10 * 60_000, 'the fire time is still the first one');
});

test('F2: an offer-only no-op still adopts the type and the newer baseline', (t) => {
  const { s } = upgrading(t);
  const base = Date.now() + 3 * 86_400_000;
  s.schedule({ ...offerJob(base, base), transcriptBytesAtDetection: 500 });
  s.schedule({ ...offerJob(base, base), rateLimitType: 'seven_day', transcriptBytesAtDetection: 900 });
  assert.equal(s.current!.offerOnly, true);
  assert.equal(s.current!.rateLimitType, 'seven_day');
  assert.equal(s.current!.transcriptBytesAtDetection, 900);
});

test('F2: a type already known is never overwritten by a re-detection', (t) => {
  const { s } = upgrading(t);
  const base = Date.now() + 3 * 86_400_000;
  s.schedule({ ...offerJob(base, base), rateLimitType: 'seven_day_opus' });
  s.schedule({ ...offerJob(base, base), rateLimitType: 'seven_day' });
  assert.equal(s.current!.rateLimitType, 'seven_day_opus');
});
