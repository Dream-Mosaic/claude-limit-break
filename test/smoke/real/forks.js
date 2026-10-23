// Smoke kit, part 1: did a smoke session fork after its last injected stop?
//   node forks.js [a|b|w]
// Lists every turn that started after the stop (a prompt, a continue, a message from Limit Break) and what it follows.
// A fork is two turns that both follow the same point. A resume may attach to the turn before the stop rather than to
// the stop entry itself (the CLI does that with an injected stop), so that alone is not a fork.
const fs = require('fs'), os = require('os'), path = require('path');

function fail(message) {
  console.error(`forks.js: ${message}`);
  process.exit(1);
}
process.on('uncaughtException', (e) => {
  console.error(`forks.js: unexpected error: ${e?.message ?? e}`);
  console.error(e?.stack ?? '');
  process.exit(1);
});

const letter = (process.argv[2] ?? 'a').toLowerCase();
if (!['a', 'b', 'w'].includes(letter)) fail('usage: node forks.js [a|b|w]');
let state;
try {
  state = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'lb-smoke-kit', 'real', 'state.json'), 'utf8'));
} catch {
  fail('no smoke sessions yet; run `node setup.js` first.');
}
const s = state?.sessions?.[letter];
if (!s?.file) fail(`no session ${letter.toUpperCase()} in state.json; run \`node setup.js\` again.`);
let text;
try {
  text = fs.readFileSync(s.file, 'utf8');
} catch (e) {
  fail(`can't read ${s.file} (${e.code ?? e.message})`);
}

const entries = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
const byUuid = new Map(entries.filter((e) => e.uuid).map((e) => [e.uuid, e]));
const stopIndex = entries.findLastIndex((e) => e.isApiErrorMessage === true);
if (stopIndex < 0) fail(`session ${letter.toUpperCase()} has no stop yet; run \`node inject.js\` first.`);
const stop = entries[stopIndex];

const words = (e) => {
  const c = e.message?.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
  return t.replace(/\s+/g, ' ').trim();
};
// A turn starts at a user entry that isn't a tool result: a prompt, a continue, or an inbound message.
const startsTurn = (e) => e.type === 'user' && !e.isSidechain && words(e) !== '' &&
  !(Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_result'));
// What a turn follows: the stop entry, or the nearest earlier turn start (the turn before the stop counts as the stop).
const beforeStop = new Set(entries.slice(0, stopIndex).filter((e) => e.uuid && startsTurn(e)).map((e) => e.uuid));
const follows = (e) => {
  for (let p = byUuid.get(e.parentUuid); p; p = byUuid.get(p.parentUuid)) {
    if (p.uuid === stop.uuid) return 'the stop';
    if (startsTurn(p)) return beforeStop.has(p.uuid) ? 'the stop' : p.uuid;
  }
  return 'the stop';
};

const turns = entries.slice(stopIndex + 1).filter(startsTurn);
console.log(`session ${letter.toUpperCase()} (${s.id}): stop at ${stop.timestamp}; ${turns.length} turn(s) since`);
const seen = new Map();
let fork = false;
for (const t of turns) {
  const f = follows(t);
  const label = f === 'the stop' ? f : `turn ${[...seen.keys()].indexOf(f) + 1}`;
  if ([...seen.values()].includes(f)) fork = true;
  seen.set(t.uuid, f);
  console.log(`  turn ${seen.size}: ${t.timestamp} ${t.entrypoint ?? ''} follows ${label}: "${words(t).slice(0, 80)}"`);
}
console.log(fork ? 'FORK: two turns follow the same point.' : 'No fork.');
process.exit(fork ? 2 : 0);
