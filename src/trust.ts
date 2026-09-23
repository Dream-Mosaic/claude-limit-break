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
 * arrives with backslashes. Folding both to forward slashes, lower case, and
 * no trailing slash makes them comparable without declaring either form
 * canonical, and without touching the filesystem (path.resolve would resolve
 * relative to *this* process's cwd, which is meaningless for a path recorded
 * by a different process on a possibly different run).
 */
export function normalizeProjectPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
export function isFolderTrusted(cwd: string, config: ClaudeUserConfig | undefined): boolean {
  const target = normalizeProjectPath(cwd);
  for (const [key, value] of Object.entries(config?.projects ?? {})) {
    if (normalizeProjectPath(key) === target) {
      return value?.hasTrustDialogAccepted === true;
    }
  }
  return false;
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
