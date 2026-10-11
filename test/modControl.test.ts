import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

interface Control {
  PROTOCOL: number; MOD_VERSION: string; CONTROL_MARKER: string;
  statusPath(home: string, sid: string): string;
  controlPath(home: string, sid: string): string;
  parseControl(text: string): { kind: 'none' } | { kind: 'invalid'; reason: string } | { kind: 'control'; jobId: string; nonce: string; prompt: string };
  acceptControl(c: { jobId: string; nonce: string }, file: string | undefined, status: { continued: { jobId: string }[] }, nowMs: number): { ok: true } | { ok: false; reason: string };
  initialStatus(fields: { sessionId: string; cwd: string; entrypoint?: string; loadedAtMs: number }, previous?: unknown): Record<string, unknown> & { continued: { jobId: string; atMs: number }[] };
  parseStatus(text: string): (Record<string, unknown> & { continued: { jobId: string; atMs: number }[] }) | undefined;
  withContinued(s: unknown, jobId: string, atMs: number): { continued: { jobId: string; atMs: number }[] };
  withRateLimits(s: unknown, rl: unknown[], atMs: number): Record<string, unknown>;
  movedTo(s: unknown, id: string): Record<string, unknown>;
}
const control = require(path.join(__dirname, '..', '..', 'mod', 'hooks', 'control.mjs')) as Control;

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const wrap = (body: string) => `<cross-session-message from="uds:limit-break" from-name="limit-break">\n${body}\n</cross-session-message>`;
const body = (o: unknown) => `${control.CONTROL_MARKER} ${JSON.stringify(o)}`;

test('paths sit under ~/.limit-break', () => {
  assert.equal(control.statusPath('C:/Users/u', SID), `C:/Users/u/.limit-break/sessions/${SID}.json`);
  assert.equal(control.controlPath('/home/u', SID), `/home/u/.limit-break/control/${SID}.json`);
});

test('a control message is found inside its envelope', () => {
  assert.deepEqual(control.parseControl(wrap(body({ jobId: 'j', nonce: 'n', prompt: 'p' }))), { kind: 'control', jobId: 'j', nonce: 'n', prompt: 'p' });
});

test('ordinary text is not a control message', () => {
  assert.deepEqual(control.parseControl(wrap('please continue')), { kind: 'none' });
});

test('a marker with a bad payload is invalid, never passed on as text', () => {
  assert.equal(control.parseControl(wrap(`${control.CONTROL_MARKER} {not json`)).kind, 'invalid');
  assert.equal(control.parseControl(wrap(body({ jobId: '', nonce: 'n', prompt: 'p' }))).kind, 'invalid');
  assert.equal(control.parseControl(wrap(body({ jobId: 'j', nonce: 'n' }))).kind, 'invalid');
});

const file = (entries: unknown[]) => JSON.stringify({ protocol: 1, entries });
const fresh = { continued: [] as { jobId: string }[] };

test('a control message is accepted only with a matching, unexpired, unused entry', () => {
  const c = { jobId: 'j', nonce: 'n' };
  assert.deepEqual(control.acceptControl(c, file([{ jobId: 'j', nonce: 'n', expiresAtMs: 2000 }]), fresh, 1000), { ok: true });
  assert.equal(control.acceptControl(c, file([{ jobId: 'j', nonce: 'other', expiresAtMs: 2000 }]), fresh, 1000).ok, false);
  assert.equal(control.acceptControl(c, file([{ jobId: 'j', nonce: 'n', expiresAtMs: 900 }]), fresh, 1000).ok, false);
  assert.equal(control.acceptControl(c, undefined, fresh, 1000).ok, false);
  assert.equal(control.acceptControl(c, '{', fresh, 1000).ok, false);
});

test('a job already continued is refused: a second control message is a replay', () => {
  const c = { jobId: 'j', nonce: 'n' };
  const status = { continued: [{ jobId: 'j' }] };
  assert.deepEqual(control.acceptControl(c, file([{ jobId: 'j', nonce: 'n', expiresAtMs: 2000 }]), status, 1000), { ok: false, reason: 'job j was already continued' });
});

test('the status carries continued jobs across a reload of the same session, and keeps 20', () => {
  let s = control.initialStatus({ sessionId: SID, cwd: '/w', entrypoint: 'claude-vscode', loadedAtMs: 1 });
  assert.equal(s.protocol, 1);
  for (let i = 0; i < 25; i += 1) s = control.withContinued(s, `j${i}`, i) as typeof s;
  assert.equal(s.continued.length, 20);
  assert.equal(s.continued[0]!.jobId, 'j5');
  const reloaded = control.initialStatus({ sessionId: SID, cwd: '/w', loadedAtMs: 99 }, control.parseStatus(JSON.stringify(s)));
  assert.equal(reloaded.continued.length, 20);
  assert.equal(reloaded.loadedAtMs, 99);
  const other = control.initialStatus({ sessionId: 'another', cwd: '/w', loadedAtMs: 99 }, s);
  assert.equal(other.continued.length, 0);
});

test('a truncated status file parses as nothing', () => {
  assert.equal(control.parseStatus('{"protocol":1,"sessionId":"x"'), undefined);
});
