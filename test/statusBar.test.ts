import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeStub, resetVscodeFake, vscodeFake } from './helpers/vscode';

installVscodeStub();

const {
  CountdownStatusBar,
  escapeMarkdown,
  trustCommandUri,
  buildSessionLines,
} = require('../src/statusBar') as typeof import('../src/statusBar');
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

// ---------------------------------------------------------------------------
// escapeMarkdown - Task 5b ruling 2. User-controlled text (folder names) must
// render literally and never as Markdown syntax or an injected link.
// ---------------------------------------------------------------------------

test('escapeMarkdown neutralises emphasis markers', () => {
  assert.equal(escapeMarkdown('*x*'), '\\*x\\*');
});

test('escapeMarkdown neutralises a link-shaped string', () => {
  assert.equal(escapeMarkdown('[a](b)'), '\\[a\\]\\(b\\)');
});

test('escapeMarkdown neutralises a backtick', () => {
  assert.equal(escapeMarkdown('a`b'), 'a\\`b');
});

test('escapeMarkdown neutralises an <img>-looking name', () => {
  // Escaping precedes each special character with a backslash rather than
  // removing it, so "<img" is still there as text - CommonMark just stops
  // reading "<" as the start of an HTML tag once it is "\<".
  const escaped = escapeMarkdown('<img src=x onerror=alert(1)>');
  assert.equal(escaped, '\\<img src=x onerror=alert\\(1\\)\\>');
});

test('escapeMarkdown leaves text with no special characters alone', () => {
  assert.equal(escapeMarkdown('plainName123'), 'plainName123');
});

// ---------------------------------------------------------------------------
// trustCommandUri - the command-URI convention from Task 5b's brief: exactly
// `command:<id>?<encodeURIComponent(JSON.stringify([cwd]))>`.
// ---------------------------------------------------------------------------

test('trustCommandUri targets the Task 5a command with the cwd as its sole argument', () => {
  const uri = trustCommandUri('/projects/example');
  assert.equal(uri, `command:claudeLimitBuster.openClaudeToTrust?${encodeURIComponent(JSON.stringify(['/projects/example']))}`);
  const query = uri.slice(uri.indexOf('?') + 1);
  assert.deepEqual(JSON.parse(decodeURIComponent(query)), ['/projects/example']);
});

test('trustCommandUri encodes a Windows path with a backslash, a space and a #', () => {
  const cwd = 'C:\\Users\\a b\\proj#1';
  const uri = trustCommandUri(cwd);
  const query = uri.slice(uri.indexOf('?') + 1);
  // None of these may appear raw in the query: a raw '#' would be read as a
  // URI fragment (or end the Markdown link early), a raw space would break
  // the query, and a raw backslash is meaningless in a URI.
  assert.ok(!query.includes('#'), query);
  assert.ok(!query.includes(' '), query);
  assert.ok(!query.includes('\\'), query);
  assert.deepEqual(JSON.parse(decodeURIComponent(query)), [cwd], 'must decode back to the exact cwd');
});

// ---------------------------------------------------------------------------
// buildSessionLines - the pure line-builder behind the tooltip. One line per
// session: pending/ready first (soonest first), gave-up-only sessions after.
// ---------------------------------------------------------------------------

const gaveUpRec = (over: Partial<import('../src/gaveUp').GaveUpRecord> = {}) => ({
  sessionId: job().sessionId,
  cwd: '/projects/example',
  cause: 'stall' as const,
  atMs: Date.now(),
  ...over,
});

test('a counting-down job renders its id, folder and formatted resume time', () => {
  const at = Date.now() + 90_000;
  const { lines, waitingCount } = buildSessionLines([job({ resumeAtMs: at })], [], []);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes('0b3d1f66'), lines[0]);
  assert.ok(lines[0]!.includes('example'), lines[0]);
  assert.ok(lines[0]!.includes(new Date(at).toLocaleString()), lines[0]);
  assert.ok(!/ready/i.test(lines[0]!), lines[0]);
  assert.equal(waitingCount, 1);
});

test('a ready job says "ready", not a time', () => {
  const { lines } = buildSessionLines([], [job()], []);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /ready/i);
  assert.ok(!lines[0]!.includes(new Date(job().resumeAtMs).toLocaleString().slice(0, 4)), lines[0]);
});

