import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where Claude Code keeps its own files: `$CLAUDE_CONFIG_DIR` when that is set
 * and non-empty, otherwise `~/.claude`.
 *
 * Every read this extension makes under that directory (the transcript tree,
 * the per-pid session records, the user `settings.json`) goes through here, so
 * a relocated configuration directory cannot leave one reader looking at the
 * wrong tree (final review I3). The test is truthiness, not definedness, the
 * same as the CLI's own `process.env.CLAUDE_CONFIG_DIR || ...`: an empty
 * string falls back to `~/.claude` rather than resolving against this
 * process's cwd.
 *
 * `~/.claude.json` is a different file with its own resolver
 * (`defaultClaudeConfigPath` in trust.ts) and does not come from here.
 *
 * Read-only by design: nothing in the extension writes under this directory
 * (global constraint 2).
 */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
