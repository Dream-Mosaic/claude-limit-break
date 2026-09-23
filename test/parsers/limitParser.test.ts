import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLimit,
  looksLikeCode,
  looksLikeLimitMessage,
  normalize,
  formatDuration,
  MAX_NOTICE_LENGTH,
} from '../../src/parsers/limitParser';

const NOW = new Date('2026-08-03T12:00:00Z');
const MAXW = 24;
const epochAt = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

test('detects every documented limit format', () => {
  const positives: [string, string][] = [
    [`Claude AI usage limit reached|${epochAt('2026-08-03T17:00:00Z')}`, 'epoch'],
    ['You have hit your session limit, resets at 2026-08-03T18:00:00Z', 'iso'],
    ["You've hit your session limit - resets 1:40am (Asia/Jerusalem)", 'clock+tz'],
    ['Claude usage limit reached, resets at 12:00 (UTC+3)', 'clock+offset'],
    ['Claude AI usage limit reached. Try again in 5 hours', 'duration-hours'],
    ['Usage limit reached - retry in about 4h 32m', 'duration-compound'],
    ['Session limit reached. Try again in 45 minutes', 'duration-minutes'],
    ['You have reached your usage limit. Try again in 5 hours.', 'phrasing'],
    ['Error 429: rate limit exceeded, try again in 2 hours', '429-routes-here'],
    // Captured verbatim from a real transcript on 2026-09-09, when two probe
    // sessions hit an actual limit. The bare epoch form above was written from
    // the docs; this is what Claude Code really writes, with a status prefix and
    // a middot ahead of the notice the parser is looking for.
    [`API Error: Request rejected (429) · Claude AI usage limit reached|${epochAt('2026-08-03T17:00:00Z')}`, 'real-429-prefixed'],
    // Also captured verbatim, 2026-09-10 and 2026-09-11, from this project's own
    // sessions hitting genuine limits. Note the middot separator, where the form
    // taken from the docs above uses a hyphen, and the bare hour with no minutes.
    ["You've hit your session limit · resets 12:40am (America/Chicago)", 'real-clock+tz-middot'],
    ["You've hit your session limit · resets 2am (America/Chicago)", 'real-bare-hour'],
  ];
  for (const [text, tag] of positives) {
    assert.ok(detectLimit(text, NOW, MAXW), `${tag}: ${text}`);
  }
});

test('a bullet glued to the reset time still parses', () => {
  // Claude-Autopilot's issue #25 was a live break: the CLI started writing
  // "5-hour limit reached ∙ resets 1am" and their regex, which had the
  // separator baked in, stopped matching. Their PR #26 then had to handle
  // three different bullet codepoints.
  //
  // This parser never had that exposure, but NOT because of the bullet class in
  // `normalize` - the patterns simply do not care what sits between the hint and
  // the time. `5-hour limit reached BANANA resets 1am` parses. Which means the
  // obvious regression test - the notice with a bullet where the separator goes -
  // proves nothing: it passes with bullet normalisation deleted. Removing that
  // line leaves the whole suite green, so nothing here pinned it.
  //
  // The one shape that genuinely depends on it is a bullet with no spaces
  // between `resets` and the time, which reaches the time matcher as a single
  // token. That is what this test pins. It fails if the bullet class in
  // `normalize` is removed; the cases above do not.
  const glued = '5-hour limit reached resets∙1am';
  assert.ok(detectLimit(glued, NOW, MAXW), 'bullet glued to the time must normalise away');

  // All five separators Claude Code has been seen to use, plus the ASCII form.
  for (const sep of ['∙', '·', '•', '‧', '●', '-']) {
    const text = `5-hour limit reached ${sep} resets 1am`;
    assert.ok(detectLimit(text, NOW, MAXW), `separator ${JSON.stringify(sep)}: ${text}`);
  }
});

test('ignores prose and source code that merely discuss limits', () => {
  const negatives: [string, string][] = [
    ['function isLimit() { return /limit reached/.test(s); }', 'source'],
    ['Claude finished the task successfully.', 'unrelated'],
    ['resets at 14:00 (UTC)', 'time-without-hint'],
    ['Try again in 5 hours', 'duration-without-hint'],
  ];
  for (const [text, tag] of negatives) {
    assert.equal(detectLimit(text, NOW, MAXW), undefined, `${tag}: ${text}`);
  }
});

test('rejects a reset time beyond the wait horizon', () => {
  assert.equal(detectLimit('Usage limit reached. Try again in 40 hours', NOW, MAXW), undefined);
});