test('ordering: a ready job (already elapsed) sorts before one still counting down', () => {
  const ready = job({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', cwd: '/p/ready', resumeAtMs: Date.now() - 5000 });
  const counting = job({ sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', cwd: '/p/counting', resumeAtMs: Date.now() + 90_000 });
  const { lines } = buildSessionLines([counting], [ready], []);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes('aaaaaaaa'), lines[0]);
  assert.ok(lines[1]!.includes('bbbbbbbb'), lines[1]);
});

test('ordering: two counting-down jobs sort soonest first regardless of input order', () => {
  const soon = job({ sessionId: 'cccccccc-0000-0000-0000-000000000000', resumeAtMs: Date.now() + 10_000 });
  const later = job({ sessionId: 'dddddddd-0000-0000-0000-000000000000', resumeAtMs: Date.now() + 90_000 });
  const { lines } = buildSessionLines([later, soon], [], []);
  assert.ok(lines[0]!.includes('cccccccc'), lines[0]);
  assert.ok(lines[1]!.includes('dddddddd'), lines[1]);
});

test('gave-up-only sessions come after every pending/ready line', () => {
  const { lines } = buildSessionLines([job()], [], [gaveUpRec({ sessionId: 'ffffffff-0000-0000-0000-000000000000', cause: 'cwd' })]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes('0b3d1f66'), lines[0]);
  assert.ok(lines[1]!.includes('ffffffff'), lines[1]);
});

test('a session that only gave up gets a line with its cause, and no resuming/ready wording', () => {
  const { lines, waitingCount } = buildSessionLines([], [], [gaveUpRec({ cause: 'launcher' })]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /claude executable/);
  assert.ok(!/ready/i.test(lines[0]!), lines[0]);
  assert.equal(waitingCount, 0, 'a gave-up-only session is not "waiting"');
});

test('both pending and gave up: a counting-down job with a matching gave-up record is ONE line with both', () => {
  const { lines } = buildSessionLines([job()], [], [gaveUpRec({ cause: 'stall' })]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /resum/i);
  assert.match(lines[0]!, /stall/i);
});

test('both ready and gave up: a ready job with a matching gave-up record is ONE line with both', () => {
  const { lines, waitingCount } = buildSessionLines([], [job()], [gaveUpRec({ cause: 'launcher' })]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /ready/i);
  assert.match(lines[0]!, /claude executable/i);
  assert.equal(waitingCount, 1, 'still one waiting session, not two');
});

test('the folder is escaped before it reaches the line', () => {
  const { lines } = buildSessionLines([job({ cwd: '/projects/*x*' })], [], []);
  assert.ok(lines[0]!.includes('\\*x\\*'), lines[0]);
  assert.ok(!lines[0]!.includes('*x*'), lines[0]);
});

test('an untrusted job gets a warning marker and a trust link, and reports hasTrustLink', () => {
  const { lines, hasTrustLink } = buildSessionLines([job({ folderTrusted: false, cwd: '/projects/example' })], [], []);
  assert.match(lines[0]!, /not trusted/i);
  assert.ok(lines[0]!.includes('command:claudeLimitBuster.openClaudeToTrust'), lines[0]);
  assert.ok(hasTrustLink);
});

test('a trusted or unknown-trust job gets no marker, and hasTrustLink stays false', () => {
  const trusted = buildSessionLines([job({ folderTrusted: true })], [], []);
  assert.ok(!/not trusted/i.test(trusted.lines[0]!), trusted.lines[0]);
  assert.ok(!trusted.hasTrustLink);

  const unknown = buildSessionLines([job({ folderTrusted: undefined })], [], []);
  assert.ok(!/not trusted/i.test(unknown.lines[0]!), unknown.lines[0]);
  assert.ok(!unknown.hasTrustLink);
});

test('waitingCount counts a session once even if it were somehow in both lists', () => {
  const same = job();
  const { waitingCount } = buildSessionLines([same], [same], []);
  assert.equal(waitingCount, 1);
});

test('a session in both jobs and ready keeps its counting-down line, not "ready" (Task 4b fix round 1, finding 1)', () => {
  // One session can genuinely hold a counting-down job and an unrelated
  // stale ready job at once. `ready` must defer to `jobs` for that session,
  // not silently overwrite the soon-to-happen countdown with "ready".
  const at = Date.now() + 45_000;
  const counting = job({ resumeAtMs: at });
  const staleReady = job({ resumeAtMs: Date.now() - 99_000 });
  const { lines, waitingCount } = buildSessionLines([counting], [staleReady], []);
  assert.equal(lines.length, 1, 'one line per session, even here');
  assert.match(lines[0]!, /resum/i, lines[0]);
  assert.ok(!/ready/i.test(lines[0]!), `must not read as ready: ${lines[0]}`);
  assert.equal(waitingCount, 1);
});

// ---------------------------------------------------------------------------
// CountdownStatusBar.update - end to end through the fake vscode item.
// ---------------------------------------------------------------------------

test('the tooltip warns when the folder is not trusted for the CLI, and marks the string trusted for the link only', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update([job({ folderTrusted: false })]);
    assert.match(tooltipText(), /not trusted/i, `expected an untrusted-folder note; got ${JSON.stringify(tooltipText())}`);
    const tooltip = vscodeFake.statusBarItems[0]?.tooltip as { isTrusted?: unknown } | undefined;
    assert.deepEqual(tooltip?.isTrusted, { enabledCommands: ['claudeLimitBuster.openClaudeToTrust'] });
  } finally {
    bar.dispose();
  }
});

test('the tooltip says nothing about trust when the folder is trusted, and isTrusted is not set', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update([job({ folderTrusted: true })]);
    assert.doesNotMatch(tooltipText(), /not trusted/i);
    const tooltip = vscodeFake.statusBarItems[0]?.tooltip as { isTrusted?: unknown } | undefined;
    assert.equal(tooltip?.isTrusted, undefined, 'isTrusted must stay unset with no link in the tooltip');
  } finally {
    bar.dispose();
  }
});

