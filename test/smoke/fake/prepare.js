// Smoke kit, part 2: fake sessions in an isolated Claude config dir, for the dev build.
// Nothing here touches the real ~/.claude or ~/.claude.json. Everything lives in
// <tmp>/lb-smoke-kit/fake.
//   node prepare.js                                   sessions A-D, no stops yet
//   node prepare.js stop [seconds] [weeklySeconds] [letters]
//                                                     with the window open: append the stops,
//                                                     to every session or only the letters given (e.g. A)
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(os.tmpdir(), 'lb-smoke-kit', 'fake');
const HOME = path.join(ROOT, 'home');         // CLAUDE_CONFIG_DIR for the dev host
const PROFILE = path.join(ROOT, 'profile');   // --user-data-dir for the dev host
const TRUSTED = path.join(ROOT, 'ws-trusted'), UNTRUSTED = path.join(ROOT, 'ws-untrusted');
const STATE = path.join(ROOT, 'state.json');
const jsonl = (ls) => ls.map((l) => JSON.stringify(l)).join('\n') + '\n';

// Limit Break skips whatever a transcript already held when it started, so the stops are
// appended by a second step, with the window open.
if (process.argv[2] === 'stop') {
  const secs = Number(process.argv[3] || 120);
  // maxWaitHours is 1 (its floor), so the weekly reset must be further out than an hour to be offered.
  const weeklySecs = Number(process.argv[4] || 65 * 60);
  const only = (process.argv[5] || 'ABCD').toUpperCase();
  const nowS = Math.floor(Date.now() / 1000);
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  for (const t of state.targets.filter((t) => only.includes(t.label[0]))) {
    const at = nowS + (t.type === 'seven_day' ? weeklySecs : secs);
    const stop = { ...t.base, type: 'assistant', uuid: crypto.randomUUID(), parentUuid: t.parentUuid, timestamp: new Date().toISOString(),
      isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
      quotaLimits: { status: 'rejected', rateLimitType: t.type, resetsAt: at },
      message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: t.text }] } };
    const lines = [stop];
    if (t.file.includes(`${path.sep}subagents${path.sep}`)) {
      // A read receipt for X3: a finished-turn entry, written in the same append as the stop, that
      // the log reports as "Turn ended in transcript agent-smoke.jsonl". It shows the file was read
      // and the stop beside it skipped; a stop that armed would be logged instead. Marked as not a
      // sidechain only so that the turn-end rule, which ignores subagent turns, reports it.
      lines.push({ ...t.base, isSidechain: false, type: 'assistant', uuid: crypto.randomUUID(), parentUuid: stop.uuid,
        timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Subagent done.' }] } });
    }
    fs.appendFileSync(t.file, jsonl(lines));
    console.log(`${t.label} = ${t.base.sessionId}: ${t.type} resets ${new Date(at * 1000).toLocaleTimeString()}`);
  }
  process.exit(0);
}

for (const d of [HOME, TRUSTED, UNTRUSTED]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [path.join(HOME, 'projects'), path.join(PROFILE, 'User'), TRUSTED, UNTRUSTED]) fs.mkdirSync(d, { recursive: true });

// Trust record (fake, inside the fake config dir): one folder trusted, one not.
fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({
  projects: { [TRUSTED.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true }, [UNTRUSTED.replace(/\\/g, '/')]: { hasTrustDialogAccepted: false } },
}, null, 2));

// Fast timings for the dev host only.
fs.writeFileSync(path.join(PROFILE, 'User', 'settings.json'), JSON.stringify({
  'claudeLimitBreak.randomDelayMinMinutes': 0,
  'claudeLimitBreak.randomDelayMaxMinutes': 1,
  'claudeLimitBreak.transcriptPollSeconds': 2,
  'claudeLimitBreak.statusBar': 'always',
  'claudeLimitBreak.maxWaitHours': 1,
}, null, 2));

const encode = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const targets = [];
function session(cwd, label, { type = 'five_hour', text = "You've hit your session limit · resets soon", subagent = false } = {}) {
  const id = crypto.randomUUID(), dir = path.join(HOME, 'projects', encode(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString(), u1 = crypto.randomUUID(), a1 = crypto.randomUUID();
  const base = { sessionId: id, cwd, version: '2.1.285', userType: 'external', entrypoint: 'cli', isSidechain: false };
  const lines = [
    { ...base, type: 'user', uuid: u1, parentUuid: null, timestamp: now, promptSource: 'typed', message: { role: 'user', content: `smoke test session ${label}` } },
    { ...base, type: 'assistant', uuid: a1, parentUuid: u1, timestamp: now, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Working on it.' }], stop_reason: 'tool_use' } },
  ];
  let file = path.join(dir, `${id}.jsonl`);
  if (subagent) {
    // The parent ends on an ordinary finished turn; only its subagent's transcript gets the limit.
    fs.writeFileSync(file, jsonl([lines[0], { ...lines[1], message: { ...lines[1].message, stop_reason: 'end_turn' } }]));
    fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
    file = path.join(dir, id, 'subagents', 'agent-smoke.jsonl');
    fs.writeFileSync(file, jsonl(lines.map((l) => ({ ...l, isSidechain: true }))));
    base.isSidechain = true;
  } else {
    fs.writeFileSync(file, jsonl(lines));
  }
  targets.push({ label, file, type, text, base, parentUuid: a1 });
}
session(TRUSTED, 'A (trusted folder)');
session(UNTRUSTED, 'B (untrusted folder)');
session(TRUSTED, 'C (weekly, beyond maxWaitHours)', { type: 'seven_day', text: "You've hit your weekly limit · resets soon" });
session(TRUSTED, 'D (limit only inside a subagent)', { subagent: true });
fs.writeFileSync(STATE, JSON.stringify({ targets }, null, 2));
for (const t of targets) console.log(`${t.label} = ${t.base.sessionId}`);
console.log('Sessions ready. Launch the window, then: node prepare.js stop');
