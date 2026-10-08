# Next steps

State as of 2026-10-01, after the Limit Break 1.0 plan (both lanes), its
final review fix wave, and the two field-report fix waves (A and B) landed on
`fix/1.0-field-reports`. Read
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
(git history: `d90f032:.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/progress.md`,
Task 10 re-review 3). The slower case Task 2's holder check already covered
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
  one for each cancelled job's whole random-delay window (Important 7; the
  deadline is `claimHoldDeadline` in `src/claims.ts`). The ruled cost: a
  failed launch from the "Resume in Terminal Anyway" button leaves the fire's
  own claim in place (it only releases a claim it took itself). Manual
  resumes bypass claims either way. The same reset re-detected in the window
  that cancelled it is planned afresh and releases that window's own claim
  (wave A, A8); a copy of the job in another window can still fire first, in
  which case the other window resumes it and this one drops on its claim, so
  there is still one resume per reset.
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
fix, with the reviewer's stated cost of being wrong. Checked against `HEAD` on
2026-09-25. The two the field-report waves have since fixed (the default
`resumePrompt` naming a usage limit for an overload retry, and the native
auto-continue check reading any growth as "it continued") are removed, and the
synchronous `claude agents` call has moved to 1.1 below.

**Detection / parsing** (Task 1 and 4a reviews)
- A flagged rate-limit entry whose `quotaLimits.resetsAt` is rejected (past
  the grace, or more than 8 days out) logs a warning and returns early, never
  falling through to the overload check below it (`src/transcriptWatcher.ts`,
  the `verdict.kind === 'rejected'` branch). Cost if wrong: one missed
  overload retry on a doubly-flagged entry.
- `MAX_OVERLOAD_AGE_MS`'s boundary is tested with a 5s margin
  (`GRACE_TEST_MARGIN_MS`, `test/transcriptWatcher.test.ts`), not pinned at
  the exact millisecond. Cost if wrong: an off-by-ms edge.
- The in-flight-retry regex's narrowness is unpinned — no test asserts a
  terminal case containing the literal word "attempt" that should NOT match
  (`src/parsers/overloadParser.ts`).

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

## 1.1

Planned for the release after 1.0.

- **Read `usage.iterations[]` when the top-level usage sums to 0.** Some
  2.1.25x-2.1.27x turns at compaction boundaries report 0 at the top level but
  carry real numbers in `cache_creation.ephemeral_1h_input_tokens` and
  `usage.iterations[]`. parseLastUsage skips them, so the budget measures one
  turn earlier (an overestimate, never a silent pass).
- **Act on the armed and fired auto-continue lines.** 1.0 only logs Claude
  Code's own armed, cancelled and fired status lines and uses the cancel lines
  to stand down (wave C). A confirmed armed line in the transcript is a better
  signal than reading `autoContinueAtUsageLimit` from settings: stand down on
  it, and use a fired line to know Claude Code took the session.
- **Map the other cancel reasons once there are real samples.** Only
  `process_exit` has a real transcript line (v2.1.278); the Desktop, cloud,
  background and Esc wordings come from the 2.1.285 binary, and the
  "Don't continue automatically" answer is a `user` entry derived from code.
  Confirm them against real lines, and decide about `relaunch` and the "turned
  off", "stopped" and "did not run" lines, which are logged and not acted on.
- **Compaction-failure shapes: resolved.** An automatic compaction failure
  writes nothing to the transcript (the failed turn's ordinary flagged limit
  entry follows and is already caught), so the manual `/compact` shape wave C
  reads is the only one there is. Revisit only if a real automatic-compaction
  failure entry turns up.
- **A cancel line written before the detection baseline.** The stand-down scan
  reads from the size the transcript had when the limit was detected, so a
  cancel line written between the limit entry and that moment is not seen. In
  practice they land seconds after the stop and the watcher reads within a
  poll, but a window that starts at the limit entry itself would close it.
  A variant: a same-reset re-detection moves the baseline forward
  (`scheduler.ts`, the `transcriptBytesAtDetection` refresh) and can step past
  a cancel line written in between. Fix: carry the limit entry's end offset in
  `LimitHit` (`from` plus the bytes through that line), persist the earliest
  value across re-detections, and start only the C5 scan there, leaving
  `continuedSince`'s baseline alone. A same-batch cancel line is logged (C4)
  today but cannot be seen by C5.
- **A compaction-limit job in an idle five-hour CLI.** For a C1 job whose
  session is an idle terminal with native auto-continue on, `decideOnFire`
  assumes Claude Code will continue it, but a compaction request's rate-limit
  signal may not arm the native wait. The "Claude Code did not continue ... on
  its own" notice after the grace covers it (an offer, never an unattended
  resume). Revisit with real samples; a C1 detection could tell `decideOnFire`
  not to count on native auto-continue.
- **Read `CLAUDE_CONFIG_DIR` from Claude Code's settings too.** The extension
  sees the variable only in the environment VS Code was started from. Claude
  Code also honours one set in its user and managed settings `env`; reading
  those as well would close the gap.
