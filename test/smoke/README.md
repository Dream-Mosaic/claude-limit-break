# Smoke kit

A by-hand check of Limit Break in a real VS Code window, run before a release and
whenever a change needs eyes on glass. It doesn't run in CI.

Two parts. Part 1 is the main test: the packaged extension resuming real sessions.
Part 2 covers what Part 1 can't stage with real sessions, using fake ones. Both run in
their own isolated VS Code window and neither touches your real sessions. Everything
they create lives under your temp folder (`lb-smoke` and `lb-smoke-kit`).

Open the log in either window: Command Palette → `Limit Break: Show Log`. The log
names sessions by ID; the scripts print which ID is which letter.

Windows and PowerShell; the scripts need `node`, `code` and, for Part 1, `claude` on
the PATH.

## Part 1: real end-to-end (packaged .vsix, your real login)

`setup.js` makes two throwaway sessions with `claude -p`:
- **A** in `%TEMP%\lb-smoke\a`, gets a five-hour usage limit
- **B** in `%TEMP%\lb-smoke\b`, gets a server overload, and stays untrusted

The window watches only `%TEMP%\lb-smoke` (`watchScope: workspace`).

```powershell
cd test\smoke\real
node setup.js               # 1. the two sessions and the window's profile
# 2. Trust folder A yourself (Limit Break never does): start claude, accept the trust prompt, then /exit
Push-Location "$env:TEMP\lb-smoke\a"; claude; Pop-Location
.\launch.ps1                # 3. packages the repo, installs the .vsix into an isolated VS Code, opens it
# 4. With that window open:
node inject.js limit 120    # A hits a five-hour limit that resets in 2 minutes
node inject.js overload     # B hits a server overload now
```

`launch.ps1 -Vsix <path>` installs a given `.vsix` instead of packaging the repo.

| # | What | Expect |
|---|------|--------|
| R1 | Install | Extensions view shows Limit Break at the version in `package.json`, from the .vsix; status-bar item visible |
| R2 | Limit detected (A) | Notice and a status-bar countdown to about 2 minutes, plus up to 1 |
| R3 | Overload detected (B) | Notice; resume scheduled almost at once (the first backoff step is +0, plus up to 1 min); B is called out as untrusted, with "Open Claude to Trust" |
| R4 | Tooltip | Hover the status bar: one line per pending session, with its time |
| R5 | A resumes | A new terminal runs `claude --resume <A's id> "[Limit Break] Your session was interrupted…"` and Claude replies |
| R6 | B resumes | Same for B. If B wasn't trusted through R3's button, Claude shows its own trust prompt in the terminal; you answer it, Limit Break never does |
| R7 | No doubles | Each session resumes exactly once; the tooltip empties |
| R8 | Backoff reset | After B's resumed turn finishes, `node inject.js overload` again: scheduled at +0 again, because a finished turn resets the count |

Afterwards: close the window. `node setup.js` remakes the sessions.

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
| X1 | Weekly limit (C) | Notice says it will offer Resume Now at the reset, not resume itself |
| X2 | Weekly offer | At C's reset (plus up to 1 min): a Resume Now offer, no terminal of its own |
| X3 | Subagent limit (D) | No notice and nothing in the tooltip for D, AND the log shows `Turn ended in transcript agent-smoke.jsonl` with no `Limit detected in transcript agent-smoke.jsonl`. The turn-end line is written in the same append as D's limit, so it proves the file was read and the limit beside it skipped. A is the control: the identical limit in a main transcript is detected |
| X4 | Cancel | Close the window, run steps 1-3 again, then status bar → "Cancel Pending Resume" (it cancels everything): the tooltip empties, nothing fires, and the log says how many were cancelled |
| X5 | Two windows | Close all smoke windows, run step 1, `.\launch.ps1`, `.\launch.ps1 -Second` (a second VS Code instance with its own profile, titled ws-untrusted), then step 3. Both windows detect A and B; each session resumes in exactly one window, and the other window's log says `Resume for <id8> claimed by another window; dropping.` |
| X6 | Hover flicker (#49) | Run steps 1-2, then `node prepare.js stop 120 3900 A` (trusted only) and hover the countdown for 10+ seconds; note whether the hover flashes as the seconds tick. Then `node prepare.js stop 120 3900 B` (untrusted: the tooltip gains a "Trust this folder" link) and hover again |

## Cleanup

```powershell
Remove-Item -Recurse "$env:TEMP\lb-smoke", "$env:TEMP\lb-smoke-kit"
```

Part 1's two sessions also leave their history in `~\.claude\projects`, in the
folders named `…-Temp-lb-smoke-a` and `…-Temp-lb-smoke-b`; delete those to drop them
from Claude's resume list.

## Last run

1.0.0, 2026-10-07, Windows 11: R1-R8 and X1-X5 passed. One run of X5 had both windows
fire within the same second; the claim files still let only one resume.
