import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { continuedSince, MAX_CONTINUED_READ_BYTES } from '../src/continuedSince';

/**
 * Final fix wave A, A3 (final review I1, M5, M7): has the session moved on
 * since its stop was detected? Real files in a throwaway directory, written
 * the way Claude Code writes a transcript: one JSON object per line.
 */

const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';

/** The flagged synthetic entry Claude Code writes for a usage limit. */
const LIMIT_ENTRY = line({
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'rate_limit',
  apiErrorStatus: 429,
  message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 2:10am" }] },
});

/** Every temp directory this file made, removed when it is done (review m5). */
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A transcript holding some history and the limit entry; returns its path and the size at "detection". */
function transcriptAtDetection(): { file: string; baseline: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-continued-'));
  dirs.push(dir);
  const file = path.join(dir, '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl');
  fs.writeFileSync(
    file,
    line({ type: 'user', message: { role: 'user', content: 'refactor the parser' } }) +
      line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'On it.' }] } }) +
      LIMIT_ENTRY,
  );
  return { file, baseline: fs.statSync(file).size };
}

test('a real user entry appended since detection means the session continued', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, line({ type: 'user', message: { role: 'user', content: 'ok, carry on' } }));
  assert.equal(continuedSince(file, baseline), true);
});

test('a real assistant entry appended since detection means the session continued', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(
    file,
    line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Resuming.' }] } }),
  );
  assert.equal(continuedSince(file, baseline), true);
});

test('only a flagged synthetic error entry appended is not a continuation (a second limit notice)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, LIMIT_ENTRY);
  assert.equal(continuedSince(file, baseline), false);
});

test('an unflagged <synthetic> assistant entry ("No response requested.") is not a continuation', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(
    file,
    line({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
  );
  assert.equal(continuedSince(file, baseline), false);
});

test('a flagged entry typed "user" is not a continuation either', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, line({ type: 'user', isApiErrorMessage: true, message: { content: 'API Error: 529 Overloaded' } }));
  assert.equal(continuedSince(file, baseline), false);
});

test('only system or other non-user/assistant entries appended is not a continuation', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(
    file,
    line({ type: 'system', subtype: 'stop_hook_summary', content: 'Stop hook ran' }) +
      line({ type: 'summary', summary: 'Parser refactor' }) +
      line({ type: 'file-history-snapshot', snapshot: {} }),
  );
  assert.equal(continuedSince(file, baseline), false);
});

test('unparseable and partial lines are ignored', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, 'not json at all\n{"type":"user","message":{"content":"half writ');
  assert.equal(continuedSince(file, baseline), false);
});

test('a continuation after ignored lines is still found', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, 'garbage\n' + line({ type: 'system', content: 'x' }) + line({ type: 'user', message: { content: 'go' } }));
  assert.equal(continuedSince(file, baseline), true);
});

test('history before the baseline never counts', () => {
  const { file, baseline } = transcriptAtDetection();
  assert.equal(continuedSince(file, baseline), false, 'nothing appended');
});

test('no baseline (a job from an older build) is not a continuation: the resume fires as before', () => {
  const { file } = transcriptAtDetection();
  fs.appendFileSync(file, line({ type: 'user', message: { content: 'ok, carry on' } }));
  assert.equal(continuedSince(file, undefined), false);
});

test('an unreadable transcript is not a continuation: fail open', () => {
  assert.equal(continuedSince(path.join(os.tmpdir(), 'clb-continued-missing', 'nope.jsonl'), 100), false);
});

test('a transcript now shorter than its baseline (replaced) is not a continuation', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'new file' } }));
  assert.equal(continuedSince(file, baseline), false);
});

// ---------------------------------------------------------------------------
// Wave A fix round 1 (review C1): the question is whether the session is PAST
// its stop, not whether anything happened. The sequences below are the real
// ones the review found in ~/.claude/projects: 43 "limit, prompt, the same
// limit again" cases, and background-task notifications that start a turn
// which hits the limit again. Each of those must still be resumed.
// ---------------------------------------------------------------------------

/** A prompt from the panel or a Remote Control retry. */
const SDK_PROMPT = line({ type: 'user', promptSource: 'sdk', message: { role: 'user', content: 'try again' } });
/** A background task finishing: Claude Code starts a turn for it. */
const TASK_NOTIFICATION = line({
  type: 'user',
  promptSource: 'system',
  message: { role: 'user', content: '<task-notification>Agent "review" completed</task-notification>' },
});
/** Claude Code's own native auto-continue prompt. */
const NATIVE_CONTINUE = line({
  type: 'user',
  isMeta: true,
  message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] },
});
const REAL_TURN = line({
  type: 'assistant',
  message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Picking up where I stopped.' }] },
});

test('a hand retry that hit the same limit again is not past its stop (C1)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, SDK_PROMPT + LIMIT_ENTRY);
  assert.equal(continuedSince(file, baseline), false);
});

test('a task notification whose turn hit the limit again is not past its stop (C1)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, TASK_NOTIFICATION + LIMIT_ENTRY);
  assert.equal(continuedSince(file, baseline), false);
});

test('a Remote Control continue answered by a real turn is past its stop (C1)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, SDK_PROMPT + REAL_TURN);
  assert.equal(continuedSince(file, baseline), true);
});

test('the native "Continue from where you left off." answered by a real turn is past its stop (C1)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, NATIVE_CONTINUE + REAL_TURN);
  assert.equal(continuedSince(file, baseline), true);
});

test('the native isMeta continue on its own, its turn still running, already counts (I1: isMeta is not skipped)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, NATIVE_CONTINUE);
  assert.equal(continuedSince(file, baseline), true);
});

test('stopped again, then continued for real after that, is past its stop (C1)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, SDK_PROMPT + LIMIT_ENTRY + SDK_PROMPT + REAL_TURN);
  assert.equal(continuedSince(file, baseline), true);
});

test('the last entry decides, so the tail is read, not the head (C1)', () => {
  // A real turn right after the stop, then more than the read cap of other
  // entries, then the session stopping again: only a tail read sees the stop.
  const { file, baseline } = transcriptAtDetection();
  const filler = line({ type: 'system', subtype: 'informational', content: 'x'.repeat(1000) });
  fs.appendFileSync(file, SDK_PROMPT + filler.repeat(Math.ceil(MAX_CONTINUED_READ_BYTES / filler.length) + 10) + LIMIT_ENTRY);
  assert.equal(continuedSince(file, baseline), false);
});

// Review I1: a local slash command after a limit (/usage, /status, /model -
// the natural way to check when it resets) makes no API call and is not the
// session moving on. The native auto-continue's isMeta prompt above still is.
test('local slash-command entries after a limit are not a continuation (I1)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(
    file,
    line({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>' },
    }) +
      line({
        type: 'user',
        message: { role: 'user', content: '<command-name>/usage</command-name>\n            <command-message>usage</command-message>\n            <command-args></command-args>' },
      }) +
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<local-command-stdout>Session: 100% used</local-command-stdout>' }] } }),
  );
  assert.equal(continuedSince(file, baseline), false);
});
