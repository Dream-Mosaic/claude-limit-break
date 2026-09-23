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
 * Variables a running Claude Code session sets for the processes it starts,
 * read off a shell spawned by one. They describe that session - its id, its
 * messaging socket and token, that it is the parent of whatever runs next.
 *
 * VS Code starts the resume terminal from the window's environment, and a
 * window opened from inside a Claude session (`code .` typed into one) carries
 * all of them. The resumed `claude` is a different process resuming a
 * different session, so it must not start out as that session's child (#9).
 *
 * Deliberately a named list rather than a prefix. People export CLAUDE_CODE_*
 * settings on purpose - CLAUDE_CODE_USE_BEDROCK, for one - and the Claude Code
 * extension injects CLAUDE_CODE_SSE_PORT into integrated terminals so the CLI
 * can find the editor. Clearing those would change what the resume does.
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
 * The prompt is one array element. Nothing quotes it, because nothing parses
 * it: VS Code hands shellArgs to the child process as argv. Upstream built a
 * command string instead and double-quoted it on Windows, where PowerShell
 * expands $(...) inside double quotes - $(1+41) reached Claude as 42.
 *
 * No --permission-mode: an interactive resume already runs at the user's own
 * autonomy level, so the flag could only ever escalate it.
 *
 * No --continue: it resumes "the most recent interactive session", skipping -p,
 * SDK, background and /loop sessions. We know the id, so we name it.
 */
export function buildResumeArgs(sessionId: string, prompt: string): string[] {
  return ['--resume', sessionId, prompt];
}

/**
 * Arguments for opt-in headless mode. `--output-format json` returns a `usage`
 * block for post-flight accounting and structured `permission_denials`.
 *
 * Headless does NOT inherit the session's permission mode (verified: an
 * acceptEdits session resumed with -p was denied a Write), so an explicit mode
 * is required for it to do tool work. That is exactly why the setting is
 * machine-scoped and off by default.
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
 * createTerminal does not throw on a missing directory - VS Code reports
 * "Starting directory (cwd) ... does not exist" asynchronously, inside the
 * terminal process, well after a caller that logs success right after calling
 * it would already have done so. Checking first turns that into a result the
 * caller can act on - keep the job, tell the user, name the transcript -
 * before anything is launched.
 *
 * No cwd at all is fine: VS Code falls back to its own default, same as
 * always. `exists` is injected rather than importing node:fs directly so this
 * stays a pure function callable without a filesystem, matching
 * buildTerminalOptions below.
 */
export function cwdExists(cwd: string | undefined, exists: (p: string) => boolean): boolean {
  return cwd === undefined || exists(cwd);
}

export function buildTerminalOptions(
  session: ResolvedSession,
  prompt: string,
  launcher: Launcher,
  /**
   * The claude arguments to run. Defaults to an interactive resume; the caller
   * passes buildHeadlessArgs instead when resumeMode is headless. Injected
   * rather than branched on a mode flag here so this stays one shape with one
   * reason to change, and so the argument builders keep their own tests.
   */
  claudeArgs: string[] = buildResumeArgs(session.sessionId, prompt),
): TerminalOptionsLike {
  return {
    name: `Limit Buster: ${session.sessionId.slice(0, 8)}`,
    cwd: session.cwd,
    shellPath: launcher.file,
    shellArgs: [...launcher.args, ...claudeArgs],
    isTransient: true,
    env: Object.fromEntries(PARENT_SESSION_VARIABLES.map((name) => [name, null])),
  };
}

/**
 * Matches the shim-directory variables npm's generated launchers set to their
 * own directory: %dp0% / %~dp0% in a .cmd shim (computed by its :find_dp0
 * routine), $basedir in a .ps1 shim (computed from $PSScriptRoot). All three
 * are expanded to path.dirname(found) before the entry point is resolved.
 */
const SHIM_DIR_VAR = /%~?dp0%?|\$basedir/gi;

/**
 * Find something spawnable for `claude`.
 *
 * On Windows the PATH entry is usually `claude.cmd`, an npm shim. A .cmd is not
 * a PE image, so it cannot be spawned directly - and running it through cmd.exe
 * would reintroduce a command-line parser, which is the thing this module
 * exists to avoid. So the shim is read and its cli.js extracted, and node runs
 * that directly.
 */
export function resolveClaudeLauncher(
  configured: string,
  platform: NodeJS.Platform,
  which: (cmd: string) => string | undefined,
  readShim: (p: string) => string | undefined,
): Launcher | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const trimmed = configured.trim();
  // A configured bare name has to go through PATH like an unset one does.
  // "claude" on Windows is claude.cmd, an npm shim - the exact case this
  // module exists to unwrap - and handing VS Code shellPath: "claude" spawns
  // nothing. A value with a separator in it is already a path; use it as
  // given. A name that PATH does not know fails closed rather than quietly
  // becoming "claude", which is not the program that was asked for.
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