- **A huge text-only last prompt reads as "not continued".** When the last
  prompt is longer than the read window and only attachment entries follow it,
  the window holds no verdict and the session reads as still stopped. Step the
  read window back until a verdict is found.
- **A per-limit-type setting.** Policy B (wave D) offers Resume Now for any
  limit that resets beyond `maxWaitHours` and auto-resumes only within it,
  whatever the limit type. If users ask, consider a per-type setting - for
  example "auto-resume weekly limits" - rather than raising `maxWaitHours` for
  every type at once.
- **Purge dropped restored jobs.** A restored job that fails validation is
  dropped from memory but never removed from the stored pending list, so it is
  logged again at every activation until the list is next rewritten.

- **Headless option C.** Today `resumeMode: headless` does not inherit the
  session's permission mode, so unattended tool work is denied unless
  `headlessPermissionMode` is set. Option C resumes headless with the mode the
  session itself recorded, never a bypass mode, plus `--permission-prompts
  none`, so anything that would prompt is denied instead of hanging. It also
  surfaces `permission_denials` from the JSON output, so silent partial work is
  reported, and it is version-gated at Claude Code 2.1.259, which introduced
  `--permission-prompts`. Four design calls are still open with the user: an
  empty `headlessPermissionMode` means "mirror the session"; a recorded
  `bypassPermissions` falls back to `default` rather than being mirrored; the
  `--permission-prompts none` gate at 2.1.259; and a warning on
  `permission_denials` with a button to continue in a terminal. The options
  table is section 7 of `research-headless-permissions.md` in the maintainer's
  local, untracked SDD workspace, not in this repository.
- **Following a headless run.** Today a headless resume runs in a shown VS Code
  terminal with `--output-format json`: silent until it finishes, no input, no
  done notice, and the panel tab for that session is stale meanwhile (typing
  into it forks the conversation). Wanted with headless C: `stream-json`
  progress plus a "running headless" status-bar item; a done notice with the
  denial count and "Open session" / "Resume in terminal" buttons; a check
  whether `-p` processes show up in `claude agents --json` and
  `~/.claude/sessions`, and if not, Limit Break marking its own headless runs as
  holders; and a warning if the panel for that session is focused while a
  headless run owns it.
- **Ways to get the user's attention.** Ideas, not a design (to be shaped in
  1.1), checked against `@types/vscode` 1.138. Available: `MessageOptions.modal`
  (with `detail`, modal only), `ProgressLocation.Notification` (optional cancel,
  no icons) and `ProgressLocation.Window` (status bar, no cancel),
  `StatusBarItem.backgroundColor` (limited to the error and warning
  backgrounds), a `ViewBadge` on our own view (needs the sidebar below), and
  `createWebviewPanel`. `WindowState.focused` / `.active` with
  `onDidChangeWindowState` would let Limit Break notice whether the user is
  there, and hold a notice until they return. Not in the API: a taskbar flash
  or request-attention call, Do Not Disturb behaviour, OS toasts (per-OS code).
  Whether a modal blocks the whole window is not stated in the types.
- **M6: the claims directory in a shared `/tmp` on Linux.** The claims live
  under `os.tmpdir()` (`src/claims.ts`), which on Linux is a `/tmp` every local
  user shares: another user could pre-create `claude-limit-break/claims` and
  plant fresh claim files to suppress resumes. A denial of service only. A
  per-user location (`$XDG_RUNTIME_DIR`, say) would close it.
- **M10: synchronous `claude agents` and `where` calls on the extension host.**
  `claude agents --json` runs through `execFileSync` with a timeout of up to
  10s, and `where` has none, on the extension host thread: once per fire, once
  per manual resume and on each turn end of a session resumed in this window.
  `execFile` (async) would fix it, and `resumedSessions` should be pruned when
  the resumed terminal closes.
- **Terminal reuse.** Continue inside our own idle resume terminal rather than
  opening a new one.
- **Cancel, then a retry, across a reload (wave A review m4).** Cancel followed
  by a re-detection of the same reset releases this window's own claim so the
  new plan can fire (wave A, A8), but it recognises "this window" by
  `vscode.env.sessionId`, which changes on a reload. After Cancel, reload, then
  a retry that hits the same limit, the fresh plan finds its own pre-reload
  claim, reads it as another window's, and is dropped until the cancelled job's
  fire time plus an hour. Rare. Recording the cancelled keys in `globalState`
  instead of relying on window identity would close it. Parked.
