# Next steps

State as of 2026-09-25, after the Limit Break 1.0 plan (both lanes) and its
final review fix wave landed on
`claude/limit-break-1.0-cloud`. Read
[design](design/2026-09-01-design.md) and [UPSTREAM.md](UPSTREAM.md) first.

## Settled (unlikely to need revisiting)

- **Copyright holder:** Dream Mosaic LLC. **Attribution:** root `LICENSE`,
  `THIRDPARTY.md` for upstream's verbatim notice, no per-file headers.
- **Packaging gate:** `LICENSE`, `THIRDPARTY.md` and `CHANGELOG.md` must ship
  inside the `.vsix`; `.superpowers` must not; only `media/icon.png` ships of
  the brand assets. `scripts/check-vsix.sh` asserts all of it in CI.
- **Public repo, no Marketplace listing**, `.vsix` attached to releases.
  `claudeLimitBreak.checkForUpdates` (off by default) is how someone finds
  out a newer one exists.
- **Extension identity:** package id `claude-limit-break`, extension id
  `dream-mosaic.claude-limit-break`, setting/command namespace
  `claudeLimitBreak.*`.

## Known limitations

**Two open windows resuming the same session twice — now mostly covered, not
fully.** The original 2026-09-24 field incident (both windows detect an
identical limit within ~1-2s and each fires its own `claude --resume`, see
the Windows-lane ledger's "Root cause" note) is closed: a machine-wide
filesystem claim (`src/claims.ts`, `fs.openSync(path, 'wx')`, first one wins)
runs before every automatic fire and every manual bypass path (Resume Now in
both `autoResume` states, "Resume Anyway", "Resume in Terminal Anyway") —
Task 10, 3 review rounds, all four manual paths verified symmetric
(`.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/progress.md`, Task 10
re-review 3). The slower case Task 2's holder check already covered
(one window sees the other's resume alive in `claude agents`, minutes later)
is unaffected by any of this and still works as before.

What is not covered:
- **The job lists themselves are shared across windows.** `globalState` is
  per profile, not per window, so every window reads and writes the same
  `claudeLimitBreak.pending` and `claudeLimitBreak.ready` keys: one window's
  persist can overwrite another's list, and a reload restores whatever the
  last writer left. The claims make sure only one window ACTS on a job
  (including a cancelled one, since the final review wave), but the lists
  are not merged. Pre-existing; a per-window key or a merge-on-write would
  fix it.
- A claim is kept whenever the holder decision stands down or offers
  "Resume in Terminal Anyway" (final review, Important 2), and Cancel holds
  one until each cancelled job's own fire time (Important 7). The ruled cost:
  the same reset re-detected in the same window within that time is dropped
  as "already claimed by this window", and a failed launch from the "Resume
  in Terminal Anyway" button leaves the fire's own claim in place (it only
  releases a claim it took itself). Manual resumes bypass claims either way.
- The claim's atomicity guarantee is `O_EXCL`, which is real, but Task 10's
  own two-claimer test only exercises it sequentially in one process, not
  with two real concurrent processes racing the syscall (Task 10 review 1
  note, ledger). Nothing has actually broken this; it is simply unverified
  the way the original bug could only be measured live.
- A claim is scoped to `os.tmpdir()` for the current OS user
  (`src/claims.ts` module doc). Two different OS user accounts on the same
  machine, or two different machines, do not share a claims directory and so
  are not deduped — not believed to be a real deployment shape for this
  extension, but worth knowing if it ever is one.

## Deferred review findings

Grouped by area; each was accepted as a deferred Minor rather than a required
fix, with the reviewer's stated cost of being wrong. Checked against current
`HEAD` on 2026-09-25 — none of these has since been fixed by a later task.

**Detection / parsing** (Task 1 and 4a reviews)
- A flagged rate-limit entry whose `quotaLimits.resetsAt` fails the
  grace/horizon check returns early and never falls through to the overload
  check below it (`src/transcriptWatcher.ts` ~478-480, the
  `return resumeAt ? {...} : { inputNeeded }` branch). Cost if wrong: one
  missed overload retry on a doubly-flagged entry.
- `MAX_OVERLOAD_AGE_MS`'s boundary is tested with a 5s margin
  (`GRACE_TEST_MARGIN_MS`, `test/transcriptWatcher.test.ts`), not pinned at
  the exact millisecond. Cost if wrong: an off-by-ms edge.
- DST spring-forward resolution east of UTC (e.g. London 01:30 → 03:30 BST)
  overshoots by an extra hour; only Chicago is under test
  (`src/parsers/limitParser.ts`, Task 4a report). Safe direction (later, not
  earlier), so low urgency.
- The in-flight-retry regex's narrowness is unpinned — no test asserts a
  terminal case containing the literal word "attempt" that should NOT match
  (`src/parsers/overloadParser.ts`).
- The default `resumePrompt` says "I hit my usage limit" even when the job
  is an overload retry (`src/config.ts`, `src/policy.ts` - the job carries
  `reason`, the prompt ignores it). A reason-specific default would read
  better; harmless as it stands, since the resumed model just continues.

**Trust hotlink** (Task 5a review)
- `claudeLimitBreak.openClaudeToTrust` opens a terminal with no `cwdExists`
  check first, unlike the resume path (`src/extension.ts`, the command
  handler around `openClaudeToTrust`).
- "could not find the claude executable" is a duplicated literal string
  (the resume-launch failure and the trust-terminal failure in
  `src/extension.ts`, and again as `REASON.launcher` in `src/gaveUp.ts`).
- A `void executeCommand(...)` inside a notification's `.then()` has no
  `.catch()`.
- The `trustTerminals` `Set` in `src/extension.ts` is never cleared on
  `deactivate()` (currently a no-op; not a leak that outlives the process,
  but not tidy either).

**Gave-up state** (Task 4b review)
- The trust sentence is duplicated between the stall log's `trustFirst`
  branch and `gaveUpNotice`'s `stall` case (`src/extension.ts`,
  `src/gaveUp.ts`).
