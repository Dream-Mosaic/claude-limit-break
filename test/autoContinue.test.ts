import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { autoContinueEnabled } from '../src/autoContinue';

const CWD = '/work/app';

/** A reader over an in-memory map, keyed by the exact path asked for, folded
 * to forward slashes so a test does not need to know which separator
 * `path.join` chose on the host platform running the suite. Throws for
 * anything else, the same as a real fs.readFileSync on a missing file. */
const reader = (files: Record<string, string>) => (p: string) => {
  const key = p.replace(/\\/g, '/');
  if (!(key in files)) {
    throw new Error(`ENOENT: ${p}`);
  }
  return files[key]!;
};

const managedPath = (platform: NodeJS.Platform): string =>
  (platform === 'win32'
    ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
    : platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : '/etc/claude-code/managed-settings.json'
  ).replace(/\\/g, '/');

/** Run `fn` with CLAUDE_CONFIG_DIR unset, restoring whatever the suite had after. */
function withoutConfigDir(fn: () => void): void {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    fn();
  } finally {
    if (saved !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }
}

test('autoContinueEnabled defaults to on when no layer sets the key', () => {
  // claude.exe 2.1.281: `setting ?? (autoContinueKeyPresence === "absent")` -
  // absent reads as present-and-true, not as false.
  assert.equal(autoContinueEnabled(CWD, 'linux', reader({})), true);
});

test('autoContinueEnabled reads false from the user settings file, the lowest layer', () => {
  withoutConfigDir(() => {
    const files = {
      [path.posix.join(os.homedir().replace(/\\/g, '/'), '.claude', 'settings.json')]: JSON.stringify({
        autoContinueAtUsageLimit: false,
      }),
    };
    assert.equal(autoContinueEnabled(undefined, 'linux', reader(files)), false);
  });
});

test('autoContinueEnabled reads a boolean from CLAUDE_CONFIG_DIR when set, in place of ~/.claude', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/custom/claude-home';
  try {
    const files = {
      '/custom/claude-home/settings.json': JSON.stringify({ autoContinueAtUsageLimit: false }),
    };
    assert.equal(autoContinueEnabled(undefined, 'linux', reader(files)), false);
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }
});

test('autoContinueEnabled prefers <cwd>/.claude/settings.json over the user settings file', () => {
  const files = {
    [path.posix.join(CWD, '.claude', 'settings.json')]: JSON.stringify({ autoContinueAtUsageLimit: false }),
    '/custom/claude-home/settings.json': JSON.stringify({ autoContinueAtUsageLimit: true }),
  };
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/custom/claude-home';
  try {
    assert.equal(autoContinueEnabled(CWD, 'linux', reader(files)), false);
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }
});

test('autoContinueEnabled prefers <cwd>/.claude/settings.local.json over <cwd>/.claude/settings.json', () => {
  const files = {
    [path.posix.join(CWD, '.claude', 'settings.local.json')]: JSON.stringify({ autoContinueAtUsageLimit: false }),
    [path.posix.join(CWD, '.claude', 'settings.json')]: JSON.stringify({ autoContinueAtUsageLimit: true }),
  };
  assert.equal(autoContinueEnabled(CWD, 'linux', reader(files)), false);
});

test('autoContinueEnabled skips a layer whose JSON parses but is not an object', () => {
  // JSON.parse('null') and JSON.parse('42') both succeed; neither can be
  // indexed for the setting key without throwing, so this must be skipped
  // exactly like a missing or malformed file, not crash the whole read.
  const files = {
    [path.posix.join(CWD, '.claude', 'settings.local.json')]: 'null',
    [path.posix.join(CWD, '.claude', 'settings.json')]: JSON.stringify({ autoContinueAtUsageLimit: false }),
  };
  assert.equal(autoContinueEnabled(CWD, 'linux', reader(files)), false);
});

test('autoContinueEnabled prefers managed settings over every other layer', () => {
  const files = {
    [managedPath('linux')]: JSON.stringify({ autoContinueAtUsageLimit: false }),
    [path.posix.join(CWD, '.claude', 'settings.local.json')]: JSON.stringify({ autoContinueAtUsageLimit: true }),
  };
  assert.equal(autoContinueEnabled(CWD, 'linux', reader(files)), false);
});

test('autoContinueEnabled reads managed settings from the win32 path', () => {
  const files = {
    [managedPath('win32')]: JSON.stringify({ autoContinueAtUsageLimit: false }),
  };
  assert.equal(autoContinueEnabled(CWD, 'win32', reader(files)), false);
});

test('autoContinueEnabled reads managed settings from the darwin path', () => {
  const files = {
    [managedPath('darwin')]: JSON.stringify({ autoContinueAtUsageLimit: false }),
  };
  assert.equal(autoContinueEnabled(CWD, 'darwin', reader(files)), false);
});

test('autoContinueEnabled skips a layer whose key is present but not a boolean', () => {
  const files = {
    [path.posix.join(CWD, '.claude', 'settings.local.json')]: JSON.stringify({ autoContinueAtUsageLimit: 'no' }),
    [path.posix.join(CWD, '.claude', 'settings.json')]: JSON.stringify({ autoContinueAtUsageLimit: false }),
  };
  assert.equal(autoContinueEnabled(CWD, 'linux', reader(files)), false);
});

test('autoContinueEnabled skips a layer that cannot be read at all', () => {
  // No file at settings.local.json (a real fs.readFileSync throws ENOENT);
  // the next layer down still decides.
  const files = {
    [path.posix.join(CWD, '.claude', 'settings.json')]: JSON.stringify({ autoContinueAtUsageLimit: false }),
  };
  assert.equal(autoContinueEnabled(CWD, 'linux', reader(files)), false);
});

test('autoContinueEnabled skips a layer with malformed JSON rather than throwing', () => {
  const files = {
    [path.posix.join(CWD, '.claude', 'settings.local.json')]: '{ not json',
    [path.posix.join(CWD, '.claude', 'settings.json')]: JSON.stringify({ autoContinueAtUsageLimit: false }),
  };
  assert.equal(autoContinueEnabled(CWD, 'linux', reader(files)), false);
});

test('autoContinueEnabled skips the two cwd-scoped layers entirely when there is no cwd', () => {
  // A job can be scheduled with no cwd (see PendingJob). Only the managed and
  // user-level layers can possibly apply.
  withoutConfigDir(() => {
    const files = {
      [path.posix.join(os.homedir().replace(/\\/g, '/'), '.claude', 'settings.json')]: JSON.stringify({
        autoContinueAtUsageLimit: false,
      }),
    };
    assert.equal(autoContinueEnabled(undefined, 'linux', reader(files)), false);
  });
});

test('an explicit true is read the same as an absent key', () => {
  const files = {
    [path.posix.join(CWD, '.claude', 'settings.json')]: JSON.stringify({ autoContinueAtUsageLimit: true }),
  };
  assert.equal(autoContinueEnabled(CWD, 'linux', reader(files)), true);
});
