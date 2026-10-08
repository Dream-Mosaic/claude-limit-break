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
 */
export function isFolderTrusted(
  cwd: string,
  config: ClaudeUserConfig | undefined,
  platform: NodeJS.Platform,
): boolean {
  return trustedSpelling(cwd, config, platform) !== undefined;
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
