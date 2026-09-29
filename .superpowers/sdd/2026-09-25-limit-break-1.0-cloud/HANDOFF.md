# Handoff: Limit Break 1.0, cloud lane → fix/1.0-field-reports

Written 2026-09-29 by the cloud-lane controller (claude.ai session
`session_01JRHoU2Jtzz7ZD6EKVKb5bu`) for the Windows-lane session that owns
`fix/1.0-field-reports`. Everything below is verifiable from git and from `progress.md` in this folder.

## TL;DR

- **The whole plan is done.** Tasks 1-10 of `docs/superpowers/plans/2026-09-24-limit-break-1.0.md` are
  implemented, each task-reviewed. A final whole-branch review was run, its one fix wave landed, and the
  scoped re-review was clean. Two Minors are parked (below).
- **Branch `claude/limit-break-1.0-cloud`** holds all of it. It already contains:
  - your `ca4f2ae` (Tasks 1, 2, 10, 3);
  - your `bbff534` (Task 4's DST commit), merged as `8923bc0`;
  - `origin/main` @ `28b0eec` (#17, #18, #22), merged as `48fbb64`.
- **Branch `release/1.0.0`** = that head + one commit, `chore(release): 1.0.0` (version bump only).
  - A **draft PR** into `main` is open: https://github.com/Dream-Mosaic/claude-limit-break/pull/23. Nobody has merged it: `release.yml` publishes on any
    push to main whose version is untagged, so merging it publishes 1.0.0.
- **Tests at the release head**
  - unit: 675/675
  - integration (VS Code under xvfb): 9/9
  - `scripts/check-vsix.sh`: green

## How to pull this in

`fix/1.0-field-reports` on GitHub is at `bbff534`, which is an ancestor of `claude/limit-break-1.0-cloud`.

1. **If your local branch has nothing beyond `bbff534`**, it fast-forwards:
   ```
   git fetch origin
   git switch fix/1.0-field-reports
   git merge --ff-only origin/claude/limit-break-1.0-cloud
   ```
2. **If your Task 4 implementer left local commits or edits**, stash or commit them first, then
   `git merge origin/claude/limit-break-1.0-cloud`. Expect conflicts in:
   - `src/parsers/limitParser.ts`: this lane added a spring-forward fix on top of `bbff534`.
   - `src/parsers/overloadParser.ts` and `src/transcriptWatcher.ts`: Task 4a, plus final-review I4.
   - `src/extension.ts` and `src/statusBar.ts`: Tasks 4b, 5a, 5b, plus final-review C1 and I2-I7.

   This lane's Task 4 superseded yours, so prefer this side unless yours has something reviewed that this lacks.
3. **Line endings.** The repository stores `src/*.ts` and `test/*.ts` as LF (`git ls-files --eol`). Your CRLF
   comes from autocrlf on checkout; do not commit CRLF.
4. **Your untracked workspace** `.superpowers/sdd/2026-09-24-limit-break-1.0/` does not collide with this
   tracked one (`-cloud`). This folder is tracked on purpose, as the record. Delete it once you have read it, if
   you prefer the plan's "workspace is scratch" convention.

## Order the work ran in (cloud lane)

| Task | Commits | Review |
|---|---|---|
| 6 resume prompt default | 3fef8ce..385beb7 | clean |
| 7 icon + brand assets (media/, VSIX ships icon only) | 54eea64..58b3c3a | clean |
| 5a "Open Claude to Trust" command/button | f1cb859..18fad58 | 1 fix round |
| 9a merge origin/main | 48fbb64 | clean |
| (merge bbff534) | 8923bc0 | reviewed in 4a |
| 4a overload detection + DST (A5-A7) | 8923bc0..29c97b7 | 1 fix round |
| 4b gave-up state (A8, A9) | 10e897f..f1ce3df | pre-review change + 1 fix round |
| 5b one tooltip list + trust link | dfa5461..836371a | 1 fix round |
| 8 rename → Limit Break / `claudeLimitBreak.*` | 5392b80..32a1515 | clean |
| 9b CHANGELOG / README / NEXT.md | 4f87eb9..cb13d7e | 1 fix round |
| Final whole-branch review → fix wave | 09bb883..230fc67 | re-review clean, 2 parked |
| Release bump (`release/1.0.0`) | 8dd2644 | suites + check-vsix |

Every commit is reachable in `git log`. Every task has `task-N-brief.md`, `task-N-report.md` and
`review-*.diff` in this folder.

## What the final review changed (read these before touching extension.ts)

- **C1.** Native auto-continue counts only for **usage limits**. An overload in an idle terminal is offered
  ("Resume in Terminal Anyway"), not dropped. 0.1.2 resumed these; the 1.0 holder policy had regressed it.
- **I2.** A holder-policy decline **keeps** the cross-window claim, so other windows do not re-offer.
- **I3.** Overload claim keys use the detection entry's own timestamp, not a 10-minute bucket. Claim files
  record the window (`vscode.env.sessionId`), and a self-collision is logged as such.
- **I4.** On the unflagged path, every overload rule needs a line starting with `API Error` (`:` or `(`).
  Prose no longer arms retries.
- **I5.** On activation, if `dream-mosaic.claude-limit-buster` is still installed, a warning appears with an
  Uninstall button.
- **I6.** After standing down for native auto-continue, a 60 s check follows. If the transcript has not grown
  since detection, the job is remembered and "Resume Now" is offered.
- **I7.** Cancel writes a claim for each cancelled job (mtime = its `resumeAtMs`), so other windows drop it.

## Parked (ship, but know)

1. After Cancel, a re-detection of the **same** reset is dropped silently in **every** window. NEXT.md says it
   affects only the cancelling window; that is wrong.
   - Fix idea: when this window schedules a fresh plan whose key holds its own claim, release that claim.
2. The CHANGELOG I6 bullet says "a minute after the resume time". It is really a minute after this window's
   fire (the reset plus 5-30 min jitter), measured against the transcript size at detection. Wording only.

Every other deferred Minor, parked finding and open question is in `docs/NEXT.md` (grouped), and each is traced
in `progress.md`.

## Open questions that need a real machine (cannot be settled in the cloud)

- **How Claude Code writes errors to the JSONL.** Does it write the `API Error: …` head literally, and does a
  transient-429 entry carry `quotaLimits`? Tasks 4a and I4 assume the rendered text; check a live transcript.
- **Whether native auto-continue is on.** `autoContinueAtUsageLimit` is treated as absent ⇒ on. The research
  says the toggle is account-gated. I6's check is the safety net; verify on your account.
- **A manual smoke test in an Extension Development Host.** Run it for the new UI: the tooltip list, the trust
  link, the gave-up icon with "Dismiss gave-up notices", the old-extension warning, and the cross-window claim
  with two windows.

## Environment notes (cloud)

- Integration tests needed `*.visualstudio.com` and `*.microsoft.com` allowed (the user did this on 2026-09-25).
- `scripts/check-vsix.sh` needs only the npm registry.
- The mutation runner is `mutate.py` in this folder (Linux paths).

## Rulings I made on the user's behalf (exhaustive, in order; each with its cost if wrong)

1. Ruling: branch from `ca4f2ae`, not `bbff534` — only reviewed work under this lane; `bbff534` is Task 4's first, unreviewed commit — cost if wrong: none, the handoff merge takes either.
2. Ruling: Task 7 assets mapped by dimensions: ICO 256² → icon.png, color 1254² → logo.png, "Logo" 627×541 → banner.png, mono 1254² → logo-mono.png (each `cmp`-identical to `5b4d91a`) — cost if wrong: a file name.
3. Ruling (user, 2026-09-25): `media/logo-mono.svg` is the "no square" variant — the user's shapes (frame, "Limit", gauge) in currentColor on transparent, without the solid square and mask. Validated against the VS Code docs (activity-bar icon: 24×24, single colour, SVG; drawn as a CSS mask, `paneCompositeBar.ts`) with a Chromium mock; the square version read as a filled tile beside the codicons. A 24-unit redraw with ~2px margin is a v1.1 item for NEXT.md — cost if wrong: one file.
4. Ruling: Task 5 split into 5a (this lane) and 5b (after Task 4) — the plan's T4/T5 ruling ties only the tooltip to T4 — cost if wrong: the tooltip link lands one task later.
5. Ruling: integration tests cannot run here (network policy blocks update.code.visualstudio.com). Gate on unit tests; list every integration test a task touches under "Integration pending" below for a run on the user's machine or in CI (ci.yml runs them on pull_request) — cost if wrong: an integration break found at handoff instead of here.
6. Ruling: this workspace is force-added to git (`.superpowers/` is ignored) so the handoff carries it; it is named `-cloud` so it can never collide with the Windows lane's untracked workspace — cost if wrong: one folder to delete.
7. Ruling: commits in this lane carry the session's two trailer lines (Co-Authored-By + Claude-Session), not the Windows lane's one — cost if wrong: a trailer line.
8. Ruling: a commit's Co-Authored-By names the model that actually wrote it; constraint 8 amended to "the implementing model's own attribution line + the Claude-Session line" — accurate attribution beats a uniform one — cost if wrong: a trailer line.
9. Ruling (T5a dispatch): the trust terminal reuses the resume path's launcher lookup and its launcher-missing handling; on its close, refreshTrust runs for EVERY pending job, not only those matching the folder — refreshTrust is mtime-cached per session, so this is cheap and cannot miss a spelling variant of the same folder — cost if wrong: a few stat calls.
10. Ruling (T5a dispatch): invoked without a string cwd (e.g. from the palette) the command logs and does nothing, and it is hidden from the palette — it only makes sense with a folder — cost if wrong: one menu entry.
11. Ruling: merge origin/main (Task 9a) before Task 4, not at the end — 7 files now vs. every task's diff later, and 4a-9b get tested against engines ^1.138 — cost if wrong: none; the user approved this lane merging main.
12. Ruling: Task 4 split into 4a (detection: A5, A6, A7 incl. reviewing bbff534) and 4b (gave-up state: A8, A9) — different files, different review surfaces — cost if wrong: one extra review.
13. Ruling: Task 9 split into 9a (merge main, early) and 9b (docs + release branch, last) — cost if wrong: none.
14. Ruling: prior-art slices copied to ref/prior-art/ (from 5b4d91a) so 4a's implementer has the verbatim renders — cost if wrong: 270 KB of markdown in the workspace.
15. Ruling (Important 1): skip the quotaLimits branch when the entry's text matches the transient-429 render; do NOT add a quotaLimits.status gate — that would change Task 1's reviewed behaviour on evidence we do not have — cost if wrong: a flagged non-429 entry with status 'allowed' could still arm from resetsAt (not observed).
16. Ruling (Important 2): anchor the NEW rules (transient-429, stream-interrupted) at a line start, allowing leading whitespace and the TUI glyphs ⏺/●; leave the old api-error-status rule as is (deferred minor below) — the fix stays scoped to this task — cost if wrong: an old-rule false positive from quoted prose, pre-existing.
17. Ruling (Important 3): add isSubagentFile to the !flagged veto for overload text too — Task 3's intent; flagged entries stay exempt — cost if wrong: an unflagged real overload in a subagent file is missed; its parent records it.
18. Ruling: the subagent-file veto on unflagged overload text also covers the OLD overload rules (e.g. a bare unflagged "API Error: 529" in subagents/) — intended: unflagged text in a subagent file is not a live notice, a flagged one always is (Task 3's rule, now uniform across limit and overload) — cost if wrong: an unflagged real overload in a subagent file goes unretried; the parent transcript still records the stop.
19. Ruling (concern 1, before review): warn-once silences AUTOMATIC repeats only; an explicit user action (Resume Now command or button, Resume Anyway, Open Claude to Trust) always shows its failure notice — a click with no visible answer is the "looks idle" failure A8 exists to remove — cost if wrong: a repeated popup for a user clicking the same broken resume twice. The 4 tests changed to expect silence on a manual retry go back to expecting the notice.
20. Ruling (concern 2): a dismissed budget refusal records gave-up with no second popup — the refusal was the notice — cost if wrong: none.
21. Ruling (concern 3): `statusBar: "pending"` showing gave-up is right (not idle); the setting's description is updated in Task 9b's README/settings pass — cost if wrong: one description line.
22. Ruling (Important 2): (a) clear a session's gave-up record — record only, not the warn-once memory — when the watcher reports that session finished a turn (onInputNeeded; session id = the top-level transcript's basename; ignore subagents/ files), BEFORE the workspace-folder filter, since gave-up records can belong to any watched session; (b) add a status-bar menu item "Dismiss gave-up notices" that clears gave-up records only, shown only when there are any. Cancel keeps ruling 3 — cost if wrong: a gave-up marker clears on a turn that did not actually fix the cause (the next failure re-records it).
23. Ruling (Important 1): percent-encode "(" and ")" (and "!", "'", "*" for good measure — all left raw by encodeURIComponent) after encodeURIComponent; red test: a cwd ending in ")" whose rendered link target parses back to [cwd] — cost if wrong: none (VS Code decodes with decodeURIComponent).
24. Ruling (Important 2): refresh trust for scheduler.jobs AND readyJobs on the trust-terminal close and on scheduler.onChange (not on every countdown tick); persist the ready list when a ready job's folderTrusted flips so the fix survives reload — refreshTrust is mtime-cached per session, so the cost is a stat per listed job per change — cost if wrong: a few stat calls.
25. Ruling (9b dispatch): Task 9b does docs only; the 1.0.0 bump and release/1.0.0 are cut AFTER the final whole-branch review, from the reviewed head — so the final review's fixes land in the release — cost if wrong: none.
26. Ruling: native auto-continue counts only for reason 'limit'; overload jobs with an idle terminal holder take the remember + "Resume in Terminal Anyway" branch — cost if wrong: none.
27. Ruling: keep the claim when the decision remembers/notifies or drops the job for a busy/waiting holder; manual clicks already ignore claims — cost if wrong: a stale claim suppresses a later automatic fire of the same key for ≤1h (manual still works).
28. Ruling: key overload claims on the detection entry's own identity (its timestamp, identical in every window, distinct per event) instead of the bucket; write a window identity (vscode.env.sessionId) into the claim and log a self-collision as such — cost if wrong: none.
29. Ruling: on the UNFLAGGED path every overload rule requires a line starting with "API Error" (widen LINE_HEAD_RE to `api error[:(]`); flagged entries keep full recall — cost if wrong: an unflagged genuine overload without an API Error head is missed (Claude Code flags its own errors).
30. Ruling: on activation, if the old extension id is present, warn once per activation with an "Uninstall Claude Limit Buster" button (workbench.extensions.uninstallExtension) — cost if wrong: one popup.
31. Ruling: after standing down for native auto-continue, arm a check (reuse the stall-watch grace) at the reset; if the transcript has not grown, fall through to remember + a notice ("Claude Code did not continue this session on its own") — cost if wrong: one late notice.
32. Ruling: on Cancel, write a claim for each cancelled job's key so other windows drop it when it fires. The shared globalState job lists across windows (pre-existing) → NEXT.md — cost if wrong: a cancelled resume fires in another window (as today).
33. Parked — post-Cancel same-reset re-detection is silently dropped in EVERY window (NEXT.md says only the cancelling window) — Ruling: ship; the process allows no second fix wave, it errs silent-but-safe (no double writer), and the fix (release an own-claim when this window schedules a fresh plan for that key) is a NEXT.md item — cost if wrong: a user who cancels then re-hits the same reset waits for a countdown that does nothing.
34. Parked — CHANGELOG I6 bullet says "a minute after the resume time"; it is a minute after this window's fire (reset + 5-30 min jitter), measured against the size at detection — Ruling: ship; wording only; for the other lane to fix while merging — cost if wrong: an imprecise changelog line.
35. Ruling: keep this SDD workspace (not deleted as the skill's Finish step says) — the user asked for tracked progress for the handoff to fix/1.0-field-reports — cost if wrong: a folder the other lane deletes after merging.

Plus the Windows lane's rulings for Tasks 1, 2, 10 and 3 (made there, carried here): see `ref/windows-lane-progress.md`.

## Before PR #23 can merge

- Remove this tracked workspace (`.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/`, 51 files) from the
  branch that goes to main. It is the handoff record, not product.
- If `fix/1.0-field-reports` gains anything after pulling this in, re-cut `release/1.0.0` from its head, or
  merge it into `release/1.0.0`, so the PR carries it.
