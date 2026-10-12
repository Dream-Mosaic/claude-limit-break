# 1.1 final fix wave

The findings of the final whole-branch review (and two items the user raised), each with the controller's ruling, as handed to the fixer. All were addressed in commits 9b945f8..da42d7f; the outcome is in [the ledger](2026-10-11-live-continue-ledger.md). Copied verbatim on 2026-10-11.

---

# Final fix wave: Limit Break 1.1 (branch feat/1.1-live-continue, head 230c2c7)

One fix round for the whole-branch review's findings plus two items the user raised. Each item has the controller's ruling; implement the ruling. Every item needs a test unless it says otherwise. Read the spec (docs/superpowers/specs/2026-10-09-live-continue-and-mod-design.md) for context where needed.

## A. Critical

### A1. An idle terminal whose continue in place falls back must not get an automatic second terminal
- Today: `holderPolicy.ts` routes an idle terminal (overload, a non-five-hour limit, or native off) to `continueInPlace`; `continueHolder` in `extension.ts` runs `resume(job, manual)` on any `fallback`, whatever the holder kind. 1.0 never auto-launched into a live terminal: it remembered the job and offered "Resume in Terminal Anyway".
- Ruling: a TERMINAL holder's fallback takes 1.0's terminal outcome: `rememberReady(job)` and the same "Resume in Terminal Anyway" notice 1.0 shows for that case (reuse holderPolicy's notice text for overload / other limit / native-off; the decision that routed it to continue in place knows which). The fire's claim is kept, as for any declined fire. A PANEL holder's fallback still launches (spec-decided).
- Manual path: with the setting on, `manualResumeWarning` skips the modal for an idle terminal; a Resume Now / offer-button continue that falls back for a TERMINAL must show 1.0's fork modal ("already open in a terminal … will fork") before launching, and launch only if the user confirms.
- Make the README's idle-terminal row and the CHANGELOG say this: continued in place; if that can't be done, the 1.0 offer.
- Tests (extension): idle terminal, stub outcome `fallback` → no terminal, job remembered, "Resume in Terminal Anyway" offered; idle panel `fallback` still launches; Resume Now on an idle terminal with `fallback` shows the modal and launches only on "Resume Anyway".

### A2. "Open Session" must not open a second panel for a session held in another VS Code window
- Today: `claude-vscode.editor.open(sessionId)` creates a new panel (a new Claude process) when the session isn't in this window; with `watchScope: machine` the window that shows the notice is often not the one holding the panel.
- Ruling: call the command only when the holder's claude process descends from this window's extension host: `process.pid` is among the holder pid's 4 nearest ancestors (reuse the `parentPid` walk; make the depth a parameter). Otherwise don't call it; the notice says "Limit Break: session X is open in another VS Code window." Terminal matching is unchanged.
- Tests (sessionOpener): panel whose ancestry includes the host pid → opens; panel whose ancestry doesn't → false and the command is NOT executed; parentPid failure → not executed. Add an L-row to test/smoke/README.md: Open Session from the window that does NOT hold the waiting panel opens nothing and says so.

## B. Important

### B1. Don't promise limit sensing 1.1 doesn't do
- The install offer (`extension.ts`, "read limits exactly") and README "The Claude Code mod" ("so Limit Break sees limits exactly instead of inferring them") claim something no code does (nothing reads `rateLimits` or `lastStopFailure`).
- Ruling: say the mod reports the session's limits and lets Limit Break continue a session as you, privately; don't claim Limit Break uses the limit readings yet. Also make the offer start with "Limit Break: " (global constraint).

## C. User-reported bug (1.0 behaviour): a resume skipped as "continued" when the session hadn't moved
- Evidence: 2026-10-11T11:32:29Z, window log: "Session 7a00d6c0 has continued since it stopped; not resuming." The transcript (`~/.claude/projects/c--Users-thegr-Dream-Mosaic-Projects-unwritten-chronicles/7a00d6c0-b8e4-4527-aaa8-73187cfb067c.jsonl`) ends: the flagged limit entry at byte 6045923 (09:39:57.542Z, `isApiErrorMessage`, `<synthetic>`), then two `user` entries whose text starts `<task-notification>` (background subagents finishing, 09:39:57.987Z and 09:39:59.560Z), then nothing. `continuedSince` on that file returns true for baselines 6045923, 6048952 and 6051779 (checked with out/src/continuedSince.js). No assistant turn followed: the session never moved.
- Root cause: `continuedSince`'s `readEntry` treats any unflagged `user` entry as "the session moved on". Inbound deliveries queued into a stopped session (a background task's `<task-notification>`, a message from another session or agent) are not the session moving; only the turn they wake is.
- Ruling: in `readEntry`, a `user` entry whose leading text starts with `<task-notification>`, `<cross-session-message`, or `Another Claude session sent a message:` is neutral (neither sets nor clears), like local slash commands. A real assistant entry after it still sets "continued"; a flagged one still clears it. Update the doc comment's list.
- Tests (continuedSince): limit entry then two task-notification user entries → false; then a real assistant reply → true; a cross-session message user entry then nothing → false; a flagged error after a task notification → false. Add a regression test built from the same entry shapes as the real file (no real content).

