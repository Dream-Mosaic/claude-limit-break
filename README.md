# Limit Break

![Limit Break](https://raw.githubusercontent.com/Dream-Mosaic/claude-limit-break/main/media/banner.png)

A VS Code extension that waits out Claude Code usage limits and resumes your
session — without typing into your terminal.

## What it does

When a Claude Code session stops — a usage limit, a `529`, a server error — it
notices, waits out the clock, and picks the session back up where it left off.

Detection reads Claude Code's own session transcripts rather than watching a
terminal, so it works whether Claude is running in the VS Code panel or in a
terminal, and whether or not the session was started from VS Code at all. It
reads Claude Code's files (the transcripts, the per-process session records,
`settings.json`) from `$CLAUDE_CONFIG_DIR` when that is set in the environment
VS Code was started from, and from `~/.claude` otherwise. A variable set only
in Claude Code's settings `env`, or in a shell profile VS Code's launcher never
loads, is not seen. The folder-trust record is read from
`$CLAUDE_CONFIG_DIR/.claude.json` when the variable is set, where current
Claude Code builds keep it (checked against the CLI; Claude Code's
documentation does not say), and from `~/.claude.json` otherwise. It only ever
reads these files.

A usage limit or a server error is acted on only when Claude Code itself
flagged the transcript entry as an API error, or - for a usage limit hit during
a manual `/compact`, which Claude Code writes unflagged - when it is the
`system` entry Claude Code writes for that failure. Text the model wrote, a
tool returned or you pasted never arms a timer, even when it quotes a limit
notice word for word.

It also chimes when a Claude turn finishes in a folder open in this window, so
you can walk away from a long run and hear when it is your turn again.

## How it resumes

Recovery targets a session **by ID** and hands the prompt to a fresh terminal as
an argument:

```
claude --resume <session-id> "<prompt>"
```

Three consequences worth knowing:

- **Nothing is typed into an existing terminal.** No prompt text is ever sent to
  a shell that might be sitting at a command line.
- **The right session, every time.** The transcript filename *is* the session
  ID, and detection already knows which transcript the limit came from — so
  there is no "most recent session" guessing.
- **No autonomy is granted.** Resume runs at whatever permission level you
  already use. An unattended headless mode exists, but it is opt-in and
  machine-scoped so a workspace cannot enable it for you.

## Limits that reset more than a day out

A weekly limit can reset days from now. Limit Break resumes automatically only
when the reset is within `maxWaitHours` (24 hours by default), the same line
Claude Code draws for its own auto-continue. A later reset is never resumed
automatically:

- When it is detected, you are told once (not once per window) when `notify`
  is on; the output channel always logs it: "Limit Break:
  session `<id8>` hit a weekly limit that resets `<date and time>`. That is
  more than 24 hours away, so it won't resume automatically; Resume Now will
  be offered when it resets." The job is kept like any other - across a
  reload, and in the status bar, which marks it `(manual)`.
- When it resets, Resume Now is offered - a notice with the button, and the
  session joins the Resume Now list - exactly as with `autoResume` off.
  Nothing is launched on its own. A session that has moved on since it
  stopped is skipped silently, as always.
- Raising `maxWaitHours` turns a longer reset into an automatic one.
- The latest detection decides. Each new limit hit is judged again, so if you
  hit the same limit again once its reset is within `maxWaitHours`, the job
  becomes automatic, and you are told once, when `notify` is on (the output
  channel always logs it): "Limit Break: session `<id8>` hit its weekly limit
  again. It resets within 24 hours, so it will now resume automatically at
  `<time>`." An untrusted folder is called out in that notice, with the
  "Open Claude to Trust" button, as for any automatic resume. It keeps the
  resume time it already had.
