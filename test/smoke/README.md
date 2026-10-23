# Smoke kit

A by-hand check of Limit Break in a real VS Code window, run before a release and
whenever a change needs eyes on glass. It doesn't run in CI.

Two parts. Part 1 is the main test: the packaged extension continuing and resuming real
sessions. Part 2 covers what Part 1 can't stage with real sessions, using fake ones, and
needs no Claude usage. Both run in their own isolated VS Code window, and everything they
create lives under your temp folder (`lb-smoke` and `lb-smoke-kit`). Part 1 uses your real
Claude login, and **its L1 installs Limit Break's mod into your real Claude Code**: the mod
loads into every Claude Code session on this machine until you remove it at the end.

Open the log in any smoke window: Command Palette → `Limit Break: Show Log`. Each fire
logs `Resume due for <id8> …`, then exactly one `Outcome for <id8>: …`. The log names
sessions by the first 8 characters of their ID; `setup.js` prints which ID is which letter.

Windows and PowerShell. The scripts need `node`, `code`, `git` and, for Part 1, `claude`
on the PATH.

## Part 1: real end-to-end (packaged .vsix, your real login)

### What setup makes

| Session | Folder | Used for |
|---|---|---|
| **A** | `%TEMP%\lb-smoke\a` | Five-hour limits; the panel and terminal rows. Its `.claude\settings.local.json` turns Claude Code's own auto-continue off for this folder only, so Limit Break handles A's terminal itself. |
| **B** | `%TEMP%\lb-smoke\b-<date-time>` | A server overload. It stays untrusted: its folder is new on every run, because `~/.claude.json` keeps a folder's trust forever, so reusing it would make B trusted in every run after the first. |
| **W** | `%TEMP%\lb-smoke\repo\.claude\worktrees\w` | A git worktree of `%TEMP%\lb-smoke\repo` (L15). |

### Helpers (in `test\smoke\real`)

| Command | What it does |
|---|---|
| `node inject.js limit [seconds] [a\|w]` | Appends a five-hour usage limit to A (or W), resetting in `[seconds]` (default 120) |
| `node inject.js overload` | Appends a server overload to B, now |
| `node holder.js [a\|b\|w]` | Which live processes hold the session (panel or terminal, and status), and whether the mod is loaded in it |
| `node holder.js a --break-inbox` / `--restore-inbox` | Points A's inbox at nothing, so a continue's send fails (L5); then puts it back |
| `node forks.js [a\|b\|w]` | The turns since the session's last stop, and whether two follow the same point (a fork). Exit code 2 on a fork |
| `node forge.js` | Row L16: sends a forged control message at the fire and checks that its text never enters A |

**Timing.** The smoke profile's random delay is 0 to 1 minute, so after `inject.js limit 120`
the fire comes 2 to 3 minutes later. Watch for the `Resume due for` line in the log.

**Steps marked _(unverified)_** describe the Claude Code panel's own UI, which the kit can't
check. On your first run, note what you actually clicked, and fix the step.

### 0. Setup, each run

```powershell
cd test\smoke\real
node setup.js
# Trust A and the worktree's repo yourself (Limit Break never does). In each: accept the trust prompt
# if Claude Code shows one (it won't after the first run), then /exit.
Push-Location "$env:TEMP\lb-smoke\a"; claude; Pop-Location
Push-Location "$env:TEMP\lb-smoke\repo"; claude; Pop-Location
.\launch.ps1
```

`launch.ps1` packages the repo, installs it and Claude Code's own extension into an isolated
VS Code, and opens a window on `%TEMP%\lb-smoke` (the **root window**: it watches A, B and W).
`.\launch.ps1 -Folder a` opens a window on A's folder instead. `-Second` opens another window
without reinstalling. `-Vsix <path>` installs a given `.vsix` instead of packaging the repo.

### 1. Install, and the terminal path (root window)