test('rejects a reset time already in the past', () => {
  const past = `Claude AI usage limit reached|${epochAt('2026-08-03T09:00:00Z')}`;
  assert.equal(detectLimit(past, NOW, MAXW), undefined);
});

test('resolves the epoch format to the exact instant', () => {
  const hit = detectLimit(`Claude AI usage limit reached|${epochAt('2026-08-03T17:00:00Z')}`, NOW, MAXW);
  assert.equal(hit?.resumeAt.toISOString(), '2026-08-03T17:00:00.000Z');
});

test('ANSI escapes are stripped before a notice is matched', () => {
  const noisy = `\x1b[31mClaude AI usage limit reached. Try again in 5 hours\x1b[0m`;
  assert.ok(detectLimit(noisy, NOW, MAXW), 'normalize() must strip SGR sequences first');
});

test('looksLikeCode flags the punctuation prose does not use', () => {
  assert.ok(looksLikeCode('const x = () => 1;'));
  assert.ok(looksLikeCode('// resets at 3pm'));
  assert.equal(looksLikeCode('Usage limit reached. Try again in 5 hours.'), false);
});

test('formatDuration renders compact countdowns', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(3_600_000 * 4 + 60_000 * 32), '4h 32m');
});

test('detects the bare "your limit" format from the docs', () => {
  const hit = detectLimit('Your limit will reset at 14:00 (UTC)', NOW, MAXW);
  assert.ok(hit, 'documented format must be recognised');
  assert.equal(hit.resumeAt.toISOString(), '2026-08-03T14:00:00.000Z');
});

test('detectLimit guards against source code internally', () => {
  const code = 'const LIMIT_HINTS = [/usage limit reached/i]; // try again in 5 hours';
  assert.equal(detectLimit(code, NOW, MAXW), undefined);
});

test('detectLimit rejects text longer than the notice cap', () => {
  const long = 'Usage limit reached. Try again in 5 hours.' + ' x'.repeat(MAX_NOTICE_LENGTH);
  assert.equal(detectLimit(long, NOW, MAXW), undefined);
});

test('a trusted entry bypasses the source-code guard', () => {
  const banner = 'Claude AI usage limit reached `retry` => try again in 5 hours';
  assert.equal(detectLimit(banner, NOW, MAXW), undefined, 'untrusted: guarded');
  assert.ok(detectLimit(banner, NOW, MAXW, { trusted: true }), 'trusted: allowed');
});

test('a real captured 429 notice resolves to the instant it names, prefix and all', () => {
  // Regression for the shape recovered from the 2026-09-09 probe sessions. The
  // epoch is the reset time; the surrounding "API Error: Request rejected
  // (429) · " prefix must not shift or defeat it.
  const resetAt = new Date('2026-08-03T17:00:00Z');
  const hit = detectLimit(
    `API Error: Request rejected (429) · Claude AI usage limit reached|${epochAt(resetAt.toISOString())}`,
    NOW,
    MAXW,
  );
  assert.ok(hit, 'the real notice must be detected');
  assert.equal(hit.resumeAt.getTime(), resetAt.getTime(), 'the epoch must resolve to the exact instant');
});

test('the real session-limit notices this project captured resolve to the right instant', () => {
  // Two genuine notices, copied out of transcripts rather than written from the
  // docs. Between them they cover the two ways the observed wording differs from
  // the documented form: a middot rather than a hyphen before "resets", and an
  // hour with no minutes. NOW is 2026-08-03T12:00:00Z, so both resolve to the
  // next occurrence of that clock time in Chicago, which is on CDT (UTC-5).
  const cases: [string, string][] = [
    ["You've hit your session limit · resets 12:40am (America/Chicago)", '2026-08-04T05:40:00.000Z'],
    ["You've hit your session limit · resets 2am (America/Chicago)", '2026-08-04T07:00:00.000Z'],
  ];
  for (const [text, expected] of cases) {
    const hit = detectLimit(text, NOW, MAXW);
    assert.ok(hit, `not detected: ${text}`);
    assert.equal(hit.resumeAt.toISOString(), expected, `wrong instant for: ${text}`);
  }
});

