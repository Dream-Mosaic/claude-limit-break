#!/usr/bin/env bash
#
# Verify a packaged .vsix ships what it must and nothing it must not.
#
# Called from both ci.yml (as a pull-request gate) and release.yml (before a
# release asset is published). The two workflows package for different reasons,
# but the contents must satisfy the same rules, and keeping two copies of the
# rules is how they drift apart.
#
# Usage: bash scripts/check-vsix.sh <path-to-vsix>
set -euo pipefail

vsix="${1:-}"
if [ -z "$vsix" ]; then
  echo "::error::usage: check-vsix.sh <path-to-vsix>"
  exit 2
fi
if [ ! -f "$vsix" ]; then
  echo "::error::no .vsix at $vsix"
  exit 2
fi

# Read the archive once, and insist it is readable before trusting anything it
# says. A half-written .vsix lists only its early entries, so checking files
# one at a time against a truncated archive reports whichever notice happens to
# sit late in the zip as "missing" - an error that sends you looking in the
# wrong place entirely.
if ! listing=$(unzip -l "$vsix" 2>&1); then
  echo "::error::could not read $vsix as an archive - it may be truncated"
  echo "$listing"
  exit 1
fi

# A well-formed listing ends with a totals line naming a file count. Without
# this, a zip that unzip parses leniently could still be short.
if [[ ! "$listing" =~ ([0-9]+)[[:space:]]+files? ]]; then
  echo "::error::$vsix does not look like a complete archive listing"
  echo "$listing"
  exit 1
fi
echo "Read $vsix: ${BASH_REMATCH[1]} entries."

failed=0

# MIT requires the notice to accompany the distributed artifact, and the
# artifact is the .vsix, not the repository. Nothing else would catch this.
#
# vsce renames LICENSE to extension/LICENSE.txt when packaging, so these are
# substring matches. Do not tighten them to exact paths - that would fail
# forever.
for f in LICENSE THIRDPARTY.md; do
  if [[ "$listing" == *"extension/$f"* ]]; then
    echo "ok: $f ships inside the .vsix"
  else
    echo "::error::$f is missing from the .vsix"
    failed=1
  fi
done

# .superpowers is gitignored, but vsce reads .vscodeignore and ignores
# .gitignore - so the whole development workspace once shipped to users inside
# the package. Assert it stays out.
if [[ "$listing" == *".superpowers"* ]]; then
  echo "::error::.superpowers is present in the .vsix"
  failed=1
else
  echo "ok: .superpowers is absent from the .vsix"
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "The .vsix contents are correct."
