import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAgentRows,
  otherLivePids,
  hasLivePanel,
  livePanelDetector,
  classifyHolder,
  busyFolderHolder,
  holderDetector,
} from '../src/liveSessions';

const SESSION = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const OTHER = '9a1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e';

/** The shape `claude agents --json` prints, trimmed to the fields used here. */
const rowsJson = (...rows: unknown[]) => JSON.stringify(rows);

test('parseAgentRows reads pid, kind and sessionId off the listing, ignoring fields it does not know', () => {
  const rows = parseAgentRows(
    rowsJson({ pid: 9624, kind: 'interactive', sessionId: SESSION, startedAt: 1790216331148 }),
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

// ---------------------------------------------------------------------------
// AgentRow carries cwd and status too (Task 2), for the busy-folder check.
// The existing tests above assert exact-shape rows with deepEqual, so these
// two fields must be omitted from a row entirely when the listing did not
// report them - present as `undefined` would fail those deepEqual checks.
// ---------------------------------------------------------------------------

test('parseAgentRows carries cwd and status when the listing reports them', () => {
  const rows = parseAgentRows(
    rowsJson({ pid: 9624, kind: 'interactive', sessionId: SESSION, cwd: '/work/app', status: 'busy' }),
  );
  assert.deepEqual(rows, [{ pid: 9624, kind: 'interactive', sessionId: SESSION, cwd: '/work/app', status: 'busy' }]);
});

test('parseAgentRows omits cwd and status rather than reporting them as undefined', () => {
  const rows = parseAgentRows(rowsJson({ pid: 9624, kind: 'interactive', sessionId: SESSION }));
  assert.deepEqual(rows, [{ pid: 9624, kind: 'interactive', sessionId: SESSION }]);
  assert.equal('cwd' in rows[0]!, false);
  assert.equal('status' in rows[0]!, false);
});

// ---------------------------------------------------------------------------
// classifyHolder: the pure classifier scheduler.onFire uses to decide whether
// somebody already holds the session before spawning a second writer.
// ---------------------------------------------------------------------------

test('classifyHolder reports none when nothing else is live on the session', () => {
  const rows = parseAgentRows(rowsJson({ pid: 222, kind: 'interactive', sessionId: SESSION }));
  assert.deepEqual(classifyHolder(rows, SESSION, 222, () => undefined), { kind: 'none' });
});

test('classifyHolder reports a panel, not bridged, when the vouched record has no bridgeSessionId', () => {
  const rows = parseAgentRows(rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }));
  const holder = classifyHolder(rows, SESSION, 222, () => ({ sessionId: SESSION, entrypoint: 'claude-vscode' }));
  assert.deepEqual(holder, { kind: 'panel', pid: 111, bridged: false });
});

test('classifyHolder reports a bridged panel when Remote Control is connected', () => {
  const rows = parseAgentRows(rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }));
  const holder = classifyHolder(rows, SESSION, 222, () => ({
    sessionId: SESSION,
    entrypoint: 'claude-vscode',
    bridgeSessionId: 'bridge-1',
  }));
  assert.deepEqual(holder, { kind: 'panel', pid: 111, bridged: true });
});

test('classifyHolder reports a terminal for a cli entrypoint', () => {
  const rows = parseAgentRows(rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }));
  const holder = classifyHolder(rows, SESSION, 222, () => ({ sessionId: SESSION, entrypoint: 'cli' }));
  assert.deepEqual(holder, { kind: 'terminal', pid: 111 });
});

test('classifyHolder reports a terminal for any non-panel entrypoint, not only cli', () => {
  const rows = parseAgentRows(rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }));
  const holder = classifyHolder(rows, SESSION, 222, () => ({ sessionId: SESSION, entrypoint: 'sdk' }));
  assert.deepEqual(holder, { kind: 'terminal', pid: 111 });
});

test('classifyHolder prefers a panel over a terminal when both are present, regardless of row order', () => {
  const rows = parseAgentRows(
    rowsJson(
      { pid: 111, kind: 'interactive', sessionId: SESSION },
      { pid: 222, kind: 'interactive', sessionId: SESSION },
    ),
  );
  const holder = classifyHolder(rows, SESSION, 333, (pid) =>
    pid === 111 ? { sessionId: SESSION, entrypoint: 'cli' } : { sessionId: SESSION, entrypoint: 'claude-vscode' },
  );
  assert.deepEqual(holder, { kind: 'panel', pid: 222, bridged: false });
});

