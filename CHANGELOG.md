# Changelog

VS Code renders this file in the extension's Changelog tab, including for an
extension installed from a `.vsix`. Since there is no Marketplace listing here,
this is the only in-editor account of what changed.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
