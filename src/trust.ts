import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudeUserConfig {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>;
}

/**
 * Normalize a path for comparison against a `~/.claude.json` project key.
 *
 * Keys in that file are recorded with forward slashes and inconsistent
 * drive-letter casing - both `c:/Users/...` and `C:/Users/...` were observed
 * in the same file on one machine - while a transcript's `cwd` on Windows
 * arrives with backslashes. Folding both to forward slashes and no trailing
 * slash makes them comparable without declaring either form canonical, and
 * without touching the filesystem (path.resolve would resolve relative to
 * *this* process's cwd, which is meaningless for a path recorded by a
 * different process on a possibly different run).
 *
 * Case is folded only on win32 and darwin, whose default filesystems
 * (NTFS/ReFS, HFS+/APFS) do not distinguish it - not everywhere. The
 * drive-letter casing problem is real and Windows-specific; folding case
 * unconditionally was wrong on Linux (ext4 etc.), where `/home/a/proj` and
 * `/home/A/proj` are two different directories that would wrongly share one
 * trust answer (#8). `platform` is a parameter rather than read from
 * `process.platform` internally so both branches stay directly testable.
 */
export function normalizeProjectPath(p: string, platform: NodeJS.Platform): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' || platform === 'darwin' ? slashed.toLowerCase() : slashed;
}

/**
 * Whether Claude Code has recorded `cwd` as trusted for CLI use.
 *
 * This is read-only and stays that way: it must never write
 * `hasTrustDialogAccepted` back to the config, because doing so would answer
 * the trust prompt on the user's behalf and defeat the control it exists to
 * enforce (issue #5). "No config", "folder not tracked yet", and "tracked but
 * declined" all return false and are treated identically by callers - all
 * three land a resume on the same stalled prompt, so there is nothing useful
 * to tell them apart for.
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
 * One folder can hold several records. The CLI builds its key with
 * `f(e).replaceAll("\\", "/")` and looks it up exactly, with no case folding -
 * read out of its own bundle - so `c:/x` and `C:/x` are two records to it. On
 * the development machine the panel had written `c:/...` untrusted (VS Code
 * reports the drive in lower case) while trusting the folder from a terminal
 * wrote `C:/...` trusted. The first-match lookup this replaced answered
 * "untrusted" for a folder the user had trusted, and kept saying so after.
 *
 * Returned in the platform's own form, because the caller launches the resume
 * with it as the terminal's cwd: the CLI then derives exactly the key the
 * user trusted, instead of the one the panel happened to write. On a
 * case-insensitive filesystem both spellings are the same directory, so this
 * chooses between names for one folder and never widens trust to another.
 * The spelling already given wins when it is itself trusted.
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
 * Where the CLI reads `.claude.json` from.
 *
 * CLAUDE_CONFIG_DIR does relocate this file, not only `~/.claude/` - checked,
 * not assumed, by reading the installed CLI's own bundle (issue #8 finding
 * 1). Its resolver is `path.join(process.env.CLAUDE_CONFIG_DIR || homedir(),
 * ".claude.json")`, found twice independently in the bundle: CLAUDE_CONFIG_DIR
 * stands in for homedir() wholesale for this file, the same as it does for
 * ~/.claude itself. The check is `||`, not `??`, so an empty string (as well
 * as unset) falls back to the home directory rather than resolving relative
 * to this process's own cwd.
 */
export function defaultClaudeConfigPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

/**
 * Parse `~/.claude.json`. `readFile` is injected so this - and everything
 * that calls it - stays unit-testable without touching the user's real
 * config: tests pass a fake reader, production passes `fs.readFileSync`.
 *
 * Failure of any kind (missing file, unreadable, malformed JSON) comes back
 * as `undefined` rather than throwing: a limit notice is not the place to
 * surface a config-parsing error, and `isFolderTrusted` already treats "no
 * config" the same as "not trusted", which is the safe reading either way.
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
