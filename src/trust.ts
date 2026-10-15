import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudeUserConfig {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>;
}

/**
 * Normalize a path for comparison against a `~/.claude.json` project key.
 *
 * Keys are recorded with forward slashes and inconsistent drive-letter casing (`c:/Users/...` and `C:/Users/...` both occur), while a Windows transcript's `cwd` arrives with backslashes. Folding to forward slashes with no trailing slash makes them comparable without touching the filesystem (path.resolve would resolve against *this* process's cwd).
 *
 * Case is folded only on win32 and darwin, whose default filesystems do not distinguish it; on Linux `/home/a/proj` and `/home/A/proj` are different directories that must not share a trust answer. `platform` is a parameter so both branches are testable.
 */
export function normalizeProjectPath(p: string, platform: NodeJS.Platform): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' || platform === 'darwin' ? slashed.toLowerCase() : slashed;
}

/**
 * Whether Claude Code has recorded `cwd` as trusted for CLI use.
 *
 * Read-only, and must stay so: writing `hasTrustDialogAccepted` back would answer the trust prompt on the user's behalf. "No config", "folder not tracked yet" and "tracked but declined" all return false and are treated identically: all three land a resume on the same stalled prompt.
 *
 * A folder is trusted when its own record says so (`trustedSpelling`), or when it is a git worktree whose main checkout is trusted (`worktreeTrusted`, which needs `readText`). Without `readText` only the first applies. An explicit `false` on the worktree's own key does not block the second: the CLI looks up the canonical root first.
 */
export function isFolderTrusted(
  cwd: string,
  config: ClaudeUserConfig | undefined,
  platform: NodeJS.Platform,
  readText?: (p: string) => string,
): boolean {
  return trustedSpelling(cwd, config, platform) !== undefined || (readText !== undefined && worktreeTrusted(cwd, config, platform, readText));
}

/**
 * Whether `cwd` is the root of a git worktree whose main checkout is recorded as trusted. This mirrors Claude Code 2.1.296, which looks up `projects[<canonical root>]` first, where a worktree's canonical root is its main checkout. The CLI's validation is copied so that a copied or moved worktree reads as "not trusted", the safe direction:
 *
 * 1. `<cwd>/.git` is a file whose content starts with `gitdir:`; call the folder it names gitdirDir.
 * 2. `<gitdirDir>/commondir` resolves, against gitdirDir, to u; `dirname(gitdirDir)` is `join(u, 'worktrees')`; `<gitdirDir>/gitdir` resolves to `<cwd>/.git`; `basename(u)` is `.git`. The main checkout is `dirname(u)`.
 * 3. Any failed check, or any read that throws, means "not trusted".
 * 4. The main checkout's key is looked up exactly: backslashes become slashes and a trailing slash goes, but case is not folded, and the spelling is the gitdir file's own.
 *
 * Only `<cwd>/.git` is read, so a session in a subfolder of the worktree keeps the plain warning. Known limit: the CLI's final path helper may be a realpath. If so its key has the disk's real case where ours has the case written in the gitdir file; that errs safe unless the gitdir spelling's key is trusted and the real-case key is not. The general walk from cwd up to the git root is not done (#55).
 */
export function worktreeTrusted(
  cwd: string,
  config: ClaudeUserConfig | undefined,
  platform: NodeJS.Platform,
  readText: (p: string) => string,
): boolean {
  const main = worktreeMainCheckout(cwd, platform, readText);
  if (main === undefined) {
    return false;
  }
  const key = main.replace(/\\/g, '/').replace(/\/+$/, '');
  return config?.projects?.[key]?.hasTrustDialogAccepted === true;
}

const firstLine = (text: string): string => text.split(/\r?\n/)[0]!.trim();

/** The main checkout of the worktree rooted at `cwd`, as the gitdir file spells it, or undefined when any check of `worktreeTrusted` fails. */
export function worktreeMainCheckout(
  cwd: string,
  platform: NodeJS.Platform,
  readText: (p: string) => string,
): string | undefined {
  const p = platform === 'win32' ? path.win32 : path.posix;
  // Exact, as the CLI's `!==` on resolved paths: a case mismatch then reads as "not trusted", the safe direction.
  const same = (a: string, b: string) => p.resolve(a) === p.resolve(b);
  try {
    const dotGit = readText(p.join(cwd, '.git'));
    if (!dotGit.startsWith('gitdir:')) {
      return undefined;
    }
    const gitdirDir = p.resolve(cwd, firstLine(dotGit.slice('gitdir:'.length)));
    const u = p.resolve(gitdirDir, firstLine(readText(p.join(gitdirDir, 'commondir'))));
    if (!same(p.dirname(gitdirDir), p.join(u, 'worktrees'))) {
      return undefined;
    }
    const back = p.resolve(gitdirDir, firstLine(readText(p.join(gitdirDir, 'gitdir'))));
    if (!same(back, p.join(cwd, '.git')) || p.basename(u) !== '.git') {
      return undefined;
    }
    return p.dirname(u);
  } catch {
    return undefined;
  }
}

/**
 * The spelling of `cwd` that the CLI has on record as trusted, if any.
 *
 * One folder can hold several records: the CLI builds its key with `f(e).replaceAll("\\", "/")` and looks it up exactly, with no case folding, so `c:/x` and `C:/x` are two records to it (VS Code reports the drive in lower case, a terminal writes upper).
 *
 * Returned in the platform's own form, because the caller launches the resume with it as the terminal's cwd, so the CLI derives exactly the key the user trusted. On a case-insensitive filesystem both spellings are the same directory, so this never widens trust to another. The spelling already given wins when it is itself trusted.
 */
export function trustedSpelling(
  cwd: string,
  config: ClaudeUserConfig | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const target = normalizeProjectPath(cwd, platform);
  const exact = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const trusted = Object.entries(config?.projects ?? {})
    .filter(([key, value]) => value?.hasTrustDialogAccepted === true && normalizeProjectPath(key, platform) === target)
    .map(([key]) => key.replace(/\/+$/, ''));
  if (trusted.length === 0) {
    return undefined;
  }
  const chosen = trusted.includes(exact) ? exact : trusted[0]!;
  return platform === 'win32' ? chosen.replace(/\//g, '\\') : chosen;
}

/**
 * Where the CLI reads `.claude.json` from: `path.join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json")`. CLAUDE_CONFIG_DIR stands in for homedir() wholesale for this file, as for ~/.claude itself. The check is `||`, not `??`, so an empty string falls back to the home directory rather than resolving against this process's cwd.
 */
export function defaultClaudeConfigPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

/**
 * Parse `~/.claude.json`. `readFile` is injected so tests never touch the user's real config.
 *
 * Any failure (missing, unreadable, malformed JSON) returns `undefined` rather than throwing: a limit notice is not the place to surface a config-parsing error, and `isFolderTrusted` already treats "no config" as "not trusted", the safe reading either way.
 */
export function readClaudeUserConfig(
  configPath: string,
  readFile: (p: string) => string,
): ClaudeUserConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(readFile(configPath));
    return parsed && typeof parsed === 'object' ? (parsed as ClaudeUserConfig) : undefined;
  } catch {
    return undefined;
  }
}