test('the tooltip says nothing about trust when trust is unknown', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update([job({ folderTrusted: undefined })]);
    assert.doesNotMatch(tooltipText(), /not trusted/i);
  } finally {
    bar.dispose();
  }
});

test('the pill says how many sessions are waiting when there is more than one', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update([job(), job({ sessionId: '7f2a9c41-8b3d-4e5f-9a01-6c7d8e9f0a1b' })]);
    assert.match(vscodeFake.statusBarItems[0]?.text ?? '', /2 sessions/);
  } finally {
    bar.dispose();
  }
});

test('a counting-down job and a ready job together still count as 2 sessions on the pill', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update([job()], [job({ sessionId: '7f2a9c41-8b3d-4e5f-9a01-6c7d8e9f0a1b' })]);
    assert.match(vscodeFake.statusBarItems[0]?.text ?? '', /2 sessions/);
  } finally {
    bar.dispose();
  }
});

test('the pill does not mention a count for a single session', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  try {
    bar.update([job()]);
    assert.doesNotMatch(vscodeFake.statusBarItems[0]?.text ?? '', /sessions/);
  } finally {
    bar.dispose();
  }
});

// ---------------------------------------------------------------------------
// Idle presence.
// ---------------------------------------------------------------------------

test('with nothing pending the item still shows a marker', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [], 'always');
  const item = vscodeFake.statusBarItems[0];
  assert.ok(item?.visible, 'the item must be visible when idle');
  assert.match(item.text, /\$\(.+\)/, 'an icon, so it reads as a marker rather than a label');
  assert.ok(!/resumes in/.test(item.text), 'and no countdown, because nothing is counting down');
});

test('the idle tooltip says it is watching and nothing is pending', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [], 'always');
  assert.match(tooltipText(), /watching/i);
  assert.match(tooltipText(), /nothing pending/i);
});

test('statusBar "pending" keeps the item hidden until there is a countdown', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [], 'pending');
  assert.equal(vscodeFake.statusBarItems[0]?.visible, false);
  bar.update([job()], [], 'pending');
  assert.equal(vscodeFake.statusBarItems[0]?.visible, true);
});

test('statusBar "never" hides the item even while a resume is counting down', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([job()], [], 'never');
  assert.equal(vscodeFake.statusBarItems[0]?.visible, false);
});

test('a pending job still shows the countdown, not the idle marker', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([job()], [], 'always');
  const item = vscodeFake.statusBarItems[0];
  assert.match(item!.text, /resumes in/);
});

test('clicking opens the menu rather than cancelling outright', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([job()], [], 'always');
  assert.equal(vscodeFake.statusBarItems[0]?.command, 'claudeLimitBuster.statusBarMenu');
});

test('the tooltip no longer promises that clicking cancels', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([job()], [], 'always');
  assert.ok(!/click to cancel/i.test(tooltipText()), tooltipText());
});

// ---------------------------------------------------------------------------
// Sessions waiting to be started by hand (Task 5b): nothing counting down,
// but a session is ready. It must not read as idle.
// ---------------------------------------------------------------------------

