import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLimit,
  looksLikeCode,
  looksLikeLimitMessage,
  looksLikePercentageUsage,
  looksLikeQuotedNotice,
  normalize,
  formatDuration,
  MAX_NOTICE_LENGTH,
  RESET_GRACE_MS,
  resolveStructuredReset,
  classifyLimit,
  MAX_RESET_DAYS,
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
    // Real transcript text: a status prefix and a middot ahead of the notice.
    [`API Error: Request rejected (429) · Claude AI usage limit reached|${epochAt('2026-08-03T17:00:00Z')}`, 'real-429-prefixed'],
    // Real notices: a middot separator (the documented form uses a hyphen), and a bare hour with no minutes.
    ["You've hit your session limit · resets 12:40am (America/Chicago)", 'real-clock+tz-middot'],
    ["You've hit your session limit · resets 2am (America/Chicago)", 'real-bare-hour'],
  ];
  for (const [text, tag] of positives) {
    assert.ok(detectLimit(text, NOW, MAXW), `${tag}: ${text}`);
  }
});

test('a bullet glued to the reset time still parses', () => {
  // The patterns ignore what sits between the hint and the time, so a bullet with
  // spaces around it passes even without bullet normalisation. A bullet with no
  // spaces reaches the time matcher as one token, and fails if the bullet class in
  // `normalize` is removed.
  const glued = '5-hour limit reached resets∙1am';
  assert.ok(detectLimit(glued, NOW, MAXW), 'bullet glued to the time must normalise away');

  // The separators Claude Code uses, plus the ASCII form.
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

// Beyond the wait horizon is offer-only; only past MAX_RESET_DAYS is it rejected.
test('a reset time beyond the wait horizon is offer-only, not automatic', () => {
  assert.equal(detectLimit('Usage limit reached. Try again in 40 hours', NOW, MAXW)?.offerOnly, true);
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
  // A day unit, so a weekly reset is not "167h 0m".
  assert.equal(formatDuration(3_600_000 * 23 + 60_000 * 59), '23h 59m');
  assert.equal(formatDuration(86_400_000), '1d 0h');
  assert.equal(formatDuration(86_400_000 * 6 + 3_600_000 * 23 + 60_000 * 59), '6d 23h');
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
  // The "API Error: Request rejected (429) · " prefix must not shift or defeat the epoch.
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
  // Two real notices: a middot rather than a hyphen before "resets", and an hour
  // with no minutes. NOW is 2026-08-03T12:00:00Z, so both resolve to the next
  // occurrence of that clock time in Chicago, on CDT (UTC-5).
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

test('a zoneless reset time crossing a DST change still resolves to the right wall clock', () => {
  // No zone in the notice exercises the "no zone named" branch of resolveClockTime:
  // the calendar date must advance and the wall clock be re-derived, not a flat 24h
  // added. A `zone` override pins America/Chicago, since `TZ` is not reliably
  // honoured by Node on Windows. Each `now` is 22:00 local the night before the
  // reset; the expected wall clock is 05:00 Chicago in every case:
  //   2024-03-09 -> reset morning is the US spring-forward day.
  //   2024-11-02 -> reset morning is the US fall-back day.
  //   2024-06-10 -> control, no DST crossing.
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

test('a wall-clock time inside a DST fall-back repeated hour resolves to the LATER instant', () => {
  // America/Chicago falls back on 2026-11-01, so 01:00-01:59 happens twice (CDT,
  // then CST). "resets 1:30am" is ambiguous; the LATER instant is safe, since waking
  // early risks resuming into a session that is still limited.
  // `now` is 2026-11-01T05:30:00Z (00:30 local, still CDT), so dayOffset=0 is under test.
  const now = new Date('2026-11-01T05:30:00Z');
  const text = "You've hit your session limit · resets 1:30am (America/Chicago)";
  const hit = detectLimit(text, now, MAXW);
  assert.ok(hit, 'not detected');
  assert.equal(
    hit.resumeAt.toISOString(),
    '2026-11-01T07:30:00.000Z',
    'must resolve to the LATER (CST) instant of the repeated hour, not the earlier (CDT) one',
  );
});

test('a wall-clock time inside a DST spring-forward SKIPPED hour resolves to the safe, LATER side of the gap', () => {
  // America/Chicago springs forward on 2026-03-08, so 02:00-02:59 never happens.
  // "resets 2:30am" names a nonexistent reading; it must resolve to the safe, LATER
  // side of the gap (03:30 CDT, 2026-03-08T08:30:00Z), never an hour early.
  // `now` is 2026-03-08T06:30:00Z (00:30 local, still CST), so dayOffset=0 is under test.
  const now = new Date('2026-03-08T06:30:00Z');
  const text = "You've hit your session limit · resets 2:30am (America/Chicago)";
  const hit = detectLimit(text, now, MAXW);
  assert.ok(hit, 'not detected');
  assert.equal(
    hit.resumeAt.toISOString(),
    '2026-03-08T08:30:00.000Z',
    'must resolve to the safe, LATER side of the spring-forward gap (03:30 CDT), not the early side (01:30 CST)',
  );
});

// Each test uses an input that trips only one LIMIT_HINTS entry, so deleting that
// hint turns it red.
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

// normalize()'s curly-quote, dash and escaped-newline transforms are each pinned.
test('normalize(): curly quotes fold to straight quotes', () => {
  assert.equal(normalize("You’ve hit your limit"), "You've hit your limit");
  assert.equal(normalize('Claude said “wait”'), 'Claude said "wait"');
});

test('normalize(): unicode dashes fold to ASCII hyphen', () => {
  // U+2010 HYPHEN, as seen in a captured "rate‐limited" notice.
  assert.equal(normalize('rate‐limited'), 'rate-limited');
});

test('normalize(): JSON-escaped newlines become spaces', () => {
  // A literal backslash-n (two characters), as in a notice captured raw from a JSON payload.
  assert.equal(normalize('Usage limit reached.\\nTry again in 5 hours'), 'Usage limit reached. Try again in 5 hours');
});

// 400/401 are hardcoded rather than derived from MAX_NOTICE_LENGTH, so a mutation
// of the constant shows up as a wrong-length string.
test('detectLimit: MAX_NOTICE_LENGTH boundary (400 accepted, 401 rejected)', () => {
  const base = 'Usage limit reached. Try again in 5 hours.';
  const at400 = base + 'x'.repeat(400 - base.length);
  const at401 = base + 'x'.repeat(401 - base.length);
  assert.ok(detectLimit(at400, NOW, MAXW), 'exactly 400 chars must still be accepted');
  assert.equal(detectLimit(at401, NOW, MAXW), undefined, '401 chars must be rejected');
});

test('detectLimit: the wait-horizon boundary accepts an exact tie', () => {
  // MAXW is 24, so "24 hours" resolves to exactly now + maxWaitHours*HOUR_MS -
  // precisely the wait horizon, not past it. `>` accepts a tie; `>=` would not.
  const hit = detectLimit('Usage limit reached. Try again in 24 hours', NOW, MAXW);
  assert.ok(hit, 'a resume landing exactly on the wait horizon must still be accepted');
  assert.equal(hit.resumeAt.getTime(), NOW.getTime() + 24 * 3_600_000);
});

// RESET_GRACE_MS: a resolved reset in the past is still due now within the window,
// and history beyond it. `readAt` (the real clock) is distinct from `now` (the basis
// a relative notice resolves against): the grace check must use `readAt`.

test('detectLimit: RESET_GRACE_MS boundary, decided against readAt rather than the resolving basis', () => {
  const readAt = new Date('2026-08-03T12:00:00Z');
  // 25 minutes before readAt, so "in 10 minutes" resolves to 15 minutes
  // (RESET_GRACE_MS) before readAt - exactly the edge of the window.
  const basis = new Date(readAt.getTime() - RESET_GRACE_MS - 10 * 60_000);
  const text = 'Claude AI usage limit reached. Try again in 10 minutes';

  const atEdge = detectLimit(text, basis, MAXW, { readAt });
  assert.ok(atEdge, 'exactly RESET_GRACE_MS old (by readAt) is "at most" the grace, not history');
  assert.equal(atEdge.resumeAt.getTime(), readAt.getTime() - RESET_GRACE_MS);

  const pastEdge = detectLimit(text, basis, MAXW, { readAt: new Date(readAt.getTime() + 1) });
  assert.equal(pastEdge, undefined, 'one millisecond further back (by readAt) must tip it into history');
});

test('detectLimit: omitting readAt keeps every existing caller unaffected (readAt defaults to now)', () => {
  // The default reuses one time reference for both roles.
  const past = 'Claude AI usage limit reached. Try again in 10 minutes';
  assert.ok(detectLimit(past, new Date(NOW.getTime() - 20 * 60_000), MAXW), 'still within grace of its own basis');
});

// resolveStructuredReset: quotaLimits.resetsAt, an absolute instant. Same grace and
// horizon rules as detectLimit, with a single time reference.

test('resolveStructuredReset: RESET_GRACE_MS boundary, both sides', () => {
  const now = new Date('2026-08-03T12:00:00Z');
  const atEdge = Math.floor((now.getTime() - RESET_GRACE_MS) / 1000);
  assert.equal(resolveStructuredReset(atEdge, now, MAXW).kind, 'auto', 'exactly RESET_GRACE_MS old is still due now');
  assert.equal(resolveStructuredReset(atEdge - 1, now, MAXW).kind, 'rejected', 'a further second back is history');
});

test('resolveStructuredReset: wait-horizon boundary is automatic on an exact tie, offer-only beyond it', () => {
  const now = new Date('2026-08-03T12:00:00Z');
  const atHorizon = Math.floor((now.getTime() + MAXW * 3_600_000) / 1000);
  assert.equal(resolveStructuredReset(atHorizon, now, MAXW).kind, 'auto', 'exactly at the horizon is still automatic');
  assert.equal(resolveStructuredReset(atHorizon + 3600, now, MAXW).kind, 'offerOnly', 'an hour beyond the horizon is offered');
});

test('resolveStructuredReset: a non-finite value is rejected outright', () => {
  assert.equal(resolveStructuredReset(NaN, new Date(), MAXW).kind, 'rejected');
});

// The clock-reset rollover is grace-aware: a notice read moments after its clock
// time struck is not rolled a full day forward.

test('the clock-reset rollover accepts a today occurrence still inside the grace window', () => {
  // 1:05am Chicago (CST, UTC-6): five minutes past the target, inside RESET_GRACE_MS,
  // so it is due now, not rolled to tomorrow.
  const now = new Date('2026-01-15T07:05:00Z');
  const hit = detectLimit("You've hit your session limit - resets 1am (America/Chicago)", now, MAXW);
  assert.ok(hit, "today's occurrence, five minutes gone, must still be picked");
  assert.equal(hit.resumeAt.toISOString(), '2026-01-15T07:00:00.000Z', "today's 1am CST, not tomorrow's");
});

test('the clock-reset rollover still rolls to tomorrow once the grace window has passed', () => {
  // Same notice, twenty minutes past 1am CST - past RESET_GRACE_MS, so
  // today's occurrence is history and the next real occurrence is tomorrow.
  const now = new Date('2026-01-15T07:20:00Z');
  const hit = detectLimit("You've hit your session limit - resets 1am (America/Chicago)", now, MAXW);
  assert.ok(hit, 'a genuinely missed reset still resolves to the next occurrence');
  assert.equal(hit.resumeAt.toISOString(), '2026-01-16T07:00:00.000Z', "tomorrow's 1am CST");
});

// Text that merely looks like a limit banner (a percentage status line, visibly
// quoted text) must not arm a timer on the untrusted path. A flagged entry is
// unaffected, like the looksLikeCode guard.

test('a percentage-usage status line does not arm untrusted, but does trusted (real false positive)', () => {
  // A usage-percentage status line, not a limit notice.
  const text = "You've used 91% of your session limit · resets 12:40pm";
  assert.equal(detectLimit(text, NOW, MAXW), undefined, 'untrusted: a usage-percentage line must not arm');
  assert.ok(detectLimit(text, NOW, MAXW, { trusted: true }), 'trusted: the same text is unaffected by the veto');
});

test('a line prefixed with `>` does not arm untrusted, but does trusted', () => {
  const text = '> Claude AI usage limit reached. Try again in 5 hours';
  assert.equal(detectLimit(text, NOW, MAXW), undefined, 'untrusted: a blockquoted line must not arm');
  assert.ok(detectLimit(text, NOW, MAXW, { trusted: true }), 'trusted: the same text is unaffected by the veto');
});

test('a grep-style "file.ext:line:" prefix does not arm untrusted, but does trusted', () => {
  const text = 'docs/PRIOR-ART.md:277:Claude AI usage limit reached. Try again in 5 hours';
  assert.equal(detectLimit(text, NOW, MAXW), undefined, 'untrusted: a grep citation must not arm');
  assert.ok(detectLimit(text, NOW, MAXW, { trusted: true }), 'trusted: the same text is unaffected by the veto');
});

test('a bare "path:line-" grep prefix (no file extension) is still recognised', () => {
  const text = 'notes:42-Claude AI usage limit reached. Try again in 5 hours';
  assert.equal(detectLimit(text, NOW, MAXW), undefined);
});

test('an absolute Windows path with a drive letter is still recognised as a grep prefix', () => {
  const text = 'C:\\Users\\x\\y.ts:12:Claude AI usage limit reached. Try again in 5 hours';
  assert.equal(detectLimit(text, NOW, MAXW), undefined, 'untrusted: a drive-letter grep citation must not arm');
  assert.ok(detectLimit(text, NOW, MAXW, { trusted: true }), 'trusted: the same text is unaffected by the veto');
});

test('drive-letter support does not open a hole for real banners', () => {
  // "12:40pm" must not itself be read as a drive letter + path.
  const cases = [
    "You've hit your session limit · resets 12:40am (America/Chicago)",
    "You've hit your session limit · resets 2am (America/Chicago)",
    'Claude usage limit reached, resets at 12:00 (UTC+3)',
    'Claude AI usage limit reached. Try again in 5 hours',
  ];
  for (const text of cases) {
    assert.ok(detectLimit(text, NOW, MAXW), `real banner must still arm: ${text}`);
  }
});

test('a real banner with no quoting marks still arms untrusted (positive control)', () => {
  // The new vetoes must not catch an ordinary, unquoted banner - the whole
  // point of the guard is to stay narrow.
  const text = "You've hit your session limit · resets 2am (America/Chicago)";
  assert.ok(detectLimit(text, NOW, MAXW), 'a genuine unquoted banner must still arm');
});

test('looksLikePercentageUsage flags a "used N%" status line and nothing else', () => {
  assert.ok(looksLikePercentageUsage("You've used 91% of your session limit"));
  assert.equal(looksLikePercentageUsage('Claude AI usage limit reached. Try again in 5 hours'), false);
});

test('looksLikeQuotedNotice recognises backtick, blockquote and grep-prefix forms', () => {
  assert.ok(looksLikeQuotedNotice('`Claude AI usage limit reached`'), 'backtick-fenced');
  assert.ok(looksLikeQuotedNotice('> Claude AI usage limit reached'), 'blockquoted');
  assert.ok(looksLikeQuotedNotice('src/x.ts:12:Claude AI usage limit reached'), 'grep-prefixed');
  assert.equal(
    looksLikeQuotedNotice('Claude AI usage limit reached. Try again in 5 hours'),
    false,
    'a plain banner is not quoted',
  );
});

test('looksLikeQuotedNotice checks each physical line, since normalize() collapses newlines', () => {
  // A multi-line grep dump where only the second line carries the citation
  // prefix - the veto must still catch it even though it is not on line one.
  const text = 'Found 2 matches:\ndocs/PRIOR-ART.md:277:Claude AI usage limit reached. Try again in 5 hours';
  assert.ok(looksLikeQuotedNotice(text));
});

test('looksLikeQuotedNotice recognises an absolute Windows path with a drive letter', () => {
  assert.ok(looksLikeQuotedNotice('C:\\Users\\x\\y.ts:12: Claude AI usage limit reached'), 'drive-letter grep prefix');
  assert.equal(looksLikeQuotedNotice("You've hit your session limit \u00b7 resets 12:40pm"), false, '"12:40pm" is not a drive letter');
});

// A text-path detection names the limit type when the notice does; holderPolicy
// uses it to decide whether native auto-continue (five_hour only) covers the limit.

const LIMIT_TYPE_CASES: [string, string | undefined][] = [
  ["You've hit your session limit · resets 2am (America/Chicago)", 'five_hour'],
  ["You've hit your weekly limit · resets 2am (America/Chicago)", 'seven_day'],
  ["You've hit your Opus limit · resets 2am (America/Chicago)", 'seven_day_opus'],
  ["You've hit your Sonnet limit · resets 2am (America/Chicago)", 'seven_day_sonnet'],
  ["You've hit your Fable limit · resets 2am (America/Chicago)", 'seven_day_overage_included'],
  ["You've hit your usage credit limit · resets 2am (America/Chicago)", 'overage'],
  // Progress-saved suffix Claude Code appends.
  ["You've hit your weekly limit · resets 2am (America/Chicago) · progress saved", 'seven_day'],
  // Text that does not name a type leaves it undefined.
  ['Claude AI usage limit reached. Try again in 5 hours', undefined],
  ['API Error: Request rejected (429) · Claude AI usage limit reached|1785762000', undefined],
  ["You've hit your monthly limit · resets 2am (America/Chicago)", undefined],
];

for (const [text, type] of LIMIT_TYPE_CASES) {
  test(`detectLimit reads the limit type from the text (${type ?? 'undefined'}): ${text.slice(0, 48)}`, () => {
    const hit = detectLimit(text, NOW, MAXW, { trusted: true });
    assert.ok(hit, text);
    assert.equal(hit.rateLimitType, type);
    // An absent type is an absent key, so a detection deep-equals one without the field.
    assert.equal(Object.hasOwn(hit, 'rateLimitType'), type !== undefined);
  });
}

// resolveStructuredReset's three outcomes: within maxWaitHours automatic; beyond it
// up to MAX_RESET_DAYS (8; a weekly reset is at most 7 days) offer-only; further out,
// or further past than the grace, rejected with a reason the caller logs.

const D1_NOW = new Date('2026-08-03T12:00:00Z');
const secs = (ms: number) => ms / 1000;

test('a structured reset within maxWaitHours is automatic, a tie at the horizon included', () => {
  const inTwo = resolveStructuredReset(secs(D1_NOW.getTime() + 2 * 3_600_000), D1_NOW, MAXW);
  assert.deepEqual(inTwo, { kind: 'auto', at: new Date(D1_NOW.getTime() + 2 * 3_600_000) });
  const atHorizon = resolveStructuredReset(secs(D1_NOW.getTime() + MAXW * 3_600_000), D1_NOW, MAXW);
  assert.equal(atHorizon.kind, 'auto', 'exactly at the horizon is still automatic');
});

test('a structured reset one second past maxWaitHours is offer-only', () => {
  const v = resolveStructuredReset(secs(D1_NOW.getTime() + MAXW * 3_600_000) + 1, D1_NOW, MAXW);
  assert.equal(v.kind, 'offerOnly');
});

test('a weekly reset (7 days out) is offer-only, and the 8-day bound is inclusive', () => {
  assert.equal(resolveStructuredReset(secs(D1_NOW.getTime() + 7 * 86_400_000), D1_NOW, MAXW).kind, 'offerOnly');
  const atBound = resolveStructuredReset(secs(D1_NOW.getTime() + MAX_RESET_DAYS * 86_400_000), D1_NOW, MAXW);
  assert.equal(atBound.kind, 'offerOnly', 'exactly 8 days out is still believed');
  assert.equal(MAX_RESET_DAYS, 8);
});

test('a structured reset more than 8 days out is rejected as absurd, with its instant', () => {
  const at = D1_NOW.getTime() + MAX_RESET_DAYS * 86_400_000 + 1000;
  assert.deepEqual(resolveStructuredReset(secs(at), D1_NOW, MAXW), { kind: 'rejected', reason: 'absurd', at: new Date(at) });
});

test('raising maxWaitHours turns a weekly reset automatic, but never past the 8-day bound', () => {
  assert.equal(resolveStructuredReset(secs(D1_NOW.getTime() + 7 * 86_400_000), D1_NOW, 7 * 24).kind, 'auto');
  const nineDays = resolveStructuredReset(secs(D1_NOW.getTime() + 9 * 86_400_000), D1_NOW, 10 * 24);
  assert.equal(nineDays.kind, 'rejected', 'a huge maxWaitHours does not lift the misread bound');
});

test('a structured reset further back than the grace is rejected as past, with its instant', () => {
  const at = D1_NOW.getTime() - RESET_GRACE_MS - 1000;
  assert.deepEqual(resolveStructuredReset(secs(at), D1_NOW, MAXW), { kind: 'rejected', reason: 'past', at: new Date(at) });
});

test('a non-finite structured reset is rejected as unparseable', () => {
  assert.deepEqual(resolveStructuredReset(Number.NaN, D1_NOW, MAXW), { kind: 'rejected', reason: 'unparseable' });
});

test('detectLimit applies the same three outcomes to text', () => {
  const offer = detectLimit('Usage limit reached. Try again in 40 hours', NOW, MAXW);
  assert.equal(offer?.offerOnly, true, '40 hours out is offer-only at maxWaitHours 24');
  assert.equal(offer?.resumeAt.getTime(), NOW.getTime() + 40 * 3_600_000);
  const auto = detectLimit('Usage limit reached. Try again in 5 hours', NOW, MAXW);
  assert.ok(auto);
  assert.equal(Object.hasOwn(auto, 'offerOnly'), false, 'an automatic detection carries no offerOnly key');
  const absurd = classifyLimit('You have hit your session limit, resets at 2026-08-20T00:00:00Z', NOW, MAXW);
  assert.equal(absurd?.kind, 'rejected');
  assert.equal(absurd?.kind === 'rejected' ? absurd.reason : '', 'absurd');
  assert.equal(detectLimit('You have hit your session limit, resets at 2026-08-20T00:00:00Z', NOW, MAXW), undefined);
  // Nor may a clock rule then read the year's "20" as 8pm tonight.
  const retry = classifyLimit('Usage limit reached. Try again at 2026-08-20T00:00:00Z', NOW, MAXW);
  assert.equal(retry?.kind === 'rejected' ? retry.reason : JSON.stringify(retry), 'absurd');
});

test('classifyLimit tells "not a notice at all" (undefined) from a notice it could not use', () => {
  assert.equal(classifyLimit('Claude finished the task successfully.', NOW, MAXW), undefined);
  const v = classifyLimit("You've hit your monthly spend limit · raise it at claude.ai/settings/usage", NOW, MAXW);
  assert.deepEqual(v, { kind: 'rejected', reason: 'unparseable' });
  const past = classifyLimit(`Claude AI usage limit reached|${epochAt('2026-08-03T09:00:00Z')}`, NOW, MAXW);
  assert.equal(past?.kind === 'rejected' ? past.reason : '', 'past');
});

test('an automatic reading from a later rule still beats an offer-only one from an earlier rule', () => {
  // The iso rule (earlier) reads 3 days out; the duration rule (later) reads 2 hours.
  // An offer is only taken when no rule yields an automatic reading.
  const v = detectLimit('Usage limit reached, resets at 2026-08-06T12:00:00Z. Try again in 2 hours', NOW, MAXW);
  assert.equal(v?.resumeAt.getTime(), NOW.getTime() + 2 * 3_600_000);
  assert.equal(v?.offerOnly, undefined);
});

// The dated reset text Claude Code writes for a reset more than 24h out: "Aug 4, 1am",
// "Jun 3 at 4pm", and the docs' weekday form "Mon 12:00am". A zone in parentheses is
// required; the year is the next occurrence on or after the entry's own timestamp.

/** Resolve one notice the way the watcher does: trusted, against `basis`, read now at `readAt`. */
const dated = (text: string, basis: string, maxWait = MAXW, readAt = basis) =>
  classifyLimit(text, new Date(basis), maxWait, { trusted: true, readAt: new Date(readAt) });
const atOf = (v: ReturnType<typeof dated>) => (v?.kind === 'detected' ? v.detection.resumeAt.toISOString() : JSON.stringify(v));

test('a real dated-reset sample with no quotaLimits is an offer-only weekly limit at 1am CDT', () => {
  const v = dated("You've hit your weekly limit · resets Aug 4, 1am (America/Chicago)", '2026-07-31T04:55:10.016Z');
  assert.equal(v?.kind, 'detected');
  if (v?.kind !== 'detected') return;
  assert.equal(v.detection.resumeAt.toISOString(), '2026-08-04T06:00:00.000Z');
  assert.equal(v.detection.offerOnly, true, '97 hours out is beyond maxWaitHours 24');
  assert.equal(v.detection.rateLimitType, 'seven_day');
  assert.equal(v.detection.rule, 'dated-reset');
});

test('a real sample\'s text reset agrees with its own quotaLimits.resetsAt to the second', () => {
  // The same entry carries quotaLimits.resetsAt 1790661600: an independent oracle for the parse.
  const v = dated("You've hit your weekly limit · resets Sep 29, 1am (America/Chicago)", '2026-09-25T01:33:11.483Z');
  assert.equal(atOf(v), new Date(1790661600 * 1000).toISOString());
});

test('raising maxWaitHours makes the same dated reset automatic', () => {
  const v = dated("You've hit your weekly limit · resets Aug 4, 1am (America/Chicago)", '2026-07-31T04:55:10.016Z', 7 * 24);
  assert.equal(v?.kind === 'detected' ? Object.hasOwn(v.detection, 'offerOnly') : 'not detected', false);
});

test('the "Jun 3 at 4pm (Europe/Berlin)" form resolves in CEST', () => {
  assert.equal(atOf(dated("You've hit your weekly limit · resets Jun 3 at 4pm (Europe/Berlin)", '2026-06-01T10:00:00Z')), '2026-06-03T14:00:00.000Z');
});

test('minutes are read when present', () => {
  assert.equal(atOf(dated("You've hit your weekly limit · resets Aug 4, 1:30am (America/Chicago)", '2026-07-31T04:55:10Z')), '2026-08-04T06:30:00.000Z');
  assert.equal(atOf(dated("You've hit your weekly limit · resets Aug 4, 12pm (America/Chicago)", '2026-07-31T04:55:10Z')), '2026-08-04T17:00:00.000Z');
  assert.equal(atOf(dated("You've hit your weekly limit · resets Aug 4, 12am (America/Chicago)", '2026-07-31T04:55:10Z')), '2026-08-04T05:00:00.000Z');
});

test('across New Year, a December entry saying "resets Jan 2" lands in the next year', () => {
  assert.equal(atOf(dated("You've hit your weekly limit · resets Jan 2, 1am (America/Chicago)", '2026-12-29T15:00:00Z')), '2027-01-02T07:00:00.000Z');
  assert.equal(atOf(dated("You've hit your weekly limit · resets Jan 2 at 9am (Europe/Berlin)", '2026-12-29T15:00:00Z')), '2027-01-02T08:00:00.000Z');
  // The zone's own calendar decides the year: 03:00Z on Jan 1 is still Dec 31 in Chicago.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Jan 3, 1am (America/Chicago)", '2027-01-01T03:00:00Z')), '2027-01-03T07:00:00.000Z');
  // ...and the other way: at that same instant "Dec 31, 11pm" is two hours away, not next December.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Dec 31, 11pm (America/Chicago)", '2027-01-01T03:00:00Z')), '2027-01-01T05:00:00.000Z');
  // And a date still ahead this year stays in this year.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Dec 31, 11pm (America/Chicago)", '2026-12-29T15:00:00Z')), '2027-01-01T05:00:00.000Z');
});

test('a DST week in America/Chicago: the offset in force AT THE RESET is used, not the one at the entry', () => {
  // Spring forward 2026-03-08 02:00 CST -> 03:00 CDT.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Mar 9, 1am (America/Chicago)", '2026-03-05T12:00:00Z')), '2026-03-09T06:00:00.000Z');
  // A reading inside the skipped hour lands on the safe, later side of the gap.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Mar 8, 2:30am (America/Chicago)", '2026-03-05T12:00:00Z')), '2026-03-08T08:30:00.000Z');
  // Fall back 2026-11-01 02:00 CDT -> 01:00 CST.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Nov 2, 9am (America/Chicago)", '2026-10-28T12:00:00Z')), '2026-11-02T15:00:00.000Z');
  // The repeated hour resolves to its later pass.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Nov 1, 1:30am (America/Chicago)", '2026-10-28T12:00:00Z')), '2026-11-01T07:30:00.000Z');
});

test('a DST week in Europe/Berlin, both directions', () => {
  // Spring forward 2026-03-29 02:00 CET -> 03:00 CEST.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Mar 30 at 4pm (Europe/Berlin)", '2026-03-25T12:00:00Z')), '2026-03-30T14:00:00.000Z');
  assert.equal(atOf(dated("You've hit your weekly limit · resets Mar 29 at 2:30am (Europe/Berlin)", '2026-03-25T12:00:00Z')), '2026-03-29T01:30:00.000Z');
  // Fall back 2026-10-25 03:00 CEST -> 02:00 CET.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Oct 26, 1am (Europe/Berlin)", '2026-10-21T12:00:00Z')), '2026-10-26T00:00:00.000Z');
  assert.equal(atOf(dated("You've hit your weekly limit · resets Oct 25, 2:30am (Europe/Berlin)", '2026-10-21T12:00:00Z')), '2026-10-25T01:30:00.000Z');
});

test('a dated reset with no zone is not parsed: rejected as unparseable, saying the zone is missing', () => {
  const v = dated("You've hit your weekly limit · resets Aug 4, 1am", '2026-07-31T04:55:10Z');
  assert.equal(v?.kind, 'rejected');
  if (v?.kind !== 'rejected') return;
  assert.equal(v.reason, 'unparseable');
  assert.match(v.detail ?? '', /no time zone/);
  assert.equal(detectLimit("You've hit your weekly limit · resets Jun 3 at 4pm", new Date('2026-06-01T10:00:00Z'), MAXW), undefined);
});

test('a garbage date, time or zone is rejected as unparseable with a reason, never guessed at', () => {
  const cases: [string, RegExp][] = [
    ["You've hit your weekly limit · resets Feb 30, 1am (America/Chicago)", /not a real date/],
    ["You've hit your weekly limit · resets Aug 44, 1am (America/Chicago)", /not a real date/],
    ["You've hit your weekly limit · resets Aug 0, 1am (America/Chicago)", /not a real date/],
    ["You've hit your weekly limit · resets Aug 4, 13pm (America/Chicago)", /not a real time/],
    ["You've hit your weekly limit · resets Aug 4, 0am (America/Chicago)", /not a real time/],
    ["You've hit your weekly limit · resets Aug 4, 1:75am (America/Chicago)", /not a real time/],
    ["You've hit your weekly limit · resets Aug 4, 1am (Mars/Olympus_Mons)", /unknown time zone/],
  ];
  for (const [text, why] of cases) {
    const v = dated(text, '2026-07-31T04:55:10Z');
    assert.equal(v?.kind, 'rejected', text);
    if (v?.kind !== 'rejected') continue;
    assert.equal(v.reason, 'unparseable', text);
    assert.match(v.detail ?? '', why, text);
  }
});

test('a dated reset more than 8 days out is absurd; one already in the past (a fork read later) is history', () => {
  const far = dated("You've hit your weekly limit · resets Aug 9, 1am (America/Chicago)", '2026-07-31T04:55:10Z');
  assert.equal(far?.kind === 'rejected' ? far.reason : atOf(far), 'absurd');
  // A date before the entry itself rolls to next year, which is absurd too.
  const before = dated("You've hit your weekly limit · resets Jul 30, 1am (America/Chicago)", '2026-07-31T04:55:10Z');
  assert.equal(before?.kind === 'rejected' ? before.reason : atOf(before), 'absurd');
  const stale = dated("You've hit your weekly limit · resets Aug 4, 1am (America/Chicago)", '2026-07-31T04:55:10Z', MAXW, '2026-09-01T00:00:00Z');
  assert.equal(stale?.kind === 'rejected' ? stale.reason : atOf(stale), 'past');
});

test('a dated reset that struck minutes before the entry stays this year and is due now (grace)', () => {
  const v = dated("You've hit your weekly limit · resets Aug 4, 1am (America/Chicago)", '2026-08-04T06:05:00Z');
  assert.equal(atOf(v), '2026-08-04T06:00:00.000Z');
  assert.equal(v?.kind === 'detected' ? v.detection.offerOnly : 'x', undefined, 'due now is automatic');
});

test('the weekday form "Mon 12:00am", with a zone, is the next such weekday on or after the entry', () => {
  // Wednesday 2026-09-30 10:00 CDT -> Monday 2026-10-05 00:00 CDT.
  const v = dated("You've hit your weekly limit · resets Mon 12:00am (America/Chicago)", '2026-09-30T15:00:00Z');
  assert.equal(atOf(v), '2026-10-05T05:00:00.000Z');
  assert.equal(v?.kind === 'detected' ? v.detection.rule : '', 'weekday-reset');
  assert.equal(v?.kind === 'detected' ? v.detection.offerOnly : undefined, true);
  // Sunday 22:00 CDT: Monday midnight is two hours away, so automatic.
  const soon = dated("You've hit your weekly limit · resets Mon 12:00am (America/Chicago)", '2026-10-05T03:00:00Z');
  assert.equal(atOf(soon), '2026-10-05T05:00:00.000Z');
  assert.equal(soon?.kind === 'detected' ? soon.detection.offerOnly : 'x', undefined);
  // Monday noon: this Monday's 9am has passed, so it is next Monday's.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Mon 9am (Europe/Berlin)", '2026-10-05T10:00:00Z')), '2026-10-12T07:00:00.000Z');
});

test('the docs\' weekday form exactly as quoted, with no zone, is not parsed and says why', () => {
  const v = dated("You've hit your weekly limit · resets Mon 12:00am", '2026-09-30T15:00:00Z');
  assert.equal(v?.kind === 'rejected' ? v.reason : atOf(v), 'unparseable');
  assert.match(v?.kind === 'rejected' ? v.detail ?? '' : '', /no time zone/);
});

test('the dated forms do not disturb the within-24h clock form', () => {
  assert.equal(atOf(dated("You've hit your session limit · resets 2am (America/Chicago)", '2026-08-03T12:00:00Z')), '2026-08-04T07:00:00.000Z');
});

test('a skipped hour EAST of UTC lands one gap later, not two (London and Berlin, the clock rule too)', () => {
  // East of UTC the two-pass resolve already lands past the gap, and a flat one-hour
  // step would overshoot. London 2026-03-29: 01:00 GMT -> 02:00 BST, so "1:30am" reads 02:30 BST.
  assert.equal(atOf(dated("You've hit your weekly limit · resets Mar 29, 1:30am (Europe/London)", '2026-03-25T12:00:00Z')), '2026-03-29T01:30:00.000Z');
  const clock = detectLimit("You've hit your session limit · resets 1:30am (Europe/London)", new Date('2026-03-28T22:00:00Z'), MAXW);
  assert.equal(clock?.resumeAt.toISOString(), '2026-03-29T01:30:00.000Z');
});
