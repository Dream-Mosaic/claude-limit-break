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
  assert.equal(isModInstalled('not json'), false);
  assert.equal(isModInstalled('{"id":"limit-break@limit-break"}'), false, 'not a list');
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
