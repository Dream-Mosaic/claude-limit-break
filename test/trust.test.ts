import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  normalizeProjectPath,
  isFolderTrusted,
  trustedSpelling,
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

// --- Case folding is platform-specific ---
// NTFS is case-insensitive, so `C:/x` and `c:/x` are one directory; on Linux
// `/home/a` and `/home/A` differ and must not share a trust answer. darwin's
// default filesystem folds like Windows. Platform is a parameter so both
// branches are testable.

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
  // Lowercasing unconditionally would wrongly report /home/A/proj as trusted
  // too.
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

test('defaultClaudeConfigPath honours CLAUDE_CONFIG_DIR - the CLI relocates .claude.json there too', () => {
  // The CLI resolves the file as `path.join(CLAUDE_CONFIG_DIR || homedir,
  // '.claude.json')`; unhonoured, every folder would read as untrusted and warn
  // on every fire.
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

// Two spellings of one folder with different answers.
// ~/.claude.json can hold both `c:/x` (written by the panel, since VS Code
// reports a lower-case drive) and `C:/x` (written when trusted from a
// terminal). The CLI looks its key up exactly, with no case folding, so these
// are two records; taking the first match answers "untrusted" for a folder the
// user trusted.

const twoSpellings = (lower: boolean, upper: boolean) => ({
  projects: {
    'c:/Users/thegr/proj': { hasTrustDialogAccepted: lower },
    'C:/Users/thegr/proj': { hasTrustDialogAccepted: upper },
  },
});

test('a folder trusted under one drive-letter spelling counts as trusted', () => {
  assert.equal(isFolderTrusted('c:\\Users\\thegr\\proj', twoSpellings(false, true), 'win32'), true);
  assert.equal(isFolderTrusted('C:\\Users\\thegr\\proj', twoSpellings(false, true), 'win32'), true);
});

test('the order the spellings appear in does not decide the answer', () => {
  const reversed = {
    projects: {
      'C:/Users/thegr/proj': { hasTrustDialogAccepted: true },
      'c:/Users/thegr/proj': { hasTrustDialogAccepted: false },
    },
  };
  assert.equal(isFolderTrusted('c:\\Users\\thegr\\proj', reversed, 'win32'), true);
});

test('neither spelling trusted is still untrusted', () => {
  assert.equal(isFolderTrusted('c:\\Users\\thegr\\proj', twoSpellings(false, false), 'win32'), false);
});

test('trustedSpelling returns the exact spelling the CLI has on record as trusted', () => {
  // The resume launches with this as its cwd, so the CLI's own exact lookup
  // finds the record the user created instead of the one the panel did.
  assert.equal(
    trustedSpelling('c:\\Users\\thegr\\proj', twoSpellings(false, true), 'win32'),
    'C:\\Users\\thegr\\proj',
  );
});

test('trustedSpelling keeps the given spelling when that one is already trusted', () => {
  assert.equal(
    trustedSpelling('c:\\Users\\thegr\\proj', twoSpellings(true, true), 'win32'),
    'c:\\Users\\thegr\\proj',
  );
});

test('trustedSpelling finds nothing when no spelling is trusted', () => {
  assert.equal(trustedSpelling('c:\\Users\\thegr\\proj', twoSpellings(false, false), 'win32'), undefined);
});

test('on linux a differently-cased path is a different folder, not another spelling', () => {
  const config = { projects: { '/home/A/proj': { hasTrustDialogAccepted: true } } };
  assert.equal(trustedSpelling('/home/a/proj', config, 'linux'), undefined);
  assert.equal(isFolderTrusted('/home/a/proj', config, 'linux'), false);
});