test('with nothing counting down but a session ready, the item is not the idle eye', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [job()], 'always');
  const item = vscodeFake.statusBarItems[0];
  assert.ok(item?.visible);
  assert.ok(!item.text.includes('$(eye)'), `must not read as idle; got ${item.text}`);
  assert.match(item.text, /ready to resume/i, item.text);
  assert.doesNotMatch(tooltipText(), /nothing pending/i);
  assert.match(tooltipText(), /ready/i);
  assert.ok(tooltipText().includes('0b3d1f66'), tooltipText());
});

test('the ready pill counts sessions when more than one is ready', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [job(), job({ sessionId: '7f2a9c41-8b3d-4e5f-9a01-6c7d8e9f0a1b' })], 'always');
  assert.match(vscodeFake.statusBarItems[0]?.text ?? '', /2 sessions/);
});

test('statusBar "pending" still shows a ready-only session: it is not idle', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [job()], 'pending');
  assert.equal(vscodeFake.statusBarItems[0]?.visible, true);
});

// ---------------------------------------------------------------------------
// The gave-up state (Task 4b/5b). A session this extension has stopped
// retrying must not leave the item looking idle: it gets its own icon, and
// the unified tooltip names each such session and why.
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
  bar.update([], [], 'always', [gaveUp()]);
  const item = vscodeFake.statusBarItems[0];
  assert.ok(item?.visible);
  assert.ok(item.text.startsWith(GAVE_UP_ICON), `expected the gave-up icon; got ${item.text}`);
  assert.ok(!item.text.includes('$(eye)'), 'it must not read as idle');
});

test('the gave-up tooltip names each session, its folder basename and its cause', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [], 'always', [
    gaveUp({ cause: 'cwd' }),
    gaveUp({ sessionId: OTHER, cwd: '/projects/other', cause: 'launcher' }),
  ]);
  const text = tooltipText();
  assert.ok(text.includes('0b3d1f66') && text.includes('7f2a9c41'), text);
  assert.ok(text.includes('example') && text.includes('other'), text);
  assert.match(text, /no longer exists/);
  assert.match(text, /claude executable/);
  assert.doesNotMatch(text, /nothing pending/i, 'something did happen');
  assert.match(text, /Cancel/, 'the tooltip says how to clear it');
});

test('the gave-up text counts sessions when more than one gave up', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [], 'always', [gaveUp(), gaveUp({ sessionId: OTHER })]);
  assert.match(vscodeFake.statusBarItems[0]?.text ?? '', /2 sessions/);
  bar.update([], [], 'always', [gaveUp()]);
  assert.doesNotMatch(vscodeFake.statusBarItems[0]?.text ?? '', /sessions/);
});

test('statusBar "pending" still shows a gave-up session: it is not idle', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [], 'pending', [gaveUp()]);
  assert.equal(vscodeFake.statusBarItems[0]?.visible, true);
});

test('statusBar "never" hides the gave-up state too', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [], 'never', [gaveUp()]);
  assert.equal(vscodeFake.statusBarItems[0]?.visible, false);
});

test('a pending countdown still wins the text, and the tooltip still mentions the gave-up session', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([job({ sessionId: OTHER })], [], 'always', [gaveUp({ cause: 'budget' })]);
  const item = vscodeFake.statusBarItems[0];
  assert.match(item!.text, /resumes in/);
  assert.ok(!item!.text.includes(GAVE_UP_ICON));
  assert.ok(tooltipText().includes('0b3d1f66'), tooltipText());
  assert.match(tooltipText(), /budget/);
});

test('no gave-up section when nothing gave up', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([job()], [], 'always', []);
  assert.doesNotMatch(tooltipText(), /gave up/i);
  assert.doesNotMatch(tooltipText(), /Cancel Pending Resume/, 'no reminder with nothing to clear');
  bar.update([], [], 'always', []);
  assert.doesNotMatch(tooltipText(), /gave up/i);
  assert.ok(vscodeFake.statusBarItems[0]?.text.includes('$(eye)'));
});

test('a session both ready and given up (a launcher/cwd failure) is one line, shown with the gave-up icon', () => {
  resetVscodeFake();
  const bar = new CountdownStatusBar();
  bar.update([], [job()], 'always', [gaveUp({ cause: 'launcher' })]);
  const item = vscodeFake.statusBarItems[0];
  assert.ok(item?.text.startsWith(GAVE_UP_ICON));
  const text = tooltipText();
  assert.match(text, /ready/i);
  assert.match(text, /claude executable/i);
  // One line, not two: the session's short id must appear exactly once.
  assert.equal(text.split('0b3d1f66').length - 1, 1, text);
});
