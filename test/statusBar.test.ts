import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeStub, resetVscodeFake, vscodeFake } from './helpers/vscode';

installVscodeStub();

const { CountdownStatusBar } = require('../src/statusBar') as typeof import('../src/statusBar');
import type { PendingJob } from '../src/scheduler';

const job = (over: Partial<PendingJob> = {}): PendingJob => ({
  sessionId: '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234',
  transcript: '/h/p/0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl',
  cwd: '/projects/example',
  prompt: 'continue',
  resumeAtMs: Date.now() + 60_000,
  baseResumeAtMs: Date.now() + 60_000,
  jitterMs: 0,
  reason: 'limit',
  ...over,
});

const tooltipText = () => {
  const item = vscodeFake.statusBarItems[0];
  const tooltip = item?.tooltip as { value: string } | undefined;
  return tooltip?.value ?? '';
};

test('the tooltip warns when the folder is not trusted for the CLI', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update(job({ folderTrusted: false }));
    assert.match(
      tooltipText(),
      /not trusted/i,
      `expected an untrusted-folder note in the tooltip; got ${JSON.stringify(tooltipText())}`,
    );
  } finally {
    bar.dispose();
  }
});

test('the tooltip says nothing about trust when the folder is trusted', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update(job({ folderTrusted: true }));
    assert.doesNotMatch(tooltipText(), /not trusted/i);
  } finally {
    bar.dispose();
  }
});

test('the tooltip says nothing about trust when trust is unknown', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update(job({ folderTrusted: undefined }));
    assert.doesNotMatch(tooltipText(), /not trusted/i);
  } finally {
    bar.dispose();
  }
});

test('the pill says how many sessions are waiting when there is more than one', () => {
  // Without this, a second session's resume is invisible: the pill shows the
  // soonest one only, which reads exactly like the other one was dropped.
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update(job(), 2);
    assert.match(vscodeFake.statusBarItems[0]?.text ?? '', /2 sessions/);
  } finally {
    bar.dispose();
  }
});

test('the pill does not mention a count for a single session', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update(job(), 1);
    assert.doesNotMatch(vscodeFake.statusBarItems[0]?.text ?? '', /sessions/);
  } finally {
    bar.dispose();
  }
});
