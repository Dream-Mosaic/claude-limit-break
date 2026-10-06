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
const BIG = () => ({ input: 1, cacheRead: 5_000_000, cacheCreate: 0 });
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
    '[Limit Break] Your session was interrupted and has been resumed automatically. Please continue from where you left off.',
  );
});

test('a transcript that is not a session is ignored, not guessed at', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z'), '/h/p/summary.jsonl'), 'limit', settings(), small, NOW, noJitter);
  assert.equal(p.kind, 'ignore');
  assert.match(p.reason, /session/i);
});

test('a session too expensive to resume is refused with the numbers', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), small, NOW, noJitter, BIG);
  assert.equal(p.kind, 'refuse');
  assert.match(p.reason, /token/i);
});

test('a refusal names the session and folder it refused, so a dismissal can be recorded against them', () => {
  // Task 4b: a dismissed refusal puts that session into the gave-up state,
  // which is per session - the refusal has to say which one.
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), small, NOW, noJitter, BIG);
  assert.equal(p.kind, 'refuse');
  if (p.kind !== 'refuse') return;
  assert.equal(p.sessionId, ID);
  assert.equal(p.cwd, '/projects/example');
});

test('the budget check can be disabled', () => {
  const p = planResume(
    hit(new Date('2026-08-03T17:00:00Z')), 'limit',
    settings({ maxResumeTokens: 0 }), small, NOW, noJitter, BIG,
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
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), small, NOW, noJitter, () => ({ input: 2, cacheRead: 40_000, cacheCreate: 59_998 }));
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

test('an overload job carries the detection entry timestamp it was planned from (final review I3)', () => {
  const p = planResume(
    { detection: { text: 'API Error: 529 Overloaded' }, cwd: '/projects/example', file: FILE, entryTimestampMs: 1_234_567 },
    'overload',
    settings(),
    small,
    NOW,
    noJitter,
  );
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.entryTimestampMs, 1_234_567);
});

test('a hit with no entry timestamp plans a job without one', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), small, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.entryTimestampMs, undefined);
});

test('a planned job records the transcript size at detection, the baseline for the native-continue check (final review I6)', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), () => 123_456, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.transcriptBytesAtDetection, 123_456);
});

test('an unreadable transcript size is left off the job rather than recorded as zero', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), () => {
    throw new Error('ENOENT');
  }, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.transcriptBytesAtDetection, undefined);
});

// Task 4c (R4): the limit type the detection names rides on the job, so
// decideOnFire can tell a five-hour limit (native auto-continue covers it)
// from every other.
test('a detection that names its limit type puts it on the job', () => {
  const at = new Date('2026-08-03T17:00:00Z');
  const typed = { ...hit(at), detection: { ...hit(at).detection, rateLimitType: 'seven_day' } };
  const p = planResume(typed, 'limit', settings(), small, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.rateLimitType, 'seven_day');
});

test('a detection with no limit type leaves the key off the job, so a persisted job stays as it was', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), small, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(Object.hasOwn(p.job, 'rateLimitType'), false);
});

// Final fix wave A, A6 (the user's decision): an overload retry's backoff is
// added to the deadline itself, before the usual random delay, so the claim
// hold (A5) covers it. A limit neither counts nor backs off.
const overloadHit = { detection: { text: 'API Error: 529 Overloaded' }, cwd: '/projects/example', file: FILE };

test('an overload backoff goes into the deadline, with the usual random delay on top (A6)', () => {
  const p = planResume(overloadHit, 'overload', settings(), small, NOW, () => 7 * 60_000, undefined, 30 * 60_000);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.baseResumeAtMs, NOW.getTime() + 30 * 60_000);
  assert.equal(p.job.resumeAtMs, NOW.getTime() + 37 * 60_000);
  assert.equal(p.job.jitterMs, 7 * 60_000);
  assert.equal(p.job.backoffMs, 30 * 60_000);
});

test('the random delay under a backoff is drawn from the configured range (A6)', () => {
  const seen: [number, number][] = [];
  const jitter = (min: number, max: number) => {
    seen.push([min, max]);
    return min * 60_000;
  };
  planResume(overloadHit, 'overload', settings({ randomDelayMinMinutes: 2, randomDelayMaxMinutes: 9 }), small, NOW, jitter, undefined, 15 * 60_000);
  assert.deepEqual(seen, [[2, 9]]);
});

test('a limit ignores any overload backoff (A6)', () => {
  const at = new Date('2026-08-03T17:00:00Z');
  const p = planResume(hit(at), 'limit', settings(), small, NOW, noJitter, undefined, 60 * 60_000);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.baseResumeAtMs, at.getTime());
  assert.equal(Object.hasOwn(p.job, 'backoffMs'), false);
});

test('a first overload retry carries no backoff key (A6)', () => {
  const p = planResume(overloadHit, 'overload', settings(), small, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.baseResumeAtMs, NOW.getTime());
  assert.equal(Object.hasOwn(p.job, 'backoffMs'), false);
});

// Wave D, D3 (policy B): a limit that resets beyond maxWaitHours is scheduled
// as usual - the claim, the status bar and persistence all come with that -
// but marked offer-only, so the fire offers Resume Now instead of launching.
test('an offer-only detection puts offerOnly on the job', () => {
  const at = new Date('2026-08-07T06:00:00Z');
  const offer = { ...hit(at), detection: { ...hit(at).detection, offerOnly: true as const } };
  const p = planResume(offer, 'limit', settings(), small, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.offerOnly, true);
  assert.equal(p.job.baseResumeAtMs, at.getTime(), 'scheduled for the stated reset, as any other limit');
});

test('an ordinary detection leaves offerOnly off the job, so a persisted job stays as it was', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), small, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(Object.hasOwn(p.job, 'offerOnly'), false);
});

test('a session with no usage record is unmeasured: scheduled, flagged, with no estimate', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), () => 5_000_000, NOW, noJitter, () => undefined);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.estimate, undefined);
  assert.equal(p.budgetUnmeasured, true);
});

test('with the cap off, an unmeasured session is not flagged', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings({ maxResumeTokens: 0 }), small, NOW, noJitter, () => undefined);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.budgetUnmeasured, undefined);
});
