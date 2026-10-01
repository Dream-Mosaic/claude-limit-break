# Changelog

VS Code renders this file in the extension's Changelog tab, including for an
extension installed from a `.vsix`. Since there is no Marketplace listing here,
this is the only in-editor account of what changed.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-25

The first release.

### Added

- Watches Claude Code transcripts for usage-limit notices and server errors,
  waits out the cooldown, and resumes the session by id.
- Treats every transient error Claude Code documents as an overload (retried
  after a short backoff) rather than a usage limit: a `529` or `500` (including
  the renders that end "If it persists, check https://status.claude.com."), a
  transient 429 that disclaims being a usage limit, a request that timed out or
  got no response, a lost connection, and a response cut off mid-stream
  because the machine slept, the connection dropped or the stream stalled or
  was malformed. Errors that are not transient (a rejected API key, an unknown
  model, usage credits required, a monthly spend limit) are left alone, since
  resuming could only repeat them. A "Retrying in ..." line, with or without
  an attempt counter, means Claude Code is still retrying itself and is left
  alone, so its own backoff is not interrupted. Reads the transcript's own
  `quotaLimits.resetsAt` field ahead of parsing the banner text when a
  rate-limit entry carries one, which gets calendar dates, time zones and
  same-day rollovers right without depending on the wording of a message this
  extension does not control.
- A reset time given with no explicit time zone is resolved to the later side
  of a daylight-saving change, never an hour early. East of UTC, a
  spring-forward reset can resume up to an hour late.
- A usage limit or an overload is armed only by a transcript entry that Claude
  Code itself flagged as an API error (`isApiErrorMessage`). Text the model
  writes, a tool returns, a subagent quotes or you paste never arms a timer: a
  `grep` quoting a banner, a checkpoint note, a percentage-usage warning, even a
  limit notice or an error render quoted word for word. A flagged entry is
  believed wherever its text appears.
- Claude Code's own auto-continue covers the five-hour usage limit only, so
  Limit Break stands down for it only there. A weekly, Opus, Sonnet, Fable or
  usage-credit limit in an idle terminal is offered as "Resume in Terminal
  Anyway" instead, because nothing else will continue it.
- Resumes into a new terminal whose shell process is `claude` itself, with the
  prompt passed as an argument. No shell parses it, and no existing terminal is
  ever written to. Set `claudeLimitBreak.resumeMode` to `headless` to resume
  with `claude -p` instead; it is opt-in and machine-scoped, and tool calls are
  denied unless `headlessPermissionMode` names a permission mode.
- Resolves the session from the transcript that produced the detection, so a
  resume can never pair one project's session with another project's prompt.
- Estimates the token cost of a resume before scheduling it and refuses when it
  exceeds `claudeLimitBreak.maxResumeTokens`, which defaults to 500,000. The
  estimate reads the transcript's newest `usage` record - the live context a
  cold resume actually has to rebuild - falling back to a byte count only when
  there is none. A limit wait guarantees a cold cache, so a resume reprocesses
  the whole session.
- Keeps a separate countdown for every session that hits a limit. The limit
  belongs to the account, so the sessions working when it lands hit it
  together, and each of them is resumed.
- Counts down against wall-clock on a one-second tick, so a cooldown survives
  sleep and a window reload, and pads the deadline with random jitter. A
  repeated "usage limit" notice for a reset already scheduled does not re-roll
  its random padding or move the resume time; the first schedule for a given
  reset is kept regardless of how many times it is re-detected.
- Warns when a folder is not trusted by the Claude CLI at the moment the resume
  is scheduled - in the notification, the status-bar tooltip and the log -
  while you are still there to trust it. Otherwise Claude stops at its trust
  prompt with nobody to answer it. Any spelling the Claude CLI has trusted
  counts as trusted - for example a drive letter cased differently between a
  terminal and the panel - and the resume launches from that spelling so the
  CLI's own lookup finds it. The warning clears as soon as you trust the
  folder, even while its countdown is still running.
- Refuses a resume into a folder that no longer exists, naming the folder and
  the transcript, and keeps the job so it can be retried. A resume whose
  recorded working directory turns out to be a file, not a folder, is refused
  with a named reason.
