# SDD ledger — plan: docs/superpowers/plans/2026-09-24-limit-break-1.0.md (cloud lane)

A second controller lane on the same plan, run from a claude.ai cloud session while the Windows lane
(`.superpowers/sdd/2026-09-24-limit-break-1.0/`, controller on the user's machine) runs Task 4.
This lane takes only tasks that do not depend on Task 4.

- Branch: `claude/limit-break-1.0-cloud`, cut from `ca4f2ae` (Task 3 complete, reviewed).
- Handoff: `fix/1.0-field-reports` merges this branch. Tasks with a `complete` line here are DONE
  for the Windows lane too: do not re-dispatch them.
- Spec: docs/design/2026-09-01-design.md (Goals 1-4, Non-goals, Findings table) + README
  "The panel tab after a resume". Conflicts resolve against it.
- Constraints: `global-constraints.md` in this folder (the Windows lane's, adapted for Linux).
- Reference copy of the Windows lane's workspace as of `bbff534`: commit `5b4d91a`
  (`.superpowers push/sdd/2026-09-24-limit-break-1.0/`, on branch claude/dreamy-archimedes-f6d12c).

## Scope
| Task | This lane? | Why |
|---|---|---|
| 4 | no (option open, user 2026-09-25) | in flight in the Windows lane at `bbff534` |
| 5a trust hotlink | yes | command + notification button + refresh on terminal close; no statusBar.ts |
| 5b tooltip | no, waits on 4 | ruling: the tooltip lists T4's gave-up sessions, one status-bar model |
| 6 prompt default | yes | package.json + config.ts + tests; no T4 overlap |
| 7 assets | yes | media/, package.json icon, .vscodeignore; no T4 overlap |
| 8 rename | no, waits on 4 | brief: "after every behaviour task has landed" |
| 9 docs + 1.0.0 | no, waits on all | last task; merges origin/main first |

## Pre-flight scan
| Pair / task | Shared | Finding |
|---|---|---|
| T6 / T8 | resumePrompt string | the new default says "[Limit Break]"; T8 must not alter it. OK (Windows lane row) |
| T6 / T2 | resume prompt | T2's buildResumePrompt appends a coordination sentence to whatever the user prompt is; a new default does not interact. OK |
| T6 / T7 / T5a | package.json | three separate hunks (a default, `icon`, a command contribution); sequential in this lane. OK |
| T7 / T8 | package.json | T7 adds `icon`; T8 renames keys. OK sequentially |
| T5a / T4 | src/extension.ts | T4 wires gave-up states into the resume-failure paths; T5a touches schedule()'s trust notification, command registration and a terminal-close hook. No logic dependency; expect a textual merge at handoff. T5a must not touch statusBar.ts |
| T5a / T5b | command `claudeLimitBuster.openClaudeToTrust(cwd)` | T5a produces it; T5b links it from the tooltip. Interface fixed by the plan text. OK |
| T5a / T8 | command id | T8 renames the new id with the rest. OK |
| T6 self | - | brief names the files and the exact string; consistent. OK |
| T7 self | asset names | the brief's `13.png`..`16.png` do not exist; the user pushed renamed files. Ruling below |
| T5a self | - | the plan's tooltip-link bullet is moved to 5b; the rest is self-consistent. OK |

- Ruling: branch from `ca4f2ae`, not `bbff534` — only reviewed work under this lane; `bbff534` is Task 4's first, unreviewed commit — cost if wrong: none, the handoff merge takes either.
- Ruling: Task 7 assets mapped by dimensions: ICO 256² → icon.png, color 1254² → logo.png, "Logo" 627×541 → banner.png, mono 1254² → logo-mono.png (each `cmp`-identical to `5b4d91a`) — cost if wrong: a file name.
- Ruling (user, 2026-09-25): `media/logo-mono.svg` is the "no square" variant — the user's shapes (frame, "Limit", gauge) in currentColor on transparent, without the solid square and mask. Validated against the VS Code docs (activity-bar icon: 24×24, single colour, SVG; drawn as a CSS mask, `paneCompositeBar.ts`) with a Chromium mock; the square version read as a filled tile beside the codicons. A 24-unit redraw with ~2px margin is a v1.1 item for NEXT.md — cost if wrong: one file.
- Ruling: Task 5 split into 5a (this lane) and 5b (after Task 4) — the plan's T4/T5 ruling ties only the tooltip to T4 — cost if wrong: the tooltip link lands one task later.
- Ruling: integration tests cannot run here (network policy blocks update.code.visualstudio.com). Gate on unit tests; list every integration test a task touches under "Integration pending" below for a run on the user's machine or in CI (ci.yml runs them on pull_request) — cost if wrong: an integration break found at handoff instead of here.
- Ruling: this workspace is force-added to git (`.superpowers/` is ignored) so the handoff carries it; it is named `-cloud` so it can never collide with the Windows lane's untracked workspace — cost if wrong: one folder to delete.
- Ruling: commits in this lane carry the session's two trailer lines (Co-Authored-By + Claude-Session), not the Windows lane's one — cost if wrong: a trailer line.

Baseline at `ca4f2ae`: 482/482 unit (matches the Task 3 report). Integration: not runnable here.

## Integration pending
(integration tests touched by this lane's tasks, to run before merge)
(none: all green at a14e475)

## Log
- Task 6: dispatched (sonnet) at base 3fef8ce
- Task 6: implementer DONE (385beb7); 483/483 unit. Review dispatched (sonnet).
- Task 6 review: spec ✅, quality Approved. ⚠️ TDD ordering unverifiable from the diff; the report's RED transcript is the evidence (accepted). 1 Minor:
  - Task 6: minor (deferred): the commit trailer names Claude Sonnet 5, not the constraint's Opus 5.5.
  - Ruling: a commit's Co-Authored-By names the model that actually wrote it; constraint 8 amended to "the implementing model's own attribution line + the Claude-Session line" — accurate attribution beats a uniform one — cost if wrong: a trailer line.
Task 6: complete (commits 3fef8ce..385beb7, review clean)
- Task 7: dispatched (sonnet) at base 54eea64
- Task 7: implementer DONE (1ed70df 58b3c3a); 483/483 unit; check-vsix.sh extended test-first, break check caught. No integration tests affected. Review dispatched (sonnet).
- Task 7 review: spec ✅, quality Approved, no findings (reviewer re-ran cmp on all five assets and `vsce ls`: media/icon.png is the only media file shipped).
Task 7: complete (commits 54eea64..58b3c3a, review clean)
- Ruling (T5a dispatch): the trust terminal reuses the resume path's launcher lookup and its launcher-missing handling; on its close, refreshTrust runs for EVERY pending job, not only those matching the folder — refreshTrust is mtime-cached per session, so this is cheap and cannot miss a spelling variant of the same folder — cost if wrong: a few stat calls.
- Ruling (T5a dispatch): invoked without a string cwd (e.g. from the palette) the command logs and does nothing, and it is hidden from the palette — it only makes sense with a folder — cost if wrong: one menu entry.
- Task 5a: dispatched (sonnet) at base f1cb859
- Task 5a: implementer DONE (69ad673 d70840d 9b44133); 496/496 unit; 6 mutations (4 caught, 2 did not compile). statusBar.ts untouched. Review dispatched (opus: multi-file extension.ts wiring).
- Integration now runnable (user allowed *.visualstudio.com, *.microsoft.com, 2026-09-25). At a14e475: 9/9 integration (VS Code 1.139.0 under xvfb), covering T6's defaults test and T5a's command-registration check. "Integration pending" list cleared. Constraint 6 amended: integration gates every task from here.
- Task 5a review 1 (opus): spec ✅, quality Needs fixes. Reviewer verified both DID-NOT-COMPILE mutations are real (TS2345 under strict), and that the status.update re-render is load-bearing (its removal is caught).
  - Important: ruling 2 ("refreshTrust for EVERY pending job") is untested; narrowing the loop to scheduler.current SURVIVED (87/87). Fix round 1 sent.
  - Task 5a: minor (deferred): no cwdExists check before opening the trust terminal (resume has one).
  - Task 5a: minor (deferred): the "could not find the claude executable" string is now duplicated (~452, ~1128).
  - Task 5a: minor (deferred): `void executeCommand(...)` inside the notification's .then has no .catch.
  - Task 5a: minor (deferred): the trustTerminals Set is not cleared on dispose.
  - ⚠️ resolved by controller: onDidCloseTerminal passes the same Terminal object createTerminal returned (documented API); the 9/9 integration run at a14e475 activated this wiring in real VS Code.
- User decisions (2026-09-25, before stepping away): this lane now owns Task 4 from bbff534 and the rest of the plan (5b, 8, 9) to the end; push release/1.0.0 and open a DRAFT PR into main (never merge); this lane merges origin/main (merge commit, no rebase) for Task 9.

## Extended scope (user, 2026-09-25): this lane finishes the plan
Order: 5a (fix round) → 9a merge origin/main → merge fix/1.0-field-reports (bbff534) → 4a detection → 4b gave-up → 5b tooltip → 8 rename → 9b docs + release/1.0.0 → final whole-branch review → push release/1.0.0 + draft PR.

Pre-flight scan (added tasks)
| Pair / task | Shared | Finding |
|---|---|---|
| 9a / everything after | package.json, workflows, transcriptWatcher.ts | merging main FIRST means 4a-9b build and test on the real engine floor (^1.138) and main's watcher change; conflicts are smallest now (7 files). Ruling below |
| bbff534 / 4a | limitParser.ts nextZonedOccurrence | 4a reviews bbff534 (never reviewed) as its DST bullet. OK |
| 4a / Task 3 | transcriptWatcher.ts untrusted path, overloadParser.ts | new overload renders must respect Task 3's vetoes and the flagged exemption; brief requires a negative test. OK |
| 4a / Task 1 | MAX_OVERLOAD_AGE_MS | new overload renders obey the age gate. OK |
| 4b / 5a | extension.ts, notifications | 5a's trust notice is not a failure notice; 4b must not fold it into gave-up. OK |
| 4b / 5b | statusBar.ts, the gave-up model | 4b produces per-session gave-up data (id, cwd, cause, when); 5b lists it with pending jobs in one tooltip. Interface fixed in both briefs. OK |
| 4b / Task 10 | failed-launch paths release claims | 4b's recording on launcher-missing / cwd-missing must not change the claim release order Task 10's 3 review rounds settled. Carried into the 4b dispatch |
| 5b / 5a | command id + cwd arg | 5b links 5a's command with a URI-encoded [cwd]. OK |
| 8 / all | every id and string | runs after 4a-5b; 9b docs then use the new ids. OK |
| 9b / 8 | README settings table | table uses claudeLimitBreak.* ids. OK |
| 9b self | release branch | version bump on release/1.0.0 only; docs on this branch. User approved pushing release/1.0.0 + a DRAFT PR, never a merge. OK |

- Ruling: merge origin/main (Task 9a) before Task 4, not at the end — 7 files now vs. every task's diff later, and 4a-9b get tested against engines ^1.138 — cost if wrong: none; the user approved this lane merging main.
- Ruling: Task 4 split into 4a (detection: A5, A6, A7 incl. reviewing bbff534) and 4b (gave-up state: A8, A9) — different files, different review surfaces — cost if wrong: one extra review.
- Ruling: Task 9 split into 9a (merge main, early) and 9b (docs + release branch, last) — cost if wrong: none.
- Ruling: prior-art slices copied to ref/prior-art/ (from 5b4d91a) so 4a's implementer has the verbatim renders — cost if wrong: 270 KB of markdown in the workspace.
- Task 5a: fix round 1/5 (1 addressed per implementer, awaiting re-review — every-pending-job test; commits 9b44133..18fad58); 497/497 unit, 9/9 integration; named mutation now CAUGHT. Scoped re-review dispatched (sonnet).
- Task 5a re-review 1: ADDRESSED (the asserted job never becomes current; reference identity through the memento traced); no new breakage.
Task 5a: complete (commits f1cb859..18fad58, review clean after 1 fix round; 4 minors deferred)
- Task 9a: dispatched (sonnet) at base cd53868
- Task 9a: implementer DONE (48fbb64, merge of origin/main 28b0eec; no conflicts); npm ci 0, 497/497 unit, 9/9 integration, check-vsix 0. Review dispatched (sonnet).
- Task 9a review: spec ✅, quality Approved, no findings (reviewer confirmed both parents, main-owned files identical to main, lockfile = main's, npm ls clean).
Task 9a: complete (commits 82dddfb..48fbb64, review clean)
- Merged origin/fix/1.0-field-reports (bbff534) as 8923bc0; 498/498 unit.
- Task 4a: dispatched (sonnet) at base 8923bc0
- Task 4a: implementer DONE (912d21a 583ada4 abc9ccf); 514/514 unit, 9/9 integration; 8/8 mutations caught. Reviewing bbff534 found the spring-forward gap resolved to the EARLY side; fixed (912d21a). Review dispatched (opus), package covers bbff534 + 4a.
- Task 4a review 1 (opus): spec ❌, Needs fixes. bbff534 fall-back ✅ in Chicago/London/Sydney/Lord_Howe; in-flight exclusion ✅ both paths; transient-429 routing ✅ on the untrusted path.
  - Important 1: a FLAGGED transient-429 entry carrying quotaLimits.resetsAt arms a usage-limit timer (the quotaLimits branch returns before text is read) — breaks ruling 1.
  - Important 2: new overload rules not line-start anchored; mid-sentence prose / a Bash tool_use echo of the render schedules a retry on the untrusted path (prior art: must-not-fire).
  - Important 3: subagent-file veto not applied to unflagged overload text; the report's rationale cited a test whose entry is flagged.
  - Ruling (Important 1): skip the quotaLimits branch when the entry's text matches the transient-429 render; do NOT add a quotaLimits.status gate — that would change Task 1's reviewed behaviour on evidence we do not have — cost if wrong: a flagged non-429 entry with status 'allowed' could still arm from resetsAt (not observed).
  - Ruling (Important 2): anchor the NEW rules (transient-429, stream-interrupted) at a line start, allowing leading whitespace and the TUI glyphs ⏺/●; leave the old api-error-status rule as is (deferred minor below) — the fix stays scoped to this task — cost if wrong: an old-rule false positive from quoted prose, pre-existing.
  - Ruling (Important 3): add isSubagentFile to the !flagged veto for overload text too — Task 3's intent; flagged entries stay exempt — cost if wrong: an unflagged real overload in a subagent file is missed; its parent records it.
  - Task 4a: minor (deferred): spring-forward east of UTC overshoots by an extra hour (London 01:30 → 03:30 BST); safe direction; only Chicago is tested.
  - Task 4a: minor (deferred): the in-flight regex's narrowness is unpinned (no terminal case containing "attempt").
  - Task 4a: minor (deferred, pre-existing): the old api-error-status rule fires on mid-sentence "API Error: 529" prose.
  - ⚠️ open: whether Claude Code writes these renders into JSONL with the literal "API Error:" head, and whether a transient-429 entry carries quotaLimits — evidence covers the TUI render and CHANGELOG only. For NEXT.md.
- Task 4a: fix round 1/5 (3 claimed addressed, awaiting re-review; commits abc9ccf..29c97b7); 524/524 unit, 9/9 integration; 3/3 mutations caught. Implementer note: the subagent veto now covers the OLD overload rules too for unflagged subagent entries (intended by the ruling's wording). Scoped re-review dispatched (sonnet).
- Task 4a re-review 1: all 3 ADDRESSED (verified live against out/); no new breakage.
  - Ruling: the subagent-file veto on unflagged overload text also covers the OLD overload rules (e.g. a bare unflagged "API Error: 529" in subagents/) — intended: unflagged text in a subagent file is not a live notice, a flagged one always is (Task 3's rule, now uniform across limit and overload) — cost if wrong: an unflagged real overload in a subagent file goes unretried; the parent transcript still records the stop.
Task 4a: complete (commits 8923bc0..29c97b7 incl. bbff534 review, 1 fix round; 3 minors deferred)
- Task 4b: dispatched (opus: design of the shared gave-up model + Task 10 claim interplay) at base cff81b4
- Task 4b: implementer DONE_WITH_CONCERNS (cd14cdd 0297df6 b11ecb6 eca15a8 6155dd3); 564/564 unit, 9/9 integration; 38 mutations caught; Task 10 claim calls unchanged.
  - Ruling (concern 1, before review): warn-once silences AUTOMATIC repeats only; an explicit user action (Resume Now command or button, Resume Anyway, Open Claude to Trust) always shows its failure notice — a click with no visible answer is the "looks idle" failure A8 exists to remove — cost if wrong: a repeated popup for a user clicking the same broken resume twice. The 4 tests changed to expect silence on a manual retry go back to expecting the notice.
  - Ruling (concern 2): a dismissed budget refusal records gave-up with no second popup — the refusal was the notice — cost if wrong: none.
  - Ruling (concern 3): `statusBar: "pending"` showing gave-up is right (not idle); the setting's description is updated in Task 9b's README/settings pass — cost if wrong: one description line.
  - Carried to 5b (concern 4): a session can be both pending and gave-up — one line per session in the combined list; folder names must be escaped.
