import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeStub } from './helpers/vscode';

installVscodeStub();

const { ResumeScheduler, restoreJob } = require('../src/scheduler') as typeof import('../src/scheduler');
import type { MementoLike } from '../src/scheduler';

// Final fix wave B, B2 (final review M2): the pending and ready lists come back
// from globalState, which anyone can edit and an older build may have written
// badly. A job that fails validation is dropped with one log line; it must
// never reach `claude --resume`.

const SESSION = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const SESSION_B = '7f2a9c41-8b3d-4e5f-9a01-6c7d8e9f0a1b';

const valid = (): Record<string, unknown> => ({
  sessionId: SESSION,
  transcript: `/h/p/${SESSION}.jsonl`,
  prompt: 'continue',
  resumeAtMs: Date.now() + 60_000,
  baseResumeAtMs: Date.now() + 30_000,
  jitterMs: 30_000,
  reason: 'limit',
});

const full = (): Record<string, unknown> => ({
  ...valid(),
  cwd: '/h/p',
  folderTrusted: true,
  entryTimestampMs: 1_700_000_000_000,
  transcriptBytesAtDetection: 1234,
  rateLimitType: 'five_hour',
  backoffMs: 900_000,
});

function memento(seed: Record<string, unknown>): MementoLike {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T>(k: string) => store.get(k) as T | undefined,
    update: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
  };
}

const recording = () => {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (m: string) => lines.push(`info: ${m}`),
      warn: (m: string) => lines.push(`warn: ${m}`),
      error: (m: string) => lines.push(`error: ${m}`),
    },
  };
};

test('a valid job survives restoreJob, with every optional field', () => {
  const result = restoreJob(full());
  assert.ok('job' in result);
  assert.deepEqual(result.job, full());
});

test('a valid job with no baseResumeAtMs or jitterMs (an older build) is migrated, not dropped', () => {
  const old = valid();
  delete old.baseResumeAtMs;
  delete old.jitterMs;
  const result = restoreJob(old);
  assert.ok('job' in result);
  assert.equal(result.job.baseResumeAtMs, old.resumeAtMs);
  assert.equal(result.job.jitterMs, 0);
});

test('an overload job is valid too', () => {
  const result = restoreJob({ ...valid(), reason: 'overload' });
  assert.ok('job' in result);
  assert.equal(result.job.reason, 'overload');
});

const corrupt: [string, (j: Record<string, unknown>) => void][] = [
  ['sessionId missing', (j) => delete j.sessionId],
  ['sessionId not a string', (j) => (j.sessionId = 42)],
  ['sessionId not a UUID (an option-shaped value)', (j) => (j.sessionId = '--dangerously-skip-permissions')],
  ['sessionId a UUID with a suffix', (j) => (j.sessionId = `${SESSION} --x`)],
  ['transcript missing', (j) => delete j.transcript],
  ['transcript not a string', (j) => (j.transcript = { path: 'x' })],
  ['prompt not a string', (j) => (j.prompt = 5)],
  ['resumeAtMs missing', (j) => delete j.resumeAtMs],
  ['resumeAtMs a string', (j) => (j.resumeAtMs = '123')],
  ['resumeAtMs NaN', (j) => (j.resumeAtMs = Number.NaN)],
  ['resumeAtMs null (what JSON makes of NaN)', (j) => (j.resumeAtMs = null)],
  ['baseResumeAtMs Infinity', (j) => (j.baseResumeAtMs = Number.POSITIVE_INFINITY)],
  ['baseResumeAtMs a string', (j) => (j.baseResumeAtMs = 'soon')],
  ['jitterMs not finite', (j) => (j.jitterMs = Number.NaN)],
  ['reason missing', (j) => delete j.reason],
  ['reason unknown', (j) => (j.reason = 'sunspots')],
  ['reason not a string', (j) => (j.reason = 1)],
  ['cwd not a string', (j) => (j.cwd = 7)],
  ['folderTrusted not a boolean', (j) => (j.folderTrusted = 'yes')],
  ['entryTimestampMs not finite', (j) => (j.entryTimestampMs = Number.NaN)],
  ['transcriptBytesAtDetection a string', (j) => (j.transcriptBytesAtDetection = '12')],
  ['backoffMs not finite', (j) => (j.backoffMs = Number.POSITIVE_INFINITY)],
];

for (const [name, mutate] of corrupt) {
  test(`restoreJob drops a job with ${name}`, () => {
    const job = full();
    mutate(job);
    const result = restoreJob(job);
    assert.ok('dropped' in result, `expected a drop for: ${name}`);
    assert.ok(result.dropped.length > 0, 'the drop carries a reason for the log');
  });
}

for (const [name, value] of [['null', null], ['a string', 'x'], ['a number', 5], ['an array', []]] as const) {
  test(`restoreJob drops an entry that is ${name}`, () => {
    assert.ok('dropped' in restoreJob(value));
  });
}

test('a non-string or empty rateLimitType is repaired: the field goes, the job stays', () => {
  for (const bad of ['', 5, null, { a: 1 }, true]) {
    const result = restoreJob({ ...full(), rateLimitType: bad });
    assert.ok('job' in result, `a job with rateLimitType ${JSON.stringify(bad)} must be kept`);
    assert.ok(!('rateLimitType' in result.job), 'the bad field is deleted, not left as undefined or a default');
    assert.equal(result.job.cwd, '/h/p', 'the rest of the job is intact');
  }
});

test('the scheduler restores only the valid jobs from a mixed list, one warn line per dropped job', (t) => {
  const { lines, log } = recording();
  const good = { ...valid(), sessionId: SESSION_B, transcript: `/h/p/${SESSION_B}.jsonl` };
  const badId = { ...valid(), sessionId: '../../etc/passwd' };
  const badTime = { ...valid(), sessionId: '11111111-2222-4333-8444-555555555555', resumeAtMs: 'tomorrow' };
  const s = new ResumeScheduler(memento({ 'claudeLimitBreak.pending': [badId, good, badTime, null] }), log);
  t.after(() => s.dispose());
  assert.deepEqual(
    s.jobs.map((j) => j.sessionId),
    [SESSION_B],
  );
  assert.equal(lines.filter((l) => l.startsWith('warn:')).length, 3, `expected one warn per dropped entry, got ${JSON.stringify(lines)}`);
});

test('the scheduler repairs a bad rateLimitType and keeps the job', (t) => {
  const { log } = recording();
  const s = new ResumeScheduler(memento({ 'claudeLimitBreak.pending': [{ ...valid(), rateLimitType: 12 }] }), log);
  t.after(() => s.dispose());
  assert.equal(s.jobs.length, 1);
  assert.ok(!('rateLimitType' in s.jobs[0]!));
});

test('the scheduler still carries over a bare single-slot job, and drops a corrupt one', (t) => {
  const a = recording();
  const ok = new ResumeScheduler(memento({ 'claudeLimitBreak.pending': valid() }), a.log);
  t.after(() => ok.dispose());
  assert.equal(ok.jobs.length, 1);
  const b = recording();
  const bad = new ResumeScheduler(memento({ 'claudeLimitBreak.pending': { ...valid(), sessionId: 'nope' } }), b.log);
  t.after(() => bad.dispose());
  assert.equal(bad.jobs.length, 0);
  assert.equal(b.lines.filter((l) => l.startsWith('warn:')).length, 1);
});

test('a stored value that is not a job list at all restores nothing and does not throw', (t) => {
  const { log } = recording();
  const s = new ResumeScheduler(memento({ 'claudeLimitBreak.pending': 'garbage' }), log);
  t.after(() => s.dispose());
  assert.equal(s.jobs.length, 0);
});
