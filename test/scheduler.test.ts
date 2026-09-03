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

test('scheduling stores the job', () => {
  const s = new ResumeScheduler(memento(), silent);
  assert.equal(s.schedule(job(Date.now() + 60_000)), true);
  assert.equal(s.current?.sessionId, '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234');
});

test('a later deadline never replaces an earlier one still counting down', () => {
  const s = new ResumeScheduler(memento(), silent);
  const early = Date.now() + 60_000;
  s.schedule(job(early));
  assert.equal(s.schedule(job(Date.now() + 600_000)), false);
  assert.equal(s.current?.resumeAtMs, early);
});

test('an earlier deadline does replace a later one', () => {
  const s = new ResumeScheduler(memento(), silent);
  s.schedule(job(Date.now() + 600_000));
  const sooner = Date.now() + 60_000;
  assert.equal(s.schedule(job(sooner)), true);
  assert.equal(s.current?.resumeAtMs, sooner);
});

test('a pending job survives reconstruction from the memento', () => {
  const m = memento();
  new ResumeScheduler(m, silent).schedule(job(Date.now() + 60_000));
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
  const s = new ResumeScheduler(memento({ 'claudeLimitBuster.pending': legacy as PendingJob }), silent);
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
  const ms = randomJitterMs(30, 5);
  assert.ok(ms >= 5 * 60_000 && ms <= 30 * 60_000);
});
