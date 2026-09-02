const OUT = process.env.UPSTREAM_OUT || './upstream/extension/out/';
const L = require(OUT + 'limitParser.js');
const O = require(OUT + 'overloadParser.js');
const NOW = new Date('2026-08-03T12:00:00Z');

console.log('--- WHY does "Your limit will reset at 14:00 (UTC)" miss? ---');
const s1 = 'Your limit will reset at 14:00 (UTC)';
console.log('  passes LIMIT_HINTS gate? ', L.looksLikeLimitMessage(s1));
console.log('  with "usage" added:      ', L.looksLikeLimitMessage('Your usage limit will reset at 14:00 (UTC)'),
  '->', !!L.detectLimit('Your usage limit will reset at 14:00 (UTC)', NOW, 24));
console.log('  => gate rejects it: "your limit" is not in the hint list, so the time rule never runs.');

console.log('\n--- WHY does "socket hang up" miss? ---');
const s2 = 'socket hang up';
console.log('  passes ERROR_MARKERS gate?', O.looksLikeOverloadMessage(s2));
console.log('  with "Error:" prefix:     ', O.looksLikeOverloadMessage('Error: socket hang up'),
  '->', !!O.detectOverload('Error: socket hang up'));
console.log('  => same shape: the marker gate rejects the bare string the rule would match.');

console.log('\n--- HOW BIG is the user-question false-positive class? ---');
const watcher = (t) => (t.length <= L.MAX_NOTICE_LENGTH && !L.looksLikeCode(t)) ? L.detectLimit(t, NOW, 24) : undefined;
const questions = [
  'why does my session limit reset at 1:40am instead of midnight?',
  'my usage limit resets at 3pm right?',
  'what happens when I hit the session limit - does it reset at 14:00?',
  'can you explain why the weekly limit resets at 9pm on Sundays',
  'the daily limit reset at 6am and I still cannot use it',
  'is the rate limit reset at midnight UTC or local?',
  'I hit my usage limit. Try again in 5 hours it said.',
  'summarise the docs on usage limits please',
  'what is a session limit',
  'explain rate limiting to me',
];
let trip = 0;
for (const q of questions) {
  const d = watcher(q);
  if (d) trip++;
  console.log(`  ${d ? 'ARMS TIMER' : 'ignored   '}  ${d ? '(' + d.rule + ' -> ' + d.resumeAt.toISOString() + ')' : ''}\n              "${q}"`);
}
console.log(`\n  ${trip}/${questions.length} ordinary user questions arm a resume timer.`);

console.log('\n--- Does looksLikeCode catch ordinary prose? (it is the only guard) ---');
for (const q of questions.slice(0, 5)) {
  console.log(`  looksLikeCode=${String(L.looksLikeCode(q)).padEnd(5)}  "${q.slice(0, 60)}"`);
}
