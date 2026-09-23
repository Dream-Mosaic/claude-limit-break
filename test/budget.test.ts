import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTES_PER_TOKEN,
  estimateResumeTokens,
  checkBudget,
  IncidentBudget,
  contextTokens,
  parseLastUsage,
} from '../src/budget';

test('the estimate matches the measured calibration point', () => {
  // Spike: a cold resume of a 1,618,394-byte transcript cost 288,574
  // cache-creation tokens. Hold the estimator to within 5% of that.
  const measured = 288_574;
  const estimate = estimateResumeTokens(1_618_394);
  const drift = Math.abs(estimate - measured) / measured;
  assert.ok(drift < 0.05, `estimate ${estimate} drifted ${(drift * 100).toFixed(1)}% from ${measured}`);
});

test('the divisor is the documented one', () => {
  assert.equal(BYTES_PER_TOKEN, 5.6);
  assert.equal(estimateResumeTokens(5600), 1000);
});

test('zero bytes estimates zero', () => {
  assert.equal(estimateResumeTokens(0), 0);
});

test('allows a resume under the cap', () => {
  const v = checkBudget(500_000, 150_000);
  assert.equal(v.allowed, true);
  assert.equal(v.estimate, estimateResumeTokens(500_000));
});

test('refuses a resume over the cap and says why', () => {
  const v = checkBudget(1_618_394, 150_000);
  assert.equal(v.allowed, false);
  assert.match(v.reason!, /288,\d{3}/);
  assert.match(v.reason!, /150,000/);
});

test('checkBudget: an estimate exactly at the cap is allowed, not rejected', () => {
  // Issue #12 boundary: `estimate > maxResumeTokens` in checkBudget. 5600
  // bytes estimates to exactly 1000 tokens (Math.round(5600 / 5.6) === 1000,
  // the same figures the divisor test above uses), an exact tie with the cap.
  const v = checkBudget(5600, 1000);
  assert.equal(v.estimate, 1000);
  assert.equal(v.allowed, true, 'an estimate exactly at the cap must still be allowed');
});

test('a cap of zero disables the check', () => {
  assert.equal(checkBudget(10_000_000, 0).allowed, true);
});

test('unknown size is allowed but flagged', () => {
  const v = checkBudget(0, 150_000);
  assert.equal(v.allowed, true);
  assert.equal(v.estimate, 0);
});

test('incident budget accumulates and hard-stops', () => {
  const b = new IncidentBudget();
  assert.equal(b.total, 0);
  b.add(100_000);
  b.add(60_000);
  assert.equal(b.total, 160_000);
  assert.equal(b.exceeded(150_000), true);
  assert.equal(b.exceeded(200_000), false);
  b.reset();
  assert.equal(b.total, 0);
});

test('incident budget ignores nonsense usage numbers', () => {
  const b = new IncidentBudget();
  b.add(Number.NaN);
  b.add(-5);
  assert.equal(b.total, 0);
});

// ---------------------------------------------------------------------------
// Estimating from the transcript's own usage records.
//
// Counting bytes counts everything ever written to the file: turns already
// summarised away by compaction, segments a reload replayed verbatim, and the
// bookkeeping lines that never reach a prompt. On a real 11.2 MB session that
// read 2,007,179 tokens, while the session's own records show the largest
// cache creation it ever paid was 407,570. The estimate refused a resume that
// would have cost a quarter of what it claimed.
// ---------------------------------------------------------------------------

const usageLine = (u: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { usage: u }, ...extra });

test('the live context is what a cold resume has to re-create', () => {
  assert.equal(
    contextTokens({ input: 2, cacheRead: 24_591, cacheCreate: 407_570 }),
    432_163,
    'input + what was read from cache + what was written to it',
  );
});

test('parseLastUsage takes the newest record, not the first', () => {
  const tail = [
    usageLine({ input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 100 }),
    usageLine({ input_tokens: 2, cache_read_input_tokens: 20, cache_creation_input_tokens: 200 }),
  ].join('\n');
  assert.deepEqual(parseLastUsage(tail), { input: 2, cacheRead: 20, cacheCreate: 200 });
});

test('parseLastUsage ignores lines that carry no usage', () => {
  const tail = [
    usageLine({ input_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 500 }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'hi' }),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
  ].join('\n');
  assert.deepEqual(parseLastUsage(tail), { input: 5, cacheRead: 50, cacheCreate: 500 });
});

test('parseLastUsage survives the half line a byte-offset read starts on', () => {
  // Reading a fixed window off the end of a large file lands mid-line. That
  // fragment must be skipped, not throw and not be half-parsed.
  const tail = [
    '{"type":"assistant","message":{"usa',
    usageLine({ input_tokens: 3, cache_read_input_tokens: 30, cache_creation_input_tokens: 300 }),
  ].join('\n');
  assert.deepEqual(parseLastUsage(tail), { input: 3, cacheRead: 30, cacheCreate: 300 });
});

test('parseLastUsage reports nothing when the tail holds no usage at all', () => {
  assert.equal(parseLastUsage('{"type":"user"}\n{"type":"mode"}'), undefined);
  assert.equal(parseLastUsage(''), undefined);
});

test('an estimate prefers the usage record over the byte count', () => {
  const bytes = 11_240_205;
  const fromBytes = estimateResumeTokens(bytes);
  const fromUsage = estimateResumeTokens(bytes, { input: 2, cacheRead: 24_591, cacheCreate: 407_570 });
  assert.equal(fromBytes, 2_007_179, 'the byte estimate is what it always was');
  assert.equal(fromUsage, 432_163);
  assert.ok(fromUsage < fromBytes / 4, 'and on a real session it is several times smaller');
});

test('without a usage record the byte estimate still applies', () => {
  // A session that has never had an assistant turn has nothing to read.
  assert.equal(estimateResumeTokens(1_618_394, undefined), 288_999);
});

test('checkBudget judges the usage-based estimate when there is one', () => {
  const verdict = checkBudget(11_240_205, 500_000, { input: 2, cacheRead: 24_591, cacheCreate: 407_570 });
  assert.equal(verdict.allowed, true, 'a session the byte count would have refused');
  assert.equal(verdict.estimate, 432_163);
});
