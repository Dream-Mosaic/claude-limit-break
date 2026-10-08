# Changelog

VS Code renders this file in the extension's Changelog tab, including for an
extension installed from a `.vsix`. Since there is no Marketplace listing here,
this is the only in-editor account of what changed.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-07

The first release. Limit Break watches Claude Code's session transcripts. When
a session stops on a usage limit or a server error, it waits out the cooldown
and resumes the session with `claude --resume`.

### Detection

- Only entries Claude Code itself flags as API errors count. Text the model
  writes, a tool returns or you paste never arms a resume, even a limit notice
  quoted word for word. A usage limit hit during `/compact` is picked up too.
- Reset times come from the transcript's `quotaLimits.resetsAt` when present,
  otherwise from the notice, including dated resets such as `resets Aug 4, 1am
  (America/Chicago)`. Daylight-saving changes resolve to the later time; a
  reset with no time zone is never guessed.
- Server errors (529, 500, timeouts, dropped connections, interrupted
  streams) are retried. Errors a retry can only repeat (a bad API key, an
  unknown model, a spend limit) are left alone, and so is a request Claude
  Code is still retrying itself.
- A limit or error inside a subagent is left to its parent session.
- A stop that isn't picked up (no readable time, a reset already passed, one
  implausibly far out) is logged with the session and the reason.

### Resuming

- Opens a new terminal running `claude --resume <id> "<prompt>"` directly, with
  no shell in between. Nothing is ever typed into an existing terminal.
  `resumeMode: headless` resumes with `claude -p` instead.
- A limit that resets within `maxWaitHours` (24 by default) resumes on its own
  after a random delay. A longer one, such as a weekly limit, is offered with
  Resume Now when it resets; hitting it again within the window makes it
  automatic.
- Server errors back off: +0, 15, 30, 60 and 120 minutes, then Limit Break
  gives up until the session finishes a turn.
- Every session that hits a limit gets its own countdown, which survives sleep
  and window reloads.
- The default prompt: "[Limit Break] Your session was interrupted and has been
  resumed automatically. Please continue from where you left off."

### Never a second writer

- Checks `claude agents` before resuming. An idle panel is resumed; a busy or
  waiting session is left alone; an idle terminal is offered "Resume in
  Terminal Anyway", or left to Claude Code's own auto-continue for a five-hour
  limit. Another session busy in the same folder gets a line in the prompt
  asking the resumed one to coordinate with it first.
- Skips a session that has moved on since it stopped. Resuming one by hand
  asks first, since it would fork the conversation.
- Steps aside when Claude Code's auto-continue was cancelled because the
  session moved to Claude Desktop, the cloud or the background, or because you
  declined it, and offers Resume Now instead. If Claude Code was expected to
  continue a session and didn't, you're offered Resume Now.
- Two VS Code windows never both resume the same stop.
- After a resume, a panel tab still showing the session is flagged, or
  reopened with `onStale: reopen`, because typing into it would fork the
  conversation.

### Checks and status

- Warns when the Claude CLI hasn't trusted the folder, with an "Open Claude to
  Trust" button that opens `claude` there for you to answer. Limit Break never
  answers the trust prompt or writes `~/.claude.json`.
- Refuses a resume into a missing folder, and reports one that wrote nothing
  within a minute. Both show as "gave up" in the status bar.
- An optional token budget (`maxResumeTokens`, off by default) refuses a
  resume whose estimated cost is higher, with a "Resume anyway" button.
- A status-bar countdown, with a tooltip listing every pending, ready and
  gave-up session. Clicking it opens a menu: Resume Now, Cancel Pending
  Resume, Show Log.
- Honours `CLAUDE_CONFIG_DIR`. The resume terminal drops the identity of any
  Claude session VS Code itself was started from.
- Settings for scope (`watchScope`: the whole machine or this workspace),
  update checks against GitHub releases (`checkForUpdates`, off by default),
  the status bar, notices and an alert sound. Settings that change what runs
  are machine-scoped, so a workspace can't set them.
- Requires VS Code 1.138 or newer.

### Known limitations

- A usage limit with no readable reset time, or a dated one with no time zone,
  is logged, not picked up.
- The wording that identifies a cancelled auto-continue was read from Claude
  Code 2.1.285. If a later release rewords it, Limit Break resumes as it would
  without that check.
- A panel tab in another VS Code window can't be reopened from here; you're
  asked to do it by hand.
- Windows on one VS Code profile share one stored list of pending resumes and
  can overwrite each other's (#27).
- The server-error backoff count is per window and starts over after a reload
  (#33).