- **The "Fable limit" message.** "You've reached your Fable 5 limit" carries no
  reset time, so nothing is armed for it today (the same bucket's "You've hit
  your Fable limit · resets ..." form is). Needs a policy for a limit that
  gives no time to wait for.
- **Make "Open Claude to Trust" a nag.** The command is hidden from the
  palette because it needs a folder argument (it logs and ignores a call
  without one), so a dismissed untrusted-folder notice leaves nothing to act
  on until the next one. Keep reminding while a pending session's folder is
  untrusted (status bar or a repeat notice), rather than adding a picker.
- **A Limit Break sidebar.** An activity-bar view container with a view
  listing pending, ready and gave-up sessions — the tooltip's
  `buildSessionLines` model already has the data shape for this
  (`src/statusBar.ts`). Icon: `media/logo-mono.svg` (the user's "no square"
  redraw — frame, "Limit", gauge in `currentColor` on transparent, without
  the solid tile the square variant read as at 24px next to the codicons;
  ruling and Chromium-mock validation in git history at
  `d90f032:.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/progress.md`,
  Task 7 section). The activity bar takes an SVG directly as a CSS mask
  (`paneCompositeBar.ts`), no icon font needed. Open question carried from
  that ruling: legibility at 24px with ~2px margin — consider a gauge-only
  crop if the full mark reads too busy that small; a redraw is a one-file
  cost either way.

### Revisit from the 1.0 sign-off

Behaviours 1.0 ships as they are, to be looked at again.

- **Resume an idle terminal automatically.** An idle Claude Code terminal
  holding the session gets "Resume in Terminal Anyway", never an automatic
  resume, for an overload, a non-five-hour limit, or a five-hour limit with
  Claude Code's auto-continue off; a second `claude --resume` would be a second
  writer. Goes with terminal reuse above. Until then, the five-hour-or-untyped
  stand-down (and its check about a minute after the fire) stays as it is.
- **A waiting holder is dropped silently.** At fire time a busy or waiting
  holder is only logged. Busy is right: a turn is running, so the session is
  moving. Waiting means it is paused on a permission prompt or a question and
  needs the user: show "session X is waiting for your input; the limit has
  reset", with no resume.
- **A window that decides not to resume keeps its claim.** Other windows skip
  that reset for up to the reset plus the longest random delay plus 10 minutes.
  Revisit whether that hold is right.
- **Overload claim keys.** Session ID plus the error entry's timestamp. Revisit
  and refine.
- **Cancel in one window cancels in all.** Revisit.
- **The overload count is in memory, per window.** A reload or a window opened
  mid-streak restarts the 5-step backoff. Consider persisting it per session in
  shared state.
- **Checks on restored jobs.** A malformed saved job is dropped and a UUID
  failure at launch is only logged; consider a notice for both.
- **An unmeasured session skips the budget.** With `maxResumeTokens` on, a
  session with no real turn in its last 8 MB is resumed unchecked.
- **The 15-minute "same reset" window for automatic jobs.** Today only
  offered jobs match within 15 minutes; two automatic jobs need an exact match.
  Widening it means updating the tests that treat resets 10 minutes apart as
  different.
- **Name sessions the way the user knows them.** Notices, the tooltip and the
  log identify a session only by its ID (or its first 8 characters), which says
  nothing about which conversation it is. Show something recognisable instead,
  such as the session's title or first prompt and its folder, keeping the ID
  in the log. The resume terminal's tab ("Limit Break: <id8>") should use the
  same name.
- **Cancel or resume one session.** "Cancel Pending Resume" cancels every
  pending job at once, and the Resume Now command takes whichever job is first
  in line; neither lets you pick a session. Offer both per session (a pick list
  from the status-bar menu, say). A notice's own Resume Now button already acts
  on its session.
- **"more than 1 hours away".** The offer-only notice (`src/extension.ts`, the
  "won't resume automatically" message) always pluralises `maxWaitHours`, so
  it reads wrong at exactly 1.
- **Gave-up handling.** The marker clears on the session's next finished turn
  or from "Dismiss gave-up notices"; a turn that did not fix the cause clears it
  too. Revisit.

### Unit-test refactor

The unit tests are parked for a refactor (the user's call, 2026-10-06).

- **Test the behaviour, not the wording.** Notice and log strings are
  asserted verbatim across many tests, so a wording change touches dozens of
  them. Keep each string in one place (a constant or a builder) with one test
  for its wording, and have the behaviour tests assert which notice was
  shown, not its text.
- **Split or speed up `test/extension.test.ts`.** It takes about 200 s on its
  own, mostly real one-second scheduler ticks, which makes every full run and
  every mutation check slow. Split it by area, and inject a clock or a tick
  so a fire does not wait on wall time.
- **Mutation checks only on decision guards, always in a scratch copy.** Run
  them on arm, fire and fork logic, not on wording, and never in the working
  tree: two in-place runs that were stopped left a mutant behind. Copy the
  tree (with `node_modules` linked), run there, and filter to the relevant
  test files or names (`--test-name-pattern`) so each run stays short.
- **A Testing-view integration for the unit tests.** Evaluate a node:test
  integration for VS Code's Testing view (for example the Node.js Testing
  extension), since ms-vscode.extension-test-runner covers only the mocha
  integration suites.

## Further ideas

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
