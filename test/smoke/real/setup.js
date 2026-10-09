// Smoke kit, part 1: two throwaway Claude sessions in <tmp>/lb-smoke/{a,b}, made with your real
// login, and the smoke window's profile in <tmp>/lb-smoke-kit/real.
// Run: node setup.js   (re-running deletes and recreates both folders and sessions)
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const WS = path.join(os.tmpdir(), 'lb-smoke');
const KIT = path.join(os.tmpdir(), 'lb-smoke-kit', 'real');
const PROFILE = path.join(KIT, 'profile');

// A nested launch from inside Claude Code would otherwise be refused or tagged as a child session.
const env = { ...process.env };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CONFIG_DIR']) delete env[k];
// On Windows `claude` is a .cmd shim, so it needs a shell, which splits unquoted arguments.
const shell = process.platform === 'win32';
const arg = (s) => (shell ? `"${s}"` : s);

fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(KIT, { recursive: true });
const state = { ws: WS, sessions: {} };
for (const name of ['a', 'b']) {
  const cwd = path.join(WS, name);
  fs.mkdirSync(cwd, { recursive: true });
  const out = execFileSync('claude', ['-p', arg(`Smoke test session ${name.toUpperCase()}. Reply with just: ready`), '--output-format', 'json'],
    { cwd, env, encoding: 'utf8', shell, timeout: 180_000 });
  const id = JSON.parse(out).session_id;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`no session id from claude: ${out.slice(0, 300)}`);
  const file = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`transcript not found: ${file}`);
  state.sessions[name] = { id, cwd, file };
}
fs.writeFileSync(path.join(KIT, 'state.json'), JSON.stringify(state, null, 2));

// The smoke window's own profile: fast timings, and only this workspace is watched.
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(path.join(PROFILE, 'User'), { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'User', 'settings.json'), JSON.stringify({
  'claudeLimitBreak.watchScope': 'workspace',
  'claudeLimitBreak.randomDelayMinMinutes': 0,
  'claudeLimitBreak.randomDelayMaxMinutes': 1,
  'claudeLimitBreak.transcriptPollSeconds': 2,
  'claudeLimitBreak.statusBar': 'always',
  'security.workspace.trust.enabled': false,
}, null, 2));
console.log(JSON.stringify(state, null, 2));
