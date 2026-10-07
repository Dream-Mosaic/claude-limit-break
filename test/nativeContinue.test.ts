import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyNativeStatus, standDownReason, lastNativeCancel, STAND_DOWN_LABEL } from '../src/nativeContinue';

/**
 * Claude Code's native auto-continue status lines. ARMED and EXITED are real,
 * byte-exact; every other string here is DERIVED from the binary, not observed in a
 * real transcript. The test names say so where it matters.
 */

const ARMED = 'Usage limit reached · continuing automatically at 11:10am · esc or type to cancel';
const EXITED =
  'Automatic continue cancelled · Claude Code exited during the wait, so the task will not resume on its own when the usage limit resets (send a prompt after the reset to continue)';
const DESKTOP =
  'Automatic continue cancelled · this session moved to Claude Desktop, so the task will not resume on its own when the usage limit resets (continue it there)';
const BACKGROUND =
  'Automatic continue cancelled · this session moved to the background, so the task will not resume on its own when the usage limit resets';
const RELAUNCH =
  'Automatic continue cancelled · Claude Code relaunched during the wait, so the task will not resume on its own when the usage limit resets (send a prompt then to continue)';
const CLOUD =
  'Automatic continue cancelled · sending this session to the cloud, so the task will not resume here on its own when the usage limit resets (continue it in the cloud session)';
const ESC = 'Automatic continue cancelled · /rate-limit-options to re-arm';
/** The /rate-limit-options "Don't continue automatically" sentence, bare. */
const WAIT = 'Automatic continue cancelled. Your session will wait for you instead; /rate-limit-options can arm it again.';
/** ...and the user entry it is written as (derived from code; no real sample). */
const waitEntry = (over: Record<string, unknown> = {}) => ({
  parentUuid: '966972dc-f14b-4f93-a0a0-75b00c0410f2',
  type: 'user',
  message: { role: 'user', content: `<local-command-stdout>${WAIT}</local-command-stdout>` },
  uuid: 'b133b426-bcef-4fd3-9953-0b9a7cebb303',
  timestamp: '2026-09-23T11:58:49.136Z',
  userType: 'external',
  sessionId: 'fd493448-9183-45bd-865d-ea2ccb227021',
  ...over,
});

const info = (content: unknown, over: Record<string, unknown> = {}) => ({
  parentUuid: '966972dc-f14b-4f93-a0a0-75b00c0410f2',
  isSidechain: false,
  type: 'system',
  subtype: 'informational',
  content,
  isMeta: false,
  timestamp: '2026-09-23T11:58:48.136Z',
  uuid: 'a033b426-bcef-4fd3-9953-0b9a7cebb303',
  level: 'notice',
  userType: 'external',
  entrypoint: 'cli',
  cwd: 'C:/Users/thegr/Dream-Mosaic/Projects/limit-break',
  sessionId: 'fd493448-9183-45bd-865d-ea2ccb227021',
  version: '2.1.278',
  ...over,
});

// --- recognition by type, subtype and prefix -----------------------------

test('the real armed line is recognised as armed', () => {
  assert.deepEqual(classifyNativeStatus(info(ARMED)), { kind: 'armed', text: ARMED });
});

test('the "reached again" variant is armed too', () => {
  const again = 'Usage limit reached again · continuing automatically at 4:10pm · esc or type to cancel';
  assert.equal(classifyNativeStatus(info(again))?.kind, 'armed');
});

test('the real cancel line is recognised as cancelled, whatever its reason', () => {
  for (const text of [EXITED, DESKTOP, CLOUD, BACKGROUND, RELAUNCH, ESC, 'Automatic continue cancelled']) {
    assert.deepEqual(classifyNativeStatus(info(text)), { kind: 'cancelled', text }, text);
  }
});

test('the other auto-continue lines are recognised as other, to be logged (derived from the 2.1.285 binary)', () => {
  for (const text of [
    'Usage limit available again · continuing now',
    'Usage limit has reset · press enter to continue',
    'Automatic continue was turned off · this task will not resume on its own',
    'Automatic continue stopped · the usage limit now resets more than 24 hours out, so this task will not resume on its own (/rate-limit-options to wait anyway)',
    'Automatic continue stopped after repeated usage-limit hits · this task will not resume on its own (/rate-limit-options to try again)',
    'Automatic continue did not run · the continuation was blocked before it reached the model, so this task did not resume on its own · send a prompt to continue',
  ]) {
    assert.deepEqual(classifyNativeStatus(info(text)), { kind: 'other', text }, text);
  }
  assert.equal(classifyNativeStatus(info('Note: Usage limit available again · continuing now')), undefined, 'prefix only');
});

