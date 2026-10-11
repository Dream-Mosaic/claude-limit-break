import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSession, parentPidCommand, PANEL_OPEN_COMMAND, type OpenerDeps } from '../src/sessionOpener';

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
function deps(over: Partial<OpenerDeps> = {}) {
  const executed: unknown[][] = [];
  const shown: number[] = [];
  const d: OpenerDeps = {
    commands: async () => [PANEL_OPEN_COMMAND],
    executeCommand: async (...args) => { executed.push(args); },
    terminals: () => [10, 20].map((pid) => ({ processId: Promise.resolve(pid), show: () => shown.push(pid) })),
    parentPid: async (pid) => ({ 300: 200, 200: 20 } as Record<number, number>)[pid],
    ...over,
  };
  return { d, executed, shown };
}

test('a panel opens through the Claude Code extension when it has the command', async () => {
  const { d, executed } = deps();
  assert.equal(await openSession({ kind: 'panel', pid: 1, sessionId: SID }, d), true);
  assert.deepEqual(executed, [[PANEL_OPEN_COMMAND, SID]]);
});

test('without the command, a panel cannot be opened', async () => {
  const { d } = deps({ commands: async () => [] });
  assert.equal(await openSession({ kind: 'panel', pid: 1, sessionId: SID }, d), false);
});

test('a terminal is found by its own pid or an ancestor of the claude process, up to three levels', async () => {
  const direct = deps();
  assert.equal(await openSession({ kind: 'terminal', pid: 10, sessionId: SID }, direct.d), true);
  assert.deepEqual(direct.shown, [10]);
  const nested = deps();
  assert.equal(await openSession({ kind: 'terminal', pid: 300, sessionId: SID }, nested.d), true);
  assert.deepEqual(nested.shown, [20]);
  const absent = deps();
  assert.equal(await openSession({ kind: 'terminal', pid: 999, sessionId: SID }, absent.d), false);
});

test('the parent-pid command takes only an integer pid', () => {
  assert.deepEqual(parentPidCommand(42, 'linux'), { file: 'ps', args: ['-o', 'ppid=', '-p', '42'] });
  assert.equal(parentPidCommand(42, 'win32')!.file, 'powershell');
  assert.ok(parentPidCommand(42, 'win32')!.args.join(' ').includes('ProcessId=42'));
  assert.equal(parentPidCommand(4.2, 'linux'), undefined);
  assert.equal(parentPidCommand(-1, 'linux'), undefined);
});
