import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

/**
 * Notify the user when a newer release exists (issue #1).
 *
 * VS Code disables its own update engine for a `.vsix` installed outside the
 * Marketplace, and there is no Marketplace listing here - permanently, by
 * design - so nothing else will ever tell the user a newer build exists.
 * This module polls the GitHub Releases API by hand and decides, purely,
 * whether to say something about it.
 *
 * `/releases/latest` cannot be used: it excludes pre-releases, and every
 * release of this project so far is published as a pre-release (verified
 * against the live API on 2026-09-23 - `gh api
 * repos/Dream-Mosaic/claude-limit-buster/releases/latest` returns 404, while
 * `.../releases` lists v0.1.2 and v0.1.1, both `"prerelease": true`). The
 * newest tag is derived from the releases list instead (see {@link newestTag}).
 */

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

export type VersionOrder = 'less' | 'equal' | 'greater' | 'unknown';

/**
 * Splits a version string into numeric segments, or undefined if it is not
 * one. Accepts an optional leading `v`/`V` (release tags carry one, the
 * running extension's `package.json` version does not) and any number of
 * dot-separated all-digit segments. Anything else - empty, non-numeric,
 * pre-release/build suffixes like `-rc.1` - is refused rather than guessed
 * at, because a guess here can only ever go one way: telling someone they are
 * behind when they are not.
 */
function parseVersion(raw: string): number[] | undefined {
  const stripped = raw.trim().replace(/^v/i, '');
  if (stripped === '') {
    return undefined;
  }
  const segments = stripped.split('.');
  const nums = segments.map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? undefined : nums;
}

/**
 * Compares two version-ish strings. `unknown` covers anything that fails to
 * parse on either side, and is deliberately not `greater`: this feeds a
 * "you are behind" notification, and a value that could not be understood
 * must never be able to trigger one (a malformed tag from a bad release, or a
 * `package.json` typo, fails silent rather than nags falsely).
 */
export function compareVersions(a: string, b: string): VersionOrder {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    return 'unknown';
  }
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) {
      return 'greater';
    }
    if (x < y) {
      return 'less';
    }
  }
  return 'equal';
}

// ---------------------------------------------------------------------------
// The decision: check the network, stay quiet, or tell the user
// ---------------------------------------------------------------------------

export interface UpdateCheckInput {
  /** This build's own version, from package.json - no leading `v`. */
  currentVersion: string;
  /** The newest tag known from the last successful check, if any. */
  latestTag: string | undefined;
  /** When that check ran, per Date.now(), if it ever has. */
  lastCheckedMs: number | undefined;
  /** Injected rather than read live, so this stays a pure function. */
  now: number;
  /** Minimum gap between two network checks. */
  intervalMs: number;
  /** The tag the user last dismissed a notification for, if any. */
  dismissedVersion: string | undefined;
}

export type UpdateCheckAction =
  | { kind: 'check' }
  | { kind: 'skip' }
  | { kind: 'notify'; latestTag: string }
  | { kind: 'quiet' };

/** "Cheap and infrequent" per the issue - one check a day at most. */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * `context.globalState` keys this module's cached state is expected to live
 * under. Exported so the wiring code and this module agree on names without
 * either side hard-coding the other's strings; namespaced under
 * `claudeLimitBuster.updateCheck.` to stay clear of scheduler.ts's
 * `claudeLimitBuster.pending` and extension.ts's `claudeLimitBuster.ready`.
 */
export const LAST_CHECKED_KEY = 'claudeLimitBuster.updateCheck.lastCheckedMs';
export const LATEST_TAG_KEY = 'claudeLimitBuster.updateCheck.latestTag';
export const DISMISSED_VERSION_KEY = 'claudeLimitBuster.updateCheck.dismissedVersion';
export const FIRST_RUN_PROMPT_KEY = 'claudeLimitBuster.updateCheck.firstRunPromptAnswer';

/**
 * What to do this activation, given the cached state and the clock.
 *
 * `check` fires whenever the interval has elapsed (or nothing has ever been
 * checked) - the caller performs the one network call this allows and then
 * calls this function again with `lastCheckedMs` and `latestTag` refreshed,
 * to get the notify/quiet verdict for the value it just fetched. That second
 * call cannot itself return `check` again, because by then `lastCheckedMs` is
 * `now`: the network call this decides is capped at once per activation, but
 * this pure function is cheap to call twice to get both the "should I fetch"
 * and "should I say something" answers out of the one fetch.
 *
 * Below the interval, the verdict comes from whatever is already cached:
 * `skip` when there is nothing cached to say anything about, `notify` when
 * the cached tag is newer than `currentVersion` and was not the one the user
 * already dismissed, and `quiet` for every other case - up to date, cached
 * tag is older (a pre-release ahead of the newest tag), the cached tag is
 * malformed (`compareVersions` returns `unknown`, never treated as newer),
 * or the user has already dismissed exactly this tag.
 */
export function decideUpdateCheck(input: UpdateCheckInput): UpdateCheckAction {
  const due = input.lastCheckedMs === undefined || input.now - input.lastCheckedMs >= input.intervalMs;
  if (due) {
    return { kind: 'check' };
  }
  if (input.latestTag === undefined) {
    return { kind: 'skip' };
  }
  if (input.latestTag === input.dismissedVersion) {
    return { kind: 'quiet' };
  }
  if (compareVersions(input.currentVersion, input.latestTag) === 'less') {
    return { kind: 'notify', latestTag: input.latestTag };
  }
  return { kind: 'quiet' };
}

