import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  compareVersions,
  decideUpdateCheck,
  newestTag,
  fetchLatestReleaseTag,
  shouldOfferFirstRunPrompt,
  shouldEnableUpdateChecks,
} from '../src/updateCheck';

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

// ---------------------------------------------------------------------------
// newestTag - picking the newest tag out of a parsed /releases response
// ---------------------------------------------------------------------------

/** The shape of one element of the GitHub /releases response, trimmed to what newestTag reads. */
const release = (tag_name: string, opts: { draft?: boolean } = {}) => ({
  tag_name,
  draft: opts.draft ?? false,
  prerelease: true,
});

test('newestTag: picks the highest version out of several releases', () => {
  // Real GitHub order for this repo (verified via `gh api .../releases`) is
  // newest-first already, but nothing documents that as a guarantee - so this
  // deliberately puts the newest one in the middle.
  assert.equal(newestTag([release('v0.1.1'), release('v0.1.2'), release('v0.1.0')]), 'v0.1.2');
});

test('newestTag: skips a draft release', () => {
  // An unpublished draft is not something to point a user's download link at.
  assert.equal(newestTag([release('v0.1.2'), release('v0.2.0', { draft: true })]), 'v0.1.2');
});

test('newestTag: skips an entry with a malformed tag_name', () => {
  assert.equal(newestTag([release('v0.1.1'), { tag_name: 'not-a-version', draft: false }]), 'v0.1.1');
});

test('newestTag: undefined when there is nothing usable', () => {
  assert.equal(newestTag([]), undefined);
  assert.equal(newestTag([{ tag_name: 'garbage', draft: false }]), undefined);
  assert.equal(newestTag([{ draft: true, tag_name: 'v9.9.9' }]), undefined);
  assert.equal(newestTag('not an array'), undefined);
  assert.equal(newestTag(null), undefined);
});

// ---------------------------------------------------------------------------
// fetchLatestReleaseTag - against a real node:http server on 127.0.0.1, never
// against the real GitHub API in a test.
// ---------------------------------------------------------------------------

/**
 * Starts a throwaway server on an OS-assigned port on 127.0.0.1, runs `run`
 * with its base URL, and always tears the server down afterwards - even if
 * `run` throws - so a failing test cannot leak a listening socket into the
 * next one.
 */
async function withServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/releases`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('fetchLatestReleaseTag: a normal response resolves the newest tag', async () => {
  await withServer(
    (req, res) => {
      // GitHub rejects an unauthenticated request with no User-Agent (verified
      // live: `curl ... --header "User-Agent:"` against the real API returns
      // 403), so the client sending one is load-bearing enough to assert on.
      assert.ok(req.headers['user-agent'], 'request must carry a User-Agent header');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([release('v0.1.1'), release('v0.1.2')]));
    },
    async (baseUrl) => {
      assert.equal(await fetchLatestReleaseTag(baseUrl, 2000), 'v0.1.2');
    },
  );
});

test('fetchLatestReleaseTag: a 403 (rate limit) resolves undefined, not a throw', async () => {
  await withServer(
    (_req, res) => {
      // The body is a well-formed, parseable releases array on purpose: this
      // must resolve undefined because of the status code, not merely
      // because a rate-limit error body happens not to parse as one.
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([release('v9.9.9')]));
    },
    async (baseUrl) => {
      assert.equal(await fetchLatestReleaseTag(baseUrl, 2000), undefined);
    },
  );
});

test('fetchLatestReleaseTag: a timeout resolves undefined, not a throw', async () => {
  await withServer(
    (_req, _res) => {
      // Never respond. The client's own timeout must be what ends this, not
      // the test relying on the server to misbehave in some other way.
    },
    async (baseUrl) => {
      assert.equal(await fetchLatestReleaseTag(baseUrl, 200), undefined);
    },
  );
});

test('fetchLatestReleaseTag: malformed JSON resolves undefined, not a throw', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{not valid json');
    },
    async (baseUrl) => {
      assert.equal(await fetchLatestReleaseTag(baseUrl, 2000), undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// First-run prompt: checkForUpdates defaults to false, so the user is offered
// the choice once - Enable / Not now / Never ask - on first activation after
// install. This is the pure state machine only; the UI call (showInformation-
// Message) belongs to extension.ts.
// ---------------------------------------------------------------------------

test('shouldOfferFirstRunPrompt: never asked before -> offer it', () => {
  assert.equal(shouldOfferFirstRunPrompt(undefined), true);
});

test('shouldOfferFirstRunPrompt: already answered "enable" -> do not offer again', () => {
  assert.equal(shouldOfferFirstRunPrompt('enable'), false);
});

test('shouldOfferFirstRunPrompt: already answered "not-now" -> do not offer again', () => {
  // The issue promises the choice once, not "remind me later" on a cadence -
  // so "Not now" is just as terminal as "Never ask" for whether to ask again.
  assert.equal(shouldOfferFirstRunPrompt('not-now'), false);
});

test('shouldOfferFirstRunPrompt: already answered "never" -> do not offer again', () => {
  assert.equal(shouldOfferFirstRunPrompt('never'), false);
});

test('shouldEnableUpdateChecks: "enable" turns checkForUpdates on', () => {
  assert.equal(shouldEnableUpdateChecks('enable'), true);
});

test('shouldEnableUpdateChecks: "not-now" leaves checkForUpdates off', () => {
  assert.equal(shouldEnableUpdateChecks('not-now'), false);
});

test('shouldEnableUpdateChecks: "never" leaves checkForUpdates off', () => {
  assert.equal(shouldEnableUpdateChecks('never'), false);
});
