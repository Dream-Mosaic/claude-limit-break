import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentRows, otherLivePids, hasLivePanel, livePanelDetector } from '../src/liveSessions';

const SESSION = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const OTHER = '9a1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e';

/** The shape `claude agents --json` prints, trimmed to the fields used here. */
const rowsJson = (...rows: unknown[]) => JSON.stringify(rows);

test('parseAgentRows reads pid, kind and sessionId off the listing', () => {
  const rows = parseAgentRows(
    rowsJson({ pid: 9624, kind: 'interactive', sessionId: SESSION, status: 'idle' }),
  );
  assert.deepEqual(rows, [{ pid: 9624, kind: 'interactive', sessionId: SESSION }]);
});

test('parseAgentRows returns nothing rather than throwing on output that is not JSON', () => {
  // The CLI prints a human-readable table when --json is missing, and an
  // error to stdout when the command is unavailable. Neither is a crash here.
  assert.deepEqual(parseAgentRows('No agents running.'), []);
  assert.deepEqual(parseAgentRows(''), []);
});

test('parseAgentRows drops a row with no pid', () => {
  // A background agent record carries an id and no pid - #6 found an orphaned
  // one of these that no command could remove. It cannot be a live process.
  const rows = parseAgentRows(
    rowsJson(
      { id: 'ffcb2ab0', kind: 'background', sessionId: SESSION, state: 'blocked' },
      { pid: 4242, kind: 'interactive', sessionId: SESSION },
    ),
  );
  assert.deepEqual(rows, [{ pid: 4242, kind: 'interactive', sessionId: SESSION }]);
});

test('otherLivePids ignores the resume this extension just launched', () => {
  // The resumed `claude` is itself a live interactive process on the session,
  // so without this every resume would report a second process against itself.
  const rows = parseAgentRows(
    rowsJson(
      { pid: 111, kind: 'interactive', sessionId: SESSION },
      { pid: 222, kind: 'interactive', sessionId: SESSION },
    ),
  );
  assert.deepEqual(otherLivePids(rows, SESSION, 222), [111]);
});

test('otherLivePids ignores processes on a different session', () => {
  const rows = parseAgentRows(
    rowsJson(
      { pid: 111, kind: 'interactive', sessionId: OTHER },
      { pid: 222, kind: 'interactive', sessionId: SESSION },
    ),
  );
  assert.deepEqual(otherLivePids(rows, SESSION, 999), [222]);
});

test('otherLivePids ignores a background agent on the same session', () => {
  const rows = parseAgentRows(
    rowsJson({ pid: 111, kind: 'background', sessionId: SESSION }),
  );
  assert.deepEqual(otherLivePids(rows, SESSION, 999), []);
});

test('otherLivePids without our own pid still excludes nothing else', () => {
  // processId is a promise VS Code may not have resolved yet; undefined must
  // not silently match a real pid.
  const rows = parseAgentRows(rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }));
  assert.deepEqual(otherLivePids(rows, SESSION, undefined), [111]);
});

test('hasLivePanel is true when another live process on the session is a panel', () => {
  const rows = parseAgentRows(
    rowsJson(
      { pid: 111, kind: 'interactive', sessionId: SESSION },
      { pid: 222, kind: 'interactive', sessionId: SESSION },
    ),
  );
  const entrypointOf = (pid: number) => (pid === 111 ? 'claude-vscode' : undefined);
  assert.equal(hasLivePanel(rows, SESSION, 222, entrypointOf), true);
});

test('hasLivePanel is false when the only other process is a terminal', () => {
  const rows = parseAgentRows(
    rowsJson(
      { pid: 111, kind: 'interactive', sessionId: SESSION },
      { pid: 222, kind: 'interactive', sessionId: SESSION },
    ),
  );
  // A second terminal on one session cannot be reopened and has no tab; the
  // offer is about a panel tab specifically.
  const entrypointOf = (pid: number) => (pid === 111 ? 'cli' : undefined);
  assert.equal(hasLivePanel(rows, SESSION, 222, entrypointOf), false);
});

test('hasLivePanel is false when nothing else holds the session', () => {
  const rows = parseAgentRows(rowsJson({ pid: 222, kind: 'interactive', sessionId: SESSION }));
  assert.equal(hasLivePanel(rows, SESSION, 222, () => 'claude-vscode'), false);
});

test('hasLivePanel is false when the pid has no record to read', () => {
  // `claude agents --json` vouches the process is alive; the per-pid file is
  // where the entrypoint lives. A live pid with no readable record cannot be
  // called a panel.
  const rows = parseAgentRows(rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }));
  assert.equal(hasLivePanel(rows, SESSION, 222, () => undefined), false);
});

test('livePanelDetector reports a panel holding the session', () => {
  const detect = livePanelDetector(
    () => rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }),
    (pid) => (pid === 111 ? { sessionId: SESSION, entrypoint: 'claude-vscode' } : undefined),
  );
  assert.equal(detect(SESSION, 222), true);
});

test('livePanelDetector rejects a record that names a different session', () => {
  // `claude agents --json` says the pid is alive; the per-pid file says what
  // it is. If the file describes another session, the pid has been reused or
  // the record is stale, and either way it says nothing about this session.
  const detect = livePanelDetector(
    () => rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }),
    () => ({ sessionId: OTHER, entrypoint: 'claude-vscode' }),
  );
  assert.equal(detect(SESSION, 222), false);
});

test('livePanelDetector says no when the listing cannot be run', () => {
  // No claude on PATH, or a version without `agents`. Not knowing is not a
  // reason to interrupt someone right after a resume.
  const detect = livePanelDetector(
    () => {
      throw new Error('ENOENT');
    },
    () => ({ sessionId: SESSION, entrypoint: 'claude-vscode' }),
  );
  assert.equal(detect(SESSION, 222), false);
});

test('livePanelDetector reads a record only for pids the listing vouched for', () => {
  const asked: number[] = [];
  const detect = livePanelDetector(
    () =>
      rowsJson(
        { pid: 111, kind: 'interactive', sessionId: SESSION },
        { pid: 222, kind: 'interactive', sessionId: SESSION },
        { pid: 333, kind: 'interactive', sessionId: OTHER },
      ),
    (pid) => {
      asked.push(pid);
      return undefined;
    },
  );
  detect(SESSION, 222);
  assert.deepEqual(asked, [111], 'not our own pid, and not one on another session');
});
