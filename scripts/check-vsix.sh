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

# Read the archive once, as bare entry names, and insist it is readable before
# trusting anything it says. A half-written .vsix lists only its early entries,
# so checking files one at a time against a truncated archive reports whichever
# notice happens to sit late in the zip as "missing" - an error that sends you
# looking in the wrong place entirely.
if ! names=$(unzip -Z1 "$vsix" 2>&1); then
  echo "::error::could not read $vsix as an archive - it may be truncated"
  echo "$names"
  exit 1
fi

count=$(printf '%s\n' "$names" | grep -c . || true)
if [ "$count" -lt 2 ]; then
  echo "::error::$vsix holds $count entries, which is not a complete package"
  exit 1
fi
echo "Read $vsix: $count entries."

failed=0

# MIT requires the notice to accompany the distributed artifact, and the
# artifact is the .vsix, not the repository. Nothing else would catch this.
#
# vsce renames LICENSE to extension/LICENSE.txt when packaging, so the match
# has to tolerate an added extension - but anchored, so a stray
# LICENSE_THIRDPARTY.md could not satisfy the LICENSE requirement by accident.
# CHANGELOG.md is here for a different reason than the notices: VS Code renders
# it in the extension's Changelog tab from inside the installed package, and
# with no Marketplace listing it is the only in-editor account of what changed.
for f in LICENSE THIRDPARTY.md CHANGELOG.md; do
  # Case-insensitive: vsce keeps LICENSE but lowercases CHANGELOG.md and
  # README.md when it packages them. Still anchored, so a stray
  # LICENSE_THIRDPARTY.md cannot satisfy the LICENSE requirement.
  if printf '%s\n' "$names" | grep -qiE "^extension/${f//./\\.}(\.[A-Za-z]+)?$"; then
    echo "ok: $f ships inside the .vsix"
  else
    echo "::error::$f is missing from the .vsix"
    failed=1
  fi
done

# .superpowers is gitignored, but vsce reads .vscodeignore and ignores
# .gitignore - so the whole development workspace once shipped to users inside
# the package. Assert it stays out.
if printf '%s\n' "$names" | grep -q "\.superpowers"; then
  echo "::error::.superpowers is present in the .vsix"
  failed=1
else
  echo "ok: .superpowers is absent from the .vsix"
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "The .vsix contents are correct."
