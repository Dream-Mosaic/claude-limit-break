import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planResume } from '../src/policy';
import { readSettings } from '../src/config';

const ID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const FILE = `/h/.claude/projects/p/${ID}.jsonl`;
const NOW = new Date('2026-08-03T12:00:00Z');
const settings = (over: Record<string, unknown> = {}) =>
  readSettings({ get: <T>(k: string, f: T) => (k in over ? (over[k] as T) : f) });
const small = () => 100_000;
const noJitter = () => 0;

const hit = (resumeAt: Date, file = FILE) => ({
  detection: { resumeAt, text: 'Claude AI usage limit reached. Try again in 5 hours' },
  cwd: '/projects/example',
  file,
});

test('a limit hit schedules a job for the stated time plus jitter', () => {
  const at = new Date('2026-08-03T17:00:00Z');
  const p = planResume(hit(at), 'limit', settings(), small, NOW, () => 600_000);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.sessionId, ID);
  assert.equal(p.job.baseResumeAtMs, at.getTime());
  assert.equal(p.job.resumeAtMs, at.getTime() + 600_000);
  assert.equal(p.job.jitterMs, 600_000);
  assert.equal(p.job.cwd, '/projects/example');
  assert.equal(
    p.job.prompt,
    '[Limit Break] I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.',
  );
});

test('a transcript that is not a session is ignored, not guessed at', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z'), '/h/p/summary.jsonl'), 'limit', settings(), small, NOW, noJitter);
  assert.equal(p.kind, 'ignore');
  assert.match(p.reason, /session/i);
});

test('a session too expensive to resume is refused with the numbers', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), () => 5_000_000, NOW, noJitter);
  assert.equal(p.kind, 'refuse');
  assert.match(p.reason, /token/i);
});

test('a refusal names the session and folder it refused, so a dismissal can be recorded against them', () => {
  // Task 4b: a dismissed refusal puts that session into the gave-up state,
  // which is per session - the refusal has to say which one.
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), () => 5_000_000, NOW, noJitter);
  assert.equal(p.kind, 'refuse');
  if (p.kind !== 'refuse') return;
  assert.equal(p.sessionId, ID);
  assert.equal(p.cwd, '/projects/example');
});

test('the budget check can be disabled', () => {
  const p = planResume(
    hit(new Date('2026-08-03T17:00:00Z')), 'limit',
    settings({ maxResumeTokens: 0 }), () => 5_000_000, NOW, noJitter,
  );
  assert.equal(p.kind, 'schedule');
});

test('a disabled extension schedules nothing', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings({ enabled: false }), small, NOW, noJitter);
  assert.equal(p.kind, 'ignore');
});

test('an overload has no stated time and retries after jitter alone', () => {
  const p = planResume(
    { detection: { text: 'API Error: 529 Overloaded' }, cwd: '/projects/example', file: FILE },
    'overload', settings(), small, NOW, () => 300_000,
  );
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.reason, 'overload');
  assert.equal(p.job.resumeAtMs, NOW.getTime() + 300_000);
});

test('the estimate is reported so it can be surfaced before resuming', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), () => 560_000, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.estimate, 100_000);
});

test('a custom resumePrompt reaches job.prompt', () => {
  const p = planResume(
    hit(new Date('2026-08-03T17:00:00Z')), 'limit',
    settings({ resumePrompt: 'pick up the refactor' }), small, NOW, noJitter,
  );
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.prompt, 'pick up the refactor');
});

test('a reset time already in the past still schedules rather than being ignored', () => {
  const past = new Date('2026-08-03T06:00:00Z');
  const p = planResume(hit(past), 'limit', settings(), small, NOW, () => 600_000);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.resumeAtMs, past.getTime() + 600_000);
});
