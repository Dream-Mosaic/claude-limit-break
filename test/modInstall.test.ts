import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  marketplaceJson,
  isModInstalled,
  installSteps,
  updateSteps,
  removeSteps,
  copyMod,
  shouldOfferInstall,
  runSteps,
  listInstalledPlugins,
  installMod,
  updateMod,
  removeMod,
  type ModDeps,
} from '../src/modInstall';

test('the marketplace lists the mod from ./mod', () => {
  assert.deepEqual(JSON.parse(marketplaceJson()), {
    name: 'limit-break',
    owner: { name: 'Dream Mosaic' },
    plugins: [{ name: 'limit-break', source: './mod' }],
  });
});

test('installed means an entry with the mod id', () => {
  assert.equal(isModInstalled(JSON.stringify([{ id: 'limit-break@limit-break', enabled: true }])), true);
  assert.equal(isModInstalled(JSON.stringify([{ id: 'other@x' }])), false);
  assert.equal(isModInstalled('[]'), false, 'a list without the mod is "not installed"');
  assert.equal(isModInstalled('not json'), undefined, 'unparseable is "cannot tell"');
  assert.equal(isModInstalled('{"id":"limit-break@limit-break"}'), undefined, 'not a list is "cannot tell"');
});

test('the CLI steps', () => {
  assert.deepEqual(installSteps('/g/marketplace'), [
    ['plugin', 'marketplace', 'add', '/g/marketplace'],
    ['plugin', 'install', 'limit-break@limit-break', '--scope', 'user'],
  ]);
  assert.deepEqual(updateSteps(), [
    ['plugin', 'marketplace', 'update', 'limit-break'],
    ['plugin', 'update', 'limit-break@limit-break'],
  ]);
  assert.deepEqual(removeSteps(), [
    ['plugin', 'uninstall', 'limit-break@limit-break', '--scope', 'user'],
    ['plugin', 'marketplace', 'remove', 'limit-break'],
  ]);
});

test('the offer is made only when it can help and was not refused for good', () => {
  const base = { enabled: true, continueInPlace: true, installed: false, offer: undefined };
  assert.equal(shouldOfferInstall(base), true);
  assert.equal(shouldOfferInstall({ ...base, installed: true }), false);
  assert.equal(shouldOfferInstall({ ...base, offer: 'never' }), false);
  assert.equal(shouldOfferInstall({ ...base, continueInPlace: false }), false);
  assert.equal(shouldOfferInstall({ ...base, enabled: false }), false);
});

test('runSteps stops at the first failure and names it', async () => {
  const ran: string[][] = [];
  const out = await runSteps([['a'], ['b'], ['c']], async (args) => {
    ran.push(args);
    if (args[0] === 'b') {
      throw new Error('boom');
    }
    return '';
  });
  assert.deepEqual(out, { ok: false, step: ['b'], error: 'boom' });
  assert.deepEqual(ran, [['a'], ['b']]);
});

test('runSteps reports success when every step runs', async () => {
  assert.deepEqual(await runSteps([['a'], ['b']], async () => ''), { ok: true });
});

test('listInstalledPlugins asks for the JSON list', async () => {
  let asked: string[] | undefined;
  const out = await listInstalledPlugins(async (args) => {
    asked = args;
    return '[]';
  });
  assert.deepEqual(asked, ['plugin', 'list', '--json']);
  assert.equal(out, '[]');
});

