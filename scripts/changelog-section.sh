#!/usr/bin/env bash
# Prints one version's section of CHANGELOG.md, without its "## [x.y.z]" heading:
# everything up to the next "## " heading. The release page carries this text, the
# same notes VS Code shows on the extension's Changelog tab.
#
# Usage: scripts/changelog-section.sh <version> [changelog]
# Exits 1 when the version has no section or the section is empty.
set -euo pipefail

version="${1:?usage: changelog-section.sh <version> [changelog]}"
changelog="${2:-CHANGELOG.md}"

# The heading is "## [1.0.0] - date" or "## 1.0.0 ..."; the version is compared as a
# string, so its dots are not regex wildcards. Trailing blank lines are dropped.
section="$(awk -v v="$version" '
  /^## / {
    if (found) exit
    h = $0
    sub(/^## \[?/, "", h)
    sub(/[] ].*$/, "", h)
    if (h == v) { found = 1; next }
  }
  found
' "$changelog")"

if [ -z "${section//[[:space:]]/}" ]; then
  echo "::error::$changelog has no non-empty '## [$version]' section." >&2
  exit 1
fi
printf '%s\n' "$section"
