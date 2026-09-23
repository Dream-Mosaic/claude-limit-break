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
