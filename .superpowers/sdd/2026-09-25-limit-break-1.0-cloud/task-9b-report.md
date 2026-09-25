# Task 9b report: Docs for the 1.0.0 release

Branch `claude/limit-break-1.0-cloud`, base `4f87eb9`. Per the controller
ruling: docs only. No `release/1.0.0` branch, no version bump, no branch
switch — `package.json` `version` stays `0.1.2`.

## Files changed

- `package.json` — reworded the `statusBar` "pending" enum description.
- `CHANGELOG.md` — added the `## [1.0.0] - 2026-09-25` entry.
- `README.md` — full rewrite.
- `docs/NEXT.md` — full refresh.
- `test/readmeSettings.test.ts` — new: parses the README settings table and
  checks it against `package.json`.

Commits (4, one per logical unit, each carrying the two trailer lines):
1. `daebbe6` `fix(config): reword the statusBar "pending" description`
2. `90d13f0` `docs(changelog): add the 1.0.0 entry`
3. `b23eeaa` `docs(readme): rewrite for the Limit Break 1.0 release` (README + the new test, together — the test exists to hold the README's own claim accountable)
4. `432b086` `docs(next): refresh for 1.0 - open items only`

## README outline

1. Title, banner (`media/banner.png` via its GitHub raw URL — not shipped in
   the VSIX), one-line description, "formerly Claude Limit Buster" pointer to
   Install.
2. What it does
3. How it resumes
4. **Works with Claude Code's own auto-continue** (new) — a table: idle
   panel resumes; busy/waiting panel or terminal stands down silently; idle
   terminal with native auto-continue on stands down, off notifies with
   "Resume in Terminal Anyway"; a different session busy in the same folder
   resumes with a SendMessage coordination sentence appended to its prompt;
   then a paragraph on the cross-window file claim (`src/claims.ts`) for the
   near-simultaneous case the holder check can't see.
5. **What you will see** (rewritten per the Task 5b addendum) — the three
   status-bar texts (`Claude resumes in …`, `Claude ready to resume`,
   `Resume gave up`, with gave-up winning when both apply), the one-line-per-
   session tooltip and its "Open Claude to Trust" link, the status-bar menu
   including "Dismiss gave-up notices" (shown only when something has given
   up), and the `statusBar: pending` behaviour restated to match the reworded
   package.json description.
6. The panel tab after a resume (kept, setting id updated)
7. Token budget (kept; default updated to 500000, usage-record-first
   estimate and the "Resume anyway"/gave-up connection made explicit)
8. Install — the brief's install note verbatim, new repo/tag/filename
   throughout (`claude-limit-break`)
9. Settings — full 18-row table (see below)
10. Versioning and releases (kept, ids updated)
11. **Staying up to date** (rewritten) — describes `checkForUpdates` and its
    one-time first-run Enable/Not now/Never ask prompt, in addition to the
    "watch the repo" fallback
12. Development — added a line pointing at the new settings-table test
13. License, Acknowledgements (kept)

## Settings-table verification

Added `test/readmeSettings.test.ts` (part of `npm test`, so it runs on every
future change too). It:
- Splits the README's `## Settings` section into table rows, requiring each
  Setting/Default cell to be backtick-quoted (handling the two combined rows,
  `alertSound`/`alertSoundFile` and `randomDelayMinMinutes`/
  `randomDelayMaxMinutes`, by splitting on `" / "` before stripping
  backticks, so names and defaults stay paired by position).
- Reads `package.json`'s `contributes.configuration.properties`.
- Asserts, for every `claudeLimitBreak.*` property: it is listed exactly
  once, and its rendered default (`""` for an empty string, `String(value)`
  otherwise) matches the table's Default cell.
- Asserts every name the table lists is actually declared in `package.json`
  (no extras).

TDD: wrote the test against the already-written README (both had to be
authored together — the table is the thing under test), then ran three
mutations to confirm it fails for the right reason before trusting it green:
1. Changed `maxResumeTokens`'s README default to `150000` → failed on the
   default-mismatch assertion.
2. Deleted the `checkForUpdates` row entirely → failed on the "package.json
   declares X, table is missing it" assertion.
3. Restored the README, reran → green (1/1), confirming the mutation was the
   only thing that had broken it.
All three README edits were reverted (`cp` from a `/tmp` backup) before
committing; `git status` was clean of the mutation before the README commit.

The full suite (610/610, including this test) and a live `npx tsc -p .`
compile were run after restoring.

## CHANGELOG entry (pasted in full)

```markdown
## [1.0.0] - 2026-09-25

**Limit Break** is a new name for what shipped as **Claude Limit Buster**
through 0.1.2: package id `claude-limit-break`, extension id
`dream-mosaic.claude-limit-break`, and every setting and command moved from
`claudeLimitBuster.*` to `claudeLimitBreak.*`.

Limit Break is a new extension id. Uninstall Claude Limit Buster 0.1.x first;
its settings do not carry over.

### Added

- Coordinates with Claude Code's own session state and with other Claude
  sessions instead of always spawning a second `claude --resume` against the
  same session. An idle Claude Code panel still resumes unattended - the main
  use case - and the existing stale-tab handling runs after it exactly as
  before. A panel or terminal that is already busy or waiting is left alone. An
  idle terminal defers to Claude Code's own "Continue automatically at usage
  limit" setting when it is on, and only offers "Resume in Terminal Anyway"
  when it is off. A different session busy or waiting in the *same folder*
  still gets resumed, with a sentence added to its opening prompt asking it to
  message the busy session via SendMessage before editing anything, rather
  than being blocked.
- A machine-wide, filesystem-based claim so that two VS Code windows watching
  the same account do not both launch a resume for the same reset - the
  scenario that motivated this release: two windows detected an identical
  limit within milliseconds of each other and each fired its own terminal.
- A distinct "gave up" status for a resume this window has stopped retrying on
  its own: a launch that stalled (its transcript never grew), no `claude`
  executable found, the session's folder no longer exists, or a token-budget
  refusal that was dismissed rather than overridden. Each shows in the status
  bar with its own icon and a reason, and a "Dismiss gave-up notices" menu item
  clears them without discarding any resume still waiting.
- `claudeLimitBreak.watchScope`: watch every Claude session on the machine (the
  previous, and still default, behaviour) or only sessions inside this
  window's workspace.
- `claudeLimitBreak.checkForUpdates`, off by default: checks GitHub once a day
  for a newer release and says so, since a `.vsix` install never shows up as
  outdated on its own. A one-time prompt on first activation offers to turn it
  on.
- A trust hotlink. When a folder is not trusted by the Claude CLI, the
  scheduling notification and the status-bar tooltip both offer "Open Claude to
  Trust", which opens a plain `claude` terminal in that folder so you answer
  the CLI's own trust prompt yourself - the extension never answers it and
  never writes to `~/.claude.json`.
- The status-bar tooltip now lists every waiting, ready, and gave-up session as
  its own line, instead of describing only the soonest one.
- Detects two more cases as an overload rather than a usage limit - a retry
  Claude Code is already handling in-flight, and a stream interrupted because
  the machine went to sleep - and a transient 429 that explicitly disclaims
  being a usage limit. Reads the transcript's own `quotaLimits.resetsAt` field
  ahead of parsing the banner text when a rate-limit entry carries one, which
  gets calendar dates, time zones and same-day rollovers right without
  depending on the wording of a message this extension does not control.
- A new icon and brand assets, including the banner above.

### Changed

- `claudeLimitBreak.maxResumeTokens` default raised from 150,000 to 500,000,
  and the estimate now reads the transcript's newest `usage` record - the live
  context a cold resume actually has to rebuild - falling back to a byte count
  only when there is none.
- `claudeLimitBreak.resumePrompt` default is now "[Limit Break] I hit my usage
  limit while you were working, but it has reset now. Please continue from
  where you left off."
- Dropped support for VS Code below 1.138; CI and development now target
  Node 24.
- Repository hardening: SHA-pinned GitHub Actions, branch and tag protection
  rulesets, a SECURITY.md, Dependabot.

### Fixed

- `headless` resume mode is now actually routed to a headless launch. It was
  declared in settings but silently fell through to the interactive path.
- A reset time given with no explicit time zone now resolves both the
  spring-forward and fall-back daylight-saving hours to the correct side,
  instead of landing up to an hour off.
- Untrusted transcript text (a `grep` quoting a banner, a subagent checkpoint
  note, a percentage-usage warning) no longer arms a timer by accident;
  subagent transcripts and quoted or tool-result text are excluded from that
  path the same way a genuinely flagged entry is not.
- A single click on the status bar no longer cancels the pending resume
  outright; it opens a menu (Resume Now / Cancel Pending Resume / Show Log /
  Dismiss gave-up notices when something has given up).
- `CLAUDE_CONFIG_DIR` is honoured everywhere `~/.claude` would otherwise be
  read (trust status, and now Claude Code's own auto-continue setting).
- Project paths are case-folded only on filesystems that are actually
  case-insensitive, instead of always.
- A resume whose recorded working directory turns out to be a file, not a
  folder, is refused with a named reason instead of failing unpredictably.
```

Built from `git log --oneline v0.1.2..HEAD -- . ':!.superpowers'` (~150
commits) plus the 8 task reports under this SDD folder and both lanes'
ledgers, grouped by user-visible effect rather than one bullet per commit, as
the addenda ask. Confirmed against source, not just commit subjects, for the
items I was least sure of: `headless` routing (`4369bf8` +
`resumer.ts`/`extension.ts` read), the `maxResumeTokens` default
(`test/config.test.ts` asserts `500_000`), the single-click-opens-a-menu fix
(`statusBar.ts`'s `command = statusBarMenu`, `extension.ts`'s
`statusBarMenu` registration), and `CLAUDE_CONFIG_DIR` (`autoContinue.ts`,
`trust.ts`).

## NEXT.md outline

1. Settled (trimmed: copyright/attribution, packaging gate, no-Marketplace
   distribution, the new extension identity)
2. Known limitations — the two-windows item, rewritten: what Task 10's
   cross-window claim covers (all automatic fires and all 4 manual bypass
   paths, 3 review rounds) and what it does not (O_EXCL verified only
   sequentially in-process; scoped to one OS user's `os.tmpdir()`)
3. Deferred review findings, grouped by area (Detection/parsing, Trust
   hotlink, Gave-up state, Tooltip/status bar, Same-folder coordination),
   each with a one-line why, a file (and line range where stable) or test
   name, and the reviewer's stated cost-if-wrong
4. Open questions — the unverified transient-429/`quotaLimits` JSONL shape
   (Task 4a), and the claim's untested true-concurrency guarantee (Task 10)
5. v1.1 ideas — the Limit Break sidebar (icon, the 24px/`~2px` margin ruling,
   the "consider a gauge-only crop" open question) and the synthesis doc's
   "Consider" list, each re-checked against current `HEAD`

### Ledger items dropped as fixed (with evidence)

- **Two open windows can resume the same session twice** (original framing:
  unfixed, two candidate designs listed) — **superseded**. Task 10 shipped
  `src/claims.ts` and wired it into every fire path; the Windows-lane ledger
  records 3 review rounds ending "all 4 manual bypass paths are uniform; the
  automatic releases are same-tick" (re-review 3, no new issues). Rewritten
  as "mostly covered, not fully" rather than dropped outright, since a real
  gap remains (see "Known limitations" above) — checked against
  `src/claims.ts`'s current module doc and `attempt()`/`claimResume()`.
- **`statusBar: "pending"` description stale** (Task 4b minor, `→ 9b`) —
  fixed by this task's own `package.json` commit.
- **#7 offer to reopen the stale panel tab** / **#11 a job waiting for
  Resume Now is lost on reload** / **#6 the fork record** — all three were
  already resolved in 0.1.2 per its own CHANGELOG entry; dropped from NEXT's
  open-item list (they were carried in the old file mostly for historical
  narrative, not as open work).
- **Task 10 round-1 "off-autoResume Resume Now doesn't refresh a stale
  claim" (parked)** — the ledger's own next line says fix round 3 "closes
  the parked round-1 asymmetry" (`6f334ae`); dropped.
- Everything else carried over (detection edge cases, trust-hotlink minors,
  gave-up minors, tooltip minors, the same-folder-coordination test gap, and
  Task 1's `quotaLimits`-stale/`MAX_OVERLOAD_AGE_MS`-boundary parked items)
  was individually re-checked against current source before being kept — see
  each bullet's file pointer in NEXT.md. None of it has since been fixed.

## Suite and check-vsix results

- Unit: `npm test > /tmp/t9b.log 2>&1; echo "exit=$?"` → `exit=0`, 610/610
  (609 inherited + 1 new: `readmeSettings.test.ts`). Re-run after the final
  commit: 610/610 again.
- Integration: `xvfb-run -a npm run test:integration > /tmp/it9b.log 2>&1;
  echo "exit=$?"` → `exit=0`, 9/9. Re-run after the final commit: 9/9 again.
  The `Failed to fetch` / SSL handshake lines are VS Code's own background
  Marketplace/GitHub traffic (constraint 6), not test noise.
- `bash scripts/check-vsix.sh <vsix>`: packaged with `npx @vscode/vsce
  package`, ran against it twice (once mid-work, once at the final commit)
  → both "The .vsix contents are correct." Deleted both `.vsix` files
  immediately after; `git status --porcelain` was clean of any `.vsix`
  throughout, and CHANGELOG.md/LICENSE/THIRDPARTY.md/media/icon.png all
  confirmed shipping, the other four media files confirmed absent.
- `npx tsc -p . --noEmit` (via the mutation check's compile step): clean.

## Self-review

Read `README.md` top to bottom as a new user and cross-checked every id,
setting, default and command against `package.json` and the source files
that implement them:
- Every command id (`resumeNow`, `cancel`, `showLog`, `statusBarMenu`,
  `openClaudeToTrust`) and every button/menu label ("Resume Now", "Cancel
  Pending Resume", "Show Log", "Dismiss gave-up notices", "Open Claude to
  Trust", "Resume in Terminal Anyway") matched their source string exactly
  (`extension.ts`, `holderPolicy.ts`).
- All 18 `claudeLimitBreak.*` settings and their defaults verified by the new
  test, not just by eye.
- `grep`ped the three docs files for stray `claudeLimitBuster`/`Claude Limit
  Buster`/`claude-limit-buster` strings: only the deliberate ones remain (the
  README's "formerly" line and Install note, the CHANGELOG's historical
  0.1.1/0.1.2 entries, NEXT.md's two rename-history mentions).
- Confirmed the banner URL matches the brief's verbatim string and the
  install note matches the brief's verbatim string (also pasted into the
  CHANGELOG).
- Confirmed `package.json`'s `version` is untouched (`0.1.2`) and no branch
  was created or switched (`git branch --show-current` stayed
  `claude/limit-break-1.0-cloud` throughout, `git status --porcelain` clean
  after each commit).

## Concerns

None blocking. Two things worth a reviewer's eye:
- The CHANGELOG groups ~150 commits by user-visible effect at a fairly high
  level (not every commit gets its own bullet, per the brief's instruction);
  a reviewer who wants commit-level traceability should cross-reference the
  task reports this report cites.
- NEXT.md's "Deferred review findings" section is long. I judged it more
  useful to a future contributor grouped by area with file pointers than
  trimmed further, since the addenda specifically ask to "collect every
  minor (deferred), parked, and ⚠️ open line" — but a reviewer could
  reasonably want it shorter.
