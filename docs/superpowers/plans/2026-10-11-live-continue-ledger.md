# 1.1 implementation ledger

The record of how [the 1.1 plan](2026-10-11-live-continue.md) was carried out, kept for posterity: every task's review outcome, every ruling the controller made on the user's behalf (marked `Ruling:`, each with what it costs if wrong), the minors deferred, and the final whole-branch review. The final review's fix list is [2026-10-11-live-continue-final-fixes.md](2026-10-11-live-continue-final-fixes.md). Copied verbatim from the git-ignored working ledger on 2026-10-11.

---

# SDD ledger — plan: docs/superpowers/plans/2026-10-11-live-continue.md

Spec: docs/superpowers/specs/2026-10-09-live-continue-and-mod-design.md (approved 2026-10-11).
Branch: feat/1.1-live-continue, from 383e922. Baseline: 1052 tests pass.

## Pre-flight scan

| Tasks | Produces / consumes | Found |
|---|---|---|
| 1 & 2 | both edit `onFire` in extension.ts (1 inserts after the claim; 2 trims the autoResume branch) | compatible |
| 2 & 11 | `restoreJob`: 2 drops `offerOnly`; 11 repairs `bridged` | compatible |
| 3 → 10 | `decideOnFire(..., continueInPlaceOn)`, `continueInPlace`, `openSession`; 3's placeholder return replaced in 10 | consistent |
| 4 → 8 | `startedAtMs`, `messagingSocketPath` on the record | consistent |
| 5 → 8 | `buildEnvelope`, `buildPayload`, `inboxLines` | consistent |
| 6 ↔ 7 | control body and file format; 7's test requires `mod/hooks/control.mjs` | consistent, order fine |
| 7 → 8 | `modUsable`, `continuedJob`, `buildControlBody`, `controlFileText` | consistent |
| 8 → 10, 11 | `continueInPlace(job{jobId}, pid, deps)`, `BRIDGED_GRACE_MS`, `CONFIRM_WINDOW_MS` | consistent |
| 9 → 10 | `openSession`, `parentPidCommand`; fake vscode needs `window.terminals` (10 adds) | consistent |
| 10 & 11 | 11 moves `detectAgentRows`/`readHolderRecord` above `schedule` | compatible |
| 12 | stubs modInstall in extension tests; extends `contextOver` | see ruling 3 |
| Task 1 self | step 1 creates the branch | already exists: ruling 1 |
| Task 5 self | `findPeerToken` test vs prefix/3-part check | agrees |
| Task 6 self | tests vs control.mjs (replay reason, 20-cap, carry-over) | agrees |
| Task 7 self | round trip, TTL boundary | agrees |
| Task 8 self | fake-clock elapsedMs 2000, mod read count, landed-late | agrees |
| Task 10 self | bridged test: stub grace 400 ms with base = now-1000 gives a negative head start, so the test can't see a wait | defect: ruling 2 |
| Task 12 self | how the extension tests keep activation from running `claude` is muddled | ruling 3 |

Ruling: Task 1 step 1 (create the branch) is skipped — the branch already exists at 383e922 — costs nothing if wrong.
Ruling: Task 10's bridged test stubs BRIDGED_GRACE_MS at 3_000 and uses baseResumeAtMs = Date.now(), resumeAtMs = Date.now() - 1000; asserts no call after oneTick, then a call after a further 2_500 ms — the plan's values make the head start negative, so the test would pass without testing the wait — costs a slower test (about 4 s) if wrong.
Ruling: Task 12: `modInstall.ts` exports `listInstalledPlugins(run)`; extension tests stub `./modInstall` with the real module spread plus `shouldOfferInstall: () => false` and `listInstalledPlugins: async () => '[]'`, so activation never runs `claude` — the plan's text says the same thing less clearly — costs a test-harness tweak if wrong.

