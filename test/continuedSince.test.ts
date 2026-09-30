import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { continuedSince } from '../src/continuedSince';

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

/** A transcript holding some history and the limit entry; returns its path and the size at "detection". */
function transcriptAtDetection(): { file: string; baseline: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-continued-'));
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
