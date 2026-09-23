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
