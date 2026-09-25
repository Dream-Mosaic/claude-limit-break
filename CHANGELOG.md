# Changelog

VS Code renders this file in the extension's Changelog tab, including for an
extension installed from a `.vsix`. Since there is no Marketplace listing here,
this is the only in-editor account of what changed.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
- `claudeLimitBreak.statusBar`. `always` (the default) keeps a small marker in
  the status bar even when nothing is pending, so a window running the
  extension does not look identical to one where it silently failed to load;
  `pending` hides that marker and shows the item only while something is
  counting down, ready, or given up; `never` hides it entirely.
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
- A folder the Claude CLI already trusted under a different spelling of its
  path (for example a drive letter cased differently between a terminal and
  the panel) was still reported untrusted; any spelling the CLI has trusted
  now counts, and the resume launches from that spelling so the CLI's own
  lookup finds it.
- The untrusted-folder warning - in the notification and the status-bar
  tooltip - now clears once you trust the folder while its countdown is
  still running, instead of only at the next detection (#8).
- A repeated "usage limit" notice for a reset already scheduled no longer
  re-rolls its random padding and moves the resume time; the first schedule
  for a given reset is kept regardless of how many times it is re-detected.

## [0.1.2] - 2026-09-23

### Added

- After a resume, a session still open in a Claude Code panel tab is now
  reported, and optionally reopened for you. That tab keeps its own idea of
  where the conversation ends, so the next message typed into it is anchored
  before the resumed turn: the transcript forks and the resumed turn is left on
  a branch nothing follows, with no error on either side. Reopening the tab
  clears it. Measured, not assumed - see
  `docs/research/2026-09-20-panel-fork-experiment.md` and issue #6.
- `claudeLimitBuster.onStale` chooses between `notify` (the default: a
  notification with a "Reopen session tab" button) and `reopen` (close and
  reopen the tab without asking).

### Fixed

- A job waiting for "Resume Now" survives a window reload. It was held in
  memory only, and the scheduler clears its own state before firing, so a
  reload destroyed it without a word and the command then reported "nothing
  pending" (#11). It now persists alongside the scheduler's state and is
  restored at activation. Only reachable with `autoResume` off - but that is
  the same reload now recommended for a stale panel tab, so the advice would
  have taken the job with it.

### Notes

- Whether a panel still holds a session is read from `claude agents --json`,
  not from `~/.claude/sessions/<pid>.json`: those files are keyed by pid,
  outlive the process, and nothing in them proves it is alive. The per-pid file
  is read only for a pid that listing has already vouched for, to tell a panel
  from a terminal.
- A panel tab in another VS Code window cannot be closed from here, so that
  case gets the warning without the button - and it is the case most likely to
  be typed into.

## [0.1.1] - 2026-09-15

The first published version. `v0.1.0` was tagged to reserve the version, not to
mark a release.

### Added

- Watches Claude Code transcripts for usage-limit notices and server errors,
  waits out the cooldown, and resumes the session by id.
- Resumes into a new terminal whose shell process is `claude` itself, with the
  prompt passed as an argument. No shell parses it, and no existing terminal is
  ever written to.
- Resolves the session from the transcript that produced the detection, so a
  resume can never pair one project's session with another project's prompt.
- Estimates the token cost of a resume before scheduling it and refuses when it
  exceeds `claudeLimitBuster.maxResumeTokens`. A limit wait guarantees a cold
  cache, so a resume reprocesses the whole session.
- Keeps a separate countdown for every session that hits a limit. The limit
  belongs to the account, so the sessions working when it lands hit it
  together, and each of them is resumed.
- Counts down against wall-clock on a one-second tick, so a cooldown survives
  sleep and a window reload, and pads the deadline with random jitter.
- Warns when a folder is not trusted by the Claude CLI at the moment the resume
  is scheduled - in the notification, the status-bar tooltip and the log -
  while you are still there to trust it. Otherwise Claude stops at its trust
  prompt with nobody to answer it.
- Refuses a resume into a folder that no longer exists, naming the folder and
  the transcript, and keeps the job so it can be retried.
- Reports a resume that has written nothing to its transcript a minute after
  launching, rather than leaving it logged as a success.
- Clears the identity of any Claude session the VS Code window was started from
  - its session id, messaging socket and token - from the resume terminal, so
  the resumed `claude` does not start out as that session's child. Settings you
  export yourself, such as `CLAUDE_CODE_USE_BEDROCK`, are left alone.
- Status-bar countdown, which says how many sessions are waiting when there is
  more than one, an optional chime when a turn in this workspace ends, and
  `Resume Now` / `Cancel Pending Resume` / `Show Log` commands.
- Settings under `claudeLimitBuster.*`. Everything that influences what gets
  executed is machine-scoped, so a workspace cannot set it.

### Development

- Integration tests run the extension inside a real VS Code
  (`npm run test:integration`), alongside the fast unit suite (`npm test`).

### Known limitations

- Two VS Code windows each run their own watcher and scheduler, so one limit can
  start two concurrent resumes of the same session. See `docs/NEXT.md`.
- Resuming a session that is still open in a Claude Code panel leaves two live
  processes on it. Reopen the panel tab before typing into it: an open tab does
  not show the resumed turn, and a process writing on a stale view of the
  conversation can fork the transcript ([#6]).
- With `autoResume` off, a job waiting for `Resume Now` does not survive a window
  reload ([#11]).
- A reset time given with no timezone can resolve an hour off on the night of a
  daylight-saving change ([#10]).
- Headless resume is declared in settings but not routed; it currently falls
  through to the interactive path and says so in the log.
- Nothing notifies you that a newer version exists ([#1]). VS Code disables
  auto-update for a `.vsix` install and its update check only queries a gallery.

[#1]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/1
[#6]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/6
[#10]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/10
[#11]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/11