test('classifyHolder ignores a live pid whose record names a different session', () => {
  // Same guard livePanelDetector already applies: the listing vouches the pid
  // is alive, but a record for a different session is not describing it.
  const rows = parseAgentRows(rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }));
  const holder = classifyHolder(rows, SESSION, 222, () => ({ sessionId: OTHER, entrypoint: 'claude-vscode' }));
  assert.deepEqual(holder, { kind: 'none' });
});

test('classifyHolder ignores a live pid with no record to read', () => {
  const rows = parseAgentRows(rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }));
  assert.deepEqual(classifyHolder(rows, SESSION, 222, () => undefined), { kind: 'none' });
});

// ---------------------------------------------------------------------------
// busyFolderHolder: is a DIFFERENT session busy in the same folder?
// ---------------------------------------------------------------------------

test('busyFolderHolder finds a different session busy in the same folder', () => {
  const rows = parseAgentRows(
    rowsJson({ pid: 555, kind: 'interactive', sessionId: OTHER, cwd: '/work/app', status: 'busy' }),
  );
  const found = busyFolderHolder(rows, SESSION, '/work/app', 'linux');
  assert.equal(found?.pid, 555);
});

test('busyFolderHolder ignores the same session, even if it is somehow reported busy', () => {
  const rows = parseAgentRows(
    rowsJson({ pid: 555, kind: 'interactive', sessionId: SESSION, cwd: '/work/app', status: 'busy' }),
  );
  assert.equal(busyFolderHolder(rows, SESSION, '/work/app', 'linux'), undefined);
});

test('busyFolderHolder ignores a different session that is only idle', () => {
  const rows = parseAgentRows(
    rowsJson({ pid: 555, kind: 'interactive', sessionId: OTHER, cwd: '/work/app', status: 'idle' }),
  );
  assert.equal(busyFolderHolder(rows, SESSION, '/work/app', 'linux'), undefined);
});

test('busyFolderHolder ignores a busy different session in a different folder', () => {
  const rows = parseAgentRows(
    rowsJson({ pid: 555, kind: 'interactive', sessionId: OTHER, cwd: '/work/other', status: 'busy' }),
  );
  assert.equal(busyFolderHolder(rows, SESSION, '/work/app', 'linux'), undefined);
});

test('busyFolderHolder skips a busy row with no cwd rather than throwing', () => {
  // `claude agents --json` can vouch a pid is alive and busy without ever
  // reporting its cwd; that row cannot be compared for folder equality and
  // must not crash the search for one that can be.
  const rows = parseAgentRows(rowsJson({ pid: 555, kind: 'interactive', sessionId: OTHER, status: 'busy' }));
  assert.equal(busyFolderHolder(rows, SESSION, '/work/app', 'linux'), undefined);
});

test('busyFolderHolder normalizes drive-letter casing and slash direction (win32)', () => {
  const rows = parseAgentRows(
    rowsJson({ pid: 555, kind: 'interactive', sessionId: OTHER, cwd: 'c:/work/app', status: 'busy' }),
  );
  const found = busyFolderHolder(rows, SESSION, 'C:\\work\\app', 'win32');
  assert.equal(found?.pid, 555);
});

// ---------------------------------------------------------------------------
// holderDetector: the impure wrapper scheduler.onFire actually calls.
// ---------------------------------------------------------------------------

test('holderDetector delegates to classifyHolder over the real listing', () => {
  const detect = holderDetector(
    () => rowsJson({ pid: 111, kind: 'interactive', sessionId: SESSION }),
    () => ({ sessionId: SESSION, entrypoint: 'claude-vscode' }),
  );
  assert.deepEqual(detect(SESSION, 222), { kind: 'panel', pid: 111, bridged: false });
});

test('holderDetector reports unknown, not none, when the listing cannot be run', () => {
  // A listing failure must not be read as "nobody holds it" - that would
  // resume as usual anyway, but for the wrong reason, and a caller that ever
  // treats 'unknown' more cautiously than 'none' needs the two told apart.
  const detect = holderDetector(
    () => {
      throw new Error('ENOENT');
    },
    () => ({ sessionId: SESSION, entrypoint: 'claude-vscode' }),
  );
  assert.equal(detect(SESSION, 222), 'unknown');
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
