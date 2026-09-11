import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLimit,
  looksLikeCode,
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