## D. Logging the user asked for: a fire and its outcome are always logged
- Today a fire logs only some outcomes (a launch, a drop), in different words per path, and nothing marks the fire itself, so a log can't show "Limit Break tried to resume X at T; outcome: …".
- Ruling: `onFire` logs one line when a job fires: `Resume due for <id8> (reset <base ISO>, scheduled <resumeAt ISO>).` Every branch then ends in exactly one outcome line starting `Outcome for <id8>: ` — e.g. `launched a terminal`, `continued in place by mod (confirmed after N ms)`, `continue landed late; nothing launched`, `fell back to a terminal launch`, `offered Resume in Terminal Anyway`, `left to Claude Code's auto-continue`, `dropped: has continued since it stopped`, `dropped: came due while VS Code wasn't running (N min late)`, `dropped: claimed by another window`, `dropped: busy in a panel/terminal`, `waiting for input; notice shown`, `disabled; kept for Resume Now`, `autoResume off; offered`, `bridged; waiting for the web client until T`, `Remote Control continued it`, `cancelled; nothing launched`. Keep the existing explanatory lines; add the outcome line beside them. The later checks keep their own lines (stall "producing work", native check).
- Tests: a few extension tests assert the fire line and the outcome line for: a launch, a continued-since drop, a claim drop, a continue in place.

## E. Minors to fix (each small)
1. The bridged note in the "resuming at" notice (`extension.ts` schedule) promises a head start; show it only when `continueInPlace` and `autoResume` are both on (otherwise nothing waits). Test.
2. `parseModStatus` (`modStatus.ts`): keep `nativeContinue` only if `type` is a string and `atMs` a finite number; drop `continued` entries without a finite `atMs`. (A bad `atMs` makes the native-continue timer's `toISOString()` throw, skipping its offer.) Test.
3. `modInstall.ts`: an unparseable `plugin list` output means "can't tell", like a failed listing (Remove then attempts uninstall); `isModInstalled` should distinguish "not installed" from "unparseable". Test.
4. Mod (`mod/hooks/register.mjs`): accept control messages whose `origin.kind` is `'peer'` or `'peer-send-message'` (2.1.296 types list both; the nonce gates acceptance). Extend `mod/hooks/register.test.ts`; run `claude plugin validate mod` and `claude plugin test mod`.
5. Control file permissions: create `~/.limit-break/control` with mode `0o700` and write the file with mode `0o600` (`extension.ts` writeControlFile). No test needed beyond the existing ones passing.
6. Remove also deletes `~/.limit-break/sessions/*.json` (only `*.json` in that folder; ignore errors), so a stale status file can't make the extension send a control message to a session that no longer has the mod. Test via the injected deps.
7. `src/policy.ts`: put the `},` that ends the scheduled-job literal on its own line.
8. Test: a D10 late drop keeps the claim (another window's claim attempt afterwards gets `taken`; use the existing real-claims test mode).

## F. Not in this wave
- Acting on Claude Code's "auto-continue armed" line, and persistent logs: waiting for the user's decision. Don't implement.
- Known limits recorded, not fixed: a window closed mid-continue leaves the claim held; two processes on one session can make `loadedAtMs ≥ startedAt` pick the wrong one (lands late, no fork).