// ---------------------------------------------------------------------------
// Fetching the releases list
// ---------------------------------------------------------------------------

export const RELEASES_URL = 'https://api.github.com/repos/Dream-Mosaic/claude-limit-buster/releases';

/** Where a human reads about a release, as opposed to where the API lists it. */
export const RELEASE_TAG_URL = (tag: string): string =>
  `https://github.com/Dream-Mosaic/claude-limit-buster/releases/tag/${encodeURIComponent(tag)}`;

/** GitHub returns 403 for an unauthenticated request with no User-Agent at all - verified live. */
const USER_AGENT = 'claude-limit-buster-update-check';

const DEFAULT_TIMEOUT_MS = 5000;

interface RawRelease {
  tag_name?: unknown;
  draft?: unknown;
}

/**
 * Picks the newest tag out of a parsed `/releases` response.
 *
 * Not `/releases/latest` - see the module doc comment for why that 404s for
 * this repo. Every non-draft entry with a parseable `tag_name` is compared
 * with {@link compareVersions}; the response's own order is not trusted as a
 * version sort (nothing in GitHub's docs promises one, only that it is
 * "sorted by most recent", which is a creation-time claim, not a semver one).
 * A draft is skipped because it has nothing published to point a user's
 * download link at. `undefined` covers an empty list, a response that is not
 * an array at all, and a list where nothing parses - every one of those is
 * "no information", not an error.
 */
export function newestTag(releases: unknown): string | undefined {
  if (!Array.isArray(releases)) {
    return undefined;
  }
  let best: string | undefined;
  for (const entry of releases) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { tag_name, draft } = entry as RawRelease;
    if (draft === true || typeof tag_name !== 'string') {
      continue;
    }
    // Comparing tag_name against itself is a cheap parseability check that
    // reuses compareVersions' own notion of "malformed" instead of a second
    // parser: a tag that cannot even equal itself cannot be trusted to
    // become `best` by default when it is the first (or only) entry seen.
    if (compareVersions(tag_name, tag_name) === 'unknown') {
      continue;
    }
    if (best === undefined || compareVersions(tag_name, best) === 'greater') {
      best = tag_name;
    }
  }
  return best;
}

/**
 * GET the repo's releases and return the newest tag, or `undefined` for
 * anything that goes wrong: a non-200 status (403 rate limit chief among
 * them), a request timeout, a network error, or a body that is not valid
 * JSON. None of those may ever throw into the caller - this runs on
 * extension activation, unprompted, and a network hiccup must be invisible.
 *
 * `url` and `timeoutMs` are parameters (rather than only reading
 * {@link RELEASES_URL}) so a test can point this at a local `node:http`
 * server instead of the real GitHub API; the client picks `node:http` or
 * `node:https` from the URL's own protocol, so an `http://127.0.0.1:port`
 * test URL and the real `https://api.github.com` URL both work unmodified.
 */
export function fetchLatestReleaseTag(
  url: string = RELEASES_URL,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      finish(undefined);
      return;
    }
    const client = parsed.protocol === 'http:' ? http : https;

    const req = client.get(
      url,
      { headers: { 'User-Agent': USER_AGENT }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain so the socket is released even though the body is unused
          finish(undefined);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            finish(newestTag(JSON.parse(body)));
          } catch {
            finish(undefined); // malformed JSON is "unknown", not an error
          }
        });
      },
    );
    // The `timeout` socket option fires an event; it does not abort the
    // request by itself, so destroy() is what actually stops it and lets
    // `finish` run instead of hanging until some far-off default timeout.
    req.on('timeout', () => {
      req.destroy();
      finish(undefined);
    });
    req.on('error', () => {
      finish(undefined); // offline, DNS failure, connection reset, ... all "unknown"
    });
  });
}

// ---------------------------------------------------------------------------
// First-run prompt
// ---------------------------------------------------------------------------

/**
 * `claudeLimitBuster.checkForUpdates` defaults to false - a network call the
 * user did not ask for is a surprise. To make the feature discoverable
 * without nagging, the user is offered a one-time choice on first activation
 * after install: Enable / Not now / Never ask.
 */
export type FirstRunPromptChoice = 'enable' | 'not-now' | 'never';

/**
 * Whether to show the first-run prompt, given whatever answer (if any) is
 * already in globalState.
 *
 * All three choices are equally terminal here: the issue promises the choice
 * "once", not a "remind me later" cadence, so "Not now" suppresses the
 * prompt exactly like "Never ask" does. They differ only in what
 * {@link shouldEnableUpdateChecks} does with them - "Not now" just declines
 * to turn the setting on, same as "Never ask" - the distinction is for the
 * user's own clarity when picking, not for this module's behaviour.
 */
export function shouldOfferFirstRunPrompt(storedAnswer: FirstRunPromptChoice | undefined): boolean {
  return storedAnswer === undefined;
}

/** What the wiring code should write to `claudeLimitBuster.checkForUpdates` after the prompt is answered. */
export function shouldEnableUpdateChecks(choice: FirstRunPromptChoice): boolean {
  return choice === 'enable';
}
