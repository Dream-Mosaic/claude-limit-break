# Limit Break 1.0 — finishing plan
**Spec:** `docs/design/2026-09-01-design.md` (Goals, Non-goals, Findings) and the README's shipped "panel tab after a resume" behaviour. This plan argues from them; where a task conflicts, the spec wins.

Branch `fix/1.0-field-reports`, worktree `C:/Users/thegr/Dream-Mosaic/Projects/claude-limit-buster-lead`.
Base for this plan: `3c0de89` (seven red tests, written on purpose, for Task 1).

Evidence this plan argues from:
- `docs/research/2026-09-23-prior-art-auto-retry-preheat.md` (the "synthesis"; items A1–A9 are its Adopt table)
- `docs/research/2026-09-20-panel-fork-experiment.md` (#6: a second writer on a live session forks it)
- 2026-09-23 field reports: resumes launched while a panel held the session; a fork replayed last night's limit; the tooltip said "this one is due first" with two sessions; the status bar did not clear after trusting.

## Global constraints (every task)

1. Work ONLY in the worktree above. Never edit, check out or commit in the main checkout `C:/Users/thegr/Dream-Mosaic/Projects/claude-limit-buster`. Do not push.
2. Never write `~/.claude.json` and never answer Claude Code's folder-trust dialog on the user's behalf. Reading is fine.
3. Never send anything into a Claude session this extension did not create: no writing to another session's transcript, no connecting to its `messagingSocketPath`, no signals or kills.
4. `claude --resume` must only ever receive a UUID session id.
5. TDD. Write the failing test first, see it fail for the expected reason, then implement. For every new guard or branch, verify it with a mutation: break the line, confirm that a named test goes red, then restore it. A reusable runner is at `C:/Users/thegr/AppData/Local/Temp/claude/c--Users-thegr-Dream-Mosaic-Projects-claude-limit-buster/05690955-d99d-46e1-bc06-109e58dadc2f/scratchpad/mutate.py` (JSON spec: a list of `{file, name, old, new}`); read it before use.
6. Gate on EXIT CODES, never on grep output: `npm test > "$TEMP/t.log" 2>&1; echo "exit=$?"`. Integration: `npm run test:integration` (downloads VS Code once; slow). Both must be green before the task is reported DONE.
7. Tooling traps, all observed on this repo:
   - The Bash tool HALVES doubled backslashes in heredocs and inline scripts (`'c:\\x'` lands as `'c:\x'`). Write any text containing `\\` with the Write or Edit tool.
   - `src/*.ts` and `test/*.ts` are CRLF, except `src/policy.ts`, which is LF. Use the Edit tool rather than scripted patches.
8. Commit as you go: one commit per green step, conventional-commit subjects, and end each message with
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
9. Match the surrounding code: dense "why" comments where the code is non-obvious, VS Code fakes in `test/helpers/vscode.ts`, module stubs via the existing `stubModule` pattern in `test/extension.test.ts`.
10. User-facing strings still say "Claude Limit Buster" until Task 8 renames everything. Do not rename early.

---

### Task 1: Replayed limits, the grace window, and `quotaLimits.resetsAt`

Make the seven red tests at the end of `test/transcriptWatcher.test.ts` pass without breaking any other test. They encode the requirements and are the spec. Read them first.

Requirements:
- Resolve a limit notice against the ENTRY's own `timestamp` (ISO string), not the time of reading. A missing or unparseable timestamp falls back to now, as before. Forked transcripts copy lines with their original timestamps, which is how last night's "resets 1am" re-armed an 18-hour timer.
- Grace window: if the resolved reset time is in the past by at most `RESET_GRACE_MS` (export it; 15 minutes), the limit is still an event and is due NOW (`resumeAt <= now`), never rolled forward to tomorrow. If it passed longer ago than that, it is history: return no limit.
- `quotaLimits.resetsAt` (epoch SECONDS, a top-level field of the transcript entry) is the primary reset time when present, and it wins over whatever the text says. It still counts when the text cannot be parsed at all. It is trusted ONLY on an entry Claude Code flagged (`isApiErrorMessage === true` or `error === 'rate_limit'`); on any other entry it is ignored. The same grace and history rules apply to it.
- Overloads have no reset time, so staleness is age: an overload entry whose timestamp is older than `MAX_OVERLOAD_AGE_MS` (export it; 10 minutes) triggers nothing.
- The hook point is `TranscriptWatcher.inspectLine` in `src/transcriptWatcher.ts`, where `const now = new Date()` is passed to `detectLimit` (around line 399). The text parser's rollover lives in `src/parsers/limitParser.ts` (around lines 210–224). Change it only as far as the grace rule needs.
- Keep `maxWait` semantics: a structured reset further out than `maxWait` is handled the same way a parsed one is today.

Also add tests for:
- the boundary on both sides of `RESET_GRACE_MS`;
- the boundary on both sides of `MAX_OVERLOAD_AGE_MS`;
- a flagged entry whose `quotaLimits` has no numeric `resetsAt`, which falls back to the text.

### Task 2: Never start a second writer on a live session

When a job fires, first find out who holds the session. Spawn a terminal only if nobody does.

- Extend `src/liveSessions.ts` with a pure classifier. From the `claude agents --json` rows (liveness) plus each vouched pid's record `~/.claude/sessions/<pid>.json` (for `entrypoint`, and `sessionId` must match), return one of:
  - `{ kind: 'none' }`
  - `{ kind: 'panel', pid }` (entrypoint `claude-vscode`)
  - `{ kind: 'terminal', pid }` (any other entrypoint, including `cli`)
  
  A panel wins over a terminal when both are present. Reuse `parseAgentRows` and `otherLivePids`. Keep the existing `livePanelDetector` behaviour for `handleStalePanel` working.
- Native auto-continue. Add `src/autoContinue.ts` with `autoContinueEnabled(cwd, platform, readFile)`. Claude Code's terminal UI continues by itself at a reset unless `autoContinueAtUsageLimit` is `false`; its default is ON when the key is absent (read from claude.exe 2.1.281: `setting ?? (autoContinueKeyPresence === "absent")`). Read these layers in precedence order, highest first:
  1. managed settings (win32 `C:\Program Files\ClaudeCode\managed-settings.json`; darwin `/Library/Application Support/ClaudeCode/managed-settings.json`; linux `/etc/claude-code/managed-settings.json`);
  2. `<cwd>/.claude/settings.local.json`;
  3. `<cwd>/.claude/settings.json`;
  4. `<CLAUDE_CONFIG_DIR || ~/.claude>/settings.json`.
  
  The first layer that sets the key as a boolean decides. Unreadable or malformed files are skipped. Inject the reader so tests never touch real files.
- In `src/extension.ts` `scheduler.onFire`, with `autoResume` on, before `resume(job)`, classify the holder:
  - `panel`: do NOT spawn. `rememberReady(job)`. Log it. Show an information message saying the limit has reset and the session is open in a Claude panel, so continue it there, with one button, `Resume in Terminal Anyway`. That button claims the job with `forgetReady` exactly as the existing Resume Now notification does, then calls `resume(job)`.
  - `terminal` and `autoContinueEnabled(job.cwd)`: do NOT spawn and do NOT remember it. Log that Claude Code will continue the session by itself.
  - `terminal` and auto-continue off: same as `panel`, but the message says a terminal.
  - `none`: also check whether a DIFFERENT live session (by `claude agents --json` row `sessionId`) is `status: "busy"` in the same folder (normalize with `normalizeProjectPath` from `src/trust.ts`). If so, same treatment as `panel`, with a message naming that the folder has another active Claude session. Otherwise resume as today.
- Manual Resume Now (the command and the notification button) with a live holder: ask with a modal warning that names the holder and says a resume here forks the conversation, with a `Resume Anyway` button. No holder: unchanged.
- The listing call is `execFileSync` with a 10 s timeout (reuse the `detectLivePanel` runner). A listing failure means "unknown", and it resumes as today and logs that, because failing closed would silently stop every resume on a machine where `claude agents` misbehaves.
- `AgentRow` must also carry `cwd` and `status` (optional strings) for the busy-folder check.

### Task 3: Stop untrusted text from arming timers (synthesis A3)

The watcher scans assistant, system and subagent entries with `trusted: false`. Real false positives from 2026-09-23 include:
- a subagent note quoting "…You have used up your monthly limit. Try again in 3 hours";
- "You've used 91% of your session limit · resets 12:40pm";
- a `grep` result quoting a banner.

- Do not scan files under a `subagents/` directory for LIMITS at all. A subagent that hits the limit stops its parent, whose own transcript records it.
- On the untrusted path, veto:
  - percentage-usage warnings (`/\bused\s+\d{1,3}%/i`);
  - text inside tool results;
  - text that is clearly quoted: inside backticks, or on a line prefixed with `>` or a `file:line:` grep prefix.
- Flagged entries (`isApiErrorMessage`/`error: 'rate_limit'`) are unaffected.
- Replay check: the tests must include each of the three real strings above as a negative case, and a flagged real banner as a positive case.

### Task 4: Overload and failure states (synthesis A5, A6, A7, A8, A9)

- Ignore Claude Code's own in-flight retry lines ("Retrying in Ns · attempt k/n" and close variants): it is already retrying, so we must not also schedule one.
- Route "Server is temporarily limiting requests (not your usage limit)" to the overload path. Today it falls through both parsers.
- Treat "Your computer went to sleep mid-response" (and close variants) as an overload-class interruption to retry.
- DST (A7): when a wall-clock reset time falls in the repeated hour at a fall-back transition, resolve it to the LATER instant. The #10 code is `nextZonedOccurrence` in `src/parsers/limitParser.ts`.
- A distinct "gave up" state (A8/A9). When a resume fails in a way we stop retrying on, the status bar shows a distinct icon and a tooltip saying why, instead of looking idle. Those failures are: stall watch fired, launcher missing, cwd missing, or the budget refusal dismissed. Warn once per session per failure, then stay quiet. It clears on the next successful detection or resume for that session, or on Cancel from the menu. Failure notifications name their cause distinctly.

### Task 5: Tooltip lists every waiting session, and trust hotlink

- `src/statusBar.ts`: the tooltip lists EVERY pending session, counting down or ready, one line each: short id, folder basename, resume time (or "ready"), and a warning marker if untrusted. It drops "this one is due first". The status bar text still counts down to the soonest.
- Trust hotlink. Add a command `claudeLimitBuster.openClaudeToTrust` (argument: cwd) that opens a VS Code terminal running plain `claude` (no `--resume`, no prompt) in that folder, so the user answers the trust dialog themselves. Build the environment the way `buildTerminalOptions` does, including stripping the parent-session variables, and launch from `trustedSpelling`'s spelling if there is one. Never write the trust record.
  - Link it from the tooltip line of an untrusted session (MarkdownString command link, `isTrusted` limited to that command).
  - Link it from the untrusted-folder warning notification as a button, `Open Claude to Trust`.
- After the user trusts, the existing per-session `trustStamps` cache sees the config mtime change on the next refresh. Also re-run `refreshTrust` when that terminal closes, so the marker clears without waiting.

### Task 6: Default resume prompt

- Change the default `resumePrompt` (`package.json` contribution default and `src/config.ts` fallback) to exactly:
  `[Limit Break] I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.`
- Update the integration defaults test (`test/integration/extension.itest.ts`) and any unit test that pins the old default. The README settings table is handled in Task 9.

### Task 7: Icon

- Create `media/icon.png`, 256×256 PNG, from the user's draft `C:/Users/thegr/AppData/Local/Temp/claude/c--Users-thegr-Dream-Mosaic-Projects-claude-limit-buster/05690955-d99d-46e1-bc06-109e58dadc2f/images/12.jpg` (the flat "Limit" + rainbow gauge):
  - crop to the navy frame with a small margin;
  - make the pale background outside the frame transparent;
  - downscale with nearest-neighbour or area resampling; do not smooth further.
- Also save `media/banner.png` from `images/9.jpg` (the "Limit Break / Tokenize / Vibe" wordmark), with its PAINTED checkerboard background removed to real transparency. Max width 1200.
- Set `"icon": "media/icon.png"` in package.json and make sure `.vscodeignore` keeps `media/icon.png` in the VSIX. Run `scripts/check-vsix.sh` if it applies.
- Use Python + Pillow if available (`python -c "import PIL"`); otherwise report NEEDS_CONTEXT. These are placeholders until the user's final art; say so in the commit message.

### Task 8: Rename everything to Limit Break

One mechanical pass, after every behaviour task has landed. The user's ruling is: change it ALL, with no settings migration.
- `package.json`:
  - `name` → `limit-break`;
  - `displayName` → `Limit Break`;
  - description reworded to match;
  - every contributed command, setting and view id `claudeLimitBuster.*` → `limitBreak.*`;
  - configuration title;
  - repository/bugs/homepage URLs → `https://github.com/Dream-Mosaic/limit-break` (the repo itself is renamed separately, at the end, by the controller).
- `src/`: the `NS` constant and every string key, globalState keys, the output channel name, every "Claude Limit Buster:" message prefix → "Limit Break:", and log lines.
- Tests and integration tests to match. `scripts/`, `.github/workflows/`, `.vscodeignore`, and anything that greps the VSIX name.
- Do NOT rewrite historical docs under `docs/research/`, `docs/design/` or `docs/superpowers/plans/`; they record what was true then.
- Verify with `grep -rniE "limit.?buster|claudeLimitBuster" --exclude-dir={node_modules,out,.git,docs} .` returning nothing except intentional mentions (for example the CHANGELOG's history).

### Task 9: Docs and 1.0.0 staging

- CHANGELOG: a 1.0.0 entry covering everything since 0.1.2 (read `git log 0.1.2..HEAD` or the last tag), grouped Added / Changed / Fixed. It includes the install note: "Limit Break is a new extension id. Uninstall Claude Limit Buster 0.1.x first; its settings do not carry over."
- README:
  - new name and banner;
  - settings table complete, with `watchScope`, `checkForUpdates`, `onStale`, `statusBar`, `maxResumeTokens` 500000 and the new `resumePrompt`;
  - a "Works with Claude Code's own auto-continue" section explaining panel vs terminal;
  - a "Staying up to date" section;
  - install from a GitHub release.
- `docs/NEXT.md`: refresh. Remove what shipped; keep open items, including the synthesis "Consider" list.
- `package.json` `version` → `1.0.0`. This commit goes on a new branch `release/1.0.0` cut from this branch. It is NOT merged to main, because `release.yml` publishes on any push to main whose version is untagged; the controller opens the PR.
