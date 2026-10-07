import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { continuedSince, MAX_CONTINUED_READ_BYTES } from '../src/continuedSince';

/**
 * Has the session moved on since its stop was detected? Real files in a throwaway
 * directory, written the way Claude Code writes a transcript: one JSON object per line.
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

/** Every temp directory this file made, removed when it is done. */
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

// The question is whether the session is PAST its stop, not whether anything
// happened: "limit, prompt, the same limit again" and background-task notifications
// that hit the limit again must still be resumed.

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

test('a hand retry that hit the same limit again is not past its stop', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, SDK_PROMPT + LIMIT_ENTRY);
  assert.equal(continuedSince(file, baseline), false);
});

test('a task notification whose turn hit the limit again is not past its stop', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, TASK_NOTIFICATION + LIMIT_ENTRY);
  assert.equal(continuedSince(file, baseline), false);
});

test('a Remote Control continue answered by a real turn is past its stop', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, SDK_PROMPT + REAL_TURN);
  assert.equal(continuedSince(file, baseline), true);
});

test('the native "Continue from where you left off." answered by a real turn is past its stop', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, NATIVE_CONTINUE + REAL_TURN);
  assert.equal(continuedSince(file, baseline), true);
});

test('the native isMeta continue on its own, its turn still running, already counts (isMeta is not skipped)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, NATIVE_CONTINUE);
  assert.equal(continuedSince(file, baseline), true);
});

test('stopped again, then continued for real after that, is past its stop', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, SDK_PROMPT + LIMIT_ENTRY + SDK_PROMPT + REAL_TURN);
  assert.equal(continuedSince(file, baseline), true);
});

test('the last entry decides, so the tail is read, not the head', () => {
  // A real turn right after the stop, then more than the read cap of other
  // entries, then the session stopping again: only a tail read sees the stop.
  const { file, baseline } = transcriptAtDetection();
  const filler = line({ type: 'system', subtype: 'informational', content: 'x'.repeat(1000) });
  fs.appendFileSync(file, SDK_PROMPT + filler.repeat(Math.ceil(MAX_CONTINUED_READ_BYTES / filler.length) + 10) + LIMIT_ENTRY);
  assert.equal(continuedSince(file, baseline), false);
});

// A local slash command after a limit (/usage, /status, /model) makes no API call
// and is not the session moving on. The native auto-continue's isMeta prompt above still is.
test('local slash-command entries after a limit are not a continuation', () => {
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

// The read window is the last 2 MB, so a LAST line longer than that leaves only a
// fragment. A real prompt can be that long (pasted images); a synthetic error entry
// never is. More than the cap of growth since the stop with nothing parseable in the
// window is a session that moved on.
test('a 2.1 MB real user line as the last line counts as continued', () => {
  const { file, baseline } = transcriptAtDetection();
  const huge = line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_100_000) }] },
  });
  assert.ok(huge.length > MAX_CONTINUED_READ_BYTES, 'setup: the line is longer than the read window');
  fs.appendFileSync(file, huge);
  assert.equal(continuedSince(file, baseline), true);
});

test('the same long line under the cap is read normally, and a flagged stop after it still wins (control)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(
    file,
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(1_000_000) }] } }) + LIMIT_ENTRY,
  );
  assert.equal(continuedSince(file, baseline), false, 'a retry that hit the limit again is still stopped');
});

test('a window that starts at the baseline and holds no parseable line is not continued (control)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, '{"type":"user","message":{"role":"us');
  assert.equal(continuedSince(file, baseline), false, 'a partial write, not news');
});

// A slash command that fails writes its output under <local-command-stderr> (a failed
// /compact is the case that matters). Like stdout it makes no API call past the stop,
// so it is not the session moving on.
test('a <local-command-stderr> user entry after the stop is not a continuation', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(
    file,
    line({
      type: 'user',
      message: {
        role: 'user',
        content: "<local-command-stderr>Error during compaction: You've hit your session limit · resets 8:30pm (America/Chicago)</local-command-stderr>",
      },
    }),
  );
  assert.equal(continuedSince(file, baseline), false);
});

test('the same stderr text as the first block of a content array is not a continuation either', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(
    file,
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<local-command-stderr>boom</local-command-stderr>' }] } }),
  );
  assert.equal(continuedSince(file, baseline), false);
});

test('stderr text that is not at the start of a user message is a real prompt (control)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, line({ type: 'user', message: { role: 'user', content: 'what does <local-command-stderr> mean?' } }));
  assert.equal(continuedSince(file, baseline), true);
});

// A SUCCESSFUL /compact after the reset means the session moved on: Claude Code
// writes a `compact_boundary` system entry, then a `user` entry with
// `isCompactSummary: true`. The `system` entry is neither a turn nor a stop; the summary
// is a real, unflagged user entry, so it counts. The sample follows a failed compaction
// (its logicalParentUuid is the failed entry's uuid).
const COMPACT_BOUNDARY = line({
  parentUuid: null,
  logicalParentUuid: 'e7466dc8-f37f-4842-b810-4b8381491b9a',
  isSidechain: false,
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  isMeta: false,
  timestamp: '2026-09-12T01:41:21.161Z',
  uuid: '6bde8c49-c5a8-4e90-8f61-2f17a21234b9',
  level: 'info',
  compactMetadata: { trigger: 'manual', preTokens: 370914, durationMs: 144227, postTokens: 13057 },
  userType: 'external',
  entrypoint: 'claude-vscode',
  sessionId: '05690955-d99d-46e1-bc06-109e58dadc2f',
  version: '2.1.267',
});
const COMPACT_SUMMARY = line({
  parentUuid: '6bde8c49-c5a8-4e90-8f61-2f17a21234b9',
  isSidechain: false,
  promptId: '5c03d38d-9760-4629-b1a0-5fdc113569d6',
  type: 'user',
  message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent: (trimmed)' },
  isVisibleInTranscriptOnly: true,
  isCompactSummary: true,
  uuid: '9c1aee65-2125-45ab-9bfd-4cb48593c2e0',
  timestamp: '2026-09-12T01:41:21.157Z',
  userType: 'external',
  entrypoint: 'claude-vscode',
  sessionId: '05690955-d99d-46e1-bc06-109e58dadc2f',
  version: '2.1.267',
});

test('a successful /compact after the stop counts as the session moving on', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, COMPACT_BOUNDARY + COMPACT_SUMMARY);
  assert.equal(continuedSince(file, baseline), true);
});

test('the compact_boundary entry on its own, before its summary is written, is not yet a continuation', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(file, COMPACT_BOUNDARY);
  assert.equal(continuedSince(file, baseline), false);
});

test('a compaction that failed on the limit again, then nothing, is still stopped (control)', () => {
  const { file, baseline } = transcriptAtDetection();
  fs.appendFileSync(
    file,
    line({
      type: 'system',
      subtype: 'local_command',
      content: "<local-command-stderr>Error during compaction: You've hit your session limit · resets 8:30pm (America/Chicago)</local-command-stderr>",
    }),
  );
  assert.equal(continuedSince(file, baseline), false);
});