- A repeated limit notice the scheduler drops as an exact-tie duplicate still
  calls `gaveUp.detected()`, resetting that session's warn-once memory even
  though nothing new actually happened (ruling 2 read literally;
  `src/gaveUp.ts` / `src/extension.ts`).
- A stall check armed just before "Cancel Pending Resume" can still
  record/notify a gave-up state right after Cancel runs (a narrow timing
  window, not reproduced). The native auto-continue check added in the final
  review wave is cancelled by Cancel; the stall check is not.
- A dismissed budget refusal records the session as given up even while a
  job for the same session is still counting down (final review minor).
- "Resume Now" says "nothing pending" while the status bar shows a gave-up
  session: gave-up records are not jobs, so there is nothing to resume, but
  the two messages read as contradicting each other (final review minor).

**Tooltip / status bar** (Task 5b review)
- A newline embedded in a folder name breaks the tooltip's one-line-per-
  session layout; the text is still escaped (no injection), just not
  single-line (`src/statusBar.ts`, `buildSessionLine`).
- VS Code's `$(...)` theme-icon syntax and Markdown `~~strikethrough~~` are
  not neutralised in folder names — cosmetic, since `supportThemeIcons` is
  on for the tooltip regardless.
- A harmless double render on `rememberReady` (the tooltip re-renders twice
  for one state change).
- One negative assertion in the escape tests is locale-fragile; there is no
  dedicated escape test for a gave-up-only tooltip line specifically.

**Same-folder coordination** (Task 2 re-review, Windows lane)
- No dedicated test for a failed launch with busy same-folder peers present:
  `rememberReady` gets the original (uncoordinated) prompt back, read and
  confirmed correct by inspection but not pinned by a test
  (`src/holderPolicy.ts` / `src/extension.ts`). Cost if wrong: a stale
  coordination sentence shown on a manual retry.

**Final review minors** (ruled OK to ship)
- `claude agents --json` runs through `execFileSync` with a 10s timeout, on
  the extension host thread (`src/extension.ts` `runAgentsListing`): a hung
  CLI blocks the host for up to 10s per fire or manual resume.
- `which`/`readShim` are defined twice in `src/extension.ts` (once at
  activation for `findLauncher`, again inside `resume()`).
