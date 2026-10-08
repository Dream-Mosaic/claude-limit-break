import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where Claude Code keeps its own files: `$CLAUDE_CONFIG_DIR` when set and non-empty, otherwise `~/.claude`.
 *
 * Every read under that directory (transcripts, per-pid session records, user `settings.json`) goes through here. The test is truthiness like the CLI's `process.env.CLAUDE_CONFIG_DIR || ...`: an empty string falls back to `~/.claude`.
 *
 * `~/.claude.json` has its own resolver (`defaultClaudeConfigPath` in trust.ts). Read-only: nothing writes under this directory.
 */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
