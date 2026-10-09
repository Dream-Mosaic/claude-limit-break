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
| D5 | **The socket is the fallback** when a live session has no mod: post an enveloped `resumePrompt` as a peer message. | [proposed] |
| D6 | A control message carries a single-use **nonce** from a file only the extension writes, so a peer session can't trigger an `asUser` continue. | [proposed] |
| D7 | The files live in a fixed folder, `<claudeHome>/limit-break/`, not in a path handed over at install. | [proposed] |

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

## The mod

The mod lives in a new top-level `mod/` folder. It's a Claude Code plugin with
`hooks/hooks.json` → `register.js`, and it's shipped inside the VSIX.

**Sensor.** The mod writes `<dir>/sessions/<sessionId>.json` as one whole JSON
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

**Settings [proposed]:** one setting, `claudeLimitBreak.continueInPlace`.
- `on` (the default) uses the mod or the socket.
- `off` keeps 1.0's terminal launch.

The install offer's "Never" choice is stored as state, not as a setting.

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

1. **D5.** Should the socket fallback (peer authority) be used at all? The
   alternative is to fall straight back to 1.0's launch when there's no mod.
   The socket avoids the fork. The launch has user authority but forks the
   session.
2. **D6.** Is a nonce file the right guard against peer sessions triggering an
   `asUser` continue, or is it overkill?
3. **D7.** A fixed `<claudeHome>/limit-break/` folder, or a path the installer
   writes, as Agent Rewake does?
4. **Settings.** Is one `continueInPlace` setting with `on`/`off` enough?
5. **Idle terminals (#29).** Should they also be continued in place in 1.1, or
   should 1.1 stay with panels only?
6. **Reporting a resume that stops to wait for the user.** Should this be in
   1.1, or later? It mostly applies to the socket path.
