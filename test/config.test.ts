import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSettings } from '../src/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = (values: Record<string, unknown> = {}) => ({
  get: <T>(key: string, fallback: T): T => (key in values ? (values[key] as T) : fallback),
});

test('defaults match the declared manifest defaults', () => {
  const s = readSettings(source());
  assert.equal(s.enabled, true);
  assert.equal(s.autoResume, true);
  assert.equal(s.resumeMode, 'interactive');
  assert.equal(s.headlessPermissionMode, '');
  assert.equal(s.maxResumeTokens, 500_000);
  assert.equal(s.maxWaitHours, 24);
});

test('an unknown resume mode falls back to interactive', () => {
  assert.equal(readSettings(source({ resumeMode: 'yolo' })).resumeMode, 'interactive');
});

test('an unknown permission mode falls back to none', () => {
  assert.equal(
    readSettings(source({ headlessPermissionMode: 'bypassPermissions' })).headlessPermissionMode,
    '',
    'bypassPermissions is not offered, and an injected value must not pass through',
  );
});

test('negative numbers are clamped rather than trusted', () => {
  const s = readSettings(source({ maxWaitHours: -5, transcriptPollSeconds: 0, maxResumeTokens: -1 }));
  assert.ok(s.maxWaitHours > 0);
  assert.ok(s.transcriptPollSeconds >= 1);
  assert.equal(s.maxResumeTokens, 0, 'a negative cap means disabled, not inverted');
});

test('a non-string claudeCommand falls back to the default, a valid string passes through', () => {
  const fallback = readSettings(source({ claudeCommand: 42 })).claudeCommand;
  assert.equal(fallback, '', 'a non-string value must not reach resolveClaudeLauncher, which calls .trim() on it');
  const passthrough = readSettings(source({ claudeCommand: '/opt/claude/bin/claude' })).claudeCommand;
  assert.equal(passthrough, '/opt/claude/bin/claude');
});

test('every setting the code reads is declared in the manifest, and every declared setting is read', () => {
  // Upstream read claudeTimeout.soundCommand without declaring it, which left
  // it with no scope - so a workspace could set it. This test is that finding,
  // frozen. The reverse direction catches a declared-but-dead setting: one
  // that shows up in the settings UI but nothing in config.ts ever reads.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  );
  const declared = new Set(Object.keys(manifest.contributes.configuration.properties));
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'config.ts'), 'utf8');
  const read = new Set<string>();
  for (const m of src.matchAll(/get\(\s*'([a-zA-Z]+)'/g)) {
    const key = m[1];
    assert.ok(key, 'regex capture group must have matched something');
    read.add(key);
    assert.ok(
      declared.has(`claudeLimitBuster.${key}`),
      `config.ts reads '${key}' but package.json does not declare it`,
    );
  }
  for (const declaredKey of declared) {
    const shortKey = declaredKey.replace('claudeLimitBuster.', '');
    assert.ok(
      read.has(shortKey),
      `package.json declares '${declaredKey}' but config.ts never reads it`,
    );
  }
});

test('every enum setting describes each of its choices', () => {
  // enumDescriptions is positional: one short line per enum value, in order.
  // Add a value without a description and the settings UI silently mislabels
  // the rest, which matters most for headlessPermissionMode, whose first
  // choice is the empty string and is unreadable without one.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  );
  const props: Record<string, { enum?: unknown[]; enumDescriptions?: unknown[] }> =
    manifest.contributes.configuration.properties;
  let checked = 0;
  for (const [key, prop] of Object.entries(props)) {
    if (!prop.enum) {
      continue;
    }
    checked += 1;
    assert.ok(prop.enumDescriptions, `${key} offers a choice list with no enumDescriptions`);
    assert.equal(
      prop.enumDescriptions.length,
      prop.enum.length,
      `${key}: ${prop.enum.length} choices but ${prop.enumDescriptions.length} descriptions`,
    );
  }
  assert.ok(checked > 0, 'the manifest must still declare enum settings for this to assert anything');
});

test('execution-adjacent settings are machine-scoped', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  );
  const props = manifest.contributes.configuration.properties;
  for (const key of [
    'resumeMode',
    'headlessPermissionMode',
    'claudeCommand',
    'alertSoundFile',
    'resumePrompt',
  ]) {
    assert.equal(
      props[`claudeLimitBuster.${key}`].scope,
      'machine',
      `${key} influences what gets executed and must not be workspace-settable`,
    );
  }
});

test('a stale panel tab is reported, not acted on, by default', () => {
  // The experiment in docs/research/2026-09-20-panel-fork-experiment.md is why
  // this setting exists at all. Closing someone's editor tab is the one thing
  // here that cannot be undone by ignoring a notification, so it is opt-in.
  assert.equal(readSettings(source()).onStale, 'notify');
});

test('onStale accepts reopen', () => {
  assert.equal(readSettings(source({ onStale: 'reopen' })).onStale, 'reopen');
});

test('an unknown onStale value falls back to notify', () => {
  assert.equal(readSettings(source({ onStale: 'close' })).onStale, 'notify');
});

test('the status bar shows a marker when idle by default', () => {
  // A VSIX-installed extension that shows nothing while waiting looks broken.
  assert.equal(readSettings(source()).statusBar, 'always');
});

test('statusBar accepts pending and never, and rejects anything else', () => {
  assert.equal(readSettings(source({ statusBar: 'pending' })).statusBar, 'pending');
  assert.equal(readSettings(source({ statusBar: 'never' })).statusBar, 'never');
  assert.equal(readSettings(source({ statusBar: 'sometimes' })).statusBar, 'always');
});
