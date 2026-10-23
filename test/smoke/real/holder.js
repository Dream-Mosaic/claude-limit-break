// Smoke kit, part 1: which live Claude processes hold a smoke session, and (for L5) breaking and restoring its inbox.
//   node holder.js [a|b|w]            -> each process holding the session: pid, panel or terminal, status
//   node holder.js a --break-inbox    -> point A's holder record at a pipe nothing listens on, so a send fails at once
//   node holder.js a --restore-inbox  -> put the real inbox back
// Reads ~/.claude/sessions/<pid>.json. Never reads or prints a key file or token.
const fs = require('fs'), os = require('os'), path = require('path');

function fail(message) {
  console.error(`holder.js: ${message}`);
  process.exit(1);
}
process.on('uncaughtException', (e) => {
  console.error(`holder.js: unexpected error: ${e?.message ?? e}`);
  console.error(e?.stack ?? '');
  process.exit(1);
});

const letter = (process.argv[2] ?? 'a').toLowerCase();
const action = process.argv[3];
if (!['a', 'b', 'w'].includes(letter) || (action && !['--break-inbox', '--restore-inbox'].includes(action))) {
  fail('usage: node holder.js [a|b|w] [--break-inbox | --restore-inbox]');
}
const KIT = path.join(os.tmpdir(), 'lb-smoke-kit', 'real');
let state;
try {
  state = JSON.parse(fs.readFileSync(path.join(KIT, 'state.json'), 'utf8'));
} catch {
  fail('no smoke sessions yet; run `node setup.js` first.');
}
const s = state?.sessions?.[letter];
if (!s?.id) fail(`no session ${letter.toUpperCase()} in state.json; run \`node setup.js\` again.`);

const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
const holders = [];
for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  if (!/^\d+\.json$/.test(name)) continue;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (record.sessionId === s.id) holders.push({ file: path.join(dir, name), record });
  } catch {
    // a record mid-write; skip it
  }
}
const kind = (r) => (r.entrypoint === 'claude-vscode' ? 'panel' : r.entrypoint === 'cli' ? 'terminal' : r.entrypoint ?? '?');

if (!action) {
  if (holders.length === 0) console.log(`session ${letter.toUpperCase()} (${s.id}): no live process holds it`);
  for (const { record: r } of holders) {
    console.log(`session ${letter.toUpperCase()} (${s.id}): pid ${r.pid}, ${kind(r)}, status ${r.status ?? '(not reported)'}, started ${new Date(r.startedAt).toLocaleTimeString()}`);
  }
  // The mod writes ~/.limit-break/sessions/<id>.json when it loads into the process holding the session.
  try {
    const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.limit-break', 'sessions', `${s.id}.json`), 'utf8'));
    const newest = Math.max(0, ...holders.map((h) => h.record.startedAt ?? 0));
    const current = m.movedTo === undefined && typeof m.loadedAtMs === 'number' && m.loadedAtMs >= newest;
    console.log(`mod: ${current ? 'loaded' : 'status file is stale (an earlier process, or moved on)'} (version ${m.modVersion}, loaded ${new Date(m.loadedAtMs).toLocaleTimeString()})`);
  } catch {
    console.log('mod: not loaded in this session (no status file)');
  }
  process.exit(0);
}

if (action === '--break-inbox') {
  if (holders.length !== 1) fail(`session ${letter.toUpperCase()} needs exactly one live holder for this; it has ${holders.length}. Run \`node holder.js ${letter}\`.`);
  const { file, record } = holders[0];
  const saved = path.join(KIT, `inbox-${record.pid}.json`);
  if (!fs.existsSync(saved)) fs.writeFileSync(saved, JSON.stringify({ messagingSocketPath: record.messagingSocketPath ?? null }));
  record.messagingSocketPath = process.platform === 'win32' ? '\\\\.\\pipe\\LOCAL\\lb-smoke-nothing-listens' : path.join(os.tmpdir(), 'lb-smoke-nothing-listens.sock');
  fs.writeFileSync(file, JSON.stringify(record));
  console.log(`pid ${record.pid}'s inbox now points at nothing. Claude Code may rewrite this record when the session changes state; run this again right before the fire if so. Undo: node holder.js ${letter} --restore-inbox`);
} else {
  // Every holder this script broke, even with a fallback terminal now holding the session too.
  let restored = 0;
  for (const { file, record } of holders) {
    const saved = path.join(KIT, `inbox-${record.pid}.json`);
    if (!fs.existsSync(saved)) continue;
    const { messagingSocketPath } = JSON.parse(fs.readFileSync(saved, 'utf8'));
    if (messagingSocketPath) record.messagingSocketPath = messagingSocketPath;
    else delete record.messagingSocketPath;
    fs.writeFileSync(file, JSON.stringify(record));
    fs.rmSync(saved);
    console.log(`pid ${record.pid}'s inbox is restored.`);
    restored += 1;
  }
  if (restored === 0) fail(`no holder of session ${letter.toUpperCase()} has an inbox broken by this script.`);
}
