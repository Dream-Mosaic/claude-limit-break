import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalizeProjectPath,
  isFolderTrusted,
  readClaudeUserConfig,
  defaultClaudeConfigPath,
} from '../src/trust';

// No file in this suite ever touches the real ~/.claude.json: readClaudeUserConfig
// takes its reader as an argument, and every test below supplies a fake one.

test('normalizeProjectPath folds backslashes, drive-letter casing, and a trailing slash to the same key', () => {
  assert.equal(
    normalizeProjectPath('C:\\Users\\x\\proj\\', 'win32'),
    normalizeProjectPath('c:/Users/x/proj', 'win32'),
  );
});

test('isFolderTrusted is true only when the matching project explicitly accepted the dialog', () => {
  const config = { projects: { '/projects/example': { hasTrustDialogAccepted: true } } };
  assert.equal(isFolderTrusted('/projects/example', config, 'linux'), true);
});

test('isFolderTrusted is false when the flag is explicitly false', () => {
  const config = { projects: { '/projects/example': { hasTrustDialogAccepted: false } } };
  assert.equal(isFolderTrusted('/projects/example', config, 'linux'), false);
});

test('isFolderTrusted is false when the project is not tracked at all', () => {
  const config = { projects: {} };
  assert.equal(isFolderTrusted('/projects/example', config, 'linux'), false);
});

test('isFolderTrusted is false when there is no config to check against', () => {
  // Panel-created sessions and a machine where .claude.json could not be
  // read land here alike - both mean "trust was never confirmed", which is
  // exactly the state that stalls a resume at the CLI's trust prompt.
  assert.equal(isFolderTrusted('/projects/example', undefined, 'linux'), false);
});

test('isFolderTrusted matches despite drive-letter casing and slash-direction differences (win32)', () => {
  const config = { projects: { 'c:/Users/x/proj': { hasTrustDialogAccepted: true } } };
  assert.equal(isFolderTrusted('C:\\Users\\x\\proj', config, 'win32'), true);
});

test('isFolderTrusted matches despite a trailing slash on the recorded key', () => {
  const config = { projects: { 'C:/Users/x/proj/': { hasTrustDialogAccepted: true } } };
  assert.equal(isFolderTrusted('C:/Users/x/proj', config, 'win32'), true);
});

test('isFolderTrusted does not match a sibling project sharing a prefix', () => {
  const config = { projects: { '/projects/example-old': { hasTrustDialogAccepted: true } } };
  assert.equal(isFolderTrusted('/projects/example', config, 'linux'), false);
});

// --- Case folding is platform-specific (#8 finding 3) -----------------------
//
// The drive-letter casing problem is real and Windows-specific: NTFS is
// case-insensitive, so `C:/x` and `c:/x` name the same directory. Folding
// case everywhere was wrong: on Linux (ext4 etc, case-sensitive), `/home/a`
// and `/home/A` are two different directories that would wrongly share one
// trust answer. darwin's default filesystem (HFS+/APFS) is case-insensitive
// like Windows, so it folds too; platform is a parameter rather than
// `process.platform` read internally, so both branches are directly testable.

test('normalizeProjectPath folds case on win32, where the filesystem does not distinguish it', () => {
  assert.equal(
    normalizeProjectPath('C:\\Users\\x\\Proj\\', 'win32'),
    normalizeProjectPath('c:/users/x/proj', 'win32'),
  );
});

test('normalizeProjectPath folds case on darwin, whose default filesystem is also case-insensitive', () => {
  assert.equal(
    normalizeProjectPath('/Users/X/Proj', 'darwin'),
    normalizeProjectPath('/users/x/proj', 'darwin'),
  );
});

test('normalizeProjectPath preserves case on linux, where two differently-cased paths are two different directories', () => {
  assert.notEqual(
    normalizeProjectPath('/home/a/proj', 'linux'),
    normalizeProjectPath('/home/A/proj', 'linux'),
  );
});

test('isFolderTrusted on linux does not conflate two directories that differ only by case', () => {
  // Before the fix, normalizeProjectPath lowercased unconditionally, so this
  // config would wrongly report /home/A/proj as trusted too.
  const config = { projects: { '/home/a/proj': { hasTrustDialogAccepted: true } } };
  assert.equal(isFolderTrusted('/home/A/proj', config, 'linux'), false);
  assert.equal(isFolderTrusted('/home/a/proj', config, 'linux'), true);
});

test('readClaudeUserConfig parses what the injected reader returns', () => {
  const raw = JSON.stringify({ projects: { '/p': { hasTrustDialogAccepted: true } } });
  const seen: string[] = [];
  const config = readClaudeUserConfig('/fake/.claude.json', (p: string) => {
    seen.push(p);
    return raw;
  });
  assert.deepEqual(seen, ['/fake/.claude.json'], 'the exact path must reach the reader');
  assert.equal(config?.projects?.['/p']?.hasTrustDialogAccepted, true);
});

test('readClaudeUserConfig returns undefined when the reader throws', () => {
  const config = readClaudeUserConfig('/fake/.claude.json', () => {
    throw new Error('ENOENT');
  });
  assert.equal(config, undefined);
});

test('readClaudeUserConfig returns undefined on invalid JSON rather than throwing', () => {
  const config = readClaudeUserConfig('/fake/.claude.json', () => 'not json');
  assert.equal(config, undefined);
});

test('defaultClaudeConfigPath points at .claude.json under the home directory when CLAUDE_CONFIG_DIR is unset', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.equal(defaultClaudeConfigPath(), path.join(os.homedir(), '.claude.json'));
  } finally {
    if (saved !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }
});

test('defaultClaudeConfigPath honours CLAUDE_CONFIG_DIR (#8) - the CLI relocates .claude.json there too, verified by reading its own bundle', () => {
  // The CLI resolves the file as `path.join(process.env.CLAUDE_CONFIG_DIR ||
  // <homedir-fallback>, '.claude.json')` - CLAUDE_CONFIG_DIR replaces
  // homedir() wholesale for this file, the same as it does for ~/.claude
  // itself. Left unhonoured, a scheduled resume reads no config, treats
  // every folder as untrusted, and warns wrongly on every single fire.
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'clb-custom-claude-home');
  try {
    assert.equal(
      defaultClaudeConfigPath(),
      path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'),
    );
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }
});

test('an empty CLAUDE_CONFIG_DIR falls back to the home directory, matching the CLI (it checks truthiness, not just defined-ness)', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '';
  try {
    assert.equal(defaultClaudeConfigPath(), path.join(os.homedir(), '.claude.json'));
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }
});

test('only an explicit true counts as trusted, never a merely truthy value', () => {
  // ~/.claude.json is parsed and cast, not validated, so the value is whatever
  // is in the file. Reading "yes" or 1 as trusted would tell the user a folder
  // is fine when Claude itself will still stop at its trust prompt.
  const { isFolderTrusted: trusted } = require('../src/trust') as typeof import('../src/trust');
  for (const value of ['yes', 'true', 1]) {
    const config = { projects: { '/p': { hasTrustDialogAccepted: value } } };
    assert.equal(
      trusted('/p', config as unknown as Parameters<typeof trusted>[1], 'linux'),
      false,
      `hasTrustDialogAccepted: ${JSON.stringify(value)} must not count as trusted`,
    );
  }
});
