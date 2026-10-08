import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { installVscodeStub } from './helpers/vscode';
import { claudeHome } from '../src/claudeHome';
import { sessionRegistryDir } from '../src/sessionRegistry';
import { autoContinueEnabled } from '../src/autoContinue';

installVscodeStub();

const { transcriptRoot } = require('../src/transcriptWatcher') as typeof import('../src/transcriptWatcher');

/** Run `fn` with CLAUDE_CONFIG_DIR set to `value` (undefined = unset), restoring the suite's own value after. */
function withConfigDir(value: string | undefined, fn: () => void): void {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  if (value === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = value;
  }
  try {
    fn();
  } finally {
    if (saved === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  }
}

const CUSTOM = path.join(os.tmpdir(), 'clb-custom-claude-home');
const DEFAULT = path.join(os.homedir(), '.claude');

test('claudeHome is CLAUDE_CONFIG_DIR when set and non-empty', () => {
  withConfigDir(CUSTOM, () => assert.equal(claudeHome(), CUSTOM));
});

test('claudeHome falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset or empty (the CLI checks truthiness)', () => {
  withConfigDir(undefined, () => assert.equal(claudeHome(), DEFAULT));
  withConfigDir('', () => assert.equal(claudeHome(), DEFAULT));
});

test('the transcript watcher reads projects from CLAUDE_CONFIG_DIR', () => {
  withConfigDir(CUSTOM, () => assert.equal(transcriptRoot(), path.join(CUSTOM, 'projects')));
});

test('the transcript watcher falls back to ~/.claude/projects when the variable is unset or empty', () => {
  withConfigDir(undefined, () => assert.equal(transcriptRoot(), path.join(DEFAULT, 'projects')));
  withConfigDir('', () => assert.equal(transcriptRoot(), path.join(DEFAULT, 'projects')));
});

test('the session registry reads sessions from CLAUDE_CONFIG_DIR', () => {
  withConfigDir(CUSTOM, () => assert.equal(sessionRegistryDir(), path.join(CUSTOM, 'sessions')));
});

test('the session registry falls back to ~/.claude/sessions when the variable is unset or empty', () => {
  withConfigDir(undefined, () => assert.equal(sessionRegistryDir(), path.join(DEFAULT, 'sessions')));
  withConfigDir('', () => assert.equal(sessionRegistryDir(), path.join(DEFAULT, 'sessions')));
});

test('autoContinueEnabled reads settings.json from CLAUDE_CONFIG_DIR, and from ~/.claude when it is empty', () => {
  const asked: string[] = [];
  const reader = (p: string): string => {
    asked.push(p);
    throw new Error('ENOENT');
  };
  withConfigDir(CUSTOM, () => {
    autoContinueEnabled(undefined, 'linux', reader);
    assert.ok(asked.includes(path.join(CUSTOM, 'settings.json')), `asked ${JSON.stringify(asked)}`);
    assert.ok(!asked.includes(path.join(DEFAULT, 'settings.json')), 'the default is not read in its place');
  });
  asked.length = 0;
  withConfigDir('', () => {
    autoContinueEnabled(undefined, 'linux', reader);
    assert.ok(asked.includes(path.join(DEFAULT, 'settings.json')), `asked ${JSON.stringify(asked)}`);
  });
});