test('the /rate-limit-options "Don\'t continue automatically" user entry is a cancel, tags stripped (derived from code)', () => {
  assert.deepEqual(classifyNativeStatus(waitEntry()), { kind: 'cancelled', text: WAIT });
  // As a first text block, the way a local command's output can be stored.
  const blocks = waitEntry({ message: { role: 'user', content: [{ type: 'text', text: `<local-command-stdout>${WAIT}</local-command-stdout>` }] } });
  assert.deepEqual(classifyNativeStatus(blocks), { kind: 'cancelled', text: WAIT });
});

test('that user entry must START with the stdout tag and the cancel sentence', () => {
  const bad = [
    WAIT, // no tag: a user typing it
    `Note: <local-command-stdout>${WAIT}</local-command-stdout>`,
    `<local-command-stderr>${WAIT}</local-command-stderr>`,
    `<local-command-stdout>Claude Code will continue automatically at 3:45pm.</local-command-stdout>`,
    `<local-command-stdout>/cd isn't available in this environment.</local-command-stdout>`,
  ];
  for (const content of bad) {
    assert.equal(classifyNativeStatus(waitEntry({ message: { role: 'user', content } })), undefined, content);
  }
  assert.equal(classifyNativeStatus(waitEntry({ message: { role: 'user', content: 7 } })), undefined, 'number content');
  assert.equal(classifyNativeStatus(waitEntry({ message: undefined })), undefined, 'no message');
  assert.equal(classifyNativeStatus(waitEntry({ type: 'assistant' })), undefined, 'not a user entry');
});

test('the fired line is recognised as fired', () => {
  const fired = 'Usage limit reset · continuing automatically';
  assert.deepEqual(classifyNativeStatus(info(fired)), { kind: 'fired', text: fired });
});

test('the text is never parsed: an armed line with no time is still armed', () => {
  assert.equal(classifyNativeStatus(info('Usage limit reached · continuing automatically'))?.kind, 'armed');
});

test('type, subtype and a string content are all required', () => {
  assert.equal(classifyNativeStatus(info(ARMED, { type: 'user' })), undefined, 'type');
  assert.equal(classifyNativeStatus(info(DESKTOP, { type: 'user' })), undefined, 'a system line typed user');
  assert.equal(classifyNativeStatus(info(ARMED, { type: 'assistant' })), undefined, 'assistant');
  assert.equal(classifyNativeStatus(info(ARMED, { subtype: 'local_command' })), undefined, 'subtype');
  assert.equal(classifyNativeStatus(info(ARMED, { subtype: undefined })), undefined, 'no subtype');
  assert.equal(classifyNativeStatus(info([{ type: 'text', text: ARMED }])), undefined, 'array content');
  assert.equal(classifyNativeStatus(info(7)), undefined, 'number content');
});

test('the prefix must START the content', () => {
  assert.equal(classifyNativeStatus(info('Note: ' + ARMED)), undefined);
  assert.equal(classifyNativeStatus(info('Note: ' + DESKTOP)), undefined);
  assert.equal(classifyNativeStatus(info('Note: Usage limit reset · continuing automatically')), undefined);
});

test('other informational lines and non-objects are not auto-continue status', () => {
  assert.equal(classifyNativeStatus(info('Usage limit reached')), undefined);
  assert.equal(classifyNativeStatus(info("You've hit your session limit · resets 8:30pm")), undefined);
  assert.equal(classifyNativeStatus(null), undefined);
  assert.equal(classifyNativeStatus('Automatic continue cancelled'), undefined);
  assert.equal(classifyNativeStatus([info(ARMED)]), undefined);
});

// --- which cancel reasons stand the extension down -----------------------

test('Desktop, cloud, background and the two Esc wordings each map to their reason', () => {
  assert.equal(standDownReason(DESKTOP), 'desktop');
  assert.equal(standDownReason(CLOUD), 'cloud');
  assert.equal(standDownReason(BACKGROUND), 'background');
  assert.equal(standDownReason(ESC), 'user');
  assert.equal(standDownReason(WAIT), 'user');
});

test('the cloud handoff is "sending this session to the cloud", not "moved to the cloud"', () => {
  assert.equal(standDownReason('Automatic continue cancelled · this session moved to the cloud, so ...'), undefined);
  assert.equal(standDownReason('Automatic continue cancelled · this session moved to Claude Code on the web'), undefined);
});

