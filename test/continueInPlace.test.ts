import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { continueInPlace, transcriptContains, CONFIRM_WINDOW_MS, type ContinueDeps } from '../src/continueInPlace';
import type { ModStatus } from '../src/modStatus';

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const JOB = { sessionId: SID, transcript: '/t.jsonl', prompt: '[Limit Break] continue', jobId: `${SID}-1000` };

function fakeDeps(over: Partial<ContinueDeps> = {}) {
  let clock = 0;
  let ids = 0;
  const sent: { socketPath: string; lines: readonly string[] }[] = [];
  const controls: string[] = [];
  const deps: ContinueDeps = {
    platform: 'win32',
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    newId: () => `id-${++ids}`,
    readHolderRecord: () => ({ sessionId: SID, startedAtMs: 100, messagingSocketPath: '\\\\.\\pipe\\x' }),
    readModStatus: () => undefined,
    peerToken: () => 'tok',
    writeControlFile: (_sid, text) => { controls.push(text); },
    send: async (socketPath, lines) => { sent.push({ socketPath, lines }); },
    transcriptBytes: () => 500,
    transcriptContains: () => false,
    continuedSince: () => false,
    ...over,
  };
  return { deps, sent, controls, advance: (ms: number) => { clock += ms; } };
}

test('socket: the enveloped prompt goes out after the auth line, and the msg_id in the transcript confirms it', async () => {
  let polls = 0;
  const { deps, sent } = fakeDeps({ transcriptContains: (_t, needle, from) => { assert.equal(from, 500); polls += 1; return needle === 'id-1' && polls >= 3; } });
  const out = await continueInPlace(JOB, 77, deps);
  assert.deepEqual(out, { kind: 'continued', transport: 'socket', elapsedMs: 2_000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.lines[0], '{"type":"auth","token":"tok"}\n');
  const payload = JSON.parse(sent[0]!.lines[1]!);
  assert.equal(payload.msg_id, 'id-1');
  assert.equal(payload.session_id, SID);
  assert.match(payload.message.content, /^<cross-session-message from="uds:limit-break" from-name="limit-break">\n\[Limit Break\] continue\n<\/cross-session-message>$/);
});

const usableStatus = (continued: { jobId: string; atMs: number }[] = []): ModStatus =>
  ({ protocol: 1, sessionId: SID, loadedAtMs: 200, continued });

test('mod: a control message goes out with a fresh nonce, and the mod listing the job confirms it', async () => {
  let reads = 0;
  const { deps, sent, controls } = fakeDeps({ readModStatus: () => (++reads >= 3 ? usableStatus([{ jobId: JOB.jobId, atMs: 1 }]) : usableStatus()) });
  const out = await continueInPlace(JOB, 77, deps);
  assert.equal(out.kind, 'continued');
  assert.equal(out.kind === 'continued' && out.transport, 'mod');
  const control = JSON.parse(controls[0]!);
  assert.equal(control.entries[0].jobId, JOB.jobId);
  assert.equal(control.entries[0].nonce, 'id-1');
  const payload = JSON.parse(sent[0]!.lines[1]!);
  assert.ok(payload.message.content.includes(`[limit-break-control v1] {"jobId":"${JOB.jobId}","nonce":"id-1","prompt":"[Limit Break] continue"}`));
});

test('a status file from an earlier process means the socket, never a control message', async () => {
  const { deps, controls } = fakeDeps({
    readModStatus: () => ({ ...usableStatus(), loadedAtMs: 50 }),
    transcriptContains: () => true,
  });
  const out = await continueInPlace(JOB, 77, deps);
  assert.equal(out.kind === 'continued' && out.transport, 'socket');
  assert.equal(controls.length, 0);
});

test('no record, a record for another session, or no inbox path: fall back at once', async () => {
  for (const rec of [undefined, { sessionId: 'other', messagingSocketPath: 'p' }, { sessionId: SID }]) {
    const { deps, sent } = fakeDeps({ readHolderRecord: () => rec });
    const out = await continueInPlace(JOB, 77, deps);
    assert.equal(out.kind, 'fallback');
    assert.equal(sent.length, 0);
  }
});

test('on Windows, no peer token: fall back at once (the pipe would close silently)', async () => {
  const { deps, sent } = fakeDeps({ peerToken: () => undefined });
  assert.deepEqual(await continueInPlace(JOB, 77, deps), { kind: 'fallback', reason: 'no inbox token for the holder' });
  assert.equal(sent.length, 0);
});

test('elsewhere, no token: send without an auth line', async () => {
  const { deps, sent } = fakeDeps({ platform: 'linux', peerToken: () => undefined, transcriptContains: () => true });
  await continueInPlace(JOB, 77, deps);
  assert.equal(sent[0]!.lines.length, 1);
});

test('a failed send falls back at once, without waiting out the window', async () => {
  let polls = 0;
  const { deps } = fakeDeps({
    send: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    transcriptContains: () => { polls += 1; return false; },
  });
  const started = Date.now();
  const out = await continueInPlace(JOB, 77, deps);
  assert.deepEqual(out, { kind: 'fallback', reason: 'send failed: ENOENT' });
  assert.ok(Date.now() - started < 1_000);
  assert.equal(polls, 0);
});

test('a rejection that may have written (no code, or ETIMEDOUT) is confirmed like a sent message', async () => {
  for (const err of [new Error('deadline'), Object.assign(new Error('late'), { code: 'ETIMEDOUT' })]) {
    let polls = 0;
    const { deps } = fakeDeps({
      send: async () => { throw err; },
      transcriptContains: () => ++polls >= 2,
    });
    const out = await continueInPlace(JOB, 77, deps);
    assert.equal(out.kind, 'continued');
  }
});

test('a rejection that may have written, seen only at the last look, is landed-late', async () => {
  const { deps } = fakeDeps({ send: async () => { throw new Error('deadline'); }, continuedSince: () => true });
  assert.deepEqual(await continueInPlace(JOB, 77, deps), { kind: 'landed-late', transport: 'socket' });
});

test('a throwing check counts as not seen and does not reject the continue', async () => {
  let polls = 0;
  const { deps } = fakeDeps({
    transcriptContains: () => { polls += 1; if (polls < 3) { throw new Error('EBUSY'); } return true; },
  });
  assert.equal((await continueInPlace(JOB, 77, deps)).kind, 'continued');
  const t = fakeDeps({ transcriptContains: () => { throw new Error('x'); }, continuedSince: () => { throw new Error('y'); } });
  assert.equal((await continueInPlace(JOB, 77, t.deps)).kind, 'fallback');
});

test('nothing within the window and no sign at the last look: fall back', async () => {
  const { deps } = fakeDeps();
  const out = await continueInPlace(JOB, 77, deps);
  assert.deepEqual(out, { kind: 'fallback', reason: `not confirmed within ${CONFIRM_WINDOW_MS / 1000} s` });
});

test('a turn since the send at the last look means it landed late: no launch', async () => {
  let checks = 0;
  const { deps } = fakeDeps({ continuedSince: (_t, bytes) => { assert.equal(bytes, 500); return ++checks >= 1; } });
  assert.deepEqual(await continueInPlace(JOB, 77, deps), { kind: 'landed-late', transport: 'socket' });
});

test('transcriptContains reads only from the given offset', () => {
  const file = path.join(os.tmpdir(), `lb-cip-${process.pid}.jsonl`);
  fs.writeFileSync(file, 'aaaa needle bbbb');
  try {
    assert.equal(transcriptContains(file, 'needle', 0, fs), true);
    assert.equal(transcriptContains(file, 'needle', 6, fs), false);
    assert.equal(transcriptContains(file, 'needle', 500, fs), true, 'a file shorter than the offset is scanned whole');
    assert.equal(transcriptContains(path.join(os.tmpdir(), 'missing-lb.jsonl'), 'x', 0, fs), false);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
