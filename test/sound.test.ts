import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSoundCommand } from '../src/sound';

test('macOS plays the file with afplay as an argument', () => {
  const c = buildSoundCommand('darwin', '/Users/u/my ping.aiff');
  assert.equal(c?.file, 'afplay');
  assert.deepEqual(c?.args, ['/Users/u/my ping.aiff']);
});

test('linux passes the path as an argument, never through a shell', () => {
  const c = buildSoundCommand('linux', "/home/u/o'brien/ping.oga");
  assert.notEqual(c?.file, '/bin/sh');
  assert.ok(!c?.args.includes('-c'));
  assert.ok(c?.args.includes("/home/u/o'brien/ping.oga"));
});

test('windows runs powershell with the profile disabled', () => {
  const c = buildSoundCommand('win32', 'C:\\snd\\ping.wav');
  assert.equal(c?.file, 'powershell.exe');
  assert.ok(c?.args.includes('-NoProfile'));
  assert.ok(c?.args.includes('-NonInteractive'));
});

test('an apostrophe in a windows path is doubled for the powershell literal', () => {
  const c = buildSoundCommand('win32', "C:\\o'brien\\ping.wav");
  const script = c!.args[c!.args.length - 1]!;
  assert.ok(script.includes("o''brien"), 'single quotes must be doubled inside a PS literal');
});

test('a hostile path never becomes the executable, on any platform', () => {
  const platforms: NodeJS.Platform[] = ['darwin', 'linux', 'win32'];
  for (const platform of platforms) {
    const c = buildSoundCommand(platform, 'calc.exe');
    assert.notEqual(c?.file, 'calc.exe');
  }
});

test('a quote embedded in a windows path cannot terminate the powershell string literal', () => {
  const c = buildSoundCommand('win32', "C:\\a'; Start-Process calc; '.wav");
  const script = c!.args[c!.args.length - 1]!;
  assert.ok(
    script.includes("a''; Start-Process calc; ''"),
    'the payload must survive only as doubled-quote data inside the $p literal',
  );
});