test('copyMod copies the plugin files and skips tests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-mod-'));
  try {
    const src = path.join(root, 'src-mod');
    const dest = path.join(root, 'dest', 'mod');
    fs.mkdirSync(path.join(src, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(src, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(src, '.claude-plugin', 'plugin.json'), '{"name":"limit-break"}');
    fs.writeFileSync(path.join(src, 'hooks', 'register.mjs'), 'export {};');
    fs.writeFileSync(path.join(src, 'hooks', 'register.test.ts'), 'test');
    // An earlier copy's leftover is replaced, not merged into.
    fs.mkdirSync(path.join(dest, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'hooks', 'old.mjs'), 'old');

    copyMod(src, dest, fs);

    assert.equal(fs.readFileSync(path.join(dest, '.claude-plugin', 'plugin.json'), 'utf8'), '{"name":"limit-break"}');
    assert.equal(fs.readFileSync(path.join(dest, 'hooks', 'register.mjs'), 'utf8'), 'export {};');
    assert.equal(fs.existsSync(path.join(dest, 'hooks', 'register.test.ts')), false);
    assert.equal(fs.existsSync(path.join(dest, 'hooks', 'old.mjs')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const LIST_INSTALLED = JSON.stringify([{ id: 'limit-break@limit-break' }]);

/** Deps over a scripted CLI: `fail` names the first arg-joined steps that throw; `list` is the plugin list. */
function harness(opts: { fail?: string[]; list?: string; stored?: string } = {}) {
  const ran: string[] = [];
  const notes: { m: string; level: string }[] = [];
  const state = { version: opts.stored as string | undefined, copies: 0, cleared: 0 };
  const deps: ModDeps = {
    run: async (args) => {
      const line = args.join(' ');
      ran.push(line);
      if (opts.fail?.some((f) => line.startsWith(f))) {
        throw new Error('nope');
      }
      return args[1] === 'list' ? (opts.list ?? '[]') : '';
    },
    copy: () => void (state.copies += 1),
    marketplaceDir: '/g/marketplace',
    version: '1.1.0',
    storedVersion: () => state.version,
    storeVersion: async (v) => void (state.version = v),
    notify: (m, level) => notes.push({ m, level }),
    log: () => {},
    clearStatusFiles: () => void (state.cleared += 1),
  };
  return { deps, ran, notes, state };
}

test('install success stores the version and reports installed', async () => {
  const h = harness();
  await installMod(h.deps);
  assert.equal(h.state.copies, 1);
  assert.equal(h.state.version, '1.1.0');
  assert.deepEqual(h.ran, ['plugin marketplace add /g/marketplace', 'plugin install limit-break@limit-break --scope user']);
  assert.equal(h.notes[0]?.level, 'info');
  assert.match(h.notes[0]!.m, /is installed/);
});

test('a failed install step is named and nothing is stored', async () => {
  const h = harness({ fail: ['plugin install'] });
  await installMod(h.deps);
  assert.equal(h.state.version, undefined);
  assert.equal(h.notes[0]?.level, 'warn');
  assert.match(h.notes[0]!.m, /claude plugin install limit-break@limit-break --scope user/);
  assert.match(h.notes[0]!.m, /nope/);
});

test('update re-copies, runs the update steps and stores the version', async () => {
  const h = harness({ stored: '1.0.0' });
  await updateMod(h.deps);
  assert.equal(h.state.copies, 1);
  assert.deepEqual(h.ran, ['plugin marketplace update limit-break', 'plugin update limit-break@limit-break']);
  assert.equal(h.state.version, '1.1.0');
});

test('a failed update keeps the old version so it is tried again', async () => {
  const h = harness({ stored: '1.0.0', fail: ['plugin update'] });
  await updateMod(h.deps);
  assert.equal(h.state.version, '1.0.0');
});

test('remove when not installed skips uninstall, removes the marketplace and clears the key', async () => {
  const h = harness({ stored: '1.0.0', list: '[]' });
  await removeMod(h.deps);
  assert.deepEqual(h.ran, ['plugin list --json', 'plugin marketplace remove limit-break']);
  assert.equal(h.state.version, undefined);
  assert.equal(h.notes[0]?.level, 'info');
});

test('remove when uninstall fails still removes the marketplace and keeps the key', async () => {
  const h = harness({ stored: '1.0.0', list: LIST_INSTALLED, fail: ['plugin uninstall'] });
  await removeMod(h.deps);
  assert.deepEqual(h.ran, [
    'plugin list --json',
    'plugin uninstall limit-break@limit-break --scope user',
    'plugin marketplace remove limit-break',
  ]);
  assert.equal(h.state.version, '1.0.0');
  assert.equal(h.notes[0]?.level, 'warn');
  assert.match(h.notes[0]!.m, /plugin uninstall/);
});

test('remove when the plugin list cannot be read still attempts the uninstall', async () => {
  const h = harness({ stored: '1.0.0', list: 'definitely not a plugin list' });
  await removeMod(h.deps);
  assert.deepEqual(h.ran, [
    'plugin list --json',
    'plugin uninstall limit-break@limit-break --scope user',
    'plugin marketplace remove limit-break',
  ]);
  assert.equal(h.state.version, undefined);
});

test('remove clears the mod status files once the plugin is gone, and not when the uninstall failed', async () => {
  const gone = harness({ stored: '1.0.0', list: LIST_INSTALLED });
  await removeMod(gone.deps);
  assert.equal(gone.state.cleared, 1);
  const stuck = harness({ stored: '1.0.0', list: LIST_INSTALLED, fail: ['plugin uninstall'] });
  await removeMod(stuck.deps);
  assert.equal(stuck.state.cleared, 0, 'the mod is still there, so its status is still true');
});

test('copyMod refuses a missing source without touching the destination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-mod-'));
  try {
    const dest = path.join(root, 'dest');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'keep.txt'), 'x');
    assert.throws(() => copyMod(path.join(root, 'missing'), dest, fs), /missing/);
    assert.equal(fs.existsSync(path.join(dest, 'keep.txt')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