- Reports a resume that has written nothing to its transcript a minute after
  launching, rather than leaving it logged as a success.
- Clears the identity of any Claude session the VS Code window was started from
  - its session id, messaging socket and token - from the resume terminal, so
  the resumed `claude` does not start out as that session's child. Settings you
  export yourself, such as `CLAUDE_CODE_USE_BEDROCK`, are left alone.
- Status-bar countdown, which says how many sessions are waiting when there is
  more than one, an optional chime when a turn in this workspace ends, and
  `Resume Now` / `Cancel Pending Resume` / `Show Log` commands. A single click
  on the status bar opens a menu (Resume Now / Cancel Pending Resume / Show
  Log / Dismiss gave-up notices when something has given up).
- `CLAUDE_CONFIG_DIR`, when set and non-empty, replaces `~/.claude` for every
  file the extension reads: the transcripts it watches, the per-process session
  records it checks before resuming, Claude Code's own `settings.json` (the
  auto-continue setting) and the trust record in `.claude.json`. The extension
  only ever reads these files.
- Project paths are case-folded only on filesystems that are actually
  case-insensitive.
- Checks Claude Code's own session state, and other Claude sessions, before
  resuming, so a session is not resumed a second time while something already
  holds it. An idle Claude Code panel is resumed unattended (the main use
  case), and the stale-tab handling described below runs after it. A panel or
  terminal that is already busy or waiting is left alone. An
  idle terminal at a usage limit defers to Claude Code's own "Continue
  automatically at usage limit" setting when it is on, and offers "Resume in
  Terminal Anyway" when it is off. An idle terminal after an overload always
  gets that offer: Claude Code's setting covers usage limits only. The offer
  ends "Resuming here opens a second terminal on the same conversation.", and
  the button looks at the session again when you click it: if it has become
  busy or waiting, you are told so and no second writer is started. A different
  session busy or waiting in the *same folder* is resumed anyway, with a
  sentence added to its opening prompt asking it to message the busy session
  via SendMessage before editing anything, rather than being blocked. The busy
  session's name is quoted, kept to one line and capped at 64 characters in
  that sentence, since it is text Limit Break does not control.
- Checks that Claude Code's own auto-continue really did continue a session
  it stood down for. The setting reads as on when it is absent, but it is not
  offered to every account. The check runs a minute after this window's own
  resume fires, which is the reset plus this window's random delay, and looks
  for a new message in the transcript since the stop was detected. If there is
  none, Limit Break says "Claude Code did not continue ... on its own" and
  offers Resume Now instead of dropping the session silently.
- Never resumes a session that has moved on since its stop was detected. If a
  turn (yours, Claude Code's own auto-continue, another window's resume) has
  been written since, a resume that fires on its own is dropped with a log line
  rather than forking the conversation. The manual paths (the Resume Now
  command and notification, the "Claude Code did not continue" offer, and
  "Resume in Terminal Anyway") ask first, in a modal: "Limit Break: session
  <id> has continued since it stopped. Resuming now will fork the
  conversation." with a "Resume Anyway" button. The check judges the session's
  final state: a retry that ran into the same limit again leaves it stopped, so
  it is still resumed. Local slash commands (`/usage`, `/status`) do not count
  as continuing. A successful `/compact` writes a summary entry and does count;
  a failed one writes none. When the transcript cannot be read, or its size at
  detection was not recorded, the check cannot tell and the resume goes ahead.
- Bounds server-error retries: a session's consecutive overload resumes are backed off
  and then given up. The first retry uses the usual random delay; the second to
  fifth add 15, 30, 60 and 120 minutes; the sixth is not retried, with the
  warning "Limit Break: session <id> kept stopping on server errors (5 resumes
  in a row); giving up until it finishes a turn." and a gave-up entry in the
  status bar. A finished turn starts the count over; a usage limit neither
  counts nor resets it.