## Tasks
Task 1: complete (commits 383e922..3a514ab, review clean)
Task 1: minor (deferred): test/extension.test.ts ~4541-4551 claim-hold test comment says the deadline is reset+jitter+10min in the past; resumeAtMs now decides the max, so the hours-overdue deadline is no longer exercised
Task 1: minor (deferred): no test asserts the claim is KEPT on a D10 drop (window B claiming after a late fire in window A should get `taken`); that test would also restore the hours-late hold case
Task 1: minor (deferred): extension-level D10 tests have no separate RED run (process only)
Task 2: ⚠️ resolved: beyond-notice claim is held to reset + max jitter + 10 min (claimHoldDeadline), same as 1.0's offer-notice claim; a future mtime keeps it "taken" until then, which is the intended announce-once window
Task 2: complete (commits 3a514ab..6f1e291, review clean)
Task 2: minor (deferred): src/policy.ts scheduled-job literal: `},` left on the transcriptBytesAtDetection line (formatting)
Task 2: minor (deferred): test/restoreJob.test.ts ~178-183 tests only offerOnly: true; add a false case to pin drop-not-repair
Task 2: minor (deferred): no ResumeScheduler-level test that a stored 1.0 offer-only job is dropped and logged
Task 2: note: implementer added a `beyond` branch to the "even with the budget lifted" log (beyond has no .reason) — needed to type-check
Task 3: review approved, but treated the unedited decideOnFire doc comment as a missed brief requirement (spec gap); fix round 1 sent with it plus two branch-order test cases
Task 3: fix round 1/5 (3 addressed, 0 open — stale decideOnFire doc comment; two branch-order tests; commits 6e0d508..ca2a114)
Task 3: complete (commits 6f1e291..ca2a114, review clean)
Task 3: minor (deferred): `decideOnFire` signature: rateLimitType is now `string | undefined` and required; callers pass undefined explicitly
Task 3: minor (deferred): no recorded RED run for the new holderPolicy tests (process)
Task 4: ⚠️ resolved: extension's readHolderRecord returns readSessionRecord's object directly, so the new fields reach HolderRecord consumers
Task 4: complete (commits ca2a114..c4adecc, review clean)
Task 4: minor (deferred): sessionRegistry malformed-fields test combines both bad values in one record
Task 5: review needs fixes (2 Important, plan-mandated): sendToInbox resolves on a failed write (write-callback err ignored); can hang forever (no deadline, no close handler)
Ruling: fix both plan-mandated defects in sendToInbox — the spec's continue-in-place relies on a send that settles: a hang means no fallback launch ever, a false success costs the 60 s window — costs a small API addition (a timeout) if wrong
Task 5: fix round 1/5 (2 addressed, 0 open — write-callback err; hang/deadline/close; commits 4e91257..a35dae4)
Task 5: complete (commits c4adecc..a35dae4, review clean)
Task 5: minor (deferred): test/inbox.test.ts ~99-125 the two settle-only tests would pass on the pre-fix code; no deterministic test of write-error, close-without-error or never-connects; their 4 s race timer isn't cleared
Task 5: minor (deferred): src/inbox.ts ~109-110 destroy() right after end() makes end() redundant (spike S1 tested a graceful close); doc comment says "closed"
Task 5: ⚠️ for Task 8: continueInPlace must treat a rejected send as fallback (now guaranteed to settle within timeoutMs)
Task 6: review needs fixes (5 Important): replay window open until submit resolves (busy session → double continue); movedTo depends on whether session.start refires; write-back can land on the wrong session after a switch; submit .then has no .catch; register test covers only the happy path
Ruling: replay guard = an in-memory set of in-flight job ids checked with status.continued, and `continued` still written only once the submit resolves as entered — writing it before the submit would let the extension confirm a continue that then fails, with no fallback launch — costs a double continue only across a mod reload during an in-flight submit, if wrong
Task 6: fix round 1/5 (5 addressed, 0 open — replay in flight; submit result; movedTo in start(); write-back per session; .catch; tests; commits 12149eb..3870e93)
Task 6: complete (commits a35dae4..3870e93, review clean)
Task 6: minor (deferred): no test for recordContinued's write-back to a previous session's file, nor for the submit catch path
Task 6: minor (deferred): implementer's "missing homeDir argument" fix claim did not match the first commit (re-reviewer found every call already passed s)
Task 6: note: register.mjs helpers are top-level functions taking a shared state object — `claude plugin validate` only allows `$` to be passed to top-level function declarations
Task 7: ⚠️ resolved: mod's start() sets loadedAtMs = $.clock.now() on every start (process load or session switch), always ≥ the process start; holderStartedAtMs comes from the record's startedAt (Task 4) via continueInPlace (Task 8)
Task 7: complete (commits 3870e93..f8a5117, review clean)
Task 7: minor (deferred): modStatus test fixture is hand-built; a round trip through the mod's own initialStatus/withContinued/movedTo writers would catch drift
Task 7: minor (deferred): parseModStatus doesn't type-check nativeContinue fields or continued[].atMs (log-only / unread today)
Task 8: review needs fixes (2 Important): any send rejection falls back at once with no last look, though a deadline/close rejection can follow a delivery (fork); transcriptContains misses the msg_id when the transcript shrank below the offset
Ruling: a send rejection whose code is ENOENT or ECONNREFUSED (nothing listening) falls back at once; any other rejection runs the confirm loop and last look like a successful send — derived: those two codes come before any byte is written; everything else may follow a delivery — costs up to 60 s of delay before a launch on an odd error, if wrong
Ruling: also fold in Minor 2 (a throwing dep after the send is "not seen", never a rejection), since a rejected continue in Task 10 would leave the session stopped with no launch — costs a few lines if wrong
Task 8: fix round 1/5 (3 addressed, 0 open — ambiguous send rejection; truncated transcript; throwing deps; commits 2d22f7a..711942d)
Task 8: complete (commits f8a5117..711942d, review clean)
Task 8: minor (deferred): last look is a single read; a transient EBUSY/EPERM there reads as "not seen" → fallback (retry once or twice?)
Task 8: minor (deferred): confirm loop relies on deps.now() being monotonic (wall clock in production)
Task 8: minor (deferred): with bytesAtSend undefined the whole transcript is re-read every second (allocates the full size)
Task 8: minor (deferred): test gaps — mod-transport timeout→fallback; writeControlFile throw; mod test doesn't check the confirming source; throwing now()/sleep() untested; unused `advance` helper
Task 8: ⚠️ for Task 10: real deps must take transcriptBytes immediately before the send (continueInPlace calls it before writing the control file — fine); readModStatus/continuedSince wrapped anyway
Task 9: review needs fixes (1 Important, plan-mandated + its tests): openSession rejects on any dep failure, undocumented; the caller is a notice button
Ruling: openSession never rejects — every dep failure maps to `false` (parentPid failure breaks the ancestor walk but keeps the direct match); fold in the minors isSafeInteger and a non-positive/NaN parent stop — "false = couldn't open" is the documented contract — costs nothing if wrong
Task 9: fix round 1/5 (3 addressed, 0 open — never rejects; isSafeInteger; tests; commits 595d575..85a9aa6)
Task 9: complete (commits 711942d..85a9aa6, review clean)
Task 9: minor (deferred): no NaN-parent test (guard present); first matching terminal wins, not nearest ancestor
Task 10: ⚠️ resolved: continuedSince(t, undefined) reads as not continued (hasContinued's documented contract); decideOnFire's continueInPlace outcomes set remember:false (Task 3 code)
Task 10: review approved with Important test gaps: claim kept on continued/landed-late; failed fallback launch remembers + releases; manual-path cancel/forgetReady; Cancel during bridged head start drops the continue
Ruling: fold in two minors with the fix round — an idle-terminal default-on test (D8/#29 had no extension-level test) and a cancelled check before the fallback launch after the head start — both cheap and both on the fork/cancel path — costs a few lines if wrong
Task 10: fix round 1/5 (6 addressed, 0 open — claim/job bookkeeping tests; bridged Cancel test; idle-terminal default test; cancel generation; commits d3c6175..4e851f5)
Task 10: complete (commits 85a9aa6..4e851f5, review clean)
Task 10: minor (deferred): 13 existing 1.0 idle-terminal/native/weekly offer tests now pin `continueInPlace: false` (their offers exist only with the setting off)
Task 10: minor (deferred): manual-path continues (Resume Now / offer button) aren't covered by the cancel generation; a Cancel during a manual 60 s window can still launch a fallback
Task 10: minor (deferred): fix report lacks pasted full-suite output (reply claimed 1106/1106)
Ruling: Task 11 keeps detectAgentRows/readHolderRecord where they are rather than moving them above schedule — schedule only runs from watcher callbacks after activate has finished, so no TDZ; warnIfUntrusted already relies on this — costs a TDZ error at a detection during activation if wrong (watcher.start() is the last call in activate)
Task 11: ⚠️ resolved: runAgentsListing is execFileSync with a 10 s timeout (extension.ts, 1.0 code); now also run once per newly scheduled job — planning decision 8
Task 11: complete (commits 4e851f5..ff3257e, review clean)
Task 11: minor (deferred): no extension test for an 'unknown' listing or a non-panel holder at schedule time; bridged notice regex doesn't pin the grace time
Task 12: review needs fixes (1 Important): Remove aborts on the first failed step — "not installed" or a half-failed install leaves the marketplace registered and the version key set
Ruling: Remove checks `listInstalledPlugins` first and runs `uninstall` only when the mod is installed, then always tries `marketplace remove`; clears the version key whenever the plugin is gone afterwards; install/remove/update orchestration moves into modInstall.ts with injected deps so it is testable; copyMod checks the source exists before deleting the destination — the CLI's "not found" wording is unknown, so the list decides, not error text — costs one extra `plugin list` per Remove if wrong
Task 12: implementer judgment (fix round 1): a failing plugin list during Remove is treated as installed, so uninstall is attempted
Task 12: fix round 1/5 (3 addressed, 0 open — Remove semantics; orchestration moved and tested; copyMod source check; commits 51962a4..a307f43)
Task 12: complete (commits ff3257e..a307f43, review clean)
Task 12: minor (deferred): the "installed and version differs → update" decision is still in extension.ts maybeOfferMod, untested as a decision
Task 12: minor (deferred): updateMod's copy() can throw outside a try (logged as "Mod offer skipped"); installMod's copy failure reads "`claude (copy the mod)`"
Task 12: minor (deferred): a garbled-but-successful `plugin list` reads as not installed (isModInstalled returns false) → Remove skips uninstall and clears the key
Task 12: minor (deferred, pre-existing): a locally packaged VSIX ships `.impeccable/hook.cache.json` (untracked, gitignored locally, so CI builds from a clean checkout don't include it)
Task 13: review needs fixes (1 Important): README says a pasted control message is refused and hidden from Claude; the mod passes non-peer deliveries (pasted/typed text) straight through
Task 13: correction to Task 10's deferred minor: the reviewer found continueHolder's `generation` default captures the counter at call time, so a Cancel during a manual (Resume Now) continue also skips its fallback; only a Cancel before the click is outside it — the minor is withdrawn
Task 13: fix round 1/5 (1 addressed, 0 open — "pasted" claim; smoke L5 wording; commits 803b6b1..230c2c7)
Task 13: complete (commits a307f43..230c2c7, review clean)
Task 13: minor (deferred): spec's older text still says register.js (its planning note says .mjs and wins)

## Final review (087941f..230c2c7): With fixes — 2 Critical, 1 Important, 10 Minor
Ruling: Critical 1 — a terminal holder whose continue in place falls back takes 1.0's terminal outcome (remember the job + the "Resume in Terminal Anyway" offer), never an automatic launch; a manual (Resume Now) fallback for a terminal shows 1.0's fork modal before launching — spec goal 3 "keep 1.0's behaviour wherever the new paths can't be used" outranks the spec's "fall back to resume()" line, which was written with panels in mind — costs one extra click for a terminal whose inbox failed, if wrong
Ruling: Critical 2 — Open Session calls claude-vscode.editor.open only when the panel's claude process descends from this window's extension host (process.pid within the holder's 4 nearest ancestors); otherwise the notice says the session is open in another VS Code window — the command creates a new panel (a second process) when the session isn't in this window — costs a wrong "another window" message (no fork) if the ancestry check misses, safe direction; smoke-test it
Ruling: Important 3 — reword the install offer and README so the mod "reports limits and lets Limit Break continue a session as you", not "reads limits exactly"; 1.1 doesn't consume rateLimits
Ruling: fix minors 4 (bridged note only when continueInPlace and autoResume are on), 5 (validate nativeContinue in parseModStatus), 6 (unparseable plugin list = can't tell), 7 (mod also accepts origin 'peer-send-message'; the nonce gates), 9 (offer text starts "Limit Break:"), 10 (control dir 0o700, file 0o600), 11 (Remove deletes ~/.limit-break/sessions/*.json), 13 (policy.ts formatting), and Task 1's claim-kept-on-D10 test — each is small and three affect correctness — costs a larger fix diff if wrong
Ruling: minors 8 (window closed mid-continue leaves the claim held) and 12 (two processes on one session can fool loadedAtMs) are recorded as known limits, not fixed — releasing the claim on dispose wouldn't make other windows refire (they already dropped), and 12 lands late rather than forking — costs a stopped session in a rare window-close case if wrong
Ruling: user-reported bug (resume skipped as "continued"): root cause derived — continuedSince counts a `<task-notification>` user entry queued after the limit as the session moving (reproduced on the real 7a00d6c0 transcript at three baselines); inbound deliveries (task notifications, cross-session/agent messages) become neutral, only the turn they wake counts — costs a resume launched into a session whose delivery did wake a real turn only if that turn left no assistant entry, if wrong
Ruling: user asked that resume attempts and outcomes be logged: one "Resume due" line per fire and exactly one "Outcome for <id8>:" line per branch — logging only — costs log noise if wrong
Held for the user: act on Claude Code's "auto-continue armed" line (#31); persistent logs (#36)
Final fix wave dispatched with final-fixes.md (A1, A2, B1, C, D, E1-8), base 230c2c7
Final fix wave: re-review all addressed (A1, A2, B1, C, D, E1-8), no new Critical/Important; extension.ts restore verified line by line (commits 230c2c7..da42d7f)
Final: parked — terminal fallback remembers/offers the coordinated job (carries this fire's folder-busy sentence) — Ruling: minor, deferred: harmless extra sentence on a later click
Final: parked — README:81-82 "launches at once" when nothing listens is now an offer for a terminal holder — Ruling: minor doc wording, deferred
Final: parked — nativeContinue atMs beyond the Date range still throws in the log line — Ruling: minor, the mod always writes a real epoch; deferred
Final: parked — a parent-pid lookup failure for a same-window panel says "another window" — Ruling: accepted; safe direction (no fork)
Final: parked — 0o600 applies only on create; an older control file keeps its mode — Ruling: minor, POSIX only, deferred