- A reset more than 8 days out is longer than any Claude usage limit, so it
  is taken as a misread and not picked up. Neither is one that has already
  passed (a fork's copy of an old limit, say) or one with no readable time.
  Each is logged to the output channel with the session and the reason, a
  passed one once per transcript.

The reset time comes from the transcript's `quotaLimits.resetsAt` when the
entry carries one, and otherwise from the notice text - including the dated
form Claude Code writes for a reset more than a day out, `resets Aug 4, 1am
(America/Chicago)` or `resets Jun 3 at 4pm (Europe/Berlin)`. A weekday form
(`resets Mon 12:00am`) is read only if it names a zone; as Claude Code's docs
quote it, with none, it is logged, not read. The date is read in the zone the
notice names, through daylight-saving changes and across the new year. A dated reset
that names no zone is not guessed at; it is logged instead.

## Works with Claude Code's own auto-continue

Claude Code has its own "Continue automatically at usage limit" behaviour
(`autoContinueAtUsageLimit`), on by default for an interactive terminal
session and absent from the VS Code panel. It covers the five-hour (session)
usage limit only — not the weekly, Opus, Sonnet, Fable or usage-credit limits,
and not a `529`, a server error or an interrupted stream. Left alone, that
setting and this extension can both try to continue the same session — Limit
Break checks who, if anyone, already holds a session before it launches a
resume for it:

| The session is | Limit Break |
|---|---|
| An **idle Claude Code panel** | Resumes it. This is the main case: someone leaves a panel idle at a limit and walks away. The stale-tab handling (below) runs afterwards. |
| A panel or terminal that is **busy or waiting** | Stands down silently (a log line only) — something is already continuing it, whether that's you or, for a bridged panel, Remote Control's own auto-continue. |
| An **idle terminal at a five-hour usage limit (or one whose type is unknown), native auto-continue on** | Stands down: Claude Code should pick it back up by itself, and a second `claude --resume` here would just fork the conversation. A minute after this window's own resume would have fired (the reset plus its random delay), it looks for a new message in the transcript since the stop was detected; if there is none (the setting is not available on every account), it says "Claude Code did not continue … on its own" and offers Resume Now. |
| An **idle terminal, native auto-continue off** — or any idle terminal after an **overload** or at any **other usage limit** (weekly, Opus, Sonnet, Fable, usage credit) | Notifies instead of spawning, with a "Resume in Terminal Anyway" button, since nothing else is going to continue it. The notice ends "Resuming here opens a second terminal on the same conversation." The button looks again when you click it: if the session has become busy or waiting in the meantime, you are told so, nothing is started, and the session stays ready for Resume Now. |
| A session whose native auto-continue was **cancelled for a handoff or by you** (moved to Claude Desktop, sent to the cloud, moved to the background, or Esc / Ctrl+C / "Don't continue automatically" in `/rate-limit-options`) | Stands down when the resume would fire, whatever holds the session: it keeps the claim, remembers the job for Resume Now, logs the reason and says "Limit Break: session `<id8>` was moved to Claude Desktop (or: moved to the cloud, moved to the background, set to wait by you), so it was not resumed here." with a Resume Now button. The last cancel line since the stop was detected decides. Any other reason ("Claude Code exited during the wait", "Claude Code relaunched during the wait"), no cancel line, or wording this version does not know: nothing changes. The Resume Now command and buttons are unaffected: you chose. |
| A **different** session busy or waiting in the **same folder** | Resumes anyway, and adds a sentence to the resumed session's own opening prompt asking it to message the busy session with SendMessage before editing anything, so the two coordinate instead of colliding. |

Limit Break also reads Claude Code's own auto-continue status lines (armed,
cancelled, fired) from the transcript and writes each to the output channel
with its session id. Logging them is observation only, and the text is never
parsed for a time; the cancel lines listed in the table above are the only ones
that change what Limit Break does.

Two VS Code windows watching the same account can still both detect an
identical reset within milliseconds of each other, before either shows up in
the holder check above. A machine-wide file claim (`fs.openSync(path, 'wx')`,
first one wins, aged out automatically) makes sure only one of them acts on
it — see `src/claims.ts`. The window that wins keeps the claim even when the
table above says to stand down or to offer "Resume in Terminal Anyway", so
the other windows do not each show the same offer. The claim is held for the
whole random-delay window: from the reset through the longest delay you have
set, plus ten minutes, so a window whose own delay is longer cannot find it
expired and resume the same reset a second time. "Cancel Pending Resume"
claims every job it cancels, so the other windows drop their copies too; if
the same reset is then detected again in the window that cancelled, it is
planned afresh, and that window releases its own claim so the new plan can
fire. Resuming by hand (Resume Now, or any notification button) is not blocked
by claims.