test('every other reason does not stand down: behaviour unchanged', () => {
  for (const text of [
    EXITED,
    RELAUNCH,
    'Automatic continue cancelled',
    'Automatic continue cancelled · ',
    'Automatic continue cancelled · something we have never seen',
  ]) {
    assert.equal(standDownReason(text), undefined, text);
  }
});

test('a reason must be at the start of the cancel text', () => {
  assert.equal(standDownReason('x ' + DESKTOP), undefined);
  assert.equal(standDownReason('Automatic continue cancelled · Claude Code exited; this session moved to Claude Desktop'), undefined);
  assert.equal(standDownReason('Automatic continue cancelled · note: /rate-limit-options to re-arm'), undefined);
  assert.equal(standDownReason('x ' + ESC), undefined);
  assert.equal(standDownReason('x ' + WAIT), undefined);
  assert.equal(standDownReason('x ' + CLOUD), undefined);
  assert.equal(standDownReason('x ' + BACKGROUND), undefined);
});

test('the notice labels read as the spec words them', () => {
  assert.equal(STAND_DOWN_LABEL.desktop, 'moved to Claude Desktop');
  assert.equal(STAND_DOWN_LABEL.cloud, 'moved to the cloud');
  assert.equal(STAND_DOWN_LABEL.background, 'moved to the background');
  assert.equal(STAND_DOWN_LABEL.user, 'set to wait by you');
});

// --- lastNativeCancel: the window from the detection baseline ----------------

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A transcript holding a limit entry; returns its path and the size at detection. */
function transcriptAtDetection(): { file: string; baseline: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-native-'));
  dirs.push(dir);
  const file = path.join(dir, '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl');
  fs.writeFileSync(
    file,
    line({ type: 'user', message: { role: 'user', content: 'refactor the parser' } }) +
      // An old cancel line from BEFORE the stop: history, never counted.
      line(info(DESKTOP)) +
      line({ type: 'assistant', isApiErrorMessage: true, message: { content: "You've hit your session limit · resets 2:10am" } }),
  );
  return { file, baseline: fs.statSync(file).size };
}

test('the last cancel line appended since detection is returned', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, line(info(ARMED)) + line(info(EXITED)) + line(info(ESC)));
  assert.equal(lastNativeCancel(file, baseline), ESC);
});

test('the /rate-limit-options user-entry cancel is found too, as its bare sentence', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, line(info(ARMED)) + line(waitEntry()));
  assert.equal(lastNativeCancel(file, baseline), WAIT);
});

test('the LAST decides: a Desktop cancel followed by another reason reads as the other reason', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, line(info(DESKTOP)) + line(info(EXITED)));
  assert.equal(lastNativeCancel(file, baseline), EXITED);
});

test('a cancel line from before the baseline never counts', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, line(info(ARMED)));
  assert.equal(lastNativeCancel(file, baseline), undefined);
});

test('no baseline, no growth, a missing file and a replaced (shorter) file all read as no cancel', () => {
  const { file, baseline } = transcriptAtDetection();
  assert.equal(lastNativeCancel(file, undefined), undefined, 'no baseline');
  assert.equal(lastNativeCancel(file, baseline), undefined, 'nothing appended');
  assert.equal(lastNativeCancel(path.join(os.tmpdir(), 'clb-native-missing', 'x.jsonl'), 10), undefined, 'missing');
  fs.writeFileSync(file, line(info(DESKTOP)));
  assert.equal(lastNativeCancel(file, baseline), undefined, 'shorter than baseline');
});

test('only a genuine system/informational entry counts: a quoted cancel line in a prompt or tool result does not', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(
    file,
    line({ type: 'user', message: { role: 'user', content: DESKTOP } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: DESKTOP }] } }) +
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: DESKTOP }] } }) +
      line(info(DESKTOP, { subtype: 'local_command' })),
  );
  assert.equal(lastNativeCancel(file, baseline), undefined);
});

test('unparseable and partial lines are skipped', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, 'garbage\n' + line(info(DESKTOP)) + '{"type":"system","subtype":"informational","content":"Automatic con');
  assert.equal(lastNativeCancel(file, baseline), DESKTOP);
});

test('a content block that is not a text block is not a cancel, even with the right text field', () => {
  const content = [{ type: 'tool_result', text: `<local-command-stdout>${WAIT}</local-command-stdout>` }];
  assert.equal(classifyNativeStatus(waitEntry({ message: { role: 'user', content } })), undefined);
});
