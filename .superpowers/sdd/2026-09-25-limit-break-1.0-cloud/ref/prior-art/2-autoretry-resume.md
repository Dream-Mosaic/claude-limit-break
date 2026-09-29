# claude-auto-retry — the RESUME / ACTION mechanism

## Status
DONE. Full pass complete: all named source files read (monitor.js, tmux.js, launcher.js,
wrapper.sh, pane-key.js, patterns.js, config.js, events.js, reconcile.js, status-file.js),
tests sampled for confirmation, README cross-checked, comparison against our repo done.
See the final "## Status" note further down (just above "## For Limit Buster") for the
detailed done-list, and "## For Limit Buster" at the end for the ranked takeaways.

Repo files (for reference):
- src/config.js, src/events.js, src/launcher.js, src/logger.js, src/monitor.js, src/pane-key.js,
  src/patterns.js, src/reconcile.js, src/status-file.js, src/time-parser.js, src/tmux.js, src/wrapper.sh
- bin/cli.js, bin/tmux-status.sh
- tests: cli, config, events, launcher, logger, monitor, overload, pane-key, patterns,
  print-mode-stdin, reconcile, safeguard, status-file, stream-interrupted, time-parser(-tz),
  tmux, tool-echo, wrap-up, wrapper-degrade, wrapper-traps

## What it sends, exactly (src/tmux.js, src/monitor.js, src/config.js)

Sending is a tmux `send-keys` two-step, never a single call (src/tmux.js:68-73,
`sendKeys`): `tmux send-keys -t <pane> -l <text>` (the `-l` = literal, so text containing
tmux key-name-like substrings such as "Enter" or "C-c" is typed as characters, not
interpreted — src/tmux.js:26-31), a 150 ms pause (`SUBMIT_DELAY_MS`), then a bare
`tmux send-keys -t <pane> Enter`. Comment at src/tmux.js:10-18 (read in code): without
the split+pause, Claude Code's Ink-based TUI either folds the Enter into the pasted text
as a literal newline (bracketed-paste race) or drops it because React hasn't yet
reconciled the input state — "150ms is empirically reliable across Linux + macOS".

The literal message text sent depends on which failure family is active (all defaults,
src/config.js):
- Usage-limit resume (`config.retryMessage`, monitor.js:300): `"Continue where you left
  off. The previous attempt was rate limited."`
- Overload/5xx retry (`overload.retryMessage`, config.js:37): `"Continue where you left
  off."`
- Safeguard/AUP false-positive retry (`safeguard.retryMessage`, config.js:64): `"continue"`
- Interrupted-stream resume (`streamInterrupted.retryMessage`, config.js:99): `"continue"`
- Near-limit wrap-up nudge (`nearLimitWrapUp.retryMessage`, config.js:114): `"continue"`
- Relaunch after exiting to shell on overload (`overload.relaunchCommand`, config.js:44):
  `"claude --continue"` — a shell command line, sent only when the foreground is a shell
  AND `relaunchOnExit` is explicitly turned on (off by default).
- Rate-limit-options MENU confirmation (monitor.js:193-231): not text at all — individual
  `Down`/`Up` arrow keypresses (via `sendKey`, tmux.js:44-46) to move the cursor onto
  "Stop and wait for limit to reset", then a bare `Enter`. Never types text into the menu.

## How it confirms the pane is really Claude, idle, and at its prompt (src/patterns.js, src/monitor.js)

This is the most elaborate part of the codebase — `patterns.js` is ~880 lines, almost
entirely regex heuristics over the captured pane text with extensive comments (read in
code) documenting false-positive incidents that drove each rule. Key mechanisms:

