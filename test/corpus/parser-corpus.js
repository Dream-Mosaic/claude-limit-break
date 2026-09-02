/**
 * THROWAWAY eval harness. Scores BarPopko's three parsers against the coverage
 * DOCS.md claims, plus a negative set. Nothing here ships.
 */
const OUT = process.env.UPSTREAM_OUT || './upstream/extension/out/';
const L = require(OUT + 'limitParser.js');
const O = require(OUT + 'overloadParser.js');
const I = require(OUT + 'inputParser.js');

// Fixed reference instant so every fixture is deterministic.
const NOW = new Date('2026-08-03T12:00:00Z');
const MAXW = 24;
const epochAt = (iso) => Math.floor(new Date(iso).getTime() / 1000);

const ESC = '\x1b';
let pass = 0, fail = 0;
const failures = [];

function check(group, label, actual, expected, detail) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  if (!ok) failures.push({ group, label, expected, actual, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  const exp = expected ? 'detect' : 'ignore';
  console.log(
    `  [${mark}] want ${exp.padEnd(6)} ${detail ? '(' + detail + ')' : ''} :: ${label.slice(0, 78)}`
  );
}

// ---------------------------------------------------------------- LIMIT
console.log('\n=== limitParser: DOCS.md claimed formats (positives) ===');
const limitPos = [
  [`Claude AI usage limit reached|${epochAt('2026-08-03T17:00:00Z')}`, 'epoch'],
  ['You have hit your session limit, resets at 2026-08-03T18:00:00Z', 'iso'],
  ["You've hit your session limit - resets 1:40am (Asia/Jerusalem)", 'clock+tz'],
  ['Your limit will reset at 14:00 (UTC)', 'clock+utc'],
  ['Claude usage limit reached, resets at 12:00 (UTC+3)', 'clock+offset'],
  ['Claude AI usage limit reached. Try again in 5 hours', 'duration-hours'],
  ['Usage limit reached - retry in about 4h 32m', 'duration-compound'],
  ['Session limit reached. Try again in 45 minutes', 'duration-minutes'],
  ['You have reached your usage limit. Try again in 5 hours.', 'phrasing-variant'],
  ['Error 429: rate limit exceeded, try again in 2 hours', '429->limit'],
];
for (const [text, tag] of limitPos) {
  const d = L.detectLimit(text, NOW, MAXW);
  check('limit+', text, !!d, true, d ? `${tag} -> rule=${d.rule}` : `${tag} -> MISS`);
}

console.log('\n=== limitParser: negatives at RAW detectLimit level ===');
const limitNeg = [
  ['const LIMIT_HINTS = [/usage limit reached/i]; // resets at 3pm', 'source'],
  ['function isLimit() { return /limit reached/.test(s); } // try again in 5 hours', 'source'],
  ['I was reading that the rate limit resets at midnight, which is odd.', 'prose'],
  ['why does my session limit reset at 1:40am instead of midnight?', 'user-question'],
  ['The usage limit reached state is handled in limitParser.ts', 'dev-chat'],
  ['Claude finished the task successfully.', 'unrelated'],
  ['resets at 14:00 (UTC)', 'time-without-hint'],
  ['Try again in 5 hours', 'duration-without-hint'],
];
for (const [text, tag] of limitNeg) {
  const d = L.detectLimit(text, NOW, MAXW);
  check('limit-raw', text, !!d, false, d ? `${tag} -> TRIPPED rule=${d.rule}` : tag);
}

console.log('\n=== limitParser: same negatives through the WATCHER guard chain ===');
console.log('    (unflagged user entry: length cap + looksLikeCode + detectLimit)');
const watcherLimit = (text, flagged = false) => {
  if (text.length > L.MAX_NOTICE_LENGTH) return undefined;
  if (!flagged && L.looksLikeCode(text)) return undefined;
  return L.detectLimit(text, NOW, MAXW);
};
for (const [text, tag] of limitNeg) {
  const d = watcherLimit(text);
  check('limit-guarded', text, !!d, false, d ? `${tag} -> TRIPPED rule=${d.rule}` : tag);
}

console.log('\n=== limitParser: horizon + ANSI handling ===');
check('limit-edge', 'reset 400h out must be rejected by maxWaitHours',
  !!L.detectLimit(`Claude AI usage limit reached|${epochAt('2026-09-20T12:00:00Z')}`, NOW, MAXW), false, 'beyond horizon');
check('limit-edge', 'reset in the past must be rejected',
  !!L.detectLimit(`Claude AI usage limit reached|${epochAt('2026-08-01T12:00:00Z')}`, NOW, MAXW), false, 'past');
const ansi = `${ESC}[38;5;208m${ESC}[1mClaude AI usage limit reached. Try again in 5 hours${ESC}[0m`;
check('limit-edge', 'ANSI-wrapped banner still detected', !!L.detectLimit(ansi, NOW, MAXW), true, 'ansi strip');
const boxed = 'Claude AI usage limit reached. Try again in 5 hours';
check('limit-edge', 'detectLimitInLines finds banner in scrollback',
  !!L.detectLimitInLines(`build ok\nrunning tests\n${boxed}\n$ `, NOW, MAXW), true, 'multiline');
check('limit-edge', 'hint and time on DIFFERENT lines must not pair up',
  !!L.detectLimitInLines('Claude AI usage limit reached\nsome unrelated line\nresets at 14:00 (UTC)', NOW, MAXW),
  false, 'cross-line pairing');

// ---------------------------------------------------------------- OVERLOAD
console.log('\n=== overloadParser: DOCS.md claimed formats (positives) ===');
const ovPos = [
  'API Error: 529 Overloaded. This is a server-side issue, usually temporary',
  'API Error (529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}})',
  'API Error: 500',
  '502 Bad Gateway',
  '503 Service Unavailable',
  '504 Gateway Timeout',
  'API Error: Connection error.',
  'fetch failed',
  'socket hang up',
  'Error: ECONNRESET',
  'Request timed out',
];
for (const text of ovPos) {
  const d = O.detectOverload(text);
  check('overload+', text, !!d, true, d ? `rule=${d.rule}${d.status ? ' status=' + d.status : ''}` : 'MISS');
}

console.log('\n=== overloadParser: negatives ===');
const ovNeg = [
  ['429 Too Many Requests', 'must route to limit parser, not overload'],
  ['Claude AI usage limit reached. Try again in 5 hours', 'usage limit'],
  ['if (status === 529) { return "overloaded"; }', 'source'],
  ['const OVERLOADED = /overloaded_error/; // 529 handling', 'source'],
  ['The queue was overloaded yesterday but it is fine now.', 'prose'],
  ['Everything completed without error.', 'unrelated'],
];
for (const [text, tag] of ovNeg) {
  const d = O.detectOverload(text);
  check('overload-raw', text, !!d, false, d ? `${tag} -> TRIPPED rule=${d.rule}` : tag);
}

console.log('\n=== overloadParser: user pasting an error (watcher gate) ===');
console.log('    watcher only scans overload when (apiError || entry.type !== "user")');
const pasted = 'I got API Error: 529 Overloaded, what does that mean?';
check('overload-raw', pasted + ' [RAW]', !!O.detectOverload(pasted), false, 'raw parser');
const watcherOverload = (text, entryType, apiError) =>
  (apiError || entryType !== 'user') ? O.detectOverload(text) : undefined;
check('overload-guarded', pasted + ' [unflagged user entry]',
  !!watcherOverload(pasted, 'user', false), false, 'watcher gate');

// ---------------------------------------------------------------- INPUT
console.log('\n=== inputParser: positives ===');
const inPos = [
  'Do you want to proceed?',
  'No, and tell Claude what to do differently',
  'Do you want to make this edit to foo.ts?',
  'Would you like to proceed?',
  'Claude is waiting for your input',
];
for (const text of inPos) {
  const d = I.detectInputNeeded(text);
  check('input+', text, !!d, true, d ? `rule=${d.rule}` : 'MISS');
}

console.log('\n=== inputParser: negatives ===');
const inNeg = [
  ['The permission model is described in the docs.', 'prose'],
  ['Claude finished the task.', 'unrelated'],
];
for (const [text, tag] of inNeg) {
  check('input-raw', text, !!I.detectInputNeeded(text), false, tag);
}
check('input-echo', '> do you want to proceed  [user typing, echoed]',
  !!I.detectInputNeededInLines('> do you want to proceed'), false, 'isEchoedInput filter');
check('input-echo', 'boxed prompt with selected choice still detected',
  !!I.detectInputNeededInLines('│ Do you want to proceed? │\n│ > 1. Yes │'), true, 'box strip');

console.log('\n=== inputParser: turn-end entry shapes ===');
check('input-turn', 'assistant end_turn -> turn end',
  I.isTurnEndEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } }), true);
check('input-turn', 'assistant tool_use -> still working',
  I.isTurnEndEntry({ type: 'assistant', message: { stop_reason: 'tool_use' } }), false);
check('input-turn', 'sidechain (sub-agent) end_turn -> must stay silent',
  I.isTurnEndEntry({ type: 'assistant', isSidechain: true, message: { stop_reason: 'end_turn' } }), false);
check('input-turn', 'user entry -> not a turn end',
  I.isTurnEndEntry({ type: 'user', message: { stop_reason: 'end_turn' } }), false);

// ---------------------------------------------------------------- SUMMARY
console.log('\n' + '='.repeat(72));
console.log(`TOTAL: ${pass} passed, ${fail} failed, ${pass + fail} cases`);
if (failures.length) {
  console.log('\nFAILURES:');
  const byGroup = {};
  for (const f of failures) (byGroup[f.group] ??= []).push(f);
  for (const [g, list] of Object.entries(byGroup)) {
    console.log(`\n  ${g}  (${list.length})`);
    for (const f of list) console.log(`    - ${f.detail}\n      ${f.label.slice(0, 100)}`);
  }
}
