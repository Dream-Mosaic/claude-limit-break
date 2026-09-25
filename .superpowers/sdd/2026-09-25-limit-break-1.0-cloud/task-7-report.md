# Task 7 report: Icon and brand assets

## What I implemented

Copied the five user-supplied final assets from
`.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/assets/` into `media/` at
the repo root, byte for byte:

| Source | Repo path |
|---|---|
| `Limit Break-ICO.png` | `media/icon.png` |
| `Limit Break-color.png` | `media/logo.png` |
| `Limit Break Logo.png` | `media/banner.png` |
| `Limit Break-mono.png` | `media/logo-mono.png` |
| `logo-mono.svg` | `media/logo-mono.svg` |

`logo-mono.svg` is the user-approved "no square" variant (frame, "Limit" and
gauge in `currentColor` on transparent) and was shipped as-is, unedited.

Set `"icon": "media/icon.png"` in `package.json` (added after `"license"`).

Extended `.vscodeignore` to exclude the four assets that should not ship in
the VSIX (`media/logo.png`, `media/banner.png`, `media/logo-mono.png`,
`media/logo-mono.svg`), leaving `media/icon.png` unignored so it packages.

Extended `scripts/check-vsix.sh` (it already asserts VSIX contents, e.g.
LICENSE/THIRDPARTY.md/CHANGELOG.md and the absence of `.superpowers`) to also
assert `media/icon.png` ships and the other four media files do not.

## Files changed

- `media/icon.png`, `media/logo.png`, `media/banner.png`,
  `media/logo-mono.png`, `media/logo-mono.svg` (new)
- `package.json` (`"icon": "media/icon.png"`)
- `.vscodeignore` (exclude the four non-icon media files)
- `scripts/check-vsix.sh` (new assertions)

## cmp results (all byte-identical)

```
cmp ".../assets/Limit Break-ICO.png" media/icon.png        -> icon OK
cmp ".../assets/Limit Break-color.png" media/logo.png      -> logo OK
cmp ".../assets/Limit Break Logo.png" media/banner.png     -> banner OK
cmp ".../assets/Limit Break-mono.png" media/logo-mono.png  -> logo-mono.png OK
cmp ".../assets/logo-mono.svg" media/logo-mono.svg         -> logo-mono.svg OK
```
No `cmp` reported a difference (all five exited 0, no output).

## TDD evidence

**RED** — extended `check-vsix.sh` first, then built the VSIX from the
*pre-fix* tree (media/ files present on disk, but `.vscodeignore` not yet
updated and `package.json` missing `"icon"`), so all five media files shipped:

```
$ npx @vscode/vsce package -o limit-buster.vsix
...
   ├─ media/
   │  ├─ banner.png [424.23 KB]
   │  ├─ icon.png [9.94 KB]
   │  ├─ logo-mono.png [9.96 KB]
   │  ├─ logo-mono.svg [1.55 KB]
   │  └─ logo.png [25.77 KB]
...
$ bash scripts/check-vsix.sh limit-buster.vsix; echo "exit=$?"
ok: media/icon.png ships inside the .vsix
::error::media/logo.png is present in the .vsix and should not be
::error::media/banner.png is present in the .vsix and should not be
::error::media/logo-mono.png is present in the .vsix and should not be
::error::media/logo-mono.svg is present in the .vsix and should not be
exit=1
```

**GREEN** — applied the fix (`"icon"` in `package.json`, four exclusions in
`.vscodeignore`), rebuilt:

```
$ npx @vscode/vsce package -o limit-buster.vsix
...
   ├─ media/
   │  └─ icon.png [9.94 KB]
...
 DONE  Packaged: limit-buster.vsix (33 files, 99.34 KB)
$ bash scripts/check-vsix.sh limit-buster.vsix; echo "exit=$?"
ok: LICENSE ships inside the .vsix
ok: THIRDPARTY.md ships inside the .vsix
ok: CHANGELOG.md ships inside the .vsix
ok: .superpowers is absent from the .vsix
ok: media/icon.png ships inside the .vsix
ok: media/logo.png is absent from the .vsix
ok: media/banner.png is absent from the .vsix
ok: media/logo-mono.png is absent from the .vsix
ok: media/logo-mono.svg is absent from the .vsix
The .vsix contents are correct.
exit=0
```

## Mutation (break-and-restore, done by hand — shell script, not a `.ts`
file, so `mutate.py` doesn't apply)

