import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildEnvelope, buildPayload, inboxLines, findPeerToken, sendToInbox } from '../src/inbox';

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';

test('the envelope is the cross-session-message wrapper that names limit-break', () => {
  assert.equal(
    buildEnvelope('hello'),
    '<cross-session-message from="uds:limit-break" from-name="limit-break">\nhello\n</cross-session-message>',
  );
});

test('the payload has exactly the fields the inbox reads', () => {
  assert.deepEqual(buildPayload(SID, 'body', 'm-1'), {
    msgV: 1, msg_id: 'm-1', type: 'user', message: { role: 'user', content: 'body' }, priority: 'next', session_id: SID,
  });
});

test('the auth line goes first when there is a token, and every line ends in a newline', () => {
  const payload = buildPayload(SID, 'b', 'm');
  assert.deepEqual(inboxLines(payload, 'tok'), ['{"type":"auth","token":"tok"}\n', JSON.stringify(payload) + '\n']);
  assert.deepEqual(inboxLines(payload, undefined), [JSON.stringify(payload) + '\n']);
});

test('the peer token is read from the pid key file, and nothing else', () => {
  const files: Record<string, string> = {
    [path.join('/s', '123.abcd.key')]: JSON.stringify({ peerToken: 'tok-123', procStartFt: 1, pidDomain: 'x' }),
    [path.join('/s', '1234.ffff.key')]: JSON.stringify({ peerToken: 'other' }),
    [path.join('/s', '123.json')]: '{}',
  };
  const list = () => ['123.json', '1234.ffff.key', '123.abcd.key'];
  const read = (p: string) => { const v = files[p]; if (v === undefined) throw new Error('ENOENT'); return v; };
  assert.equal(findPeerToken('/s', 123, list, read), 'tok-123');
  assert.equal(findPeerToken('/s', 999, list, read), undefined);
  assert.equal(findPeerToken('/s', 123, () => { throw new Error('EACCES'); }, read), undefined);
  assert.equal(findPeerToken('/s', 123, list, () => '{"peerToken":""}'), undefined);
});

const pipePath = () =>
  process.platform === 'win32' ? `\\\\.\\pipe\\lb-inbox-test-${randomUUID()}` : path.join(os.tmpdir(), `lb-inbox-${randomUUID()}.sock`);

test('sendToInbox writes the lines in order to a live socket', async () => {
  const where = pipePath();
  let received = '';
  const server = net.createServer((s) => s.on('data', (d) => (received += d.toString('utf8'))));
  await new Promise<void>((r) => server.listen(where, r));
  try {
    await sendToInbox(where, ['a\n', 'b\n'], 50);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(received, 'a\nb\n');
  } finally {
    server.close();
  }
});

test('sendToInbox rejects at once when nothing listens (the process is gone)', async () => {
  await assert.rejects(sendToInbox(pipePath(), ['a\n'], 50));
});

test('sendToInbox settles when the server drops the connection on accept', async () => {
  const where = pipePath();
  const server = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(where, r));
  try {
    await Promise.race([
      sendToInbox(where, ['a\n'], 50, 2_000).then(() => undefined, () => undefined),
      new Promise((_, rej) => setTimeout(() => rej(new Error('did not settle')), 4_000)),
    ]);
  } finally {
    server.close();
  }
});

test('sendToInbox honours a tiny deadline: it settles, and never hangs', async () => {
  const where = pipePath();
  const server = net.createServer(() => undefined);
  await new Promise<void>((r) => server.listen(where, r));
  try {
    await Promise.race([
      sendToInbox(where, ['a\n'], 50, 1).then(() => undefined, () => undefined),
      new Promise((_, rej) => setTimeout(() => rej(new Error('did not settle')), 4_000)),
    ]);
  } finally {
    server.close();
  }
});
