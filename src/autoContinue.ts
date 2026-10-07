import * as path from 'node:path';

import { claudeHome } from './claudeHome';

/**
 * Whether Claude Code's own terminal UI will resume a session by itself once a usage limit resets.
 *
 * The CLI evaluates `setting ?? (autoContinueKeyPresence === "absent")`, so an absent key reads as on. A `terminal` holder with this on is left alone rather than getting a second `--resume`.
 *
 * Layers are read highest-precedence first, like the CLI's settings.json layering; the first layer that sets the key as a boolean decides, and unreadable, malformed or non-boolean layers are skipped. `readFile` is injected so tests never touch real settings.
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
  // The cwd-scoped layers need a cwd to root them at (a job can have none), so they are skipped without one.
  if (cwd) {
    layers.push(path.join(cwd, '.claude', 'settings.local.json'));
    layers.push(path.join(cwd, '.claude', 'settings.json'));
  }
  // CLAUDE_CONFIG_DIR replaces ~/.claude wholesale, as it does for ~/.claude.json (trust.ts).
  layers.push(path.join(claudeHome(), 'settings.json'));
  for (const layer of layers) {
    const value = readLayer(layer, readFile);
    if (value !== undefined) {
      return value;
    }
  }
  return true;
}