| # | Do | Expect |
|---|---|---|
| R1 | Look at the Extensions view and the status bar | Limit Break at the version in `package.json`, installed from the .vsix; its status-bar item is visible |
| L1 | Wait for Limit Break's mod offer ("a small Claude Code mod …"), then click **Install** | `claude plugin list`, in any terminal, shows `limit-break@limit-break` |
| R2 | `node inject.js limit 120` | A notice, and a status-bar countdown to about 2 minutes, plus up to 1 |
| R3 | `node inject.js overload` | A notice; the resume is scheduled almost at once (the first backoff step is +0, plus up to 1 min); B is called out as untrusted, with "Open Claude to Trust" |
| R4 | Hover the status bar | One line per pending session, with its time |
| R5 | Wait for A's fire | No process holds A, so a new terminal runs `claude --resume <A's id> "[Limit Break] Your session was interrupted…"`, and Claude replies |
| R6 | Wait for B's fire | The same for B. If B wasn't trusted through R3's button, Claude shows its own trust prompt in the terminal; you answer it, Limit Break never does |
| R7 | Check the log and tooltip | Each session resumed exactly once; the tooltip is empty |
| R8 | After B's resumed turn finishes: `node inject.js overload` | Scheduled at +0 again, because a finished turn resets the count |

Afterwards, `/exit` Claude in each resume terminal and close the terminals.

### 2. Worktree trust (root window)

| # | Do | Expect |
|---|---|---|
| L15 | `node inject.js limit 120 w` | The "resuming at" notice has no "not trusted" warning, and W's tooltip line has no "Trust this folder" link (compare B in R3). At the fire, W resumes in a terminal with no trust prompt. `/exit` it afterwards |

### 3. A panel, continued by the mod (A's window)

Close the root window, then run `.\launch.ps1 -Folder a -Second`.

To open A in a panel _(unverified)_: click the Claude icon in the editor's title bar (or
Command Palette → "Claude Code: Open in New Tab"), open the past-conversations list, and
pick "Smoke test session A". Send nothing.

Then `node holder.js a` should show one holder, `panel, status idle`, and `mod: loaded`. If the
mod isn't loaded, type `/reload-plugins` in the panel and check again.

| # | Do | Expect |
|---|---|---|
| L2 | `node inject.js limit 120`, and leave the panel idle | At the fire: no new terminal; the panel shows the resume prompt as your message, and Claude replies; the log says `Continued session <id8> in place by mod (confirmed after N ms)`. `node forks.js a` says `No fork.` Record N |
| L12 (panel) | The same fire | The log's `Holder of <id8>: panel, pid …, status …` line. Record the status |
| L16 | In a second PowerShell, `node forge.js`; then `node inject.js limit 120` | At the fire `forge.js` sends its forged message. After 90 s it prints `PASS`: the forged text never entered A. The log has one `continued in place by mod` for the job |

### 4. A panel, continued through its inbox (A's window)

Command Palette → `Limit Break: Remove Claude Code mod`. Close A's panel tab and open A in a
new panel, as in section 3, so the mod is gone from the panel's process. `node holder.js a`
should say `mod: not loaded`.

| # | Do | Expect |
|---|---|---|
| L3 | `node inject.js limit 120` | At the fire: `Continued session <id8> in place by socket (confirmed after N ms)`; the panel shows "Message from @limit-break", and Claude replies. `node forks.js a` says `No fork.` Record N |
| L5 (panel) | `node holder.js a --break-inbox`, then `node inject.js limit 120` | At the fire the send fails, and Limit Break falls back to a terminal launch at once (`Outcome for <id8>: fell back to a terminal launch`). Afterwards: `node holder.js a --restore-inbox`, `/exit` the terminal, and reopen the panel tab, which is now stale |
| L11 (optional) | Switch the panel to bypass-permissions mode _(unverified: its permission-mode menu)_, then `node inject.js limit 120` | The 10-08 spike saw such a session hold peer messages for approval until `dialogExpiry` (5 minutes). Record what the panel shows and the log's `Outcome` line. Switch the mode back |

### 5. A terminal (A's window)

Close A's panel tab. In the window's terminal, run `claude --resume <A's id>` (the ID is in
`setup.js`'s output and `node holder.js a`). Send nothing. `node holder.js a` should show
`terminal, status idle`.

| # | Do | Expect |
|---|---|---|
| L4 | `node inject.js limit 120` | At the fire: continued in place by socket (the mod is removed); no second terminal; Claude replies in the same terminal. `node forks.js a` says `No fork.` |
| L12 (terminal) | The same fire | Record the `Holder of <id8>: terminal, …, status …` line |
| L5 (terminal) | `node holder.js a --break-inbox`, then `node inject.js limit 120` | Nothing launches. The job is remembered, and "Resume in Terminal Anyway" is offered. Command Palette → `Limit Break: Resume Now` shows the fork warning first; cancel it. Then `node holder.js a --restore-inbox` |
| L8 | In the terminal, ask Claude: `Run the shell command: echo smoke`. Leave its permission prompt unanswered, then `node inject.js limit 120` | At the fire: the waiting notice, with Open Session; clicking it shows that terminal. If the status at the fire isn't `waiting`, record it (that's L12's question). Answer the prompt afterwards |

Then `/exit` Claude in the terminal.

### 6. A waiting panel, and two windows (A's window)

Open A in a panel again, as in section 3.

| # | Do | Expect |
|---|---|---|
| L6 | Ask in the panel: `Run the shell command: echo smoke`. Leave the permission prompt, then `node inject.js limit 120` | At the fire: the waiting notice; Open Session focuses the panel |
| L9 | `.\launch.ps1 -Folder a -Second` opens a second window on A's folder, with no panel. Repeat L6 | The notice appears in only one window. If it's the second window, Open Session opens nothing and says `session <id8> is open in another VS Code window`. If it lands in the panel's window, repeat: each window wins the fire about half the time |

Afterwards, close the second window and answer the prompt.

### 7. A stale panel after a terminal resume (A's window)

| # | Do | Expect |
|---|---|---|
| L13 | Settings → turn `claudeLimitBreak.continueInPlace` off. With A idle in the panel: `node inject.js limit 120` | At the fire a terminal resumes A beside the panel (the 1.0 path). After its turn: the "panel tab is still on the conversation" notice → click **Reopen session tab**. Then send a message in the reopened panel. When that turn ends: no second notice. `/exit` the terminal, and turn `continueInPlace` back on |

