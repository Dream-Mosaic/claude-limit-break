# Task 8 report: Rename everything to Limit Break

Branch `claude/limit-break-1.0-cloud`, base `5392b80`. One commit: `32a1515`.

## Old -> new mapping

| Kind | Old | New |
|---|---|---|
| Package name | `claude-limit-buster` | `claude-limit-break` |
| Display name | `Claude Limit Buster` | `Limit Break` |
| Description | "Waits out Claude Code usage limits and resumes your session by ID." | "Watches Claude Code transcripts for usage limits and resumes your session automatically." |
| Repo URL | `github.com/Dream-Mosaic/claude-limit-buster` | `github.com/Dream-Mosaic/claude-limit-break` (package.json `repository.url`, updateCheck.ts `RELEASES_URL`/`RELEASE_TAG_URL`, CI/release VSIX names) |
| Command/setting id namespace | `claudeLimitBuster.*` | `claudeLimitBreak.*` (5 commands, 1 menu entry, configuration title, 17 settings, `NS` const in extension.ts, `TRUST_COMMAND` in statusBar.ts) |
| globalState key: pending job | `claudeLimitBuster.pending` | `claudeLimitBreak.pending` (`STATE_KEY` in scheduler.ts) |
| globalState key: ready jobs (#11) | `claudeLimitBuster.ready` | `claudeLimitBreak.ready` (`READY_KEY` in extension.ts) |
| globalState keys: update-check | `claudeLimitBuster.updateCheck.{lastCheckedMs,latestTag,dismissedVersion,firstRunPromptAnswer}` | `claudeLimitBreak.updateCheck.*` (updateCheck.ts) |
| Output channel / status bar name | `Claude Limit Buster` | `Limit Break` |
| Log prefix | `createLogger('limit-buster', ...)` | `createLogger('limit-break', ...)` |
| Message prefixes | `Claude Limit Buster: ...` | `Limit Break: ...` (extension.ts, gaveUp.ts, holderPolicy.ts, reopenOffer.ts) |
| Terminal name prefix | `Limit Buster: ` | `Limit Break: ` (resumer.ts: resume terminal `Limit Break: <id8>`, trust terminal `Limit Break: Trust <folder>`) |
| Update-check `User-Agent` | `claude-limit-buster-update-check` | `claude-limit-break-update-check` |
| Integration test extension id | `dream-mosaic.claude-limit-buster` | `dream-mosaic.claude-limit-break` |
| Integration probe view types (internal only, no user-facing meaning) | `claudeLimitBusterProbeViewType`, `claudeLimitBusterProbeSerializer` | `claudeLimitBreakProbeViewType`, `claudeLimitBreakProbeSerializer` |
| VSIX filenames (workflows) | `limit-buster.vsix`, `claude-limit-buster-<version>.vsix` | `limit-break.vsix`, `claude-limit-break-<version>.vsix` |

Untouched by design (per brief's exception): the resume-prompt default text
`"[Limit Break] I hit my usage limit..."` (Task 6, specified verbatim) — was
already correct, confirmed unchanged. `src/claims.ts`'s claim directory was
already `claude-limit-break` under `os.tmpdir()` — checked, not touched.

## Files changed (21, all mechanical string renames; `git diff --stat`)

```
.github/workflows/ci.yml              |   6 +-
.github/workflows/release.yml         |   2 +-
package-lock.json                     |   4 +-
package.json                          |  72 ++++++-------
src/extension.ts                      |  40 +++----
src/gaveUp.ts                         |  12 +--
src/holderPolicy.ts                   |   4 +-
src/reopenOffer.ts                    |   4 +-
src/resumer.ts                        |   4 +-
src/scheduler.ts                      |   2 +-
src/statusBar.ts                      |  10 +-
src/updateCheck.ts                    |  24 ++---
test/config.test.ts                   |   6 +-
test/extension.test.ts                | 190 +++++++++++++++++-----------------
test/gaveUp.test.ts                   |   4 +-
test/holderPolicy.test.ts             |   2 +-
test/integration/extension.itest.ts   |   6 +-
test/integration/panelReopen.itest.ts |   6 +-
test/resumer.test.ts                  |   6 +-
test/scheduler.test.ts                |   6 +-
test/statusBar.test.ts                |  10 +-
21 files changed, 210 insertions(+), 210 deletions(-)
```

Method: an ordered, whole-string replace (most-specific dashed/camel forms
first, then bare `limit-buster`, then the two-word display forms longest
first) applied to package.json by hand-edit, then the same rules applied via
a small Node script to the remaining 20 files. `package.json`'s `description`
was additionally hand-reworded since it never literally said "Buster".
Verified `package.json` stays valid JSON, `tsc -p . --noEmit` is clean, and
TDD constraint 5 is naturally satisfied here: tests pin the same strings as
the source, so old-name tests would fail against renamed source and vice
versa — both suites were run only after both sides were renamed together
(mechanical rename, not new behaviour, so no new guard to mutate per
constraint 5's mutation clause).

## Grep gate

Command (cloud-lane version, `--exclude-dir` adds `.superpowers`,
`.vscode-test` to the brief's list):
```
grep -rniE "limit.?buster|claudeLimitBuster" \
  --exclude-dir={node_modules,out,.git,docs,.superpowers,.vscode-test} .
```

**Before:** 227 hits across 21 files (the same 21 above, plus README.md,
CHANGELOG.md, test/trust.test.ts).

**After:** 18 hits, all intentional, all outside the 21 files this task
changed:

- `README.md` (9 hits) — Task 9's job; brief and cloud-lane notes both say
  leave it alone here "except where a test or script greps it," and nothing
  in `scripts/`, `.github/`, `test/`, `package.json` or `.vscodeignore`
  greps README (checked).
- `CHANGELOG.md` (7 hits) — historical entries under old dated releases;
  brief names this file explicitly as the example of an intentional
  survivor ("for example the CHANGELOG's history"). Task 9b writes the
  1.0.0 entry; the old entries record what was true then.
- `test/trust.test.ts` (2 hits) — a dated code comment ("Observed on the
  development machine, 2026-09-23: ...") quoting the literal folder-path
  strings VS Code and the Claude CLI disagreed on at the time, which is the
  finding the test below it exists to pin. Same character as the CHANGELOG
  exception: a record of an observed fact tied to the old folder name, not
  a live reference to the extension's identity. No test assertion depends
  on this string; it is a comment only.

## Suite / check-vsix results

- Unit: `npm test > /tmp/t8.log 2>&1; echo "exit=$?"` -> `exit=0`, 609/609
  passing.
- Integration: `xvfb-run -a npm run test:integration > /tmp/it8.log 2>&1;
  echo "exit=$?"` -> `exit=0`, 9/9 passing (including "the extension is
  present and activates" against the new id `dream-mosaic.claude-limit-break`
  and the "claude-limit-break activation" suite name). VS Code's own
  "Failed to fetch" / SSL handshake lines in the log are background
  Marketplace/GitHub traffic, not test noise (per constraint 6).
- `bash scripts/check-vsix.sh <vsix>`: packaged with `npx @vscode/vsce
  package --out /tmp/claude-limit-break-test.vsix`, ran check-vsix.sh against
  it -> all checks ok, "The .vsix contents are correct." Deleted the .vsix
  afterward (never left in the repo tree; `git status` stayed clean of it
  throughout).
- `npx @vscode/vsce ls`: prints the file listing only, no header line with a
  package name to verify (checked — the tool's output for this project has
  no such header), so nothing further to confirm there.
- `npx tsc -p . --noEmit`: clean.

## Self-review

- `git diff --stat` matches the file list above; no unexpected files
  touched (`out/`, `node_modules/`, `docs/`, `.superpowers/`,
  `.vscode-test/` all untouched, confirmed via `git status --porcelain`
  before/after).
- Working tree is clean after the commit; no stray `.vsix` left.
- `src/claims.ts` checked per the task's context note: already
  `claude-limit-break` under `os.tmpdir()`; not modified.
- Resume-prompt default (Task 6) checked unchanged, matches pre-flight row
  T6/T8.
- Did not touch `.superpowers/`, `docs/research/`, `docs/design/`,
  `docs/superpowers/plans/`, or README.md, per instructions.
- Did not commit this report file (per instructions); it sits untracked
  alongside the task-8 brief.

## Concerns

None. This was a mechanical, fully-covered rename: the grep gate confirms
no unintentional survivor, both suites are green, and the three remaining
survivor groups are each independently justified by the brief itself
(README deferred to Task 9b, CHANGELOG history explicitly named as the
brief's own example, and one dated historical test comment of the same
character).
