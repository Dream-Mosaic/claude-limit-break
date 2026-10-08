import * as path from 'node:path';
import type { ResolvedSession } from './sessionResolver';

export interface Launcher {
  /** Executable to spawn. Never a shell. */
  file: string;
  /** Arguments that must precede the claude arguments (a script path, usually). */
  args: string[];
}

export interface TerminalOptionsLike {
  name: string;
  cwd?: string;
  shellPath: string;
  shellArgs: string[];
  isTransient: boolean;
  /** Merged over the window's environment by VS Code; null removes a variable. */
  env: Record<string, string | null>;
}

/**
 * Variables a running Claude Code session sets for the processes it starts (its id, messaging socket and token, parent marker).
 *
 * VS Code starts the resume terminal from the window's environment, and a window opened from inside a Claude session (`code .`) carries all of them. The resumed `claude` resumes a different session, so it must not start out as that session's child.
 *
 * A named list, not a prefix: people export CLAUDE_CODE_* settings on purpose (CLAUDE_CODE_USE_BEDROCK), and the Claude Code extension injects CLAUDE_CODE_SSE_PORT so the CLI can find the editor. Clearing those would change what the resume does.
 */
export const PARENT_SESSION_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
  'AI_AGENT',
] as const;

/**
 * Arguments for an interactive resume.
 *
 * The prompt is one array element and is never quoted: VS Code hands shellArgs to the child as argv. Building a command string and double-quoting it breaks on Windows, where PowerShell expands $(...) inside double quotes.
 *
 * No --permission-mode: an interactive resume already runs at the user's own autonomy level, so the flag could only escalate it.
 *
 * No --continue: it resumes "the most recent interactive session", skipping -p, SDK, background and /loop sessions. We know the id, so we name it.
 */
export function buildResumeArgs(sessionId: string, prompt: string): string[] {
  return ['--resume', sessionId, prompt];
}

/**
 * Arguments for opt-in headless mode. `--output-format json` returns a `usage` block for post-flight accounting and structured `permission_denials`.
 *
 * Headless does NOT inherit the session's permission mode, so an explicit mode is required for tool work. That is why the setting is machine-scoped and off by default.
 */
export function buildHeadlessArgs(sessionId: string, prompt: string, permissionMode: string): string[] {
  const args = ['-p', '--resume', sessionId, prompt, '--output-format', 'json'];
  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }
  return args;
}

/**
 * Whether `cwd` is safe to hand to vscode.window.createTerminal.
 *
 * createTerminal does not throw on a missing directory; VS Code reports it asynchronously, after a caller would already have logged success. Checking first gives the caller a result to act on before anything launches.
 *
 * No cwd is fine: VS Code uses its own default. `exists` is injected so this stays a pure function.
 */
export function cwdExists(cwd: string | undefined, exists: (p: string) => boolean): boolean {
  return cwd === undefined || exists(cwd);
}

export function buildTerminalOptions(
  session: ResolvedSession,
  prompt: string,
  launcher: Launcher,
  /** The claude arguments to run. Defaults to an interactive resume; the caller passes buildHeadlessArgs when resumeMode is headless. */
  claudeArgs: string[] = buildResumeArgs(session.sessionId, prompt),
): TerminalOptionsLike {
  return {
    name: `Limit Break: ${session.sessionId.slice(0, 8)}`,
    cwd: session.cwd,
    shellPath: launcher.file,
    shellArgs: [...launcher.args, ...claudeArgs],
    isTransient: true,
    env: Object.fromEntries(PARENT_SESSION_VARIABLES.map((name) => [name, null])),
  };
}

/**
 * Terminal options for a plain `claude` launch in `cwd`, with no `--resume` and no prompt (Trust hotlink).
 *
 * This terminal exists only so a human can answer Claude's own trust dialog: the extension must not answer it or write `~/.claude.json`, so nothing here sends any input into the terminal. The environment is stripped exactly as buildTerminalOptions strips it.
 *
 * Not built via buildTerminalOptions: its name embeds a session id this launch does not have.
 */
export function buildTrustTerminalOptions(cwd: string, launcher: Launcher): TerminalOptionsLike {
  return {
    name: `Limit Break: Trust ${path.basename(cwd)}`,
    cwd,
    shellPath: launcher.file,
    shellArgs: [...launcher.args],
    isTransient: true,
    env: Object.fromEntries(PARENT_SESSION_VARIABLES.map((name) => [name, null])),
  };
}

/**
 * Matches the shim-directory variables npm's generated launchers set to their own directory: %dp0% / %~dp0% in a .cmd shim, $basedir in a .ps1 shim. All three are expanded to path.dirname(found) before the entry point is resolved.
 */
const SHIM_DIR_VAR = /%~?dp0%?|\$basedir/gi;

/**
 * Find something spawnable for `claude`.
 *
 * On Windows the PATH entry is usually `claude.cmd`, an npm shim, which is not a PE image and cannot be spawned directly; running it through cmd.exe would reintroduce a command-line parser. So the shim is read, its cli.js extracted, and node runs that directly.
 */
export function resolveClaudeLauncher(
  configured: string,
  platform: NodeJS.Platform,
  which: (cmd: string) => string | undefined,
  readShim: (p: string) => string | undefined,
): Launcher | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const trimmed = configured.trim();
  // A configured bare name goes through PATH like an unset one: "claude" on Windows is claude.cmd, an npm shim, and shellPath: "claude" spawns nothing. A value with a separator is already a path. A name PATH does not know fails closed rather than becoming "claude".
  const found = trimmed ? (/[\\/]/.test(trimmed) ? trimmed : which(trimmed)) : which('claude');
  if (!found) {
    return undefined;
  }
  const ext = p.extname(found).toLowerCase();
  if (platform !== 'win32' || (ext !== '.cmd' && ext !== '.bat' && ext !== '.ps1')) {
    return { file: found, args: [] };
  }
  const node = which('node');
  const shim = readShim(found);
  const raw = shim ? /"?([^"\s]+cli\.js)"?/.exec(shim)?.[1] : undefined;
  if (!node || !raw) {
    // Better to fail visibly than to fall back to a shell.
    return undefined;
  }
  const dir = p.dirname(found);
  const entry = raw.replace(SHIM_DIR_VAR, dir);
  const resolved = p.isAbsolute(entry) ? entry : p.resolve(dir, entry);
  return { file: node, args: [resolved] };
}
