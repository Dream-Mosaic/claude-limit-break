import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { sessionRegistryDir, readSessionRecord } from '../src/sessionRegistry';

const SESSION = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const DIR = '/fake/.claude/sessions';

const reader = (contents: Record<string, string>) => (p: string) => {
  const found = contents[p.replace(/\\/g, '/')];
  if (found === undefined) {
    throw new Error(`ENOENT: ${p}`);
  }
  return found;
};

test('sessionRegistryDir points at .claude/sessions under the home directory', () => {
  assert.equal(sessionRegistryDir(), path.join(os.homedir(), '.claude', 'sessions'));
});

test('readSessionRecord returns the session and entrypoint for a pid', () => {
  const record = readSessionRecord(
    DIR,
    9624,
    reader({
      '/fake/.claude/sessions/9624.json': JSON.stringify({
        pid: 9624,
        sessionId: SESSION,
        entrypoint: 'claude-vscode',
        kind: 'interactive',
      }),
    }),
  );
  assert.deepEqual(record, { sessionId: SESSION, entrypoint: 'claude-vscode' });
});

test('readSessionRecord returns undefined when there is no file for the pid', () => {
  assert.equal(readSessionRecord(DIR, 9624, reader({})), undefined);
});

test('readSessionRecord returns undefined rather than throwing on a half-written file', () => {
  // The CLI writes these itself; a read can land mid-write.
  assert.equal(
    readSessionRecord(DIR, 9624, reader({ '/fake/.claude/sessions/9624.json': '{"pid": 96' })),
    undefined,
  );
});

test('readSessionRecord rejects a record whose pid is not the one asked for', () => {
  // The filename is the only thing tying a record to a process. A mismatch
  // means the file is not what its name claims, so nothing in it can be
  // trusted to describe this pid.
  assert.equal(
    readSessionRecord(
      DIR,
      9624,
      reader({
        '/fake/.claude/sessions/9624.json': JSON.stringify({
          pid: 1111,
          sessionId: SESSION,
          entrypoint: 'claude-vscode',
        }),
      }),
    ),
    undefined,
  );
});

test('readSessionRecord returns undefined when the record names no session', () => {
  assert.equal(
    readSessionRecord(
      DIR,
      9624,
      reader({
        '/fake/.claude/sessions/9624.json': JSON.stringify({ pid: 9624, entrypoint: 'cli' }),
      }),
    ),
    undefined,
  );
});

test('readSessionRecord reports a missing entrypoint as undefined, not as a panel', () => {
  const record = readSessionRecord(
    DIR,
    9624,
    reader({
      '/fake/.claude/sessions/9624.json': JSON.stringify({ pid: 9624, sessionId: SESSION }),
    }),
  );
  assert.deepEqual(record, { sessionId: SESSION, entrypoint: undefined });
});

test('readSessionRecord carries bridgeSessionId when Remote Control is connected', () => {
  // The classifier's `panel` result needs to say whether the session is
  // bridged, so Remote Control's own auto-continue can be mentioned instead
  // of assuming nothing will pick the session back up.
  const record = readSessionRecord(
    DIR,
    9624,
    reader({
      '/fake/.claude/sessions/9624.json': JSON.stringify({
        pid: 9624,
        sessionId: SESSION,
        entrypoint: 'claude-vscode',
        bridgeSessionId: 'bridge-abc',
      }),
    }),
  );
  assert.deepEqual(record, { sessionId: SESSION, entrypoint: 'claude-vscode', bridgeSessionId: 'bridge-abc' });
});

test('readSessionRecord omits bridgeSessionId when the record has none, rather than reporting it as an empty string', () => {
  const record = readSessionRecord(
    DIR,
    9624,
    reader({
      '/fake/.claude/sessions/9624.json': JSON.stringify({ pid: 9624, sessionId: SESSION, entrypoint: 'cli' }),
    }),
  );
  assert.deepEqual(record, { sessionId: SESSION, entrypoint: 'cli' });
});
