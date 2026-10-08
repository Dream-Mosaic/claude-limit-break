import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

/**
 * Notify the user when a newer release exists.
 *
 * VS Code disables its update engine for a `.vsix` installed outside the Marketplace, so nothing else will tell the user a newer build exists. This module polls the GitHub Releases API by hand and decides, purely, whether to say something.
 *
 * `/releases/latest` excludes pre-releases and returns 404 for a project with only those, so the newest tag is derived from the releases list instead (see {@link newestTag}).
 */

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

export type VersionOrder = 'less' | 'equal' | 'greater' | 'unknown';

/**
 * Splits a version string into numeric segments, or undefined if it is not one. Accepts an optional leading `v`/`V` and any number of dot-separated all-digit segments. Anything else (empty, non-numeric, pre-release/build suffixes like `-rc.1`) is refused rather than guessed at, since a guess can only wrongly tell someone they are behind.
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
 * Compares two version-ish strings. `unknown` covers anything that fails to parse on either side and is deliberately not `greater`: a value that could not be understood must never trigger a "you are behind" notification.
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

/** One network check a day at most. */
export const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * `context.globalState` keys this module's cached state lives under, exported so the wiring code and this module agree on names. Namespaced under `claudeLimitBreak.updateCheck.` to stay clear of scheduler.ts's `claudeLimitBreak.pending` and extension.ts's `claudeLimitBreak.ready`.
 */
export const LAST_CHECKED_KEY = 'claudeLimitBreak.updateCheck.lastCheckedMs';
export const LATEST_TAG_KEY = 'claudeLimitBreak.updateCheck.latestTag';
export const DISMISSED_VERSION_KEY = 'claudeLimitBreak.updateCheck.dismissedVersion';
export const FIRST_RUN_PROMPT_KEY = 'claudeLimitBreak.updateCheck.firstRunPromptAnswer';

/**
 * What to do this activation, given the cached state and the clock.
 *
 * `check` fires whenever the interval has elapsed (or nothing has ever been checked); the caller performs the one network call and calls this again with `lastCheckedMs` and `latestTag` refreshed to get the verdict for the fetched value. That second call cannot return `check` again, since `lastCheckedMs` is then `now`.
 *
 * Below the interval the verdict comes from the cache: `skip` when nothing is cached, `notify` when the cached tag is newer than `currentVersion` and not the one the user dismissed, and `quiet` otherwise (up to date, cached tag older, malformed tag, or already dismissed).
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

export const RELEASES_URL = 'https://api.github.com/repos/Dream-Mosaic/claude-limit-break/releases';

/** Where a human reads about a release, as opposed to where the API lists it. */
export const RELEASE_TAG_URL = (tag: string): string =>
  `https://github.com/Dream-Mosaic/claude-limit-break/releases/tag/${encodeURIComponent(tag)}`;

/** GitHub returns 403 for a request with no User-Agent. */
const USER_AGENT = 'claude-limit-break-update-check';

const DEFAULT_TIMEOUT_MS = 5000;

interface RawRelease {
  tag_name?: unknown;
  draft?: unknown;
}

/**
 * Picks the newest tag out of a parsed `/releases` response.
 *
 * Every non-draft entry with a parseable `tag_name` is compared with {@link compareVersions}; the response's own order is not trusted as a version sort ("sorted by most recent" is a creation-time claim). A draft has nothing published to link to. `undefined` covers an empty list, a non-array response, and a list where nothing parses: "no information", not an error.
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
    // Comparing tag_name against itself is a cheap parseability check reusing compareVersions' notion of "malformed": a tag that cannot equal itself must not become `best` by default as the first entry seen.
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
 * GET the repo's releases and return the newest tag, or `undefined` for anything that goes wrong (non-200 such as a 403 rate limit, timeout, network error, invalid JSON). None may throw into the caller: this runs unprompted on activation and a network hiccup must be invisible.
 *
 * `url` and `timeoutMs` are parameters so a test can point this at a local `node:http` server; the client picks `node:http` or `node:https` from the URL's protocol.
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
    // The `timeout` socket option only fires an event; destroy() is what stops the request and lets `finish` run.
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
 * `claudeLimitBreak.checkForUpdates` defaults to false, since a network call the user did not ask for is a surprise. To keep the feature discoverable, the user is offered a one-time choice on first activation after install: Enable / Not now / Never ask.
 */
export type FirstRunPromptChoice = 'enable' | 'not-now' | 'never';

/**
 * Whether to show the first-run prompt, given whatever answer (if any) is already in globalState.
 *
 * All three choices suppress the prompt: it is offered once, with no "remind me later". Only Enable turns the setting on (see {@link shouldEnableUpdateChecks}).
 */
export function shouldOfferFirstRunPrompt(storedAnswer: FirstRunPromptChoice | undefined): boolean {
  return storedAnswer === undefined;
}

/** What the wiring code should write to `claudeLimitBreak.checkForUpdates` after the prompt is answered. */
export function shouldEnableUpdateChecks(choice: FirstRunPromptChoice): boolean {
  return choice === 'enable';
}
