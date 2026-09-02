import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLimit,
  detectLimitInLines,
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

test('line scanner strips ANSI and matches a single line', () => {
  const buf = `\x1b[31mbuilding\x1b[0m\nClaude AI usage limit reached. Try again in 5 hours\ndone`;
  assert.ok(detectLimitInLines(buf, NOW, MAXW));
});

test('line scanner skips lines longer than the notice cap', () => {
  const long = 'Usage limit reached. Try again in 5 hours' + ' padding'.repeat(60);
  assert.ok(long.length > MAX_NOTICE_LENGTH);
  assert.equal(detectLimitInLines(long, NOW, MAXW), undefined);
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
