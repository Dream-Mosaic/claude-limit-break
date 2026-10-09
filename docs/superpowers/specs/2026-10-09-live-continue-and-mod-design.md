# 1.1: continue live sessions in place, with a Claude Code mod

Status: **draft for review.** The decisions marked **[decided]** were made by the
user on 2026-10-08. Everything marked **[proposed]** is open; the questions are
collected at the end.

Evidence for every mechanism used here is in
[docs/research/2026-10-08-socket-and-mod-spikes.md](../../research/2026-10-08-socket-and-mod-spikes.md)
(PR #51). Issue #52 tracks it.

## Problem

When a limit resets and the session's process is still alive, Limit Break 1.0
launches a second process (`claude --resume`) on that same session. That
second writer is the root of #6 (the fork), #7 (the stale tab and the reopen
offer) and #29 (idle terminals only get an offer).

Claude Code can now take a message into a live session from outside, and it can
load a mod inside the session. Both continue the session in place, with no
second process.

## Goals

1. Continue a live, idle session in place instead of launching a second
   process.
2. Let a mod inside the session sense limits exactly and carry out the continue
   with the user's authority.
3. Keep 1.0's behaviour wherever there is no live process, and wherever the new
   paths can't be used.

**Non-goals:**
- Limit Break running outside VS Code. A standalone mod is a later decision.
- Cautious resumes that are weaker than 1.0's.
- Supporting agents other than Claude Code.

## Decisions so far

