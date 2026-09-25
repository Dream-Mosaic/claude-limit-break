import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResumeArgs,
  buildHeadlessArgs,
  buildTerminalOptions,
  buildTrustTerminalOptions,
  resolveClaudeLauncher,
  cwdExists,
  PARENT_SESSION_VARIABLES,
} from '../src/resumer';
import type { ResolvedSession } from '../src/sessionResolver';

const ID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const session: ResolvedSession = {
  sessionId: ID,
  transcript: `/h/.claude/projects/p/${ID}.jsonl`,
  cwd: '/projects/example',
  bytes: 1000,
};

test('the prompt is a single argv element, never concatenated', () => {
  const args = buildResumeArgs(ID, 'continue where you left off');
  assert.deepEqual(args, ['--resume', ID, 'continue where you left off']);
});

test('shell metacharacters stay inert because nothing quotes them', () => {
  const hostile = '$(1+41) `whoami` && rm -rf / ; "quoted"';
  const args = buildResumeArgs(ID, hostile);
  assert.equal(args.length, 3);
  assert.equal(args[2], hostile, 'prompt is passed through verbatim as one argument');
  assert.ok(!args.some((a) => a.includes('""')), 'no hand-quoting anywhere');
});

test('interactive resume never sets a permission mode', () => {
  const args = buildResumeArgs(ID, 'go');
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('interactive resume never uses --continue', () => {
  assert.ok(!buildResumeArgs(ID, 'go').includes('--continue'));
});

test('headless mode asks for json and carries an explicit permission mode', () => {
  const args = buildHeadlessArgs(ID, 'go', 'acceptEdits');
  assert.deepEqual(args, [
    '-p', '--resume', ID, 'go', '--output-format', 'json', '--permission-mode', 'acceptEdits',
  ]);
});

test('headless mode omits the flag when no mode is configured', () => {
  const args = buildHeadlessArgs(ID, 'go', '');
  assert.deepEqual(args, ['-p', '--resume', ID, 'go', '--output-format', 'json']);
});

test('terminal options launch claude directly, with no shell', () => {
  const opts = buildTerminalOptions(session, 'go', { file: '/usr/bin/claude', args: [] });
  assert.equal(opts.shellPath, '/usr/bin/claude');
  assert.deepEqual(opts.shellArgs, ['--resume', ID, 'go']);
  assert.equal(opts.cwd, '/projects/example');
  assert.match(opts.name, /Limit Break/);
  assert.ok(opts.name.includes(ID.slice(0, 8)));
});

test('the trust terminal runs plain claude: no --resume, no prompt argument', () => {
  const opts = buildTrustTerminalOptions('/projects/example', { file: '/usr/bin/claude', args: [] });
  assert.equal(opts.shellPath, '/usr/bin/claude');
  assert.deepEqual(opts.shellArgs, [], 'no resume args and no prompt - just plain claude');
  assert.equal(opts.cwd, '/projects/example');
});

test('the trust terminal name uses the existing "Limit Break: " prefix', () => {
  const opts = buildTrustTerminalOptions('/projects/example', { file: '/usr/bin/claude', args: [] });
  assert.match(opts.name, /^Limit Break: /);
});

test('the trust terminal strips every parent-session variable, same as a resume terminal', () => {
  const opts = buildTrustTerminalOptions('/projects/example', { file: '/usr/bin/claude', args: [] });
  for (const name of PARENT_SESSION_VARIABLES) {
    assert.equal(opts.env[name], null, `${name} must be nulled out`);
  }
  assert.equal(Object.keys(opts.env).length, PARENT_SESSION_VARIABLES.length, 'no extra env entries');
});

test('a node-shim launcher is still prefixed in the trust terminal', () => {
  const opts = buildTrustTerminalOptions('/projects/example', {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
  });
  assert.deepEqual(opts.shellArgs, ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js']);
});

test('a node-shim launcher prepends its own args before the resume args', () => {
  const opts = buildTerminalOptions(session, 'go', {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
  });
  assert.deepEqual(opts.shellArgs, [
    'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    '--resume',
    ID,
    'go',
  ]);
});

test('an explicitly configured binary is used as-is', () => {
  const l = resolveClaudeLauncher('/opt/claude/bin/claude', 'linux', () => undefined, () => undefined);
  assert.deepEqual(l, { file: '/opt/claude/bin/claude', args: [] });
});

test('a configured bare name is resolved on PATH, so a windows shim is still unwrapped', () => {
  // claudeCommand: "claude" is the obvious thing to type, and before this it
  // produced shellPath: "claude" - a .cmd shim name that cannot be spawned.
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const l = resolveClaudeLauncher(
    'claude',
    'win32',
    (c) => (c === 'claude' ? 'C:\\npm\\claude.cmd' : c === 'node' ? 'C:\\nodejs\\node.exe' : undefined),
    () => shim,
  );
  assert.deepEqual(l, {
    file: 'C:\\nodejs\\node.exe',
    args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
  });
});

test('a configured name PATH does not know fails closed instead of falling back to claude', () => {
  const l = resolveClaudeLauncher(
    'mycc',
    'linux',
    (c) => (c === 'claude' ? '/usr/local/bin/claude' : undefined),
    () => undefined,
  );
  assert.equal(l, undefined, 'a named binary that cannot be found must not silently become claude');
});

test('on posix the binary is found on PATH', () => {
  const l = resolveClaudeLauncher('', 'linux', (c) => (c === 'claude' ? '/usr/local/bin/claude' : undefined), () => undefined);
  assert.deepEqual(l, { file: '/usr/local/bin/claude', args: [] });
});

test('on windows a .cmd shim resolves to node plus the cli entry point', () => {
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const l = resolveClaudeLauncher(
    '',
    'win32',
    (c) => (c === 'claude' ? 'C:\\npm\\claude.cmd' : c === 'node' ? 'C:\\nodejs\\node.exe' : undefined),
    () => shim,
  );
  assert.deepEqual(l, {
    file: 'C:\\nodejs\\node.exe',
    args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
  });
});

test('resolution fails cleanly when claude is not on PATH', () => {
  assert.equal(resolveClaudeLauncher('', 'linux', () => undefined, () => undefined), undefined);
});

test('a shim that cannot be read fails closed rather than falling back to a shell', () => {
  const l = resolveClaudeLauncher(
    '',
    'win32',
    (c) => (c === 'claude' ? 'C:\\npm\\claude.cmd' : c === 'node' ? 'C:\\nodejs\\node.exe' : undefined),
    () => undefined,
  );
  assert.equal(l, undefined);
});

test('a shim with no cli.js entry point fails closed rather than falling back to a shell', () => {
  const shim = '@ECHO off\r\n"%_prog%" "%dp0%\\bin\\claude" %*\r\n';
  const l = resolveClaudeLauncher(
    '',
    'win32',
    (c) => (c === 'claude' ? 'C:\\npm\\claude.cmd' : c === 'node' ? 'C:\\nodejs\\node.exe' : undefined),
    () => shim,
  );
  assert.equal(l, undefined);
});

test('a shim that cannot be resolved fails closed rather than falling back to a shell', () => {
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const l = resolveClaudeLauncher(
    '',
    'win32',
    (c) => (c === 'claude' ? 'C:\\npm\\claude.cmd' : undefined),
    () => shim,
  );
  assert.equal(l, undefined);
});

test('an existing cwd is reported fine', () => {
  assert.equal(cwdExists('/projects/example', (p) => p === '/projects/example'), true);
});

test('a cwd that is gone is reported, not thrown - resume() decides what to do about it', () => {
  assert.equal(cwdExists('/projects/renamed-away', () => false), false);
});

test('no cwd at all is fine: VS Code applies its own default, same as always', () => {
  assert.equal(cwdExists(undefined, () => false), true);
});

// --- Environment (#9) ------------------------------------------------------
//
// VS Code starts the resume terminal from the window's environment. When that
// window was itself opened from inside a Claude session - `code .` typed into
// one - it carries the variables that session sets for its own children, and
// the resumed `claude` would start out believing it is that other session's
// child. These names were read off a shell spawned by a live session.

test('the resume terminal clears the identity of any Claude session it was launched from', () => {
  const opts = buildTerminalOptions(session, 'go', { file: '/usr/bin/claude', args: [] });
  for (const name of [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_PID',
  ]) {
    assert.ok(name in opts.env, `${name} must be named in the terminal env`);
    assert.equal(opts.env[name], null, `${name} must be removed (null), not set to a value`);
  }
});

test("a user's own Claude configuration is left alone", () => {
  // Settings a person exports on purpose, and the port the Claude Code
  // extension deliberately injects into integrated terminals for IDE
  // integration. Clearing any of these would change what the resume does.
  const opts = buildTerminalOptions(session, 'go', { file: '/usr/bin/claude', args: [] });
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_SSE_PORT',
  ]) {
    assert.ok(!(name in opts.env), `${name} must not be touched`);
  }
});

test('the resume terminal is transient, so a window reload does not launch the resume again', () => {
  // The API documents isTransient as opting a terminal out of the default
  // persistence on restart and reload (when enablePersistentSessions is on).
  // A resume is a one-off launch, not a terminal the window should keep.
  const opts = buildTerminalOptions(session, 'go', { file: '/usr/bin/claude', args: [] });
  assert.equal(opts.isTransient, true);
});
