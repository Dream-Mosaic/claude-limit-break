import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Whether Claude Code's own terminal UI will pick a session back up by
 * itself once a usage limit resets, without this extension doing anything.
 *
 * Verified against claude.exe 2.1.281: the CLI evaluates
 * `setting ?? (autoContinueKeyPresence === "absent")` - an absent key reads
 * as on, not off, so a machine that has never touched this setting still
 * gets native auto-continue. Task 2 needs this so a `terminal` holder with
 * auto-continue on is left alone rather than getting a second `--resume`
 * launched against it.
 *
 * The four layers below are read highest-precedence first, exactly as the
 * CLI itself layers `settings.json` files; the first layer that sets the key
 * as a boolean decides, and a layer that cannot be read at all (missing,
 * unreadable, malformed JSON) or sets the key to something other than a
 * boolean is skipped rather than treated as a decision. `readFile` is
 * injected, the same shape used throughout this codebase (trust.ts,
 * sessionRegistry.ts), so no test here ever touches the developer's real
 * settings files.
 */
const SETTING_KEY = 'autoContinueAtUsageLimit';

function managedSettingsPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  }
  if (platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  }
  return '/etc/claude-code/managed-settings.json';
}

/** The boolean value of SETTING_KEY in one settings file, or undefined if the
 * file cannot be read, is not valid JSON, is not an object, or does not set
 * the key to a boolean. */
function readLayer(settingsPath: string, readFile: (p: string) => string): boolean | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(settingsPath));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const value = (parsed as Record<string, unknown>)[SETTING_KEY];
  return typeof value === 'boolean' ? value : undefined;
}

export function autoContinueEnabled(
  cwd: string | undefined,
  platform: NodeJS.Platform,
  readFile: (p: string) => string,
): boolean {
  const layers: string[] = [managedSettingsPath(platform)];
  // The two cwd-scoped layers do not exist without a cwd to root them at - a
  // job can be scheduled with none (see PendingJob) - so they are skipped
  // rather than resolved against some arbitrary directory.
  if (cwd) {
    layers.push(path.join(cwd, '.claude', 'settings.local.json'));
    layers.push(path.join(cwd, '.claude', 'settings.json'));
  }
  // CLAUDE_CONFIG_DIR replaces ~/.claude wholesale here, the same as it does
  // for ~/.claude.json in trust.ts's defaultClaudeConfigPath - checked against
  // the CLI's own bundle there, and the same relocation rule applies to every
  // file normally found under ~/.claude.
  layers.push(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'));
  for (const layer of layers) {
    const value = readLayer(layer, readFile);
    if (value !== undefined) {
      return value;
    }
  }
  return true;
}
