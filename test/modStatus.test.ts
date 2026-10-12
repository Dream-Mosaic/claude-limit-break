import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  MOD_PROTOCOL, CONTROL_TTL_MS, limitBreakDir, statusFile, controlFile, parseModStatus, modUsable,
  continuedJob, buildControlBody, controlFileText,
} from '../src/modStatus';
import { buildEnvelope } from '../src/inbox';

const mod = require(path.join(__dirname, '..', '..', 'mod', 'hooks', 'control.mjs')) as {
  parseControl(t: string): { kind: string; jobId?: string; nonce?: string; };
  acceptControl(c: { jobId: string; nonce: string }, f: string | undefined, s: { continued: { jobId: string }[] }, now: number): { ok: boolean; prompt?: string };
  CONTROL_MARKER: string; PROTOCOL: number;
};

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ protocol: 1, modVersion: '1.1.0', sessionId: SID, loadedAtMs: 5_000, continued: [], ...over });

test('the extension and the mod agree on the protocol', () => {
  assert.equal(MOD_PROTOCOL, mod.PROTOCOL);
  assert.equal(buildControlBody('j', 'n').startsWith(mod.CONTROL_MARKER), true);
});

test('a control body the extension builds is one the mod parses and accepts', () => {
  const text = buildEnvelope(buildControlBody('job-1', 'nonce-1'));
  const parsed = mod.parseControl(text);
  assert.deepEqual(parsed, { kind: 'control', jobId: 'job-1', nonce: 'nonce-1' });
  assert.deepEqual(mod.acceptControl({ jobId: 'job-1', nonce: 'nonce-1' }, controlFileText('job-1', 'nonce-1', 1_000, '[Limit Break] continue'), { continued: [] }, 1_000 + CONTROL_TTL_MS - 1), { ok: true, prompt: '[Limit Break] continue' });
  assert.equal(mod.acceptControl({ jobId: 'job-1', nonce: 'nonce-1' }, controlFileText('job-1', 'nonce-1', 1_000, 'p'), { continued: [] }, 1_000 + CONTROL_TTL_MS).ok, false);
});

test('paths', () => {
  assert.equal(limitBreakDir('/home/u'), path.join('/home/u', '.limit-break'));
  assert.equal(statusFile('/d', SID), path.join('/d', 'sessions', `${SID}.json`));
  assert.equal(controlFile('/d', SID), path.join('/d', 'control', `${SID}.json`));
});

test('a status file parses, and a truncated or foreign one does not', () => {
  assert.equal(parseModStatus(status())?.sessionId, SID);
  assert.equal(parseModStatus(status().slice(0, 30)), undefined, 'a half-written file is "not yet"');
  assert.equal(parseModStatus('[]'), undefined);
  assert.equal(parseModStatus(JSON.stringify({ protocol: 1, sessionId: SID })), undefined, 'no loadedAtMs or continued');
});

test('the mod is used only for this session, this protocol, and this process', () => {
  const s = parseModStatus(status())!;
  assert.equal(modUsable(s, SID, 4_000), true, 'loaded after the process started');
  assert.equal(modUsable(s, SID, 5_000), true, 'loaded in the same millisecond');
  assert.equal(modUsable(s, SID, 6_000), false, 'a file from an earlier process');
  assert.equal(modUsable(s, SID, undefined), false, 'cannot tell which process wrote it');
  assert.equal(modUsable(s, 'other', 4_000), false);
  assert.equal(modUsable(parseModStatus(status({ protocol: 2 })), SID, 4_000), false);
  assert.equal(modUsable(parseModStatus(status({ movedTo: 'x' })), SID, 4_000), false);
  assert.equal(modUsable(undefined, SID, 4_000), false);
});

test('a malformed nativeContinue or continued entry is dropped, not trusted', () => {
  const good = { type: 'quota_auto_resume', atMs: 7 };
  assert.deepEqual(parseModStatus(status({ nativeContinue: good }))?.nativeContinue, good);
  for (const bad of [{ type: 'x', atMs: 'soon' }, { type: 'x' }, { atMs: 7 }, { type: 4, atMs: 7 }, { type: 'x', atMs: null }, 'x']) {
    assert.equal(parseModStatus(status({ nativeContinue: bad }))?.nativeContinue, undefined, JSON.stringify(bad));
  }
  const kept = parseModStatus(status({ continued: [{ jobId: 'a', atMs: 1 }, { jobId: 'b' }, { jobId: 'c', atMs: 'x' }, { atMs: 2 }, 'd'] }));
  assert.deepEqual(kept?.continued, [{ jobId: 'a', atMs: 1 }]);
});

test('a job counts as continued once the mod lists it', () => {
  assert.equal(continuedJob(parseModStatus(status({ continued: [{ jobId: 'j', atMs: 1 }] })), 'j'), true);
  assert.equal(continuedJob(parseModStatus(status()), 'j'), false);
  assert.equal(continuedJob(undefined, 'j'), false);
});
