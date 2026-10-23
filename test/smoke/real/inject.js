// Smoke kit, part 1: appends the stop Claude Code would write, to a throwaway session made by setup.js.
//   node inject.js limit [seconds] [a|w]  -> session A (or W): a five-hour usage limit resetting in [seconds] (default 120)
//   node inject.js overload               -> session B: a server-overload error, now
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
/** Stop with a readable line instead of a stack trace. */
function fail(message) {
  console.error(`inject.js: ${message}`);
  process.exit(1);
}
// A failure the checks below don't anticipate is a bug in this script: say so, and keep the stack.
process.on('uncaughtException', (e) => {
  console.error(`inject.js: unexpected error: ${e?.message ?? e}`);
  console.error(e?.stack ?? '');
  process.exit(1);
});

const kind = process.argv[2];
if (kind !== 'limit' && kind !== 'overload') fail('usage: node inject.js limit [seconds] [a|w] | overload');
const seconds = Number(process.argv[3] ?? 120);
if (kind === 'limit' && !(Number.isFinite(seconds) && seconds > 0)) fail(`[seconds] must be a positive number, not "${process.argv[3]}"`);
const letter = kind === 'overload' ? 'b' : (process.argv[4] ?? 'a').toLowerCase();
if (letter !== 'a' && letter !== 'b' && letter !== 'w') fail(`the session must be a or w, not "${process.argv[4]}"`);

const statePath = path.join(os.tmpdir(), 'lb-smoke-kit', 'real', 'state.json');
let state;
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
} catch (e) {
  fail(e.code === 'ENOENT' ? 'no smoke sessions yet; run `node setup.js` first.' : `can't read ${statePath} (${e.message}); run \`node setup.js\` again.`);
}
const s = state?.sessions?.[letter];
if (!s?.file) fail(`${statePath} has no session ${letter.toUpperCase()}; run \`node setup.js\` again.`);

let text;
try {
  text = fs.readFileSync(s.file, 'utf8');
} catch (e) {
  fail(`can't read session ${s.id}'s transcript ${s.file} (${e.code ?? e.message}); run \`node setup.js\` again.`);
}
const lines = text.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const last = [...lines].reverse().find((e) => e.uuid && (e.type === 'assistant' || e.type === 'user'));
if (!last) fail(`session ${s.id}'s transcript has no message to attach the stop to: ${s.file}`);
const now = new Date();
const base = {
  parentUuid: last.uuid, isSidechain: false, type: 'assistant', uuid: crypto.randomUUID(), timestamp: now.toISOString(),
  sessionId: s.id, cwd: s.cwd, version: last.version, userType: 'external', entrypoint: last.entrypoint, isApiErrorMessage: true,
};
const msg = (text) => ({ id: crypto.randomUUID(), type: 'message', role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
  stop_sequence: '', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text }] });

let entry;
if (kind === 'limit') {
  const resetsAt = Math.floor(now.getTime() / 1000) + seconds;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Date(resetsAt * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone }).replace(' ', '').toLowerCase();
  entry = { ...base, error: 'rate_limit', apiErrorStatus: 429, quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt },
    message: msg(`You've hit your session limit · resets ${local} (${zone})`) };
} else {
  entry = { ...base, error: 'server_error', apiErrorStatus: 529,
    message: msg('API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.') };
}
fs.appendFileSync(s.file, JSON.stringify(entry) + '\n');
console.log(`appended ${kind} to session ${s.id} (${s.cwd})`);
