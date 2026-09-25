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

// ---------------------------------------------------------------------------
// Idle presence. A background extension that shows nothing is indistinguishable
// from one that failed to load, which is exactly the doubt a freshly installed
// VSIX creates - so when nothing is pending the item stays as a bare marker
// rather than disappearing.
// ---------------------------------------------------------------------------

test('with nothing pending the item still shows a marker', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(undefined, 0, 'always');
  const item = vscodeFake.statusBarItems[0];
  assert.ok(item?.visible, 'the item must be visible when idle');
  assert.match(item.text, /\$\(.+\)/, 'an icon, so it reads as a marker rather than a label');
  assert.ok(!/resumes in/.test(item.text), 'and no countdown, because nothing is counting down');
});

test('the idle tooltip says it is watching and nothing is pending', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(undefined, 0, 'always');
  assert.match(tooltipText(), /watching/i);
  assert.match(tooltipText(), /nothing pending/i);
});

test('statusBar "pending" keeps the item hidden until there is a countdown', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(undefined, 0, 'pending');
  assert.equal(vscodeFake.statusBarItems[0]?.visible, false);
  bar.update(job(), 1, 'pending');
  assert.equal(vscodeFake.statusBarItems[0]?.visible, true);
});

test('statusBar "never" hides the item even while a resume is counting down', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(job(), 1, 'never');
  assert.equal(vscodeFake.statusBarItems[0]?.visible, false);
});

test('a pending job still shows the countdown, not the idle marker', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(job(), 1, 'always');
  const item = vscodeFake.statusBarItems[0];
  assert.match(item!.text, /resumes in/);
});

test('clicking opens the menu rather than cancelling outright', () => {
  // Issue #3: a single click used to destroy the pending resume, with the only
  // warning at the bottom of the tooltip. Every other status-bar item in VS
  // Code that shows state opens something on click.
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(job(), 1, 'always');
  assert.equal(vscodeFake.statusBarItems[0]?.command, 'claudeLimitBuster.statusBarMenu');
});

test('the tooltip no longer promises that clicking cancels', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(job(), 1, 'always');
  assert.ok(!/click to cancel/i.test(tooltipText()), tooltipText());
});

// ---------------------------------------------------------------------------
// The gave-up state (Task 4b). A session this extension has stopped retrying
// must not leave the item looking idle: it gets its own icon, and the tooltip
// names each such session and why.
// ---------------------------------------------------------------------------

const { GAVE_UP_ICON } = require('../src/gaveUp') as typeof import('../src/gaveUp');
import type { GaveUpRecord } from '../src/gaveUp';

const OTHER = '7f2a9c41-8b3d-4e5f-9a01-6c7d8e9f0a1b';
const gaveUp = (over: Partial<GaveUpRecord> = {}): GaveUpRecord => ({
  sessionId: '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234',
  cwd: '/projects/example',
  cause: 'stall',
  atMs: Date.now(),
  ...over,
});

test('with nothing pending and a session given up, the item shows the gave-up icon, not the idle eye', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(undefined, 0, 'always', [gaveUp()]);
  const item = vscodeFake.statusBarItems[0];
  assert.ok(item?.visible);
  assert.ok(item.text.startsWith(GAVE_UP_ICON), `expected the gave-up icon; got ${item.text}`);
  assert.ok(!item.text.includes('$(eye)'), 'it must not read as idle');
});

test('the gave-up tooltip names each session, its folder and its cause', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(undefined, 0, 'always', [
    gaveUp({ cause: 'cwd' }),
    gaveUp({ sessionId: OTHER, cwd: '/projects/other', cause: 'launcher' }),
  ]);
  const text = tooltipText();
  assert.ok(text.includes('0b3d1f66') && text.includes('7f2a9c41'), text);
  assert.ok(text.includes('/projects/example') && text.includes('/projects/other'), text);
  assert.match(text, /no longer exists/);
  assert.match(text, /claude executable/);
  assert.doesNotMatch(text, /nothing pending/i, 'something did happen');
  assert.match(text, /Cancel/, 'the tooltip says how to clear it');
});

test('the gave-up text counts sessions when more than one gave up', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(undefined, 0, 'always', [gaveUp(), gaveUp({ sessionId: OTHER })]);
  assert.match(vscodeFake.statusBarItems[0]?.text ?? '', /2 sessions/);
  bar.update(undefined, 0, 'always', [gaveUp()]);
  assert.doesNotMatch(vscodeFake.statusBarItems[0]?.text ?? '', /sessions/);
});

test('statusBar "pending" still shows a gave-up session: it is not idle', () => {
  // "pending" hides the idle marker only. A failure it would hide is the
  // silent-failure case the gave-up state exists to end.
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(undefined, 0, 'pending', [gaveUp()]);
  assert.equal(vscodeFake.statusBarItems[0]?.visible, true);
});

test('statusBar "never" hides the gave-up state too', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(undefined, 0, 'never', [gaveUp()]);
  assert.equal(vscodeFake.statusBarItems[0]?.visible, false);
});

test('a pending countdown still wins the text, and the tooltip still mentions the gave-up session', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(job({ sessionId: OTHER }), 1, 'always', [gaveUp({ cause: 'budget' })]);
  const item = vscodeFake.statusBarItems[0];
  assert.match(item!.text, /resumes in/);
  assert.ok(!item!.text.includes(GAVE_UP_ICON));
  assert.ok(tooltipText().includes('0b3d1f66'), tooltipText());
  assert.match(tooltipText(), /budget/);
});

test('no gave-up section when nothing gave up', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update(job(), 1, 'always', []);
  assert.doesNotMatch(tooltipText(), /gave up/i);
  bar.update(undefined, 0, 'always', []);
  assert.doesNotMatch(tooltipText(), /gave up/i);
  assert.ok(vscodeFake.statusBarItems[0]?.text.includes('$(eye)'));
});