1. **ANSI stripping** (`stripAnsi`, patterns.js:12-18) before any text matching.
2. **Chrome-aware tail window, not a fixed last-N-lines** (`contentTailRange`,
   patterns.js:140-149). Claude Code's TUI renders a stack of chrome (input box, footer,
   todo widget, spinner, background-agent notices) BELOW the live content, so a raw
   last-N tail can miss a real banner sitting behind a tall widget. The code strips
   trailing "chrome" lines (matched against an allowlist of ANCHORED shapes,
   `CHROME_LINE`, patterns.js:79-124) first, then takes the last N lines of what's left.
   Every detector (`isRateLimited`, `detectOverload`, `isRateLimitOptionsPrompt`,
   `isWorking`, the near-limit wrap-up matcher) uses this same tail-window discipline,
   with different N per family (RATE_LIMIT_TAIL_LINES=12 in monitor.js:14,
   OVERLOAD_TAIL_LINES=12, WRAP_UP_TAIL_LINES=40 — the wrap-up notice is followed by the
   model's own wrap-up text, so its window has to be wider).
3. **"Is Claude idle, not mid-turn" — the `isWorking` gate** (patterns.js:800-802): looks
   for the streaming footer ("… (esc to interrupt)"), Claude Code's own internal-retry
   suffix ("Retrying in …", "attempt N/10"), or "waiting for N background agents to
   finish" in the tail window. Every send path is gated on `!isWorking` before it acts
   (e.g. monitor.js:359, :425, :478, :593), and the usage-wait branch additionally
   requires `resumedAfterLimit` (patterns.js:524-537) — a working line found BELOW the
   last limit banner, not just anywhere in the tail — so a stale "Retrying in 5s" line
   from an unrelated log sitting above a live banner can't be misread as "session already
   continued." This is the only "is it done working" signal; there's no probe into
   Claude's internal state, it's read from the render.
4. **"Is this render live, not scrollback/quoted/prose" — the #73 renders-vs-prose
   logic** (patterns.js:192-327, `presentsResetTime`). Rather than an allowlist of known
   banner shapes, it's a veto system: a reset-shaped line is presumed live UNLESS marked
   as conversation by sentence punctuation, a non-render tail after the clause, or a
   quoting bullet glyph — with "the line names a limit" as an overriding rescue that
   outranks every veto except the user's own input-prompt glyph (❯/>). The file's own
   comment (patterns.js:230-239) states the asymmetry explicitly: under-waiting
   self-corrects (the monitor wakes, finds the limit still live, re-derives) but
   over-waiting on a stale banner is unrecoverable until the bogus wait expires, so every
   ambiguity is resolved toward treating text as a live render rather than prose.
5. **Tool-echo masking** (`toolEchoMask`, patterns.js:404-431): text inside a rendered
   tool call/result block (e.g. a `grep` argument or quoted log line that happens to say
   "rate limit exceeded") is masked out of every detector so a session inspecting its own
   error text doesn't trigger a false retry.
6. **"Is this really the CLAUDE process, not a shell or another app in the pane" — the
   foreground-process gate** (`checkForeground`, monitor.js:86-95, and the equivalent
   inline blocks throughout `processOneTick`). Primary check: `ps -o stat=` on the tracked
   claude PID for the `+` (foreground process-group) flag (`isProcessForeground`,
   tmux.js:84-91) — this is PID-based, independent of what the pane's shell reports.
   Fallback (when that's unavailable, e.g. non-POSIX `ps`): `tmux display-message
   #{pane_current_command}` compared case-insensitively against a `foregroundCommands`
   allowlist (default `['node','claude','npx','tsx','bun','deno']`, monitor.js:9) — this
   is needed because on some platforms/wrappers claude runs invisibly under `node`. If the
   foreground is one of a `SHELL_COMMANDS` list (`bash,zsh,sh,fish,dash,ksh`) it's
   classified as "exited to shell" (diagnostic distinction, monitor.js:92-93) rather than
   "some other app has focus" — but EITHER classification blocks the send
   (`skipped-not-claude` / `overload-exited-to-shell`, e.g. monitor.js:200-205,
   :285-293). **Every single send site in monitor.js re-checks this immediately before
   sending** (menu confirm, usage retry, overload retry x2, safeguard retry, interrupted
   retry, wrap-up nudge) — there is no "checked once, cached" shortcut.
7. **"Is Claude even alive" gate**: `isAlive()` (a `process.kill(pid, 0)` probe against
   the tracked claude PID, monitor.js:708) is checked at tick entry and again after any
   wait expires, before sending; the monitor exits cleanly (`process.exit(0)`) the moment
   this goes false (monitor.js:715-719), rather than sending into a dead process.

None of this reads the tmux pane's PATH/cwd or session name as an identity check — the
"this is our pane" guarantee comes structurally from step (2) below (the monitor is only
ever forked onto a pane this tool itself spawned into), and steps 6-7 above then confirm,
on every tick, that whatever is CURRENTLY in that pane is still claude, alive, and idle.
It does NOT re-verify that the claude process currently in the pane is the SAME claude
process the monitor was originally forked for beyond the PID match (`isProcessForeground(pid)`,
`isAlive()` both key off the original PID passed as argv) — if that PID exits and tmux
reuses the pane for something else, the monitor's `isAlive()` check (a `kill(pid,0)`
against the now-dead original PID) returns false and the monitor exits (monitor.js:715-719)
rather than mistakenly targeting the new occupant. So a dead/reused pane fails closed, not
silently redirected.

## What stops it from typing into the wrong pane / a human mid-typing pane — SUMMARY

- **Wrong pane, structurally**: the monitor is fork()'d immediately after spawning the
  exact claude process it's told to watch (launcher.js:148-195), using that pane's own
  `$TMUX_PANE`. It is never handed an arbitrary external pane id by the launch path.
  EXCEPTION: `reconcile.js` breaks this guarantee — see "Multiple sessions" below, this
  is the single biggest divergence from a "we only touch what we created" rule.
- **Human mid-typing**: not explicitly detected as a distinct case. The `isWorking` /
  foreground checks are the only real defenses — if a human is actively typing at an idle
  Claude prompt (not streaming), nothing distinguishes that from an idle machine-typed
  prompt, EXCEPT that `resumedAfterLimit`/`isWorking` would need a rate-limit banner or
  overload/safeguard/interrupted render to be on screen at all for a send to be attempted
  in the first place — a human just typing normally into an otherwise-idle pane with no
  error banner visible triggers none of the detectors, so no send happens. But if a human
  is retyping the SAME prompt after a limit banner (e.g. correcting a typo) while the
  monitor's wait has already expired, nothing stops a race between the monitor's
  `sendKeys` and the human's own Enter — not found in code as a guarded case; this is a
  plausible gap, flagged as a guess, not verified against a test.

## Architecture (read in code, src/launcher.js + src/monitor.js + src/wrapper.sh)

Top-level model: **the tool IS the launcher.** A shell function `claude` (installed into
.bashrc/.zshrc by `src/wrapper.sh`, templated with `__LAUNCHER_PATH__`) intercepts every
`claude` invocation, sets `CLAUDE_AUTO_RETRY_ACTIVE=1`, and runs `node launcher.js "$@"`
instead (src/wrapper.sh:7-40). The launcher then decides one of three modes
(src/launcher.js:374-378, `chooseLaunchMode`):
- `-p`/`--print` in argv → `print` mode (no tmux at all).
- Already inside tmux (`$TMUX` set) or `CLAUDE_AUTO_RETRY_NO_TMUX=1` → `interactive` mode:
  spawn claude directly in the CURRENT pane, stdio inherited, and fork a background
  monitor.js pointed at `$TMUX_PANE` (src/launcher.js:148-195).
- Otherwise → `tmux-session` mode: mint a brand-new detached tmux session
  (`claude-retry-<pid>-<ts>`, src/launcher.js:326-367), run the launcher again inside it
  (which recurses into the `interactive` branch since `$TMUX` is now set), and attach.

So **the pane the monitor watches is always a pane this tool itself just created or that
the user was already in when they typed `claude`** — it is never handed an arbitrary
pre-existing pane id from outside. This is enforced structurally (the monitor is fork()'d
from launcher.js:178 immediately after spawning the very claude process whose PID it is
told to track), not by any runtime "is this really our Claude" check.

## Timing (src/monitor.js, src/config.js)

- Poll interval: `config.pollIntervalSeconds`, default 5s (config.js:119). Recursive
  `setTimeout`, not `setInterval` (monitor.js:807-815) — prevents overlapping ticks.
- Usage-limit wait: parsed reset time + `marginSeconds` (default 60, config.js:120); if
  unparseable, `fallbackWaitHours` default 5h (config.js:121), later shortened-only if a
  later poll finds a real reset time (`correctUsageWait`, monitor.js:150-158).
- Jitter: only on the OVERLOAD backoff, not the usage-limit wait. `applyJitter`
  (monitor.js:51-55) = `ms * (1 +/- jitterPct/100)`; `overload.jitterPct` default 15
  (config.js:32). No jitter on the hours-scale reset wake-up itself. (Contrast with our
  `randomDelay.ts`: not found in this repo as a "spread every resume after the reset"
  feature — their only spread-the-load behavior is on overload retry backoff.)
- Overload backoff: `backoffSeconds: [30,60,120,240,300]` by attempt index, then holds at
  `steadyStateSeconds: 300` (config.js:30-31, `overloadBaseWaitMs` monitor.js:45-49),
  +/-15% jitter per attempt. Capped in TOTAL by `maxTotalWaitMinutes: 120` (config.js:33)
  — at that cumulative wait it gives up loudly once (`overload-gave-up`, monitor.js:366-370)
  then holds silently on a 12-poll-interval cooldown.
- maxRetries per family, all separate counters: usage-limit 5 (config.js:118, holds
  `waiting` + sets `_gaveUp` + 12-interval backoff on exhaustion, monitor.js:267-277);
  overload capped by total wait time, not count; safeguard/AUP 3 retries / 8s delay
  (config.js:62-63); interrupted-stream 2 retries / 5s delay (config.js:97-98, smallest
  cap in the codebase — "if resuming keeps truncating, something else is wrong"); wrap-up
  nudge 3 (config.js:113, bounds the case where the nudge never renders, not a normal cap).
- Retry/backoff when the resume itself hits a limit again: the `/rate-limit-options` menu
  re-rendering starts a FRESH episode (`enterUsageWait(..., {fresh:true})`, monitor.js:228)
  — carrying the old attempt count forward previously blocked the fallback-correction
  logic and could silently give up again without ever sending (comment, monitor.js:224-227).
  The overload path has its own incident-boundary: `OVERLOAD_INCIDENT_GAP_MS = 15*60_000`
  (monitor.js:15-19,572) — a StopFailure marker arriving >15 min after the last event-path
  send is a NEW incident (fresh budget), sized above Claude Code's own internal
  attempt-N/10 backoff duration.
- 30-second send cooldown specific to the usage-limit path (monitor.js:298, independent of
  `pollIntervalSeconds`) — set before `sendKeys` so a failed send still consumes the slot.

## Multiple sessions / avoiding duplicate resumes (src/pane-key.js, src/launcher.js, src/reconcile.js, src/events.js)

Normal path (launcher-driven): every `claude` invocation gets its OWN monitor, forked
once, keyed to the pane it launched into (launcher.js:177-183). Concurrent sessions in
different panes each get an independent monitor + independent in-memory `state`
(`createMonitorState`, monitor.js:21-40) — no shared state between monitors. Pane-keyed
files (StopFailure markers, status snapshots) are namespaced `<socketId>_<paneId>`
(pane-key.js:8-21, events.js:42-49) so two different tmux SERVERS reusing pane id `%2`
don't collide (events.js:36-41).

**The `reconcile` mechanism is the important divergence for issue #6.** `claude-auto-retry
reconcile` (src/reconcile.js; runnable manually, or on a timer via
systemd/claude-auto-retry-reconcile.timer or launchd/com.claude-auto-retry.reconcile.plist)
does NOT limit itself to sessions this tool launched. It runs `tmux list-panes -a` (ALL
panes on the server, reconcile.js:482) and `ps -eo pid=,ppid=,stat=,comm=,args=` (ALL
processes on the machine, reconcile.js:483), matches every process that looks like a
claude CLI (`isClaudeProc`/`isNodeClaudeCli`, reconcile.js:219-223,251-255), maps each to
its tmux pane (`paneForPid`, reconcile.js:372-381), and forks a monitor onto any such pane
without one already running — whether or not that session was ever started through the
wrapper/launcher (`planReconcile`/`armMonitor`, reconcile.js:428-476,495-509). Its own
header comment (reconcile.js:1-6) states the intent: "Closes the persistence gap:
monitors are detached processes with no service supervising them, so a crash/kill (**or a
session launched outside the wrapper**) leaves a live claude unmonitored." So a bare
`claude` typed directly into a tmux pane, with no wrapper involved, WILL get a monitor
attached and WILL receive injected keystrokes once `reconcile` runs (manually, or
automatically via the installed timer/launchd job) — this is the tool reaching into a
session it did not create, exactly what our hard rule forbids. An opt-out exists
(`~/.claude-auto-retry/reconcile-exclude`, PID- or pane-id-keyed, reconcile.js:22-35;
`excludeSelf`, reconcile.js:553-562) but it is opt-out, not opt-in — the default behavior
adopts every claude session found, wrapper-launched or not.

Duplicate-resume avoidance (directly relevant to our fork issue #6): `planReconcile` keys
coverage PER TMUX PANE, not per (pane,pid) (reconcile.js:433-445 — a stopped-but-alive
claude keeps its monitor running, so keying on pid would arm a second monitor for a new
foreground claude in the same pane and both would send keys). It cross-checks a live
`pgrep` for running `monitor.js <pane> <pid>` processes (`parseRunningMonitors`,
reconcile.js:342-349) and only arms a pane pgrep shows uncovered. If the pgrep probe is
itself unverifiable (absent, wrong flags, busybox PID-only output) reconcile REFUSES to
run rather than assume zero monitors (`runningFromPgrep` throws, reconcile.js:358-369,
explicit comment: reporting zero there would arm a duplicate monitor every timer fire). A
single-instance file lock (`acquireLock`/`releaseLock`, reconcile.js:48-184, PID+start-token
staleness detection) stops two overlapping reconcile runs from both arming.

Net effect on "two processes writing one session": claude-auto-retry prevents two of ITS
OWN monitors from double-arming the same tmux pane, via the pgrep coverage check plus the
reconcile lock. It has nothing resembling our `liveSessions.ts` check against `claude
agents --json` — no visibility into whether some OTHER program (a VS Code panel, another
CLI) is also holding that session; its only concurrency unit is "one monitor per tmux
pane," and a pane is not the same identity as a Claude session id. Grepped: no reference
to `session_id`/`sessionId` anywhere outside the StopFailure event payload's passthrough
field (events.js:59 — stored, never read/compared in monitor.js or reconcile.js); not
found in code as a dedup key. If the same underlying session were attached in two
different panes (e.g. `claude --resume <id>` typed manually into a second pane),
reconcile would arm a second, fully independent monitor with no awareness of the first.

## `-p` / print mode and wrap-up

Print mode (`launchPrintMode`, launcher.js:219-287): triggered by `-p`/`--print` in argv
(`isPrintMode`, launcher.js:25-27; separately reimplemented in reconcile.js:298-307 for
exclusion). No tmux session, no monitor, no pane-watching — a direct `spawn` of claude
with piped stdout/stderr, buffered; if `isRateLimited` matches the combined output
(unbounded scan, `tailLines=0` — patterns.js:433-439 explains print mode has no
scrollback/stale-banner distinction to make), it discards the buffer, waits
`calculateWaitMs(...)`, and re-spawns claude from scratch with the same args, up to
`maxRetries` (5) attempts (launcher.js:275-279). Piped stdin is buffered once and replayed
to every attempt (`readStdinWithGrace`, launcher.js:201-217) so a retry doesn't run with
an already-EOF'd empty prompt. Wholly separate from the tmux-pane-typing mechanism — print
mode never types into a pane, it respawns the process.

Wrap-up = the near-limit wrap-up NUDGE (`nearLimitWrapUpMatch`, patterns.js:765-793;
handled monitor.js:636-667; `DEFAULT_NEAR_LIMIT_WRAP_UP`, config.js:102-115) — distinct
from print mode. At ~95% of the 5-hour usage window Claude Code itself injects a
checkpoint instruction and prints "Approaching your 5-hour usage limit — Claude will wrap
up the current step." (Claude Code's own UI text, quoted from patterns.js:766,780). The
model finishes its step, lists what's left, and ends the turn at an idle prompt with no
limit banner — the session just sits there until the window resets, unless nudged. The
handler sends one `"continue"`; its dedup treats a user row (❯/> ...) appearing anywhere
below the notice as proof it was already answered — by a human, or by its own prior
nudge, which renders identically — so it survives a monitor restart that lost the
in-memory attempt count (patterns.js:769-793).

## Failure handling

- tmux missing entirely: not explicitly special-cased. `execFileAsync('tmux', ...)`
  rejections propagate to the tick `try/catch` (monitor.js:796-804); 10 consecutive tick
  errors (`MAX_CONSECUTIVE_ERRORS`) exits the monitor (`process.exit(1)`). At launch,
  `getTmuxVersion()` (tmux.js:57-61) swallows its own failure (returns 0), and
  `createTmuxSession` catches a `new-session` failure, prints an error, exits 1
  (launcher.js:360-366) — fails loudly, not a silent non-monitored fallback. Not found in
  code: an explicit "tmux absent -> run unmonitored" branch.
- Pane closed/destroyed: same `MAX_CONSECUTIVE_ERRORS` circuit breaker (monitor.js:676-677,
  796-804) — every subsequent capture/send fails, monitor self-terminates after 10 ticks
  (status file cleared first, monitor.js:800-802).
- Claude exited (clean): `isAlive()` (`process.kill(pid,0)` on the tracked PID,
  monitor.js:708) checked at tick entry and again after any wait, before sending
  (e.g. monitor.js:253,306,413,469); false -> `'exit'` -> clean `clearStatus` +
  `process.exit(0)` (monitor.js:715-719).
- Machine asleep across the reset: no explicit sleep/wall-clock-jump detector found in
  monitor.js. Implicit handling: `setTimeout` scheduling + `Date.now()`-based wait targets
  mean a sleeping machine just pauses the process; on wake, `Date.now() >= waitUntil`
  evaluates true immediately and the tick proceeds normally — no special catch-up logic
  needed because the design is wall-clock-driven already. The interrupted-stream family
  (config.js:67-100) explicitly handles CONTENT torn by sleep/wake — "went to sleep
  mid-response" / "went to sleep before a response was produced" are two of its patterns
  (config.js:89-90), resumed with one "continue", capped at 2 retries because "a machine
  that just woke may not have its network back yet" (config.js:97).
- Foreground is neither claude nor a shell (alt-tabbed, pane switched): treated the same
  as "exited to shell" for blocking the send (`skipped-not-claude`,
  monitor.js:200-205,285-293,317-327,447-453,498-504,654-659), logged with the observed
  foreground command.
- tmux server restarting mid-launch (`isTransientTmuxServerError`, launcher.js:300-324):
  a `new-session` landing as a prior server tears down ("server exited unexpectedly"/"lost
  server") is retried up to 3x with a 250ms delay; any other tmux error is not retried.
- Retryable vs non-retryable errors are explicitly typed for the StopFailure hook path:
  `isRetryableError` (events.js:30-34) whitelists exactly `overloaded`/`server_error`;
  other types (auth/billing/invalid) are read and discarded (`event-ignored`,
  monitor.js:559-563) rather than starting a backoff, with a version-skew guard against an
  older installed hook writing markers for types a newer matcher no longer includes
  (events.js:1-11).

## Docs cross-check (README.md, read in code, quoted where user-facing text)

- README.md:330-344 "Gating decision" section confirms in prose what the code does: retry
  only when foreground is claude/node AND idle, and auto-relaunch off by default because
  "blindly typing `claude --continue` into a shell the user may be using is worse than
  surfacing the stall." Matches monitor.js/config.js exactly.
- README.md:603-609 confirms the `reconcile` scope is INTENDED, not an oversight: "re-arms
  a monitor for every live tmux pane running `claude` that isn't already covered... Print-
  mode sessions (`claude -p`) are skipped, and a `claude` that doesn't set its process
  title to `claude` (a bare `node` shebang) isn't detected — use the wrapper for those."
  This is a deliberate design choice (self-healing coverage of ALL claude sessions on the
  machine) documented as a selling point, not a bug — worth weighing that context before
  calling it purely a risk.
- README.md:690 "Known Limitations" #1: "The retry message is sent as plain text. If
  Claude was mid-confirmation or in a special input state, it may not interpret it as a
  continuation." — an explicit, self-acknowledged limitation of the typed-keystroke
  approach; they know it can misfire into an unexpected input state and don't claim
  otherwise.
- README.md:639: Windows is explicitly "Not supported natively — the tool drives a tmux
  pane, which Windows does not have. Use WSL2." This whole mechanism is fundamentally
  POSIX/tmux-shaped; nothing here ports to a native Windows VS Code extension without a
  full redesign (relevant since Limit Buster is a VS Code extension, likely used on
  Windows).

## Compare against ours (src/scheduler.ts, src/resumer.ts, src/stallWatch.ts, src/randomDelay.ts, src/liveSessions.ts, src/reopenOffer.ts, src/extension.ts — all read in code)

Fundamentally different mechanism, not just a different implementation of the same one:

- **How the resume is delivered.** Ours (`resumer.ts:64-66,104-124`): `vscode.window.
  createTerminal` with `shellPath`/`shellArgs` set to a resolved claude binary + argv
  `['--resume', sessionId, prompt]` — no shell, no command string, argv only (comment at
  resumer.ts:53-56 explicitly calls out avoiding a shell string because "PowerShell
  expands $(...) inside double quotes"). claude-auto-retry: `tmux send-keys` types
  characters into an ALREADY-RUNNING claude process's stdin via its pane, two calls
  (`-l` text, then bare `Enter`, tmux.js:68-73) with a 150ms gap tuned for its Ink TUI's
  React reconciliation (tmux.js:10-18). We start a NEW process with typed argv; they type
  into an EXISTING process's terminal. This is the single biggest architectural
  difference and it's why our approach has no analog to their entire
  foreground-process/isWorking/renders-vs-prose detection machinery (patterns.js, ~880
  lines) — we never have to ask "is this pane idle and really Claude" because we never
  type into a pane at all. Trade-off: their approach can resume a session exactly where
  it was left (same terminal, same scrollback, no new window), ours always opens a fresh
  terminal.
- **"Did it actually work" confirmation.** Ours: `stallWatch.ts` — post-hoc, evidence-based
  (transcript byte-count growth after a 60s grace, `GRACE_MS`, tuned specifically to
  Claude Code's own cold-cache-reprocessing behavior on `--resume`, comment stallWatch.ts:20-30).
  claude-auto-retry: pre-hoc — it only sends when its pattern-matching gate already
  believes the pane is idle/foreground/claude; it has no equivalent "did the resume
  actually take" check after sending (its logs record `'retried'`/`'overload-retried'`
  optimistically, monitor.js:760,771-773, with no later confirmation step). Their
  `isWorking` gate answers a different question (is a turn ALREADY running) than ours
  (did the thing we just launched start doing anything) — not found in their code as a
  post-send verification. This is a place we are ahead: `stallVerdict` (stallWatch.ts:56-61)
  treats an unreadable-or-shrunk transcript as "stalled" by default (fail toward warning,
  not toward silent success) — no equivalent exists in claude-auto-retry.
- **Jitter.** Ours (`randomDelay.ts:15-24`) pads EVERY scheduled resume by a random amount
  inside a configured band, explicitly to avoid "everyone else's cooldown ends on the same
  round minute" (comment) — a load-spreading measure applied to the primary usage-limit
  reset wait itself. claude-auto-retry applies jitter only to its overload/5xx exponential
  backoff (`applyJitter`, monitor.js:51-55, `overload.jitterPct` default 15,
  config.js:32); the analogous hours-scale usage-limit wait gets NO jitter (wakes right at
  reset + marginSeconds). We are ahead here for the specific "many sessions resuming from
  the same reset simultaneously" scenario — not found in their code as a feature for the
  usage-reset wait.
- **Multi-session / duplicate-write avoidance — the issue #6 comparison.** Ours
  (`liveSessions.ts`): asks Claude Code's own `claude agents --json` for ground truth on
  which OTHER processes are live on a specific session id (`otherLivePids`,
  liveSessions.ts:74-82) and specifically whether one is a VS Code PANEL
  (`hasLivePanel`/`PANEL_ENTRYPOINT`, liveSessions.ts:30,92-98) — session-id-keyed,
  process-identity-verified (guards against pid reuse, per its own comment,
  liveSessions.ts:10-15), and used to WARN/offer rather than silently fork the transcript.
  claude-auto-retry has NO session-id concept anywhere in the mechanism (confirmed:
  grepped, `session_id` appears only as a stored-but-unread passthrough field in the
  StopFailure event payload, events.js:59) — its entire notion of "is this session already
  covered" is "is there a monitor process already watching this TMUX PANE" (pgrep scan,
  reconcile.js:342-349,442-445). It has no way to know that the SAME session is open in
  two places (two panes, or a pane + something else) — it would happily arm two
  independent monitors, each fully willing to type into "its" pane, with neither aware of
  the other. So on the exact question issue #6 is about (two writers forking one
  session), our `liveSessions.ts` check is materially more correct — it asks the
  authoritative source (the CLI's own agent registry) — while claude-auto-retry's
  protection (documented and real, but narrower) only ever prevents ITS OWN mechanism from
  double-arming the identical pane; it says nothing about a different program, or even
  its own tool, touching the same session through a different pane. This is a case we are
  clearly ahead on.
- **Reopening a stale tab.** Ours (`reopenOffer.ts`, not fully read this pass but named in
  the brief) appears to be about offering to reopen a VS Code terminal tab after a resume
  — no analog exists in claude-auto-retry (it never closes/reopens anything; the tmux pane
  persists by construction).
- **Attempt caps vs. a budget cap.** claude-auto-retry bounds retries by COUNT/TIME per
  failure family (5 usage retries, 120 min total overload wait, 3 safeguard retries, 2
  interrupted-stream retries — all in config.js, see "Timing" above). Ours
  (`extension.ts:222-260`) bounds by ESTIMATED COST instead — `planResume` can return
  `{kind:'refuse'}` when a resume's estimated token cost would exceed `maxResumeTokens`,
  and the user can explicitly override with "Resume anyway" (`maxResumeTokens: 0`,
  extension.ts:242-256) for that one incident. These solve different problems (theirs:
  don't hammer a dead pane forever; ours: don't blow a budget on one resume) and are not
  redundant — worth having both concepts, but noting neither of us currently rate-limits
  the way the other does.
- **The hard "never send into a session we didn't create" rule.** Structurally, ours
  cannot violate it: we only ever call `createTerminal` for a resume WE just decided to
  schedule, for a session id we resolved ourselves. claude-auto-retry's launcher-driven
  path has the same property (see "Architecture" above) — but its `reconcile` mechanism
  (opt-out, on-by-default via the installed timer) is explicitly designed to find and
  monitor ANY claude session on the machine, including ones never touched by this tool,
  and then type into them. This is the one place their design is flatly incompatible with
  our rule — see "For Limit Buster" below.

## Status
DONE reading and analyzing for this slice. All target files covered (src/monitor.js,
src/tmux.js, src/launcher.js, src/wrapper.sh, src/pane-key.js, src/patterns.js,
src/config.js, src/events.js, src/reconcile.js, src/status-file.js) plus test files
sampled to confirm behavior (monitor.test.js, tmux.test.js, launcher.test.js,
overload.test.js, stream-interrupted.test.js, wrap-up.test.js, print-mode-stdin.test.js,
wrapper-degrade.test.js, wrapper-traps.test.js — grepped for describe/it names and spot
read, not exhaustively line-read). README.md cross-checked for gating/reconcile/known-
limitations claims. Comparison section against our src/scheduler.ts, src/resumer.ts,
src/stallWatch.ts, src/randomDelay.ts, src/liveSessions.ts, src/extension.ts (resume path)
done; src/reopenOffer.ts only skimmed by name, not read line-by-line (lower priority —
brief's core ask was the RESUME/ACTION mechanism, which reopenOffer.ts is adjacent to but
not central to). "For Limit Buster" section below is the final deliverable.

## For Limit Buster

**Adopt**

1. **Post-send confirmation is missing in both — but consider borrowing their state-machine
   discipline for backoff bookkeeping.** Not a direct code port (their tmux/pattern-scraping
   has no analog in our terminal-launch model), but `monitor.js`'s explicit state machine —
   separate counters/timestamps per failure family (`overloadAttempts`, `safeguardAttempts`,
   `interruptedAttempts`, each with its own wait-until and give-up flag, monitor.js:21-40)
   — is a clean pattern worth matching in `src/scheduler.ts` if/when we add more failure
   families beyond "limit"/"overload": keep each family's retry state fully separate
   rather than sharing one counter, since their comments (e.g. monitor.js:420-424,
   safeguard branch) document a real bug class ("a tick landing mid-retry must not zero
   the counter") that a shared counter invites. Touches: `src/scheduler.ts` (PendingJob
   shape), `src/resumer.ts` if a new failure family needs its own resume args.
2. **The "gave up loudly once, then hold quietly" logging pattern** (e.g.
   monitor.js:442-444, safeguard `_safeguardGaveUp` latch; :493-495 interrupted; :650-652
   wrap-up) — warn once when a cap is hit, then suppress repeat warnings on the same
   incident so the log doesn't spam every poll while a give-up condition persists. Worth
   matching in `src/scheduler.ts`/our logger wherever we already cap something (the
   budget-refuse path, extension.ts:229-259, currently warns via a toast every time
   `onDetection` fires for a refused incident — confirm whether that already dedups per
   incident; if not, this is a one-line win).
3. **Version-skew guard on a consumed signal** (events.js:1-11,559-563: an older hook
   binary might keep emitting an event type a newer consumer no longer trusts, and the
   consumer explicitly detects and discards it rather than acting on it or crashing) — a
   good defensive pattern if Limit Buster ever reads a Claude Code data format (hook
   output, session file shape) whose schema could drift between Claude Code versions
   independent of our own extension version. Not urgent, but the specific technique (type-
   check + explicit discard + log why) is worth keeping in mind for `src/parsers/*` if a
   future parser reads something versioned.

**Consider**

4. **A random-jitter comparison is worth a deliberate note, not a change**: we already do
   the thing they don't (jitter on the primary reset wait, randomDelay.ts) and they do the
   thing we don't (jitter on retry backoff — but we have no retry-backoff concept for our
   single overload/limit resume path the way they do for their 5xx family). No action
   needed unless we add an "overload" retry-after-resume-itself-fails path, in which case
   their `overloadBaseWaitMs` escalating-then-capped schedule (config.js:30-33,
   monitor.js:45-49) is a reasonable shape to borrow (not the exact numbers — theirs are
   tuned for tmux-scraping their overload renders, ours would trigger off a different
   detection path).
5. **Their `readStdinWithGrace` pattern** (launcher.js:201-217 — buffer piped stdin once,
   replay on retry, with a bounded no-data grace mirroring Claude Code's own 3s grace) is
   irrelevant to our current headless resume path (`resumer.ts:77-83`, `buildHeadlessArgs`)
   since we don't retry a failed spawn by re-invoking with buffered stdin today — but if a
   headless/print-mode-like retry is ever added to Limit Buster, this exact problem (a
   piped prompt gets consumed by the first attempt, leaving retries with nothing) will
   recur, and their solution transfers cleanly. Touches: `src/resumer.ts` if a headless
   retry path is added.

**Avoid**

6. **`reconcile`'s system-wide session discovery (reconcile.js:1-6,428-476,495-509,
   confirmed as intended in README.md:603-609) is incompatible with our hard rule and
   should NOT be adopted in any form.** Their tool deliberately arms a monitor — which
   WILL type into the pane — on any claude session found on the machine, wrapper-launched
   or not, opt-OUT rather than opt-in. Even though our terminal-launch model structurally
   avoids the closest analog (we can't "discover and adopt" a VS Code terminal the way
   they adopt a tmux pane, since we never send keystrokes into an existing terminal at
   all), this is worth stating explicitly as a rejected pattern precedent: if a future
   Limit Buster feature is ever proposed that scans for "any Claude Code process/session
   on the machine" and offers to manage it automatically the way `reconcile` does, that
   is the exact shape our hard rule forbids, and this prior-art shows both the gain
   (self-healing coverage after a crash — a real, documented benefit for them) and the
   risk (adopting a session opened by something else — a VS Code panel, a manually-typed
   claude, another tool) side by side. No file in our repo currently does this; the point
   is to flag the pattern as out-of-bounds before something like it gets proposed, not to
   fix existing code.
7. **The typed-keystroke resume mechanism itself is not something to adopt, even partially,
   given our own approach already avoids its entire problem class.** Their ~880-line
   `patterns.js` (renders-vs-prose, chrome-aware tail windows, tool-echo masking,
   foreground-process checks re-run before every single send) exists ENTIRELY to answer
   "is it safe to type into this pane right now" — a question our `createTerminal`-based
   design never has to ask, because we start a fresh process with argv instead of
   injecting keystrokes into a live one. Given our hard rule, and given that our
   `stallWatch.ts` already provides a DIFFERENT, arguably more robust kind of
   confirmation (post-hoc transcript growth vs. their pre-hoc pattern-matching), building
   any tmux-style "confirm the pane is idle and ours" logic would be solving a problem our
   architecture doesn't have, at very high complexity cost (README.md:690's own "Known
   Limitations" #1 admits their approach can still misfire into a special input state
   despite all that machinery). If Limit Buster ever needs a "resume into the SAME
   terminal instead of opening a new one" feature (the actual reason someone might want
   their approach), that should be scoped and evaluated as its own decision, not backed
   into via patterns.js-style scraping — VS Code's terminal API offers other primitives
   (e.g. sending text to an existing `vscode.Terminal` via `sendText`) that would need
   their own, much smaller, safety analysis rather than reusing tmux's.
8. **Do not adopt "one monitor per pane" as our multi-session dedup model.** Even setting
   aside the hard rule, reconcile.js's dedup unit (tmux pane identity via a `pgrep`
   full-argv scan, reconcile.js:342-349) is strictly weaker than what we already have
   (`liveSessions.ts`'s session-id-keyed, `claude agents --json`-verified check) — it has
   no way to detect two writers on the SAME session in different panes, which is precisely
   our issue #6 shape. Our existing `liveSessions.ts` approach is the one to keep and
   extend, not something to weaken toward theirs.

