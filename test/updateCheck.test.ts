import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../src/updateCheck';

test('compareVersions: equal versions, one tagged with a leading v', () => {
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 'equal');
});

test('compareVersions: current is newer than the tag', () => {
  assert.equal(compareVersions('1.0.0', 'v0.1.2'), 'greater');
});

test('compareVersions: current is older than the tag', () => {
  assert.equal(compareVersions('0.1.1', 'v0.1.2'), 'less');
});

test('compareVersions: a malformed value is unknown, never greater', () => {
  // "never as newer" is the safety property here: a bad value from either
  // side must not be able to trigger a false "you are behind" notification.
  assert.equal(compareVersions('not-a-version', 'v0.1.2'), 'unknown');
  assert.equal(compareVersions('0.1.2', 'not-a-version'), 'unknown');
});
