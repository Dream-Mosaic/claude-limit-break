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

// --- A git worktree is trusted through its main checkout (F2) ---
// Mirrors the CLI's canonical-root lookup. The reads are injected: no test here touches the real disk.

const WT = '/r/proj-wt';
const MAIN = '/r/proj';
const fakeFs = (files: Record<string, string>) => (p: string): string => {
  const text = files[p];
  if (text === undefined) {
    throw new Error(`ENOENT ${p}`);
  }
  return text;
};
const worktreeFiles = (over: Record<string, string | undefined> = {}): Record<string, string> => {
  const files: Record<string, string | undefined> = {
    [`${WT}/.git`]: `gitdir: ${MAIN}/.git/worktrees/wt\n`,
    [`${MAIN}/.git/worktrees/wt/commondir`]: '../..\n',
    [`${MAIN}/.git/worktrees/wt/gitdir`]: `${WT}/.git\n`,
    ...over,
  };
  return Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined)) as Record<string, string>;
};
const mainTrusted = { projects: { [MAIN]: { hasTrustDialogAccepted: true } } };

test('a valid worktree is trusted through its main checkout, though its own record is missing', () => {
  assert.equal(isFolderTrusted(WT, mainTrusted, 'linux', fakeFs(worktreeFiles())), true);
});

test('an explicit false on the worktree\'s own key does not block the main checkout\'s record', () => {
  const config = { projects: { [MAIN]: { hasTrustDialogAccepted: true }, [WT]: { hasTrustDialogAccepted: false } } };
  assert.equal(isFolderTrusted(WT, config, 'linux', fakeFs(worktreeFiles())), true);
});

test('without a reader only the exact folder is checked', () => {
  assert.equal(isFolderTrusted(WT, mainTrusted, 'linux'), false);
});

test('a worktree whose main checkout is not trusted is not trusted', () => {
  const config = { projects: { [MAIN]: { hasTrustDialogAccepted: false } } };
  assert.equal(isFolderTrusted(WT, config, 'linux', fakeFs(worktreeFiles())), false);
});

test('a worktree is not trusted when its gitdir back-pointer is stale', () => {
  const read = fakeFs(worktreeFiles({ [`${MAIN}/.git/worktrees/wt/gitdir`]: '/elsewhere/.git\n' }));
  assert.equal(isFolderTrusted(WT, mainTrusted, 'linux', read), false);
});

test('a worktree is not trusted when commondir is missing', () => {
  const read = fakeFs(worktreeFiles({ [`${MAIN}/.git/worktrees/wt/commondir`]: undefined }));
  assert.equal(isFolderTrusted(WT, mainTrusted, 'linux', read), false);
});

test('a worktree is not trusted when its gitdir file is missing', () => {
  const read = fakeFs(worktreeFiles({ [`${MAIN}/.git/worktrees/wt/gitdir`]: undefined }));
  assert.equal(isFolderTrusted(WT, mainTrusted, 'linux', read), false);
});

test('a submodule-style gitdir is not trusted', () => {
  const files = worktreeFiles({
    [`${WT}/.git`]: 'gitdir: ../proj/.git/modules/x\n',
    [`${MAIN}/.git/modules/x/commondir`]: undefined,
  });
  assert.equal(isFolderTrusted(WT, mainTrusted, 'linux', fakeFs(files)), false);
  const withCommondir = worktreeFiles({
    [`${WT}/.git`]: 'gitdir: ../proj/.git/modules/x\n',
    [`${MAIN}/.git/modules/x/commondir`]: '../..\n',
    [`${MAIN}/.git/modules/x/gitdir`]: `${WT}/.git\n`,
  });
  assert.equal(isFolderTrusted(WT, mainTrusted, 'linux', fakeFs(withCommondir)), false, 'modules is not worktrees');
});

test('a bare common directory (not named .git) is not trusted', () => {
  const files = {
    [`${WT}/.git`]: 'gitdir: /r/proj.git/worktrees/wt\n',
    '/r/proj.git/worktrees/wt/commondir': '../..\n',
    '/r/proj.git/worktrees/wt/gitdir': `${WT}/.git\n`,
  };
  const config = { projects: { '/r': { hasTrustDialogAccepted: true }, '/r/proj.git': { hasTrustDialogAccepted: true } } };
  assert.equal(isFolderTrusted(WT, config, 'linux', fakeFs(files)), false);
});

test('a main checkout key that differs only in case is not trusted: the lookup is exact', () => {
  const config = { projects: { '/R/Proj': { hasTrustDialogAccepted: true } } };
  assert.equal(isFolderTrusted(WT, config, 'linux', fakeFs(worktreeFiles())), false);
  assert.equal(isFolderTrusted(WT, config, 'win32', fakeFs(worktreeFiles())), false);
});

test('a .git folder rather than a file is not a worktree', () => {
  const read = (p: string): string => {
    if (p === `${WT}/.git`) {
      throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    }
    return fakeFs(worktreeFiles())(p);
  };
  assert.equal(isFolderTrusted(WT, mainTrusted, 'linux', read), false);
});

test('a reader that throws means not trusted, never an exception', () => {
  assert.equal(isFolderTrusted(WT, mainTrusted, 'linux', () => { throw new Error('boom'); }), false);
});

test('a worktree is trusted on win32 with the gitdir file\'s forward slashes; a differently-cased cwd is not (the CLI compares the back-pointer exactly)', () => {
  const files: Record<string, string> = {
    'C:\\Users\\u\\proj-wt\\.git': 'gitdir: C:/Users/u/proj/.git/worktrees/wt',
    'C:\\Users\\u\\proj\\.git\\worktrees\\wt\\commondir': '../..',
    'C:\\Users\\u\\proj\\.git\\worktrees\\wt\\gitdir': 'C:/Users/u/proj-wt/.git',
  };
  const config = { projects: { 'C:/Users/u/proj': { hasTrustDialogAccepted: true } } };
  assert.equal(isFolderTrusted('C:\\Users\\u\\proj-wt', config, 'win32', fakeFs(files)), true);
  assert.equal(isFolderTrusted('c:\\Users\\u\\proj-wt', config, 'win32', (p) => fakeFs(files)(p.replace(/^c:/, 'C:'))), false);
});

test('trustedSpelling is unchanged by a worktree hit: the launch folder stays the exact folder', () => {
  assert.equal(trustedSpelling(WT, mainTrusted, 'linux'), undefined);
});