### 8. A late fire (A's window)

| # | Do | Expect |
|---|---|---|
| L7 | `node inject.js limit 120`, then close every smoke window at once. Wait 13 minutes, then `.\launch.ps1 -Folder a -Second` | Nothing resumes, and the log says `Outcome for <id8>: dropped: came due while VS Code wasn't running (N min late)` |

### Not run by hand

| # | What | Why |
|---|---|---|
| L10 | A holder busy at the 60 s fallback (S3) | It needs a session that turns busy between the fire and the 60 s mark, and there's no reliable way to stage that by hand. The extension unit tests cover it (`dropped: busy at fallback`) |
| L14 | The bridged delay (U4) | It needs a panel bridged to Remote Control, with the claude.ai web client. Optional: bridge A's panel _(unverified: `/remote-control`)_ and `node inject.js limit 120`. At this profile's 0-1 min delay the log shows `bridged; waiting for the web client until …`. With `randomDelayMinMinutes` 5 and `randomDelayMaxMinutes` 30, there's no wait line |

### Afterwards

- Record L2's and L3's N and L12's two statuses in `docs/research/`, with the date and the Claude Code version. The 60 s confirm window should rest on these.
- Remove the mod, if it is still installed: Command Palette → `Limit Break: Remove Claude Code mod`. From a terminal, `claude plugin uninstall limit-break@limit-break` then `claude plugin marketplace remove limit-break` does the same.
- Close the smoke windows. `node setup.js` remakes the sessions.
- Update "Last run" below.

## Part 2: extra cases (dev build, fake sessions)

A fake Claude config folder and fake sessions; the resumed `claude` stops at a login
prompt, which still shows the launch worked. The "All installed extensions are
temporarily disabled" notice is expected: the window runs only the dev build, which is
why the Extensions view doesn't list it.

Limit Break skips whatever a transcript already holds when it starts, so the stops go
in after the window is open (step 3), as in Part 1. Close any Part 2 window before
step 1.

```powershell
npm run compile             # the window runs out/, so build first
cd test\smoke\fake
node prepare.js             # 1. fake sessions A-D, no stops yet
.\launch.ps1                # 2. window 1
node prepare.js stop        # 3. with the window open: A, B, D reset in 2 min, C (weekly) in 65 min
```

`node prepare.js stop [seconds] [weeklySeconds] [letters]` changes the times, or stops
only the sessions named (`stop 120 3900 A`).

C is weekly and resets beyond `maxWaitHours`, which is 1 here, its lowest allowed
value; that's why its reset is 65 minutes out. To see X2 in a few minutes instead:
in `out/src/config.js`, lower the `maxWaitHours` floor from 1 to 0; set
`claudeLimitBreak.maxWaitHours` to `0.05` in `%TEMP%\lb-smoke-kit\fake\profile\User\settings.json`;
then run `node prepare.js stop 120 300`. `npm run compile` restores the floor.

| # | What | Expect |
|---|------|--------|
| X1 | Weekly limit (C) | Announced once at detection; nothing scheduled; no status-bar line |
| X2 | Weekly limit (C), at its reset | Nothing happens: announced once at detection; nothing scheduled; no status-bar line |
| X3 | Subagent limit (D) | No notice and nothing in the tooltip for D, AND the log shows `Turn ended in transcript agent-smoke.jsonl` with no `Limit detected in transcript agent-smoke.jsonl`. The turn-end line is written in the same append as D's limit, so it proves the file was read and the limit beside it skipped. A is the control: the identical limit in a main transcript is detected |
| X4 | Cancel | Close the window, run steps 1-3 again, then status bar → "Cancel Pending Resume" (it cancels everything): the tooltip empties, nothing fires, and the log says how many were cancelled |
| X5 | Two windows | Close all smoke windows, run step 1, `.\launch.ps1`, `.\launch.ps1 -Second` (a second VS Code instance with its own profile, titled ws-untrusted), then step 3. Both windows detect A and B; each session resumes in exactly one window, and the other window's log says `Resume for <id8> claimed by another window; dropping.` |
| X6 | Hover flicker (#49) | Run steps 1-2, then `node prepare.js stop 120 3900 A` (trusted only) and hover the countdown for 10+ seconds; note whether the hover flashes as the seconds tick. Then `node prepare.js stop 120 3900 B` (untrusted: the tooltip gains a "Trust this folder" link) and hover again |

## Cleanup

```powershell
Remove-Item -Recurse -Force "$env:TEMP\lb-smoke", "$env:TEMP\lb-smoke-kit"
```

Part 1's sessions also leave their history in `~\.claude\projects`, in the folders named
`…-Temp-lb-smoke-a`, `…-Temp-lb-smoke-b-…` and `…-Temp-lb-smoke-repo--claude-worktrees-w`;
delete those to drop them from Claude's resume list. Their trust records stay in
`~\.claude.json`; they're harmless, and you can remove the `lb-smoke` entries by hand.

## Last run

1.0.0, 2026-10-07, Windows 11: R1-R8 and X1-X5 passed. One run of X5 had both windows
fire within the same second; the claim files still let only one resume.
