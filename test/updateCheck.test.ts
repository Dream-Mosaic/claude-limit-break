import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, decideUpdateCheck } from '../src/updateCheck';

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

// ---------------------------------------------------------------------------
// decideUpdateCheck
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** Base input with sensible defaults; each test overrides only what it cares about. */
const base = (overrides: Partial<Parameters<typeof decideUpdateCheck>[0]> = {}) => ({
  currentVersion: '0.1.2',
  latestTag: undefined as string | undefined,
  lastCheckedMs: undefined as number | undefined,
  now: NOW,
  intervalMs: 24 * HOUR,
  dismissedVersion: undefined as string | undefined,
  ...overrides,
});

test('decideUpdateCheck: never checked before -> check', () => {
  assert.deepEqual(decideUpdateCheck(base({ lastCheckedMs: undefined })), { kind: 'check' });
});

test('decideUpdateCheck: interval has elapsed since the last check -> check', () => {
  assert.deepEqual(
    decideUpdateCheck(base({ lastCheckedMs: NOW - 25 * HOUR, intervalMs: 24 * HOUR })),
    { kind: 'check' },
  );
});

test('decideUpdateCheck: exactly at the interval boundary -> check', () => {
  // >=, not >: a check due "right now" should not wait for one more tick.
  assert.deepEqual(
    decideUpdateCheck(base({ lastCheckedMs: NOW - 24 * HOUR, intervalMs: 24 * HOUR })),
    { kind: 'check' },
  );
});

test('decideUpdateCheck: checked recently, nothing cached yet -> skip', () => {
  assert.deepEqual(
    decideUpdateCheck(base({ lastCheckedMs: NOW - HOUR, latestTag: undefined })),
    { kind: 'skip' },
  );
});

test('decideUpdateCheck: checked recently, cached tag is newer and not dismissed -> notify', () => {
  assert.deepEqual(
    decideUpdateCheck(base({ lastCheckedMs: NOW - HOUR, latestTag: 'v0.2.0' })),
    { kind: 'notify', latestTag: 'v0.2.0' },
  );
});

test('decideUpdateCheck: cached tag is newer but was already dismissed -> quiet', () => {
  // The one-per-version promise: dismissing v0.2.0 must silence it forever,
  // not just for the activation it was dismissed in.
  assert.deepEqual(
    decideUpdateCheck(
      base({ lastCheckedMs: NOW - HOUR, latestTag: 'v0.2.0', dismissedVersion: 'v0.2.0' }),
    ),
    { kind: 'quiet' },
  );
});

test('decideUpdateCheck: cached tag equals the current version -> quiet', () => {
  assert.deepEqual(
    decideUpdateCheck(base({ lastCheckedMs: NOW - HOUR, latestTag: 'v0.1.2' })),
    { kind: 'quiet' },
  );
});

test('decideUpdateCheck: cached tag is older than the current version -> quiet', () => {
  // Can happen if the user is running a pre-release ahead of the newest tag.
  assert.deepEqual(
    decideUpdateCheck(base({ lastCheckedMs: NOW - HOUR, latestTag: 'v0.0.9' })),
    { kind: 'quiet' },
  );
});

test('decideUpdateCheck: cached tag is malformed -> quiet, never notify', () => {
  assert.deepEqual(
    decideUpdateCheck(base({ lastCheckedMs: NOW - HOUR, latestTag: 'not-a-version' })),
    { kind: 'quiet' },
  );
});

test('decideUpdateCheck: a stale-but-newer dismissal for a DIFFERENT tag still notifies', () => {
  // Dismissing v0.2.0 must not silence a later v0.3.0.
  assert.deepEqual(
    decideUpdateCheck(
      base({ lastCheckedMs: NOW - HOUR, latestTag: 'v0.3.0', dismissedVersion: 'v0.2.0' }),
    ),
    { kind: 'notify', latestTag: 'v0.3.0' },
  );
});
