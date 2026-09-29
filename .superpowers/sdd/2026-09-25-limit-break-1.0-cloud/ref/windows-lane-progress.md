# SDD ledger — plan: docs/superpowers/plans/2026-09-24-limit-break-1.0.md

Base: 6c97fd0. SPEC (binding, added 2026-09-24 after Task 2 drifted): docs/design/2026-09-01-design.md (Goals 1-4, Non-goals, Findings table) + README "The panel tab after a resume" (shipped #7 behaviour: resume, then onStale notify/reopen). The plan argues from these; conflicts resolve against them.

## Pre-flight scan
| Pair / task | Shared | Finding |
|---|---|---|
| T1 / T3 / T4 | src/transcriptWatcher.ts, src/parsers/* | sequential; T3/T4 build on T1's inspectLine changes. OK |
| T2 / T4 / T5 | src/extension.ts, src/statusBar.ts | T4 gave-up state and T5 tooltip both touch statusBar.update; T5 must list gave-up sessions too. Ruling below |
| T6 / T8 | resumePrompt string | prompt already says "[Limit Break]"; T8 must not alter it. OK |
| T7 / T8 | package.json | T7 adds icon; T8 renames keys. OK sequentially |
| T9 | everything | last; release/1.0.0 branch, not main. OK |
| each task | self-consistency | T1 tests are the spec (pre-written). T2 fail-open on listing failure is deliberate. OK |

- Ruling: T5 tooltip lists gave-up sessions with their reason (from T4) - one status-bar model, not two - cost if wrong: small tooltip rework.
- Ruling: T2 treats a live cli holder with auto-continue OFF like a panel (notify, don't spawn) rather than resuming - never two writers on one session - cost if wrong: user clicks one button.
- Ruling: T2 fails OPEN (resume as today) when `claude agents` cannot be read - cost if wrong: a rare double writer, same as 0.1.2.
- Task 1: dispatched (sonnet) at base 6c97fd0
- 02:2xZ: VS Code restarted (Code.exe 64972, 21:18:45 local); Task 1 agent killed mid-run with nothing on disk; resumed via SendMessage. No fork of 05690955 (no branches since 00:30Z). Restored panel 9cca655c (pid 40964) is the PowerShell session's transcript, created by the freeze message; unrelated to this conversation.
- Ruling: Remote Control (web client) auto-continues bridged panel sessions (user-confirmed 02:11Z). Task 2 unchanged: a panel holder is notified and never spawned into, which already avoids a double writer. Addition to the Task 2 brief: when the panel's session record has a bridgeSessionId, the notification says Remote Control may continue it on its own. Cost if wrong: wording only.
- 02:26Z: resumed Task 1 agent hung (no turn in 5 min after the resume message); stopped it and dispatched a fresh sonnet implementer at base 6c97fd0.
- Ruling: user supplied final art (images 13-16, RGBA PNG) -> Task 7 revised to copy them byte for byte: icon.png 256 (13), logo.png (15), banner.png (14), logo-mono.png (16). Saved in the SDD assets/ folder so temp cleanup can't lose them. Status-bar glyph from the mono art (icon font) deferred to NEXT.md. Cost if wrong: file names.
- Task 1: implementer DONE (9b42a35 2767d66 fd0b23d dd4f6d6); 343/343 unit, 9/9 integration; review next
- Ruling: T1 quotaLimits trust via existing isRateLimitEntry (isApiErrorMessage | error~rate.?limit | apiErrorStatus/status 429) instead of the brief's narrower pair - every branch is a field Claude Code itself writes on failures, and one predicate beats two - cost if wrong: a 429-status non-flagged entry could arm from resetsAt (not observed).
- Task 1 review: spec ✅, quality Approved; 2 Minor parked:
  - Parked: a flagged entry whose resetsAt is stale returns early, skipping the overload check (transcriptWatcher.ts:452) - a rate-limit entry is not an overload banner - cost if wrong: one missed overload retry on a doubly-flagged entry.
  - Parked: the MAX_OVERLOAD_AGE_MS edge is tested at ±5s, not pinned exactly - cost if wrong: an off-by-ms edge; revisit if extracted into a pure function in Task 4.
Task 1: complete (HEAD dd4f6d6)
- Task 2: dispatched (sonnet) at base dd4f6d6
- For Task 9 NEXT.md (user, 2026-09-24): v1.1 = a Limit Break sidebar (activity-bar view container + a view listing pending/ready/gave-up sessions) using media/logo-mono.svg as its icon; the activity bar takes an SVG directly (no icon font). Legibility at 24px is the open question: consider a gauge-only crop.
- Cleanup: removed 6 old agent worktrees; deleted merged branches; kept worktree-agent-acf7a5a140ac78c4b (unmerged, obsolete #7 draft c6cdece).
- User renamed the GitHub repo to Dream-Mosaic/claude-limit-break (not limit-break); origin repointed (shared by both worktrees). Task 8 brief URL updated. Remote has a user web-session branch claude/focused-sagan-rso8ad (scripts/png-to-svg.py, author Claude) - not ours; leave it.
- Ruling (user): extension ids match the repo - name claude-limit-break, keys claudeLimitBreak.*, displayName 'Limit Break'. Task 8 brief updated. User approved hardening: security scanning, main+v* rulesets (admin bypass), Actions lockdown (SHA pinning, approval for all outside contributors). Declined: release approval gate.
- Main moved (not merged into this branch yet): #17 hardening (SHA-pinned actions, SECURITY.md, dependabot.yml), #18 actions v7, #22 (pending) engines ^1.138.0 / @types/node 24 / Node 24 CI / Dirent.path fallback removed / serialize-javascript override. Task 9 must merge origin/main into this branch first; expect package.json + workflow + transcriptWatcher.ts conflicts. User ruling: drop old VS Code support (install base 1, on 1.138).

## CHECKPOINT 2026-09-24T04:11Z (limit incoming)
- Task 1: complete (dd4f6d6), reviewed.
- Task 2: IN PROGRESS by implementer agent ab06d1557449ce2e6 (sonnet). Transcript: ~/.claude/projects/c--Users-thegr-Dream-Mosaic-Projects-claude-limit-buster/05690955-d99d-46e1-bc06-109e58dadc2f/subagents/agent-ab06d1557449ce2e6.jsonl
  - Commits: 3b454bd bridgeSessionId; db1bb9d holder classifier (liveSessions.ts); 84b0ef5 autoContinue.ts; a2311c7 holderPolicy.ts (pure decision layer).
  - Uncommitted: test/helpers/vscode.ts (fakes for the wiring tests).
  - Remaining: wire holderPolicy into extension.ts onFire + resumeNow (modal "Resume Anyway"), wiring tests, mutation checks, integration run, task-2-report.md.
  - Recovery: SendMessage to the agent id to resume it; if it's dead, dispatch a fresh sonnet implementer with task-2-brief.md, saying that the four commits above exist and only the wiring remains. Then do the Task 2 review (review-package dd4f6d6..HEAD).
- Main (origin) is at 28b0eec: #17 hardening, #18 actions v7, #22 VS Code ^1.138 / Node 24. Task 9 must merge origin/main into this branch first.
- Repo: Dream-Mosaic/claude-limit-break; rulesets "Protect Main" (user's, + 4 CI checks) and "Protect release tags"; SHA pinning required.
- Next tasks: 3..9 per the plan; Task 7 uses the assets/ folder (PNG 13-16 + logo-mono.svg).

## Root cause, 2026-09-24 overnight double resumes (derived from both windows' Limit Buster logs + process start times)
- Two VS Code windows each ran 0.1.2 with watchScope=machine: window1 (claude-limit-buster; exthost restarted 21:18 local) and window2 (unwritten-chronicles, opened 22:46 local).
- At 04:13:13Z BOTH detected the 05690955 limit ("resets 2:10am") and each scheduled independently with its own jitter: w1 2:19:02 AM -> pid 20320 (07:19:03Z); w2 2:31:11 AM -> pid 70024 (07:31:12Z). Exact matches.
- Same for 1e8a6fb6 (unwritten-chronicles): w1 2:18:55 -> resume at 07:18:58Z; w2 2:20:11 (re-rolled from 2:27:19 on a second detection) -> resume at 07:20:15Z.
- Both resumes of 05690955 also landed on a live panel (64300).
- Cause: per-window state only (resumedSessions / scheduler are per extension host); nothing coordinates windows. The earlier "two windows" claim from 66164 was wrong for 09-23, but it's right for this night.
- Task 2's fire-time holder check covers the 12-minute gap (the second window sees the first resume live). It does NOT cover a near-simultaneous fire (two windows within ~1-2 s, before the first child registers in `claude agents`).
- Ruling: add Task 2b, a cross-window claim. Before launching, atomically create a lock file (fs.openSync 'wx') named by sessionId + reset instant, under a machine-wide dir (os.tmpdir()/claude-limit-break/claims or globalStorageUri); if it exists and is fresh (< 1 h), skip and log "claimed by another window". Cost if wrong: a stale lock suppresses one resume for up to 1 h.
- Also noted: a re-detection re-rolls the jitter (w2 2:27:19 -> 2:20:11). Keep the first schedule for the same reset instant. Fold into 2b.
- 2026-09-24 ~12:10Z: Task 2 agent resumed via SendMessage (commit test files, then wiring, mutations, report).
- Necro trace (1e8a6fb6): the -2a resume `taskkill //F` the :3001 listener (the idle panel's own background server, b9qlzz1cx, launched 04:04Z). The task failed at 07:24:25, and its notification woke the idle panel. Task 2 prevents it (the panel holder means no spawn).
- User rule for resumed sessions (recorded in memory check-for-parallel-writers): idle panel = proceed; busy CLI = stand down.
- REVERSED by the user: a live IDLE panel means RESUME (the core use case; onStale handles the stale tab). A busy or waiting holder of either kind means stand down. The earlier "panel means notify" ruling was wrong; it would have stopped every resume of an open panel. Brief amended; agent told mid-task.

## Spec re-scan of tasks against docs/design/2026-09-01-design.md (2026-09-24)
| Task | Spec clause | Finding |
|---|---|---|
| T2 (as briefed) | Goal 1 "panel and terminal sessions alike" + Goal 2 "unattended" + README panel section | VIOLATED: "panel means notify" would have ended unattended panel resumes. Corrected (idle panel means resume). |
| T2 same-folder busy check | Goal 2 unattended | RESOLVED by the user: resume, and the prompt tells the resumed model to coordinate with the busy session via SendMessage. |
| T2 idle terminal + native auto-continue | Goal 2 | OK: the session still continues unattended, natively. |
| T2b claim lock | Goal 2 "correct session" | OK |
| T3 untrusted-text veto | Finding 6 (admission control at the parser) | OK, reinforces |
| T4 overload/gave-up | Goals 1, 2 | OK |
| T5 trust hotlink | Goal 3 never escalate autonomy | OK: the user answers the dialog; it is never auto-accepted |
| T5 new command | Finding 3 (execution-adjacent settings are machine-scoped) | OK: no new setting |
| T6 prompt | - | OK |
| T7-T9 | - | OK |
- Ruling (user): same-folder busy session -> resume + coordinate via a prompt sentence. User also: back to strict SDD (controller dispatches and reviews; no inline implementation).
- Task 2: implementer DONE (dd4f6d6..512d7ad, 8 commits); 420/420 unit, 9/9 integration; 32 mutations (30 caught, 2 rejected by the compiler). extension.ts at 987 lines (wiring only).
- Ruling: an unknown or missing holder status counts as IDLE (fail open, resume), not "not idle". Goal 2 (unattended), and it matches the fail-open ruling for listing failures. The 2.1.281 rows always carry status. Cost if wrong: a rare double writer. Sent to review as a required change.
- Task 2 review 1: spec ❌ / quality Changes needed.
  - Critical: fail-closed on unknown status at holderPolicy.ts:74, 93 and 149.
  - Important: no test for a terminal with unknown status.
  - Minor: 2 mutations claimed as compiler-rejected, unverified.
  - Ruling on the reviewer's "misunderstood" item: coordinate with busy same-folder peers on EVERY resume (holder none OR idle panel), not only none. The user's ruling was "resume and coordinate", unconditionally. Cost if wrong: an extra sentence in a prompt.
- Task 2 fix round 1: resumed the implementer.
- Task 2 fix round 1: 1a0e082 (423/423, 9/9, 7/7 mutations). 852215c flagged by the implementer is the controller's own plan commit. Re-review dispatched.
- Task 2 re-review: all 4 findings ✅; no new issues. Parked Minor: no dedicated test for a failed launch with busy peers (rememberReady gets the original job); the logic was read and confirmed. Cost if wrong: a stale coordination sentence on a manual retry.
Task 2: complete (HEAD 1a0e082)
- Task 10 (2b): dispatched (sonnet) at base 417773f
- Task 10: implementer DONE (af5d44e..f492f7b); 451/451 unit, 9/9 integration; 20 mutants, all caught.
  - Ruling on concern 1: the optional `log` param is accepted.
  - Ruling on concern 2: the overload claim key must use baseResumeAtMs, not resumeAtMs. resumeAtMs includes each window's own jitter, so two windows can land in different 10-minute buckets and both fire. Required.
  - Ruling on concern 3: the "Resume in Terminal Anyway" click writes a claim, the same as manual Resume Now. Required; consistency.
  - Ruling on concern 4: add an overload wiring test along with the concern 2 fix.
  - Review dispatched with these as required changes.
- Task 10 review 1: ❌. 3 Critical: the overload key used resumeAtMs, no overload wiring test, and the Terminal-Anyway click wrote no claim; all three came from rulings made after implementation. 1 Important: the off-autoResume Resume Now path didn't release its claim on a failed launch. Fix round 1 sent to the implementer. Noted: the two-claimer test is sequential, not a true multi-process race (O_EXCL is the guarantee).
- 17:24Z: controller now runs in Limit Buster resume pid 21108 (session 05690955); the only other holder is the idle panel 70924, so it proceeds per the user's rule. The Task 10 implementer hit the 12:10pm limit after committing fix round 1 (a5534ac 3ebe73c 6ee702a) and before writing its report; resuming it.
- Task 10 fix round 1 DONE (a5534ac 3ebe73c 6ee702a; 456/456, 9/9). Parked the implementer's asymmetry concern: the off-autoResume Resume Now click doesn't refresh a stale claim. autoResume is a global setting, so no other window auto-fires in that mode; the only race is a user clicking in two windows. Cost if wrong: a rare double manual resume. Re-review dispatched.
- Task 10 re-review 1: all 4 findings ✅. New: Important, a manual-bypass path can release another window's claim ('taken' is ignored, then an unconditional release on a failed launch). 2 Minor: stale 'claims' wording in the off-autoResume branch; the e2e temp dir is never removed. Fix round 2 sent.
- Task 10 fix round 2 DONE (012e973; 459/459, 9/9). Scoped re-review 2 dispatched.
- Task 10 re-review 2: round-2 fixes ✅; sweep: :918/:965 safe (same tick), :847 (off-autoResume Resume Now) can still delete another window's claim after a stale takeover. Fix round 3 sent (re-claim at click, release only if claimed); also closes the parked round-1 asymmetry.
- Task 10 fix round 3 DONE (6f334ae; 460/460, 9/9). Re-review 3 dispatched.
- Task 10 re-review 3: ✅, no new issues. All 4 manual bypass paths are uniform; the automatic releases are same-tick.
Task 10: complete (HEAD 6f334ae)
- Task 3: dispatched (sonnet) at base 6f334ae
- Task 3: implementer DONE (3688d55 1ce287f 2925f81; 477/477, 9/9; 12 mutants caught). Review dispatched.
- Task 3 review 1: ❌. Critical: the subagent-file skip vetoes FLAGGED entries (confirmed by a live run); a real limit in a subagent file is dropped. Important: the grep-prefix misses drive-letter Windows paths. Ruling: flagged is exempt from every veto (the brief's subagent skip was written for untrusted text); a duplicate detection is harmless via the Task 10 dedupe. Fix round 1 sent.
- Task 3 fix round 1 DONE (ca4f2ae; 482/482, 9/9). Re-review dispatched.
- Task 3 re-review: both ✅, verified empirically (incl. unflagged 503 in subagents/ still vetoed); no new issues.
Task 3: complete (HEAD ca4f2ae)
- Task 4: dispatched (sonnet) at base ca4f2ae
