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

test('openSession never rejects: failing dependencies mean false', async () => {
  const boom = async (): Promise<never> => { throw new Error('boom'); };
  assert.equal(await openSession({ kind: 'panel', pid: 1, sessionId: SID }, deps({ executeCommand: boom }).d), false);
  assert.equal(await openSession({ kind: 'panel', pid: 1, sessionId: SID }, deps({ commands: boom }).d), false);
  assert.equal(await openSession({ kind: 'terminal', pid: 10, sessionId: SID }, deps({ terminals: () => { throw new Error('boom'); } }).d), false);
  const failingShow = deps({ terminals: () => [{ processId: Promise.resolve(10), show: () => { throw new Error('boom'); } }] });
  assert.equal(await openSession({ kind: 'terminal', pid: 10, sessionId: SID }, failingShow.d), false);
});

test('a parent-pid failure keeps the direct match', async () => {
  const { d, shown } = deps({ parentPid: async () => { throw new Error('boom'); } });
  assert.equal(await openSession({ kind: 'terminal', pid: 10, sessionId: SID }, d), true);
  assert.deepEqual(shown, [10]);
});

test('a terminal four levels above the claude process is not matched', async () => {
  const chain: Record<number, number> = { 1000: 900, 900: 800, 800: 700, 700: 600 };
  const { d } = deps({
    parentPid: async (pid) => chain[pid],
    terminals: () => [{ processId: Promise.resolve(600), show: () => undefined }],
  });
  assert.equal(await openSession({ kind: 'terminal', pid: 1000, sessionId: SID }, d), false);
});

test('the parent-pid command rejects a pid beyond the safe integers', () => {
  assert.equal(parentPidCommand(1e21, 'linux'), undefined);
});

test('the parent-pid command takes only an integer pid', () => {
  assert.deepEqual(parentPidCommand(42, 'linux'), { file: 'ps', args: ['-o', 'ppid=', '-p', '42'] });
  assert.equal(parentPidCommand(42, 'win32')!.file, 'powershell');
  assert.ok(parentPidCommand(42, 'win32')!.args.join(' ').includes('ProcessId=42'));
  assert.equal(parentPidCommand(4.2, 'linux'), undefined);
  assert.equal(parentPidCommand(-1, 'linux'), undefined);
});
