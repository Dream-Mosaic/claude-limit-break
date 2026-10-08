# Prior-art synthesis: claude-auto-retry and claude-preheat (2026-09-23)

Sources are the five slice files in `findings/`. Items marked **[verified]** were re-checked by the lead against our code, the installed CLI or real transcripts. Everything else is the agents' reading, with `file:line` citations in their files.

Both repos are MIT licensed. No code was copied.

## Top findings

1. **Claude Code resumes at the reset by itself.** **[verified]**
   - The installed `claude.exe` 2.1.281 has a `/config` toggle, "Continue automatically at usage limit" (`autoContinueAtUsageLimit`). The code defaults it to on, but it only appears for some accounts and asks for consent. Related internals include `armRateLimitAutoContinue` and `autoContinueResetsAt`.
   - preheat withdrew its own relay feature because of it; see its commit `91ae26a` (2026-08-19), which cites v2.1.234.
   - Today's transcripts show no native continue after the 11:10am or 4:10pm resets, only Limit Buster's terminals. So it is either off for this account or not active in the VS Code panel. Which of the two is undetermined.
   - Consequence: when it is on, our resume is a second writer, which is #6. We need to detect the setting and defer to it.
   - **Update: the VS Code panel does not have it.** [verified: docs plus the extension's code]
     - The docs (interactive-mode "Wait for a usage limit to reset", whats-new 2026-w33) cover it for the interactive terminal from v2.1.234, plus a separate Desktop checkbox. vs-code.md never mentions it.
     - The panel runs the bundled binary with `--input-format/--output-format stream-json`. The auto-continue logic lives in the terminal UI host: it pre-fills the prompt box and shows the "continuing automatically at …" line.
     - The webview's `index.js` has no auto-continue code. `extension.js` only has the key in its settings schema.
     - That fits today: the panels never continued on their own.
     - **So in the panel we fill a real gap. For `entrypoint: cli` sessions, including our own resume terminals, native continue is on by default and we double-resume.** Skip cli sessions unless `autoContinueAtUsageLimit === false` in the user or managed settings.

2. **The transcript already carries the reset time in a structured field.** **[verified]**
   - Every `rate_limit` entry has `quotaLimits: {status, resetsAt: <epoch s>, rateLimitType: "five_hour", overageStatus, …}`.
   - `src/` never reads it; we regex the text.
   - Using it closes most parser gaps at once: calendar dates and weekly limits, time zones and DST (#10), and the just-passed rollover.
   - A related signal: the statusLine hook gets `rate_limits.five_hour.{used_percentage, resets_at}` on stdin (preheat's `statusline-tap.cjs`).

3. **Untrusted non-user entries can arm false timers.** **[verified]**
   - The watcher scans assistant and system entries with `trusted:false`. That includes **subagent transcripts**, which are scanned recursively.
   - These strings all fire `detectLimit`:
     - a `grep` quoting a banner
     - "You've used 91% of your session limit · resets 12:40pm"
     - a subagent checkpoint note today: 05690955 subagent, 05:42Z, "…You have used up your monthly limit. Try again in 3 hours"
   - A replay of every transcript for this project found 3 untrusted hits. 2 were genuine (a compaction that failed on the limit). 1 was a false positive.
   - What the false positive actually scheduled was not traced.

4. **Limit Buster resumed both sessions again at 21:17 and 21:22Z** (pids 28148 and 68256). **[verified]** Both identified themselves as Limit Buster resumes and stood down without writing anything. There are now 7 live claude processes on this repo.

## Adopt
| # | What | Evidence | Touches |
|---|---|---|---|
| A1 | Detect native auto-continue, and skip or notify instead of spawning. | Finding 1 | `extension.ts`, `liveSessions.ts` |
| A2 | Read `quotaLimits.resetsAt` first and fall back to text parsing. | Finding 2 | `transcriptWatcher.ts`, `limitParser.ts` |
| A3 | Tighten the untrusted path: exclude subagent files, or require `flagged`, or veto quoted text and percentage warnings. | Finding 3; auto-retry #63 and PR #85 | `transcriptWatcher.ts`, `limitParser.ts` |
| A4 | A grace window for a reset that has just passed. A "10am" read at 10:03 currently waits about 24h. | auto-retry `time-parser.js:50-63` plus 3 tests | `limitParser.ts:210-224` |
| A5 | Overload: don't act on Claude Code's own in-flight "Retrying in Ns · attempt k/n". Route "temporarily limiting requests (not your usage limit)" to overload; today it is dropped. | Direct runs by agent 1 | `overloadParser.ts`, `policy.ts` |
| A6 | Handle a stream interrupted by sleep ("Your computer went to sleep mid-response…"). | auto-retry PR #77 | `overloadParser.ts` |
| A7 | DST: resolve ambiguous times to the late side. | auto-retry `e9a69f5` | #10 |
| A8 | Show a distinct "gave up" state. Warn once, then hold quietly. | auto-retry `tmux-status.sh:50-58`, monitor latches | `statusBar.ts`, `extension.ts` |
| A9 | Give distinct notifications for auth failure, still limited, and generic failure. | preheat `platform.ps1:443-470` | `extension.ts` |

## Consider
- A fallback wait for a message that is clearly a limit but has no parseable time. auto-retry waits 5h plus 60s. Mostly moot once A2 lands.
- Persistent logs that survive a reload: a `LogOutputChannel` or a file. Whether ours survives a reload is unverified.
- Warn when a resume is likely to land while the machine is asleep. preheat checks whether wake timers are enabled.
- Preheat as an opt-in feature. It costs about $0.04 a ping, starts usage the user never asked for, and only fires while VS Code is running. It would reuse the minimal probe recipe: `-p "hi" --model haiku --no-session-persistence --strict-mcp-config --mcp-config <empty> --output-format json`.
- The near-limit wrap-up notice ("Approaching your 5-hour usage limit — Claude will wrap up the current step."). It isn't an error, and nothing resumes after it.
- Keep separate retry state for each failure family if more families get added.

## Avoid
- Typing into live sessions, and auto-retry's `reconcile`, which is system-wide discovery that types into any claude pane. Both break our hard rule.
- Scraping rendered terminal output.
- OS services, shell rc edits and profile edits. Also a split uninstall that leaves hooks and timers behind.
- Persisting an absolute path to a binary that auto-updates without checking it still exists when the job fires (preheat's Store `pwsh` incident); compare issue #16.

## Where we are ahead
- Launching a fresh process with argv `--resume <uuid>` instead of typing keystrokes.
- A session-id-keyed live check. auto-retry keys by pane, so it can't see two writers on one session.
- Jitter on the main wait.
- Confirming after the resume that the transcript grew.
- A pre-flight budget guard. Neither project has one.
- No footprint on the system.