| # | Decision | Status |
|---|---|---|
| D1 | The mod's job is **actuator plus sensor**. The extension stays the only place that makes decisions. The mod reports what it sees, and continues the session only when the extension tells it to. | [decided] |
| D2 | The mod's continue is `$.prompt.submit({ asUser: true })`, using the existing `resumePrompt`. That's the same authority 1.0's terminal launch already has. | [decided] |
| D3 | **Install:** the extension offers to install the mod, and the README documents a manual install from a marketplace in this repo. User scope. | [decided] |
| D4 | **Sensor channel:** per-session status files written by the mod and watched by the extension. The other direction (extension to mod) is a control message through the session's inbox socket, which the mod consumes. | [decided] |
| D5 | **The socket is the fallback** when a live session has no mod: post an enveloped `resumePrompt` as a peer message. | [decided] |
| D8 | **Idle terminals (#29) are continued in place in 1.1,** not only panels. | [decided] |
| D9 | **1.1 reports a resume that stopped to wait for the user,** rather than counting it as done. | [decided] |
| D6 | A control message carries a single-use, expiring **nonce** from a file only the extension writes. This guards against **accidents and replays**: quoted marker text, a pasted control message, a peer told to send the marker, or a second continue for one job. It does not protect against a process that runs as the user and sets out to read the file; nothing file-based can. | [decided] |
| D7 | The files live in a fixed folder, **`~/.limit-break/`** (the user's home directory, not Claude's config folder), not in a path handed over at install. That needs no handoff, works for manual installs, and can't disagree about `CLAUDE_CONFIG_DIR` (#33). | [decided] |

## What happens at fire time

This changes only the "live holder" branches of `scheduler.onFire`, the ones
after the claim, continued-since, native-cancel and autoResume checks, which are
unchanged. Today those branches are `holderPolicy.ts`'s `decideOnFire`.

| Holder at fire | 1.0 | 1.1 [proposed] |
|---|---|---|
| None, or the listing failed | Launch a terminal | Unchanged |
| Idle panel | Launch a terminal, then offer to reopen the stale tab | **Continue in place.** Use the mod if the session has it, otherwise the socket. If both fail, fall back to 1.0's launch. |
| Idle terminal, five-hour (or unknown) limit, native auto-continue on | Stand down, then check that native continued | Unchanged, but with the mod present its native auto-continue notices answer "did native continue?" directly, instead of the transcript check |
| Idle terminal, any other case (another limit type, an overload, native off) | Offer "Resume in Terminal Anyway" | **Continue in place,** by mod or socket. This closes #29. |
| Busy, or waiting on a prompt | Drop silently | Unchanged |

**Continuing in place** is a new `continueInPlace(job, holder)` beside
`resume()`:
1. **Choose a transport.**
   - **Mod:** used if the session's status file exists, its `pid` matches the
     live holder's pid, and its `protocol` is compatible.
   - **Socket:** used otherwise, if the holder's `~/.claude/sessions/<pid>.json`
     record has a `messagingSocketPath`.
   - **Neither:** fall back to `resume()`, which is 1.0's behaviour.
2. **Send.**
   - **Mod:** a control message (see the protocol below).
   - **Socket:** the enveloped `resumePrompt` (see the protocol below).
3. **Confirm.** Delivery is confirmed when the mod reports `continued` for this
   job (mod transport), or when the transcript records the `msg_id` (socket
   transport). If neither happens within 30 seconds [proposed], fall back to
   `resume()`. The stall check that already runs after `resume()` then applies.
4. **What's no longer needed.** The reopen-stale-tab offer (#7) isn't needed
   after a continue in place, because there's no second process. The
   busy-folder coordination sentence is still appended to the prompt.

**Manual paths**, meaning Resume Now and the offers: these use
`continueInPlace` for an idle holder too, so a click doesn't create a fork.
The modal warnings for busy holders stay.

## Reporting a resume that stopped to wait (D9)

After any continue or launch, the extension follows the resumed session until it
is `waiting`, or `idle` after a new assistant turn. There are two signals,
tentatively both [decided, pending research]:

1. **Structured: the `waiting` status.** `claude agents --json` reports
   `status: waiting` with a `waitingFor` field. The documented values
   ([agent view](https://code.claude.com/docs/en/agent-view)) are:
   - `permission prompt`
   - `input needed`, for a question from Claude or an MCP server
   - `sandbox request`
   - `worker request`
   - `dialog open`

   A message sent to a session while a dialog is open waits in its queue.
   `liveSessions.ts` doesn't parse `waitingFor` today. Notify: "Session X
   resumed and is waiting for you (`<waitingFor>`)."
2. **Heuristic: idle, but the reply asks something.** The turn ended normally,
   but the last assistant message asks the user, for example "reply go ahead".
   The docs say a session that finished its turn reads as done or idle, not
   blocked, so no status covers this case. Notify, worded as "may be waiting":
   the message ends with a question, or asks for approval ("go ahead",
   "confirm", "should I").

**The "blocked" session the user saw was a background session.** Read from
`~/.claude/jobs/7a00d6c0/` on 2026-10-09 (Claude Code 2.1.295):
- `state.json` had `template: "bg"`, `backend: "daemon"`, and the 1.0 resume
  prompt as its `intent`.
- At 11:52:49Z it went from `working` to `state: "blocked"`, with `detail`
  "paused after Task 3 (1d647b0); awaiting go to review", a `needs` line, a
  `suggestedReply` of "go ahead, continue", and
  `inFlight: {tasks: 0, queued: 1}`. `firstTerminalAt` stayed `null`, so
  `blocked` is a live state, not a final one.
- The user had asked it to stop there for their go. So for a background
  session, "finished its turn by asking you" is reported as `blocked`, which
  the docs don't say.
- A second job, `~/.claude/jobs/ffcb2ab0/`, is our own probe from 2026-09-10.
  It is also `blocked`, but because of a usage limit: `needs` is "rate limited —
  wait and retry · API Error: Request rejected (429) · Claude AI usage limit
  reached|1789010981", which ends in the reset time.
- `claude agents --json --all` gives background rows only `id`, `cwd`, `kind`,
  `startedAt`, `sessionId`, `name` and `state`. The `detail`, `needs` and
  `suggestedReply` fields are only in `state.json`, which is undocumented.

Two examples with two causes share one value, so `blocked` alone can't tell
"waiting for you" from "hit a limit"; `needs` can. `parseAgentRows` drops
background rows today (they have no `pid`), so 1.0 neither resumes nor reports
background sessions. Whether 1.1 should is an open question.

**Still to record.** The plan's first task records real `claude agents --json`
rows for the interactive conditions we can reproduce, including `dialog open`
and a queued message. It confirms what each `waitingFor` value looks like, and
whether anything else is reported.

A small model call through the mod (`$.model.classify`) is left out of 1.1. It
can come later if the heuristic proves noisy.

**The notice gets a button that opens the session** [decided, if feasible]:
- **Panel:** `claude-vscode.editor.open` takes a session id as its first
  argument. The minified source of Claude Code extension 2.1.295 checks
  `hasPanelForSession(<arg>)`. It's a private command, checked for at runtime
  the way `reopenOffer.ts` already checks `claude-vscode.reopenClosedSession`.
  It only reaches panels in this window. Not yet smoke-tested.
- **Terminal:** match `vscode.window.terminals` by process tree (the terminal's
  shell pid is the parent of the `claude` pid), then call `terminal.show()`. It
  only reaches terminals in this window.

## Bridged panels

A panel bridged to Remote Control (`bridgeSessionId` in its session record) can
be continued by the Claude Code web client at the reset. That was seen twice,
both about 90 seconds after the reset (`docs/research/2026-09-field-observations.md`).
The user reports the web client is sometimes flaky. 1.0 has no special handling
for an idle bridged panel: it resumes straight away.

1.1 [decided in outline]: **indicate it, give the web client a head start, and
follow up if its continue doesn't come.**
- The status bar and the "resuming at" notice say the session is bridged to
  Remote Control.
- At fire time an idle bridged panel waits a grace period [decided: 5
  minutes after the reset; the two continues seen came about 90 s after it],
  then checks continued-since.
  - **If the web client continued it:** stand down, and log "Remote Control
    continued it".
  - **If not:** continue in place, by mod or socket.

This is the same shape as the existing native auto-continue check
(`awaitNativeContinue`, then the stall-watch grace, then an offer). The
difference is that the follow-up continues the session instead of only
offering to.

## The mod

The mod lives in a new top-level `mod/` folder. It's a Claude Code plugin with
`hooks/hooks.json` → `register.js`, and it's shipped inside the VSIX.

**Sensor.** In this section, `<dir>` means `~/.limit-break` (D7). The mod
finds it from `$.env.get('USERPROFILE')` on Windows, or `HOME` elsewhere. The
mod writes `<dir>/sessions/<sessionId>.json` as one whole JSON
object, rewritten on each event:

| Field | Source |
|---|---|
| `protocol`, `modVersion` | constants |
| `pid`, `sessionId`, `cwd`, `entrypoint` | `session.start`, `$.session.*`, `$.env` |
| `rateLimits` and `rateLimitsAt` | `session.measure` (`kind`, `percentUsed`, `resetsAt`) |
| `lastStopFailure` | `classic.StopFailure`: `error` and time, main conversation only (no `agent_id`) |
| `nativeContinue` | `classic.Notification`, `quota_auto_resume_*`: the type and time |
| `continued` | a list of `{ jobId, at }`, appended when the mod carries out a continue |

`$.fs.write` isn't atomic. The extension treats a file that fails to parse as
"not yet", and reads it again on the next change.

The mod also handles `classic.SessionStart` for `clear`, `resume` and `fork`,
which can move the process to a different session. It rewrites the status
file, and drops the old one.

**Actuator.** `session.receive` passes every message through, except a valid
control message:
1. The text is an envelope from `limit-break` whose body starts with
   `[limit-break-control v1]`, followed by a JSON payload
   `{ jobId, nonce, prompt }`.
2. The mod reads `<dir>/control/<sessionId>.json`, which only the extension
   writes. It accepts the message only if the nonce and job id match an entry
   there that hasn't expired and hasn't been used yet.
3. It returns `{ consumed }`, so Claude never sees the control text.
4. It runs `$.prompt.submit({ text: prompt, asUser: true })` without awaiting
   it. S4 did exactly that from `session.receive` and the turn started. S2
   found that a submit made inside a `command.run` handler was silently
   dropped, so the plan should also test whether a `$.clock.after(0)` callback
   is the safer place.
5. It records `continued`.

An invalid control message is consumed too. It isn't passed on to Claude, and
the mod logs it with `$.ui.log`.

**The mod never acts on its own.** Without the extension, it only writes status
files.

## The extension

New modules, pure where possible, each with an injected IO layer like the
existing ones:

- **`modStatus.ts`:** reads and validates the status files, and watches the
  folder.
- **`inbox.ts`:** finds a session's pipe or socket and its `peerToken` from
  `~/.claude/sessions/`. It writes the auth line and the payload line, and builds
  the envelope.
- **`continueInPlace.ts`:** chooses the transport, sends, confirms, and falls
  back.
- **`modInstall.ts`:**
  - copies `mod/` from the extension into `globalStorage`;
  - runs `claude plugin marketplace add <dir>` and
    `claude plugin install limit-break@limit-break --scope user`;
  - after an extension update, re-copies the mod and runs
    `claude plugin marketplace update` and `claude plugin update`;
  - offers to install once ([Install] [Not now] [Never]);
  - adds a command, "Limit Break: Remove Claude Code mod".

`holderPolicy.ts` gains the new outcomes. Its existing tests are the template.

**Settings [decided]:** one new setting, `claudeLimitBreak.continueInPlace`.
- `on` (the default) uses the mod or the socket.
- `off` keeps 1.0's terminal launch.

The install offer's "Never" choice is stored as state, not as a setting.

No existing setting changes, but some now cover less, or apply to the new path:

| Existing setting | In 1.1 |
|---|---|
| `resumePrompt` | The same text goes out on all three paths: the mod's submit, the socket post and the launch. Docs only. |
| `resumeMode` and `headlessPermissionMode` | Apply only to a launch, which now happens only when no live process holds the session. Docs only. |
| `onStale` | Applies only when a continue in place fails and falls back to a launch. Docs only. |
| `maxResumeTokens` | Gates a continue in place too, since it costs the same. A code change. |
| `watchScope` | `workspace` filters the mod's status files by folder, the way transcripts are filtered. A code change. |

## The protocol

**Socket** (S1, Windows 2.1.293):
1. Connect to `messagingSocketPath`.
2. Send `{"type":"auth","token":"<peerToken>"}` and a newline. This is required
   on Windows and optional elsewhere. Send it everywhere a key file exists.
3. Send this payload and a newline:
   `{"msgV":1,"msg_id","type":"user","message":{"role":"user","content"},"priority":"next","session_id"}`.
4. Close the connection.

The pipe never replies.

The envelope is
`<cross-session-message from="uds:limit-break" from-name="limit-break">`,
a newline, the body, a newline, then `</cross-session-message>`. It's
undocumented and was read from `claude.exe`. Only the "Message from" row in the
panel depends on it, not delivery.

**Versioning.** The status file and the control payload both carry `protocol`.
The extension uses the mod only on a matching major version.

## Testing [proposed]

- **Unit tests in the existing suite:**
  - transport choice and the decision table;
  - the envelope and payload builders;
  - status-file parsing, including partial and corrupt writes;
  - nonce issue, expiry and single use;
  - install command lines.
- **The mod's own tests:** `mod/hooks/*.test.ts`, run with
  `claude plugin test`. That needs the `claude` CLI, so they run locally and
  in the smoke kit, not in CI. The mod's control-message parsing and nonce
  checks live in a pure module that the node suite also tests.
- **Smoke kit (Part 1):**
  - an idle panel at an injected limit, continued by mod and by socket, with
    no fork (zero branch points) and no new terminal;
  - an idle terminal (#29);
  - the mod missing, which falls back to the socket;
  - the socket failing, which falls back to a launch.

## Risks

- **The mod's behaviour in the panel is undocumented.** The mods docs cover the
  terminal and Desktop only. S2 ran once, on 2.1.293.
- **The envelope is undocumented.** If it changes, only the sender row is lost.
- **An `asUser` turn in the tab can't be told from the user's own typing.** The
  `[Limit Break]` prefix in `resumePrompt` is what marks it.
- **Socket fallback runs with peer authority.** The model may stop before an
  irreversible step and wait for the user. Three runs, so this is uncertain.
- **Sessions started before the mod was installed** don't have it until they
  restart or run `/reload-plugins`. They use the socket until then.
- **Continuing an idle terminal session has not been tested.** S1 and S2 used
  panel sessions only. The docs say an idle session starts a turn from a peer
  message, and the smoke kit has to confirm it for terminals.

## Open questions for the user

1. *(Answered 2026-10-09: D5 through D9 are decided.)*
2. *(Answered 2026-10-09: one `continueInPlace` setting, plus the docs and
   code changes for existing settings above.)*
3. **D9's detection.** Tentatively the `waiting` status plus the text
   heuristic, pending the status research in the plan's first task.
4. *(Answered 2026-10-09: the bridged-panel grace is 5 minutes after the
   reset.)*
5. **Background sessions.** *(Answered 2026-10-09: not a resume target. The
   parent session manages its background sessions.)* Still open: the user hit
   one when reopening a panel, so the question may be how a panel reopen
   handles a session a background job holds. Context requested from the session
   that read `~/.claude/jobs/7a00d6c0/`.
