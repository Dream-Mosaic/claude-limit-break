import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOverload } from '../../src/parsers/overloadParser';
import { detectLimit } from '../../src/parsers/limitParser';

test('detects transient server failures', () => {
  const positives = [
    'API Error: 500 Internal Server Error',
    'API Error: 503 Service Unavailable',
    'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}',
    'Overloaded',
    'Request failed: fetch failed',
    'Error: connect ECONNRESET',
    'Error: socket hang up',
    'The request timed out',
  ];
  for (const text of positives) {
    assert.ok(detectOverload(text), text);
  }
});

test('a 429 is a rate limit and belongs to the limit parser', () => {
  assert.equal(detectOverload('API Error: 429 Too Many Requests'), undefined);
  assert.equal(detectOverload('Error 429: rate limit exceeded, try again in 2 hours'), undefined);
});

test('ignores prose and source code discussing server errors', () => {
  const negatives = [
    'const RULES = [{ id: "overloaded", re: /529/ }];',
    'I think the API was overloaded earlier in the queue.',
    'describe("overload", () => { expect(status).toBe(503); });',
    'Claude finished the task successfully.',
  ];
  for (const text of negatives) {
    assert.equal(detectOverload(text), undefined, text);
  }
});

test('reports the status code when one is present', () => {
  assert.equal(detectOverload('API Error: 503 Service Unavailable')?.status, 503);
  assert.equal(detectOverload('API Error: 529 Overloaded')?.status, 529);
});

test('rejects text longer than the notice cap', () => {
  assert.equal(detectOverload('API Error: 500 ' + 'x'.repeat(500)), undefined);
});

test('recognises a bare socket hang up, which is how Node prints it', () => {
  assert.ok(detectOverload('socket hang up'));
  assert.ok(detectOverload('Error: socket hang up'), 'prefixed form must keep working');
});

test('the added marker does not admit prose about sockets', () => {
  assert.equal(detectOverload('the socket layer hangs up on idle connections'), undefined);
});

// ---------------------------------------------------------------------------
// Task 4a (synthesis A5): Claude Code's own in-flight retry must not also be
// scheduled - acting on it would interrupt Claude's own backoff. The PARENS
// form carrying a "Retrying in"/"attempt k/n" suffix is that in-flight retry;
// the COLON form with no such suffix is terminal and stays actionable.
// Source: prior-art/1-autoretry-detection.md "Three gaps" #1 (line ~30) and
// the fixture table near line 230; overload.test.js:83-85 ("Acting on it
// would interrupt Claude's own backoff").
// ---------------------------------------------------------------------------

test('an in-flight retry (parens form, "Retrying in"/"attempt k/n") must not schedule anything', () => {
  const positives = [
    // Exact spec string.
    'API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10',
    // Close variants: other codes, other second counts, attempt 10/10, no JSON body.
    'API Error (500) · Retrying in 30s · attempt 10/10',
    'API Error (503 {"type":"error","message":"Service Unavailable"}) · Retrying in 12s · attempt 1/5',
  ];
  for (const text of positives) {
    assert.equal(detectOverload(text), undefined, text);
  }
});

test('the colon form with no retry suffix stays terminal and actionable', () => {
  assert.ok(detectOverload('API Error: 529 Overloaded'), 'colon form with no suffix must still fire');
});

// ---------------------------------------------------------------------------
// Task 4a: the transient-429 render disclaims being a usage limit in its own
// text and must route to overload instead of being dropped by both parsers.
// Source: prior-art/1-autoretry-detection.md "Three gaps" #3 (line ~37-48)
// and the fixture table near line 230.
// ---------------------------------------------------------------------------

const TRANSIENT_429 = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';

test('a transient 429 that disclaims being a usage limit routes to overload', () => {
  const hit = detectOverload(TRANSIENT_429);
  assert.ok(hit, 'must be detected as overload');
  assert.equal(hit.rule, 'transient-429');
});

test('the transient-429 render never arms a usage-limit timer, trusted or not', () => {
  assert.equal(detectLimit(TRANSIENT_429, new Date(), 24, { trusted: false }), undefined, 'untrusted path');
  assert.equal(detectLimit(TRANSIENT_429, new Date(), 24, { trusted: true }), undefined, 'trusted (flagged) path');
});

// ---------------------------------------------------------------------------
// Task 4a: "computer went to sleep mid-response" and its sibling renders
// (dropped connection, stalled stream) must route to overload as a
// retry-class interruption. Anchored on the "API Error:" head so prose that
// merely mentions sleep never matches.
// Sources: prior-art/1-autoretry-detection.md line 80-81 (six of the seven
// variants, verbatim from claude-auto-retry's own fixture, tmux pane %111);
// prior-art/2-autoretry-resume.md line 296-297 (the "before a response was
// produced" sleep variant, config.js:89-90); prior-art/5-history-issues.md
// bug entry #3 ("all seven render variants... suspend, dropped connection,
// stalled stream, mid-response server error in two forms").
// ---------------------------------------------------------------------------

test('sleep/stream-interruption renders route to overload', () => {
  const positives: [string, string][] = [
    // Exact spec string.
    ['API Error: Your computer went to sleep mid-response. The response above may be incomplete.', 'spec string'],
    ['API Error: Your computer went to sleep before a response was produced. Try again.', '2-autoretry-resume.md:296-297'],
    ['API Error: The response stopped arriving. The response above may be incomplete.', '1-autoretry-detection.md:81 (stalled stream)'],
    ['API Error: Connection lost mid-response. The response above may be incomplete.', '1-autoretry-detection.md:81 (dropped connection)'],
    ['API Error: Connection lost before a response was produced. Try again.', '1-autoretry-detection.md:81 (dropped connection)'],
    ['API Error: Server error mid-response. The response above may be incomplete.', '1-autoretry-detection.md:81'],
    ['API Error: The response stalled before a response was produced. Try again.', '1-autoretry-detection.md:81 (stalled stream)'],
  ];
  for (const [text, source] of positives) {
    const hit = detectOverload(text);
    assert.ok(hit, `${source}: ${text}`);
    assert.equal(hit.rule, 'stream-interrupted', source);
  }
});

test('prose merely mentioning sleep, without the API Error: head, never matches', () => {
  assert.equal(
    detectOverload('My computer went to sleep mid-response earlier today, is that a problem?'),
    undefined,
  );
});

test('the exact stream-interruption wording without the API Error: head does not match, even when other overload vocabulary is present', () => {
  // Isolates the head anchor itself: this text carries an ERROR_MARKERS word
  // ("error") so it clears looksLikeOverloadMessage and actually reaches the
  // RULES loop, and it carries the literal "your computer went to sleep
  // mid-response" phrase the rule matches - but with a bare "error:", not
  // "API Error:", ahead of it. Only the head anchor stands between this and
  // a false positive.
  assert.equal(
    detectOverload('There was an error: your computer went to sleep mid-response, apparently.'),
    undefined,
  );
});