- A machine-wide, filesystem-based claim so that two VS Code windows watching
  the same account do not both launch a resume for the same reset. Without it,
  two windows can detect an identical limit within milliseconds of each other
  and each fire its own terminal.
  The window that claims a reset keeps the claim when it stands down or
  offers "Resume in Terminal Anyway", so other windows do not each repeat the
  offer. An overload is claimed per failure (the transcript entry that
  reported it), so a second overload soon after a resumed one is not mistaken
  for the first. The claim is held for the whole random-delay window (the reset
  plus the longest delay you have set, plus ten minutes), so a window with a
  longer delay does not find it expired and resume the same reset again.
  "Cancel Pending Resume" claims every job it cancels, so the other windows
  drop their copies instead of firing them; if the same reset is detected
  again in the window that cancelled, it is planned afresh and that window
  releases its own claim so the new plan can fire. Resuming by hand is not
  blocked by claims. If the claims directory cannot be created, the resume goes
  ahead without a claim, as it does for every other filesystem failure here.
- A distinct "gave up" status for a resume this window has stopped retrying on
  its own: a launch that stalled (its transcript never grew), no `claude`
  executable found, the session's folder no longer exists, or a token-budget
  refusal that was dismissed rather than overridden. Each shows in the status
  bar with its own icon and a reason, and a "Dismiss gave-up notices" menu item
  clears them without discarding any resume still waiting. A gave-up record
  also clears on a new detection for that session, when the session finishes
  a turn or is resumed, and with "Cancel Pending Resume"; the tooltip lists
  all of these.
- Settings under `claudeLimitBreak.*`. Everything that influences what gets
  executed is machine-scoped, so a workspace cannot set it. Turning `enabled`
  off also stops a resume that is already counting down: when its time comes it
  is kept for Resume Now instead of firing.
- The default `resumePrompt` is "[Limit Break] Your session was interrupted and
  has been resumed automatically. Please continue from where you left off." It
  is the same for a usage limit and for a server error, and there is no second
  setting.
- `claudeLimitBreak.watchScope`: watch every Claude session on the machine
  (the default) or only sessions inside this window's workspace.
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
- The status-bar tooltip lists every waiting, ready, and gave-up session as
  its own line.
- After a resume, a session still open in a Claude Code panel tab is
  reported, and optionally reopened for you. That tab keeps its own idea of
  where the conversation ends, so the next message typed into it is anchored
  before the resumed turn: the transcript forks and the resumed turn is left on
  a branch nothing follows, with no error on either side. Reopening the tab
  clears it. Measured, not assumed - see
  `docs/research/2026-09-20-panel-fork-experiment.md`.
- `claudeLimitBreak.onStale` chooses between `notify` (the default: a
  notification with a "Reopen session tab" button) and `reopen` (close and
  reopen the tab without asking).
- A job waiting for "Resume Now" (because `autoResume` is off, an idle terminal
  holds the session, or a launch failed in a way that keeps it retryable)
  survives a window reload: it persists alongside the scheduler's state and is
  restored at activation, unless another window on the same VS Code profile has
  overwritten the stored list (see Known limitations). A stored job that fails
  validation (a session id that is not a UUID, a missing or non-numeric time,
  an unknown reason) is dropped with a log line rather than restored, and the
  session id is checked once more immediately before `claude --resume` is
  launched.
- Extension icon, logo and README banner.
- Requires VS Code 1.138 or newer; CI and development target Node 24.
- Repository hardening: SHA-pinned GitHub Actions, branch and tag protection
  rulesets, a SECURITY.md, Dependabot.

### Known limitations

- A Claude Code panel tab in another VS Code window cannot be closed or
  reopened from here. If a resumed session is open in one, you get the
  warning to reopen it by hand, without the "Reopen session tab" button,
  even with `claudeLimitBreak.onStale` set to `reopen`.
- Windows on the same VS Code profile share one stored list of pending and
  ready resumes, and the lists are not merged: one window can overwrite
  another's, and a reload restores whatever the last writer left. The claim
  above stops two windows from both acting on a reset, not from sharing
  that list. See `docs/NEXT.md` in the repository.
- The count of consecutive overload resumes, which drives the backoff and the
  give-up after five, lives in memory, per window. A window reload, or a window
  opened partway through a streak, starts the count again at zero and can skip
  one backoff step.