Backed up `.vscodeignore`, removed the `media/logo-mono.svg` exclusion line
with `sed`, rebuilt the VSIX, and reran the check:

```
$ sed -i '/^media\/logo-mono\.svg$/d' .vscodeignore
$ npx @vscode/vsce package -o limit-buster.vsix
$ bash scripts/check-vsix.sh limit-buster.vsix; echo "exit=$?"
ok: media/logo.png is absent from the .vsix
ok: media/banner.png is absent from the .vsix
ok: media/logo-mono.png is absent from the .vsix
::error::media/logo-mono.svg is present in the .vsix and should not be
exit=1
```

Confirmed the check goes red for exactly the mutated guard. Restored
`.vscodeignore` from the backup, rebuilt, reran the check: back to `exit=0`
with all nine `ok:` lines (shown above under GREEN).

## `npx @vscode/vsce ls` (final state)

```
CHANGELOG.md
LICENSE
README.md
THIRDPARTY.md
package.json
media/icon.png
out/src/autoContinue.js
out/src/budget.js
out/src/claims.js
out/src/config.js
out/src/extension.js
out/src/holderPolicy.js
out/src/liveSessions.js
out/src/log.js
out/src/panelTab.js
out/src/policy.js
out/src/randomDelay.js
out/src/reopenOffer.js
out/src/resumer.js
out/src/scheduler.js
out/src/sessionRegistry.js
out/src/sessionResolver.js
out/src/sound.js
out/src/stallWatch.js
out/src/statusBar.js
out/src/transcriptWatcher.js
out/src/trust.js
out/src/updateCheck.js
out/src/parsers/inputParser.js
out/src/parsers/limitParser.js
out/src/parsers/overloadParser.js
```

`media/icon.png` is the only media file listed; the four excluded assets
(`logo.png`, `banner.png`, `logo-mono.png`, `logo-mono.svg`) do not appear.
`npx @vscode/vsce package` ran cleanly with no complaints about `repository`,
`icon`, `license`, or `engines` — no unrelated package.json fields were
touched.

The built `.vsix` was deleted after each check (`rm -f limit-buster.vsix`);
none is left in the repo (`git status --short` is clean, `find . -name
"*.vsix"` outside `node_modules` returns nothing).

## Unit suite

```
$ npm test > /tmp/t7.log 2>&1; echo "exit=$?"
exit=0
# tests 483
# pass 483
# fail 0
```

## Integration tests changed or affected

None. This task only touched packaging config (`package.json`,
`.vscodeignore`), a packaging shell script (`scripts/check-vsix.sh`), and
added static `media/` assets — no `.ts` source or `test/*.ts` files changed,
so no integration test is affected. `npm run test:integration` was not run
(container network policy blocks the VS Code download, per the global
constraints) and did not need to be for this task.

## Commits

- `1ed70df` `test: assert the VSIX ships only the Marketplace icon` —
  extends `scripts/check-vsix.sh` (RED evidence above is against this
  commit's version of the script, before the `feat` commit's fix).
- `58b3c3a` `feat: Limit Break icon and brand assets` — the five `media/`
  assets, `package.json` icon field, `.vscodeignore` exclusions.

## Self-review

- Completeness against the brief's table: all five source files copied to
  the exact repo paths specified; verified.
- Byte-identical copies: confirmed via `cmp` (see above), no re-encoding.
- No extra files: `git status --short` clean after both commits; only the
  five `media/*` files, `package.json`, `.vscodeignore`, and
  `scripts/check-vsix.sh` changed across the two commits.
- VSIX contains exactly what it should: `media/icon.png` only, confirmed by
  both the `vsce ls` listing and `check-vsix.sh`.
- Output pristine: no leftover `.vsix`, no stray temp files in the repo
  (backup used `/tmp/vscodeignore.bak`, outside the repo).
- YAGNI: did not touch `repository`/`license`/`engines` fields (brief said
  to report, not fix, if vsce objected — it didn't object, so nothing to
  report there); did not add the SVG or the other media files to the
  package, matching the brief's "not now" ruling; did not rename any
  user-facing strings (constraint 10 — none were touched, this task is
  packaging-only).

## Concerns

None. `npx @vscode/vsce package` and `ls` completed without any warnings
about `repository`, `icon`, `license`, or `engines`, so there was nothing to
report on that front.