test('a zoneless reset time crossing a DST change still resolves to the right wall clock (#10)', () => {
  // "You have hit your session limit, resets 5am" carries no zone of its own,
  // so this exercises the "no zone named in the notice" branch of
  // resolveClockTime - the one that used to roll an already-past reading
  // forward by a flat 24h (DAY_MS) instead of advancing the calendar date and
  // re-deriving the wall clock. A `zone` override pins the case to
  // America/Chicago without depending on the machine's own zone: `TZ` is not
  // reliably honoured by Node on Windows, so a bare `process.env.TZ` swap
  // would not actually move this test.
  //
  // Each `now` is 22:00 local the night before the reset, exactly as in issue
  // #10's repro. The three nights are the issue's own table:
  //   2024-03-09 -> reset morning 2024-03-10 is the US spring-forward day.
  //   2024-11-02 -> reset morning 2024-11-03 is the US fall-back day.
  //   2024-06-10 -> control, no DST crossing, isolates the cause.
  // In every case the expected wall clock is 05:00 America/Chicago. Before
  // the fix this resolved to 06:00 (spring forward) and, worse, 04:00 (fall
  // back) - an hour *before* the limit actually lifts, resuming into a
  // session that is still limited.
  const text = 'You have hit your session limit, resets 5am';
  const cases: [string, string, string][] = [
    ['2024-03-09 spring forward', '2024-03-10T04:00:00.000Z', '2024-03-10T10:00:00.000Z'],
    ['2024-11-02 fall back', '2024-11-03T03:00:00.000Z', '2024-11-03T11:00:00.000Z'],
    ['2024-06-10 control', '2024-06-11T03:00:00.000Z', '2024-06-11T10:00:00.000Z'],
  ];
  for (const [label, nowIso, expected] of cases) {
    const now = new Date(nowIso);
    const hit = detectLimit(text, now, MAXW, { zone: 'America/Chicago' });
    assert.ok(hit, `not detected (${label}): ${text}`);
    assert.equal(hit.resumeAt.toISOString(), expected, `wrong instant for ${label}`);
  }
});

// Issue #12: mutation testing found 10 of LIMIT_HINTS' entries could each be
// deleted without any test failing - nothing pinned any one of them
// individually. Each test below uses the exact input from the issue's table,
// chosen so it trips only that one hint (checked by hand against every other
// pattern in the array); deleting the hint it targets must turn it red.
test('LIMIT_HINTS: \\blimit reached\\b', () => {
  assert.ok(looksLikeLimitMessage('Limit reached. Try again in 3 hours'));
});

test('LIMIT_HINTS: (session|usage|weekly|daily|opus|sonnet) limit', () => {
  assert.ok(looksLikeLimitMessage('Weekly limit exceeded, resets in 2 hours'));
});

test('LIMIT_HINTS: rate[- ]limit(ed|s)?', () => {
  assert.ok(looksLikeLimitMessage('You are being rate limited. Try again in 10 minutes'));
});

test("LIMIT_HINTS: you've/have hit...limit", () => {
  assert.ok(looksLikeLimitMessage('You have used up your monthly limit. Try again in 3 hours'));
});

test('LIMIT_HINTS: out of (tokens|credits|usage|quota)', () => {
  assert.ok(looksLikeLimitMessage('You are out of tokens for this session. Try again in 3 hours'));
});

test('LIMIT_HINTS: \\d+-hour limit', () => {
  assert.ok(looksLikeLimitMessage('5-hour limit exceeded. Try again in 3 hours'));
});

test('LIMIT_HINTS: quota (exceeded|reached|exhausted)', () => {
  assert.ok(looksLikeLimitMessage('Your monthly quota exhausted. Try again in 3 hours'));
});

test('LIMIT_HINTS: upgrade to (claude )?max', () => {
  assert.ok(looksLikeLimitMessage('Please upgrade to Max for higher limits. Try again in 3 hours'));
});

test('LIMIT_HINTS: error...429', () => {
  assert.ok(looksLikeLimitMessage('Error: 429 received from API. Try again in 3 hours'));
});

test('LIMIT_HINTS: 429...too many requests', () => {
  assert.ok(looksLikeLimitMessage('429 Too Many Requests. Try again in 3 hours'));
});

// Issue #12: normalize()'s curly-quote, dash and escaped-newline transforms
// were each unpinned - deleting any one line left the whole suite green.
test('normalize(): curly quotes fold to straight quotes', () => {
  assert.equal(normalize("You’ve hit your limit"), "You've hit your limit");
  assert.equal(normalize('Claude said “wait”'), 'Claude said "wait"');
});

test('normalize(): unicode dashes fold to ASCII hyphen', () => {
  // U+2010 HYPHEN, as seen in a captured "rate‐limited" notice.
  assert.equal(normalize('rate‐limited'), 'rate-limited');
});
