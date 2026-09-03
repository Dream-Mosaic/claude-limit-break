import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSession, isSessionId } from '../src/sessionResolver';

const ID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const FILE = `/home/u/.claude/projects/c--projects-example/${ID}.jsonl`;
const bytes = () => 1_618_394;

test('the transcript filename is the session id', () => {
  const s = resolveSession(FILE, 'C:\\projects\\example', bytes);
  assert.equal(s?.sessionId, ID);
  assert.equal(s?.transcript, FILE);
  assert.equal(s?.cwd, 'C:\\projects\\example');
  assert.equal(s?.bytes, 1_618_394);
});

test('works on Windows-style transcript paths', () => {
  const win = `C:\\Users\\u\\.claude\\projects\\c--projects-example\\${ID}.jsonl`;
  assert.equal(resolveSession(win, undefined, bytes)?.sessionId, ID);
});

test('refuses a filename that is not a session id', () => {
  const bad = '/home/u/.claude/projects/p/summary.jsonl';
  assert.equal(resolveSession(bad, undefined, bytes), undefined);
});

test('refuses a path that is not a transcript', () => {
  assert.equal(resolveSession(`/tmp/${ID}.txt`, undefined, bytes), undefined);
});

test('survives an unstattable file by reporting zero bytes', () => {
  const throwing = () => {
    throw new Error('ENOENT');
  };
  assert.equal(resolveSession(FILE, undefined, throwing)?.bytes, 0);
});

test('isSessionId accepts a uuid and rejects anything else', () => {
  assert.ok(isSessionId(ID));
  assert.equal(isSessionId('not-a-uuid'), false);
  assert.equal(isSessionId(`${ID} --dangerously-skip-permissions`), false);
  assert.equal(isSessionId(''), false);
});
