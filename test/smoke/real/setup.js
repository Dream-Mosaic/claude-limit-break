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

/** Stop with a readable line instead of a stack trace, followed by whatever the failing command printed. */
function fail(message, output = '') {
  console.error(`setup.js: ${message}`);
  const text = String(output).trim();
  if (text) {
    console.error(text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length - 4000} more characters)` : text);
  }
  process.exit(1);
}

// A failure the checks below don't anticipate is a bug in this script: say so, and keep the stack.
process.on('uncaughtException', (e) => {
  console.error(`setup.js: unexpected error: ${e?.message ?? e}`);
  console.error(e?.stack ?? '');
  process.exit(1);
});

/** `claude -p`'s JSON result, from its stdout whether or not it exited 0; undefined if there is none. */
function parseResult(text) {
  try {
    return JSON.parse(String(text ?? '').trim().split('\n').pop());
  } catch {
    return undefined;
  }
}

/** Make one session with `claude -p` and return its result, or stop with why it couldn't. */
function makeSession(name, cwd) {
  let out;
  try {
    out = execFileSync('claude', ['-p', arg(`Smoke test session ${name.toUpperCase()}. Reply with just: ready`), '--output-format', 'json'],
      // stderr is captured, not echoed, so a failure prints it once, under the summary line.
      { cwd, env, encoding: 'utf8', shell, timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const who = `claude -p for session ${name.toUpperCase()}`;
    const printed = [e.stderr, e.stdout].map((s) => String(s ?? '').trim()).filter(Boolean).join('\n');
    const result = parseResult(e.stdout);
    if (result?.api_error === 'usage_limit_reached') {
      fail(`Claude is at a usage limit: "${result.result}". Part 1 needs live Claude usage; run it again after the reset. Part 2 (test/smoke/fake) needs none.`);
    }
    if (result?.is_error) {
      fail(`${who} returned an error${result.api_error_status ? ` (HTTP ${result.api_error_status})` : ''}: ${result.result ?? result.api_error ?? 'no detail'}`, printed);
    }
    // Without a shell a missing program is ENOENT; through cmd.exe it is exit 1 and "is not recognized".
    if (e.code === 'ENOENT' || /'claude' is not recognized/.test(String(e.stderr ?? ''))) {
      fail('`claude` is not on the PATH.');
    }
    if (e.code === 'ETIMEDOUT') {
      fail(`${who} did not finish within 3 minutes and was stopped.`, printed);
    }
    fail(`${who} failed (${e.status != null ? `exit ${e.status}` : `signal ${e.signal ?? '?'}`}).`, printed || e.message);
  }
  const result = parseResult(out);
  if (!result) fail(`claude -p for session ${name.toUpperCase()} printed no JSON result.`, out);
  if (result.is_error) fail(`claude -p for session ${name.toUpperCase()} returned an error: ${result.result ?? result.api_error ?? 'no detail'}`, out);
  return result;
}

fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(KIT, { recursive: true });
const state = { ws: WS, sessions: {} };
for (const name of ['a', 'b']) {
  const cwd = path.join(WS, name);
  fs.mkdirSync(cwd, { recursive: true });
  const id = makeSession(name, cwd).session_id;
  if (!/^[0-9a-f-]{36}$/.test(id ?? '')) fail(`no session id from claude for session ${name.toUpperCase()}`);
  const file = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  if (!fs.existsSync(file)) fail(`transcript not found: ${file}`);
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
