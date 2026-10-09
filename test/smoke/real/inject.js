// Smoke kit, part 1: appends the stop Claude Code would write, to a throwaway session made by setup.js.
//   node inject.js limit [seconds]   -> session A: a five-hour usage limit resetting in [seconds] (default 120)
//   node inject.js overload          -> session B: a server-overload error, now
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const state = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'lb-smoke-kit', 'real', 'state.json'), 'utf8'));
const kind = process.argv[2];
const s = state.sessions[kind === 'limit' ? 'a' : kind === 'overload' ? 'b' : ''];
if (!s) { console.error('usage: node inject.js limit [seconds] | overload'); process.exit(1); }

const lines = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const last = [...lines].reverse().find((e) => e.uuid && (e.type === 'assistant' || e.type === 'user'));
const now = new Date();
const base = {
  parentUuid: last.uuid, isSidechain: false, type: 'assistant', uuid: crypto.randomUUID(), timestamp: now.toISOString(),
  sessionId: s.id, cwd: s.cwd, version: last.version, userType: 'external', entrypoint: last.entrypoint, isApiErrorMessage: true,
};
const msg = (text) => ({ id: crypto.randomUUID(), type: 'message', role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
  stop_sequence: '', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text }] });

let entry;
if (kind === 'limit') {
  const resetsAt = Math.floor(now.getTime() / 1000) + Number(process.argv[3] || 120);
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
