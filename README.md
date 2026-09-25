# Limit Break

![Limit Break](https://raw.githubusercontent.com/Dream-Mosaic/claude-limit-break/main/media/banner.png)

A VS Code extension that waits out Claude Code usage limits and resumes your
session — without typing into your terminal.

Formerly published as **Claude Limit Buster**. See [Install](#install) if
you have that version.

## What it does

When a Claude Code session stops — a usage limit, a `529`, a server error — it
notices, waits out the clock, and picks the session back up where it left off.

Detection reads Claude Code's own session transcripts rather than watching a
terminal, so it works whether Claude is running in the VS Code panel or in a
terminal, and whether or not the session was started from VS Code at all.

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

## Works with Claude Code's own auto-continue

Claude Code has its own "Continue automatically at usage limit" behaviour
(`autoContinueAtUsageLimit`), on by default for an interactive terminal
session and absent from the VS Code panel. Left alone, that setting and this
extension can both try to continue the same session — Limit Break checks who,
if anyone, already holds a session before it launches a resume for it:

| The session is | Limit Break |
|---|---|
| An **idle Claude Code panel** | Resumes it. This is the main case: someone leaves a panel idle at a limit and walks away. The existing stale-tab handling (below) runs afterwards exactly as it always does. |
| A panel or terminal that is **busy or waiting** | Stands down silently (a log line only) — something is already continuing it, whether that's you or, for a bridged panel, Remote Control's own auto-continue. |
| An **idle terminal, native auto-continue on** | Stands down. Claude Code will pick it back up by itself; a second `claude --resume` here would just fork the conversation. |
| An **idle terminal, native auto-continue off** | Notifies instead of spawning, with a "Resume in Terminal Anyway" button, since nothing else is going to continue it. |
| A **different** session busy or waiting in the **same folder** | Resumes anyway, and adds a sentence to the resumed session's own opening prompt asking it to message the busy session with SendMessage before editing anything, so the two coordinate instead of colliding. |

Two VS Code windows watching the same account can still both detect an
identical reset within milliseconds of each other, before either shows up in
the holder check above. A machine-wide file claim (`fs.openSync(path, 'wx')`,
first one wins, aged out automatically) makes sure only one of them actually
launches — see `src/claims.ts`.

## What you will see

A marker in the status bar while it is watching (`$(eye)`), and while
something is pending, one of:

- `Claude resumes in 4h 12m` — one or more sessions counting down.
- `Claude ready to resume` — the countdown elapsed but `autoResume` is off, or
  a launch failed in a way that keeps the job retryable.
- `Resume gave up` — at least one session has stalled, lost its `claude`
  executable, lost its folder, or had a budget refusal dismissed; see
  [Token budget](#token-budget). This wins over "ready" in the status-bar text
  when both apply.

Hovering shows one line per session — short id, folder, its state (a resume
time, "ready", or a gave-up reason), and, for a folder the Claude CLI does not
yet trust, an "Open Claude to Trust" link. That link (also offered on the
notification when a job is first scheduled) opens a plain `claude` terminal in
that folder so *you* answer the CLI's own trust prompt — the extension never
answers it and never writes to `~/.claude.json`.

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
you instead of being asked.

This is measured, not assumed:
[docs/research/2026-09-20-panel-fork-experiment.md](docs/research/2026-09-20-panel-fork-experiment.md).

## Token budget

Recovery competes with the quota it is recovering. A usage-limit wait guarantees
a cold prompt cache, so resuming a large session reprocesses its whole history —
a measured resume of a 1.6 MB session cost 288,574 cache-creation tokens.

Spend is estimated before resuming and capped, rather than retrying a fixed
number of times with no idea what each attempt costs. The estimate reads the
transcript's newest `usage` record — the live context a cold resume has to
rebuild — and falls back to a byte count only when there is none. A refusal
offers a "Resume anyway" button; dismissing it instead of overriding it is
recorded as a gave-up session (above), not retried again on its own.

## Install

Limit Break is a new extension id. Uninstall Claude Limit Buster 0.1.x first;
its settings do not carry over.

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

The tag is named explicitly on purpose: GitHub's idea of "latest" excludes
pre-releases, and every `0.x` release here is one, so a tagless
`gh release download` reports `release not found`. `gh release list` does
include them.

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
| `enabled` | `true` | Watch transcripts for limits and server errors. |
| `autoResume` | `true` | Resume when the cooldown elapses. Off means a notification offers Resume Now instead, and that offer survives a window reload. |
| `resumeMode` | `interactive` | `interactive` opens a terminal at your normal autonomy. `headless` runs with `-p` and needs an explicit permission mode below or tool calls are denied; opt-in and machine-scoped. |
| `headlessPermissionMode` | `""` | Permission mode for headless resumes. Empty denies tool calls; headless does not inherit the session's own mode. |
| `claudeCommand` | `""` | Path to `claude`. Empty auto-detects from PATH. |
| `resumePrompt` | `[Limit Break] I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.` | Passed as one argument, never through a shell. |
| `maxResumeTokens` | `500000` | Refuse a resume whose estimated cost exceeds this, with a "Resume anyway" button. `0` never refuses. |
| `maxWaitHours` | `24` | Ignore a reset time further out than this — usually a misparse. |
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
