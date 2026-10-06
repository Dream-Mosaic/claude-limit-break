import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateResumeTokens,
  checkBudget,
  IncidentBudget,
  contextTokens,
  parseLastUsage,
} from '../src/budget';

const U150 = { input: 1, cacheRead: 100_000, cacheCreate: 50_000 };

test('allows a resume under the cap', () => {
  const v = checkBudget(500_000, { input: 2, cacheRead: 24_591, cacheCreate: 40_000 });
  assert.equal(v.allowed, true);
  assert.equal(v.estimate, 64_593);
});

test('refuses a resume over the cap and says why', () => {
  const v = checkBudget(150_000, { input: 2, cacheRead: 24_591, cacheCreate: 407_570 });
  assert.equal(v.allowed, false);
  assert.match(v.reason!, /432,163/);
  assert.match(v.reason!, /150,000/);
});

test('checkBudget: an estimate exactly at the cap is allowed, not rejected', () => {
  // Issue #12 boundary: `estimate > maxResumeTokens` in checkBudget.
  const v = checkBudget(150_001, U150);
  assert.equal(v.estimate, 150_001);
  assert.equal(v.allowed, true, 'an estimate exactly at the cap must still be allowed');
  assert.equal(checkBudget(150_000, U150).allowed, false, 'one over is refused');
});

test('a cap of zero disables the check', () => {
  assert.equal(checkBudget(0, { input: 1, cacheRead: 10_000_000, cacheCreate: 0 }).allowed, true);
});

test('a session with no usage record is unmeasured: allowed, with no estimate', () => {
  const v = checkBudget(150_000, undefined);
  assert.equal(v.allowed, true);
  assert.equal(v.estimate, undefined);
  assert.equal(estimateResumeTokens(undefined), undefined);
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

// The two shapes Claude Code really writes for its synthetic limit/overload
// entry (grep of ~/.claude/projects: 140 of 143 are all-zero).
const REAL_TURN = { input_tokens: 2, cache_read_input_tokens: 24_591, cache_creation_input_tokens: 407_570 };
const REAL_TURN_RECORD = { input: 2, cacheRead: 24_591, cacheCreate: 407_570 };
const SHORT_ZERO = { input_tokens: 0, output_tokens: 0 };
const LONG_ZERO = {
  output_tokens_details: null,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: null,
};
const syntheticLine = (usage: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { model: '<synthetic>', usage, content: [{ type: 'text', text: 'API Error: 529' }] },
  });

for (const [name, zero] of [['short', SHORT_ZERO], ['long', LONG_ZERO]] as const) {
  test(`parseLastUsage reads the real turn behind a synthetic zero-usage error entry (${name} shape)`, () => {
    const tail = [usageLine(REAL_TURN), syntheticLine(zero)].join('\n');
    assert.deepEqual(parseLastUsage(tail), REAL_TURN_RECORD);
  });
}

test('parseLastUsage reports nothing when the window holds only synthetic zero-usage entries', () => {
  const tail = [syntheticLine(SHORT_ZERO), syntheticLine(LONG_ZERO)].join('\n');
  assert.equal(parseLastUsage(tail), undefined);
  assert.equal(estimateResumeTokens(parseLastUsage(tail)), undefined, 'so the session is unmeasured');
});

test('parseLastUsage reaches a real turn behind a ~3 MB image-bearing entry and a synthetic error', () => {
  const image = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(3_000_000) } }] },
  });
  const tail = [usageLine(REAL_TURN), image, syntheticLine(LONG_ZERO)].join('\n');
  assert.ok(tail.length > 3_000_000);
  assert.deepEqual(parseLastUsage(tail), REAL_TURN_RECORD);
});

test('parseLastUsage skips an isApiErrorMessage entry even when its usage is not zero', () => {
  const flagged = JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { usage: { input_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 } } });
  assert.deepEqual(parseLastUsage([usageLine(REAL_TURN), flagged].join('\n')), REAL_TURN_RECORD);
});

test('parseLastUsage skips a <synthetic> model entry even when its usage is not zero', () => {
  const synthetic = JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 } } });
  assert.deepEqual(parseLastUsage([usageLine(REAL_TURN), synthetic].join('\n')), REAL_TURN_RECORD);
});

test('parseLastUsage still reads a real turn that carries neither flag', () => {
  const real = JSON.stringify({ type: 'assistant', isApiErrorMessage: false, message: { model: 'claude-opus-4', usage: REAL_TURN } });
  assert.deepEqual(parseLastUsage(real), REAL_TURN_RECORD);
});

test('parseLastUsage skips an unflagged entry whose counted usage sums to zero', () => {
  const zero = usageLine({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(parseLastUsage([usageLine(REAL_TURN), zero].join('\n')), REAL_TURN_RECORD);
  assert.equal(parseLastUsage(zero), undefined);
});

test('an estimate is the live context of the usage record', () => {
  assert.equal(estimateResumeTokens({ input: 2, cacheRead: 24_591, cacheCreate: 407_570 }), 432_163);
});

test('checkBudget judges the usage-based estimate when there is one', () => {
  const verdict = checkBudget(500_000, { input: 2, cacheRead: 24_591, cacheCreate: 407_570 });
  assert.equal(verdict.allowed, true, 'a session a byte count would have refused');
  assert.equal(verdict.estimate, 432_163);
});