- The unit suite's extension tests run on real timers (the scheduler's 1s
  tick, a shortened stall grace): the suite takes about two minutes, and
  timing-sensitive tests poll for a log line rather than sleeping a fixed
  time where they can.
- Subagent test fixtures use UUID-shaped transcript names; real subagent
  transcripts are named differently (e.g. `agent-*.jsonl`), so the fixtures
  exercise the resolver a little more generously than reality.
- `test/readmeSettings.test.ts` rejects column-padded table rows with a
  misleading "missing" message (Task 9b review).
- The native auto-continue check's baseline is the transcript size at
  detection. Anything written between detection and the check - including
  you typing into the terminal during the wait - reads as "it continued",
  and the check stays silent. That is the safe direction (the old,
  pre-check behaviour), not a false alarm.

## Open questions

- **Does a flagged in-flight retry that carries `quotaLimits` get read as a
  usage limit?** The in-flight-retry exclusion ("Retrying in 5s · attempt
  3/10") lives in the overload parser; the watcher's `quotaLimits.resetsAt`
  branch runs first for a flagged entry and only skips itself for the
  transient-429 render (`src/transcriptWatcher.ts`). If Claude Code writes
  `quotaLimits` on an in-flight 429 entry, that entry would arm a limit timer.
  Needs a real transcript line to settle (final review, open question).

- **Does Claude Code actually write a transient-429 entry with the literal
  "API Error:" head into the JSONL, and does such an entry carry
  `quotaLimits`?** Task 4a's evidence covers the TUI render and the upstream
  CHANGELOG only, not an observed transcript line. If it turns out that
  entries never combine both, the Important-1 ruling from that review
  (skip the `quotaLimits` branch when text matches the transient-429 render)
  is dead code but harmless; if they combine differently than assumed, worth
  re-checking against a live transcript.
- **Is the cross-window claim's `O_EXCL` guarantee sound under real
  concurrency**, not just the sequential two-claimer test Task 10 shipped
  with? See "Known limitations" above.

## v1.1 ideas

- **A Limit Break sidebar.** An activity-bar view container with a view
  listing pending, ready and gave-up sessions — the tooltip's
  `buildSessionLines` model already has the data shape for this
  (`src/statusBar.ts`). Icon: `media/logo-mono.svg` (the user's "no square"
  redraw — frame, "Limit", gauge in `currentColor` on transparent, without
  the solid tile the square variant read as at 24px next to the codicons;
  ruling and Chromium-mock validation in
  `.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/progress.md`, Task 7
  section). The activity bar takes an SVG directly as a CSS mask
  (`paneCompositeBar.ts`), no icon font needed. Open question carried from
  that ruling: legibility at 24px with ~2px margin — consider a gauge-only
  crop if the full mark reads too busy that small; a redraw is a one-file
  cost either way.

From the 2026-09-23 prior-art synthesis
(`docs/research/2026-09-23-prior-art-auto-retry-preheat.md`), "Consider" list
— re-checked against current `HEAD`, none of these has landed:
- A fallback wait for a message that is clearly a limit notice but has no
  parseable time. Mostly moot now that `quotaLimits.resetsAt` (Task 1) closes
  most of the parser gaps this was a backstop for.
- Persistent logs that survive a reload. Still a plain
  `vscode.window.createOutputChannel` (`src/extension.ts`), not a
  `LogOutputChannel` or a file — confirmed still true, `src/log.ts` has no
  persistence of its own.
- Warn when a resume is likely to land while the machine is asleep (preheat
  checks whether wake timers are enabled).
- Preheat as an opt-in feature: a cheap (~$0.04) periodic ping to keep a
  session's cache warm. Would reuse the minimal probe recipe from the
  synthesis: `-p "hi" --model haiku --no-session-persistence
  --strict-mcp-config --mcp-config <empty> --output-format json`.
- The near-limit wrap-up notice ("Approaching your 5-hour usage limit —
  Claude will wrap up the current step.") isn't an error and nothing resumes
  after it; currently ignored entirely.
- Separate retry state per failure family, if more families get added beyond
  today's `limit` / `overload` split.