## A session that has already moved on

A resume is for a session that is still stopped. If something has continued it
since the stop was detected (you typed into the panel or the terminal, Claude
Code's own auto-continue ran, another window resumed it), resuming on top of it
would fork the conversation. So when a resume fires on its own, a session that
has moved on is left alone: one line in the log, nothing offered, nothing
launched.

On the manual paths (the Resume Now command, the Resume Now notification, the
"Claude Code did not continue" offer, and "Resume in Terminal Anyway") you are
asked first, in a modal: `Limit Break: session <id8> has continued since it
stopped. Resuming now will fork the conversation.` with a "Resume Anyway"
button. (`<id8>` is the first eight characters of the session id.)

The check judges the session's final state, not just whether anything was
written. A retry that ran into the same limit again leaves the session stopped
again, so it is still resumed. Local slash commands such as `/usage` and
`/status` make no API call and do not count as continuing, nor does the error
output of one that failed. A successful `/compact` writes a summary entry, which
does count; one that failed writes none, so the session is still resumed. When
the transcript cannot be read, or there is no record of its size at detection (a
job saved by an older version), the check cannot tell and the resume goes
ahead. The one exception: if the
transcript has grown by more than 2 MB since the stop and ends in a line too big
to read, that line is a real prompt (pasted images, say), and the session counts
as continued.

## Server errors

A server error (a `529`, a `500`, a dropped stream) has no reset time, so it is
retried after the usual random delay. Retries are bounded, so a session that
keeps failing does not spend tokens indefinitely. The count is of overload
resumes in a row for one session, since it last finished a turn:

| Resume in a row | When it is retried |
|---|---|
| 1st | After the usual random delay. |
| 2nd to 5th | The usual delay plus 15, 30, 60 and 120 minutes. |
| 6th | Not retried. A warning says `Limit Break: session <id8> kept stopping on server errors (5 resumes in a row); giving up until it finishes a turn.`, and the status bar lists it as gave up. Nothing is kept for Resume Now; continue it by hand. |

A finished turn starts the count over. A usage limit in between neither counts
nor resets it, and is never backed off. The count lives in memory, per window,
so a window reload starts it again at zero.

## What you will see

A marker in the status bar while it is watching (`$(eye)`), and while
something is pending, one of:

- `Claude resumes in 4h 12m` — one or more sessions counting down.
- `Claude ready to resume` — the countdown elapsed but `autoResume` is off,
  the session is held by an idle terminal and waits for you to say so (see the
  table above), or a launch failed in a way that keeps the job retryable.
- `Resume gave up` — at least one session has stalled, lost its `claude`
  executable, lost its folder, kept stopping on server errors, or had a budget
  refusal dismissed; see [Token budget](#token-budget) and
  [Server errors](#server-errors). This wins over "ready" in the status-bar
  text when both apply.

Hovering shows one line per session — short id, folder, its state (a resume
time, "ready", or a gave-up reason), and, for a folder the Claude CLI does not
yet trust, a "Trust this folder" link. That link (the notification shown when
a job is first scheduled offers the same thing as an "Open Claude to Trust"
button) opens a plain `claude` terminal in that folder so *you* answer the
CLI's own trust prompt — the extension never answers it and never writes to
`~/.claude.json`. A gave-up line clears on its own on a new detection for that
session, or when the session finishes a turn or is resumed.

Clicking the status bar opens a menu: Resume Now, Cancel Pending Resume (also
clears anything that gave up), Show Log, and — only shown when something has
given up — Dismiss gave-up notices, which clears just those records and
leaves any waiting resume untouched.

Set `claudeLimitBreak.statusBar` to `pending` to hide the marker except when
something is counting down, ready, or given up, or `never` to hide it
entirely.

## The panel tab after a resume

A resume advances the session on disk. A Claude Code panel tab that was already
open does not re-read it: it keeps its own idea of where the conversation ends,
in memory. Type into that tab and your message is anchored *before* the resumed
turn — the transcript forks, and the branch holding the resumed turn is the one
everything afterwards ignores. Neither side reports anything wrong.

So when a resumed session is still open in a panel, you get a notification
saying to reopen that tab before typing in it. Reopening fixes it, because a
restarted panel reads the transcript instead of its memory. Set
`claudeLimitBreak.onStale` to `reopen` to have the tab closed and reopened for
you instead of being asked. Reopening uses Claude Code's own
`claude-vscode.reopenClosedSession` command, on the one Claude tab in this
window. A tab in a different VS Code window is out of reach of this window's
tab API, so there you always get the warning without the button, even with
`onStale` set to `reopen`.

This is measured, not assumed:
[docs/research/2026-09-20-panel-fork-experiment.md](docs/research/2026-09-20-panel-fork-experiment.md).

## Token budget

Recovery competes with the quota it is recovering. A usage-limit wait guarantees
a cold prompt cache, so resuming a large session reprocesses its whole history —
a measured resume of a 1.6 MB session cost 288,574 cache-creation tokens.

Spend is estimated before resuming and capped, rather than retrying a fixed
number of times with no idea what each attempt costs. The estimate reads the
transcript's newest `usage` record — the live context a cold resume has to
rebuild. A limit's own error entry carries no usage and is skipped, so it
is the last real turn that counts. A session with no real turn at all is
unmeasured and is not refused (the output channel says so). A refusal
offers a "Resume anyway" button; dismissing it instead of overriding it is
recorded as a gave-up session (above), not retried again on its own.

## Install

There is no Marketplace listing and there is not intended to be one. Every
release attaches a built `.vsix`, so the quickest route is to download one from
the [Releases page](../../releases) and install it from the Extensions view —
the `...` menu, **Install from VSIX...**.

From a terminal, with the [GitHub CLI](https://cli.github.com/):

```powershell
$tag = gh release list --repo Dream-Mosaic/claude-limit-break --limit 1 --json tagName -q '.[0].tagName'
gh release download $tag --repo Dream-Mosaic/claude-limit-break --pattern "*.vsix" --dir $env:TEMP --clobber
code --install-extension "$env:TEMP\claude-limit-break-$($tag.TrimStart('v')).vsix" --force
```

The tag is looked up first because it is part of the `.vsix` file name used in
the last line.

To build it yourself instead:

```bash
npm install
npx --yes @vscode/vsce package
```

That writes `claude-limit-break-<version>.vsix` beside the manifest. Install it
from the Extensions view — the `...` menu, **Install from VSIX...** — or from a
terminal:

```bash
code --install-extension claude-limit-break-<version>.vsix
```

## Settings

All under `claudeLimitBreak.`, all with defaults that work unattended.

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | Watch transcripts for limits and server errors. Turning it off also stops a resume that is already counting down: when its time comes it is kept for Resume Now instead of firing. |
| `autoResume` | `true` | Resume when the cooldown elapses. Off means a notification offers Resume Now instead, and that offer survives a window reload (unless another window on the same VS Code profile has overwritten the shared list of waiting resumes; see Known limitations in [CHANGELOG.md](CHANGELOG.md)). |
| `resumeMode` | `interactive` | `interactive` opens a terminal at your normal autonomy. `headless` runs with `-p` and needs an explicit permission mode below or tool calls are denied; opt-in and machine-scoped. |
| `headlessPermissionMode` | `""` | Permission mode for headless resumes. Empty denies tool calls; headless does not inherit the session's own mode. |
| `claudeCommand` | `""` | Path to `claude`. Empty auto-detects from PATH. |
| `resumePrompt` | `[Limit Break] Your session was interrupted and has been resumed automatically. Please continue from where you left off.` | Passed as one argument, never through a shell. The same prompt is used for a usage limit and for a server error. |
| `maxResumeTokens` | `500000` | Refuse a resume whose estimated cost exceeds this, with a "Resume anyway" button. `0` never refuses. |
| `maxWaitHours` | `24` | Resume automatically only when the limit resets within this many hours. A later reset (a weekly limit, for example) is not resumed automatically; Resume Now is offered when it resets. Each new limit hit is judged again, so a hit within this window resumes automatically even if an earlier one was only offered. See [Limits that reset more than a day out](#limits-that-reset-more-than-a-day-out). |
| `transcriptPollSeconds` | `5` | Polling backstop, for when file watching is unreliable. |
| `randomDelayMinMinutes` / `randomDelayMaxMinutes` | `5` / `30` | Random padding after the reset time, so every waiting session does not resume at the same instant. |
| `notify` | `true` | Notify on detection and on resume. |
| `alertSound` / `alertSoundFile` | `true` / `""` | Chime when a turn finishes in this window's folders. Empty file uses the system default. |
| `onStale` | `notify` | What to do when the resumed session is still open in a panel tab: `notify` or `reopen`. |
| `statusBar` | `always` | `always`, `pending` (hide unless something is counting down, ready, or given up) or `never`. |
| `watchScope` | `machine` | `machine` watches every Claude session on the machine, including one started outside any open window. `workspace` watches only this window's workspace, and avoids two open windows reacting to the same limit. |
| `checkForUpdates` | `false` | Check GitHub once a day for a newer release and say so. Off by default: it's an outbound request to `api.github.com`, and a VSIX never updates itself so nothing else will tell you. Failures are silent. |

Settings that name a program or a file — `claudeCommand`, `resumePrompt`,
`alertSoundFile`, the headless pair — are machine-scoped on purpose, so a
workspace you open cannot set them for you.

Verified against `package.json`: every property under
`contributes.configuration.properties` appears above with its declared
default, and nothing above is not in `package.json` — see the Development
section for how this is checked.

## Versioning and releases

`package.json` holds the version and nothing derives it. Tags are `v<version>`
and only the release workflow creates them.

Merging to `main` runs that workflow. It compares the version against the
existing tags: if the tag already exists it does nothing, and if it does not it
runs the tests, packages, verifies the archive, and publishes a GitHub release
with the `.vsix` attached. Anything below `1.0.0` is marked pre-release. It
never publishes to the Marketplace.

So a release is one line in a pull request — the version bump — and it can be
its own pull request, after the changes it releases have already merged.

Nothing blocks a pull request for not bumping the version. Instead, when a merge
to `main` finds the version already tagged, the release workflow compares `src/`
against that tag and warns if it has moved on. That asks the question that
actually matters — has `main` drifted from the last release — rather than asking
each pull request to guess its own version bump before review has decided
whether it is a patch or a minor.

Releasing a version requires a matching `## [x.y.z]` section in
[CHANGELOG.md](CHANGELOG.md) — the release fails without one, so the changelog
cannot quietly rot. VS Code renders it in the extension's Changelog tab, which for a
`.vsix` install is the only in-editor account of what changed.

## Staying up to date

VS Code disables automatic updates for an extension installed from a `.vsix`,
and its update check only ever queries a marketplace — an extension that has
never been listed on one has no identity to check against, so **Show Outdated
Extensions** will never mention it.

`claudeLimitBreak.checkForUpdates` closes that gap: turned on, it asks GitHub
once a day for the newest release tag and notifies you when it is ahead of the
running version. It is off by default, since it's a network request you did
not explicitly ask for; the first time the extension activates, a one-time
prompt offers to turn it on (Enable / Not now / Never ask — all three are
final, there is no repeat nag).

You can also just watch this repository for releases: **Watch → Custom →
Releases**.

## Development

```bash
npm install
npm test
```

The parser suites in [test/parsers](test/parsers), together with the
entry-level cases in
[test/transcriptWatcher.test.ts](test/transcriptWatcher.test.ts), are the
regression gate for detection. See [docs/UPSTREAM.md](docs/UPSTREAM.md) for how
detection is built and [docs/NEXT.md](docs/NEXT.md) for current state.

`npm run test:integration` runs the extension inside a real VS Code
(`xvfb-run -a npm run test:integration` on Linux without a display).

The settings table above is checked against `package.json` by
`test/readmeSettings.test.ts`, part of the regular unit suite: it parses this
file's `## Settings` table and asserts, for every `claudeLimitBreak.*`
property, that the setting is listed, its default matches, and nothing listed
is missing from `package.json`.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

This project incorporates MIT-licensed code from
[Claude Timeout Resume](https://marketplace.visualstudio.com/items?itemName=BarPopko.claude-timeout-resume)
by BarPopko. Its notice is in [THIRDPARTY.md](THIRDPARTY.md).
