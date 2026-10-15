# Limit Break 1.1 final review: deliberation outcome

Inputs:
- [the blind code review](2026-10-11-blind-code-review.md): I1-I6, M1-M17;
- [the decision review](2026-10-11-decision-review.md): verdicts on D1-D12 and the rulings;
- three field findings from 2026-10-11/12, on this machine with the installed 1.0 build: F1-F3.

Branch `feat/1.1-live-continue` at `ea227ca`. The deliberator and the controller, the session that built 1.1, went through each item. Every item below is **AGREED**. F2 was argued, and the deliberator conceded under four conditions; both positions are recorded.

What was run to verify (no source file was edited):
- `claude plugin validate mod`: passed with warnings.
- `claude plugin test mod`: 7 pass, 0 fail, on Claude Code 2.1.296.
- A node simulation of the real `pruneOffsets` from `out/src/transcriptWatcher.js` (I1).
- `where.exe npm` and `where.exe npx` on this machine (I4).
- The branch's `out/src/continuedSince.js` on session 7a00d6c0's real transcript (F3a).
- A read-only search of `claude.exe` 2.1.296 for the trust lookup, and a read of the field worktree's git pointer files and its `~/.claude.json` keys (F2).

## User decisions (2026-10-12 and 2026-10-14)

- **Must-fix for the release**, all done in a50b142, 03dfa56, 84cb39c and 18515c0:
  - S3, I5, M5, M2 and F1;
  - U2 (the prompt moved into the control file);
  - **F2**, moved from FIX-LATER to must-fix because it had already bitten the user;
  - the wording fixes (D3, P2, U4);
  - D9a.

  The smoke run, rows L1-L16, stays by hand before merge.
- **U1**: parked as #56. No README note in this release.
- **U3, U5 and U6**: kept as recommended. Parked in #36, #29 and #33.
- **Finding `claude`** (I4 + M12): deferred to after the release. #16 was retitled "Finding and running claude" and carries the full triage. The npm package's `bin` became a native `bin/claude.exe` at 2.1.113, so the shim parser fails for every npm install on Windows, not only on the line order.
- **Everything else** went to issues: #27, #29, #31, #33, #34, #36, #38, #39 and #53. New issues: #54 (mod follow-ups), #55 (the Trust terminal and the general trust walk) and #56 (U1).
- **Version**: the release is **2.0.0**, not 1.1.0 (7ae3ff1), because how a resume happens changed by default. The mod's protocol stays at 1. "1.1" remains the working name in the spec, plan, ledger and these reviews.

## Summary

- **10 FIX-NOW**, all before merge:
  - F1: stale-panel notice repeats.
  - I4+M12: npm launcher on Windows.
  - I5: mod update, install and offer once across windows.
  - S3: re-check the holder before a fallback launch.
  - F2: worktree trust, narrowed.
  - M2: catch in the fire's continue path.
  - M5: guard `origin` in the mod.
  - D3: offer wording.
  - P2: README wording.
  - D9a: log the holder status at the fire.
- **6 USER-DECISION**, with recommendations below:
  - U1 (D9b): keep it.
  - U2 (D6): do it now.
  - U3 (D10): keep it, and file an issue.
  - U4 (D11): keep it, and fix the wording.
  - U5 (D8): later.
  - U6 (I3): keep fail-open, retry later.
- **SMOKE**: Part 1 rows L1-L9 have never run on 1.1. Six new rows are added (see SM).
- **FIX-LATER**: I1, I2, I3 async plus retry, T11, I6, F2's general walk, F3b (a comment on #31), P1, and the minors M3, M4, M6, M7, M8, M9, M10, M11, M13, M14, M15, M16.
- **DOC**: M1 (already documented) and F3a (field evidence for final-fix C).
- **REJECT**: M17, and the D8 sub-claim that the README overstates #29.

## Outcomes

| Id | Source | Claim | Verified | Outcome | Owner |
|---|---|---|---|---|---|
| F1 | field | The stale-panel notice repeats on every later turn end, even after Reopen | CONFIRMED | FIX-NOW | controller |
| I4 + M12 | blind | `where claude` lists the extensionless npm shim first; `resume()` keeps its own copy of `which` | CONFIRMED | FIX-NOW | controller |
| I5 | blind | Mod update, install and offer run in every window; `plugin list` runs before "Never" is read | CONFIRMED | FIX-NOW (narrow) | controller |
| S3 | decision | The 60 s fallback can launch into a holder that has turned busy or waiting | PARTLY | FIX-NOW | controller |
| F2 | field | The trust check misses the CLI's canonical-root lookup for a git worktree | CONFIRMED; mechanism derived | FIX-NOW (worktree case, exact); general walk FIX-LATER | controller / issue |
| M2 | blind | The fire's continue-in-place async has no catch | CONFIRMED | FIX-NOW | controller |
| M5 | blind | `e.origin.kind` is unguarded in the mod | CONFIRMED | FIX-NOW | controller |
| D3 | decision | The offer should say the mod loads into every Claude Code session | CONFIRMED | FIX-NOW (wording) | controller |
| P2 | decision | README 81-82 says "launches at once"; a terminal gets the offer | CONFIRMED | FIX-NOW (wording) | controller |
| D9a | decision | The `status` reported for a limit-stopped holder is unknown | CONFIRMED (gap) | FIX-NOW (log line) + SMOKE | controller / user |
| D9b | decision | Nothing follows a socket continue that ends in a question | CONFIRMED | USER-DECISION U1 | user |
| D6 | decision | The control message carries the prompt; only the nonce is checked | CONFIRMED | USER-DECISION U2 | user |
| D10 | decision | A late fire is dropped silently | CONFIRMED | USER-DECISION U3 | user |
| D11 | decision | The bridged head start does nothing at the default jitter | CONFIRMED (fact); OVERTURN not supported | USER-DECISION U4 | user |
| D8 | decision | An idle terminal at a five-hour limit, native on, ends in a click | CONFIRMED; the README sub-claim is WRONG | USER-DECISION U5 | user |
| I3 | blind | Sync child processes; a timed-out listing fails open to a launch | CONFIRMED | USER-DECISION U6 (fail-open) + FIX-LATER (async, retry) | user / issue |
| D5 | decision | Every L row of the smoke kit is unrun for 1.1 | CONFIRMED | SMOKE | user |
| SM | both | Smoke rows to add | n/a | SMOKE | user |
| I1 | blind | The offset cap plus scan-then-prune thrashes above 2000 files | CONFIRMED (simulated) | FIX-LATER | issue |
| I2 | blind | A full recursive listing and N stats per event, in each window | CONFIRMED | FIX-LATER | issue |
| T11 | decision | A sync listing runs at schedule time | CONFIRMED | FIX-LATER (with I3) | issue |
| I6 | blind | `register.mjs` tests don't run in CI | CONFIRMED (the spec decided not in CI) | FIX-LATER (node stub of `$`) | issue |
| F3b | field | Native "armed" line, then no native continue | CONFIRMED | FIX-LATER (comment on #31) | issue |
| P1 | decision | `modUsable` stays true after an uninstall outside Remove | PARTLY | FIX-LATER | issue |
| M3, M4, M6, M7, M8, M9, M10, M11, M13, M14, M15, M16 | blind | Minors | see details | FIX-LATER | issue(s) |
| M1 | blind | Shared job lists are last-writer-wins | CONFIRMED, already documented | DOC (exists) | none |
| F3a | field | 7a00d6c0 dropped again as "continued" by 1.0 | CONFIRMED; the branch returns false | DOC (ledger evidence for final-fix C) | controller |
| M17 | blind | The update-check body is unbounded | CONFIRMED, negligible | REJECT | none |

## FIX-NOW details

### F1. False "panel tab is still on the conversation" notice
- Code: `resumedSessions.set` is at `src/extension.ts:833` and is read at `:1264`; nothing deletes it (those are its only references).
- `reopen()` (`:1249-1253`) doesn't clear it either. So every later turn end in that session re-runs `handleStalePanel`, including a synchronous `claude agents --json`. It warns whenever any panel is live, including a reopened, current one.
- 1.1 makes this rarer, because an idle panel is continued in place. But every launch still sets the entry.
- Agreed fix:
  - The **first** turn end after a launch decides; then the entry is forgotten. It is also forgotten on `reopen()` and on a stall verdict.
  - The button on that first notice must keep working after the entry is gone; it uses the target it captured.
- Tests: a second turn end shows nothing, and Reopen clears the entry.

### I4 + M12. Launcher resolution on Windows with an npm-installed Claude Code
- On this machine, `where npm` prints `...\npm` (no extension) before `npm.cmd`.
- `resolveClaudeLauncher` (`src/resumer.ts:131-139`) takes the first line. It returns the extensionless sh script, which can't be spawned. The result is a dead terminal, a listing that fails and so fails open, and a failed mod install.
- Agreed fix:
  - From `where`'s output, prefer `.exe`, then `.cmd`/`.bat`, and never take a line with no extension on win32.
  - `resume()` must use `findLauncher`. Its duplicate `which` and `readShim` (`src/extension.ts:753-767`) would otherwise keep the bug.
- Test: `which` returns the extensionless path first.

### I5. Mod update, install and offer across windows
- `maybeOfferMod` spawns `plugin list` before reading "never" (`src/extension.ts:1451`).
- When the extension updates, every window reloads and runs `updateMod`, which does `rmSync` and a copy into the same folder.
- Agreed fix: read the "never" flag first, and put one `holdClaim` around update/install and the offer. Copying into a temp folder and renaming is not needed.

### S3. Re-check the holder before a fallback launch
- `continueHolder` never re-reads the holder before `launchedAfterFallback` (`src/extension.ts:983-984`).
- The last look's `continuedSince(bytesAtSend)` already catches any turn that wrote an entry after the send. What remains is a turn that started before the send and wrote nothing for 60 s (one long tool call), or a waiting prompt.
- Agreed fix:
  - Re-run `detectAgentRows`/`classifyHolder` before a fallback launch. A busy holder gets "no launch": keep the claim and log the outcome. A waiting holder gets the D9 notice.
  - Do the same for a terminal holder, for consistency, even though a terminal's fallback already only offers.
  - If the holder is busy because our own message is waking it, dropping is right: the message lands late, with no fork.
- This applies the decided "busy: drop" and "waiting: D9 notice" rows at launch time. It does not change the decided last look.

### F2. Worktree trust: narrowed to the worktree case, matched exactly
- Limit Break: `src/trust.ts:40-55` matches only the exact folder's key (case-folded on win32/darwin).
- The CLI (2.1.296), derived from the bundle:
  - It first looks up `projects[<canonical root>]`, where the canonical root is `ft(gitRoot)`.
  - `ft` reads `<gitRoot>/.git`. If that is a `gitdir:` file for a valid worktree, the canonical root is the **main checkout**; otherwise it is the git root.
  - It then walks from the cwd up to the nearest `.git` (a file or a folder), with no bound outside git. The first trusted key wins.
  - Keys are exact: only backslashes become slashes.
  - So for a worktree the walk stops at the worktree itself, but the main repo's record has already matched.
- Field check, read from disk:
  - The worktree's `.git` is `gitdir: C:/Users/thegr/Dream-Mosaic/Projects/unwritten-chronicles/.git/worktrees/docs+rules-content-map`.
  - Its `commondir` is `../..`, and its `gitdir` points back to `<worktree>/.git`.
  - The key `C:/Users/thegr/Dream-Mosaic/Projects/unwritten-chronicles` is true; the `c:/` spelling is false.
  - About ten more worktree records under that repo exist with `hasTrustDialogAccepted: false`. The CLI still trusts those sessions, because it checks the canonical key first. So the false warning hits many of this user's sessions.
- Positions:
  - Deliberator, at first: FIX-LATER. The false warning errs the safe way, it is 1.0 behaviour, and a port has to reproduce the CLI's spelling exactly.
  - Controller: FIX-NOW. Worktrees are this user's normal workflow, and a false warning on every worktree resume trains them to ignore the trust warning. An exact match errs safe on a spelling mismatch.
  - The deliberator conceded under these conditions:
- Agreed fix, with its conditions:
  1. **Mirror the CLI's validation** (`zn()`), or fall back to "not trusted":
     - the content starts with `gitdir:`;
     - `<gitdirDir>/commondir` exists, and resolving it gives `u`;
     - `dirname(gitdirDir)` equals `join(u, 'worktrees')`;
     - `<gitdirDir>/gitdir` exists, and its content resolves to `<cwd>/.git`;
     - `basename(u)` is `.git`, and the main checkout is `dirname(u)`.

     Without these checks, a moved or copied worktree, whose back-pointer is stale, would read as trusted while the CLI prompts. That is the unsafe direction: a resume that stalls with no warning. A bare common folder, or a submodule's `gitdir: ../.git/modules/x`, stays "not trusted".
  2. Read only `<cwd>/.git`. A session whose cwd is a subfolder of the worktree keeps today's warning, which is safe.
  3. Look up the exact key, normalizing slashes only, with no case folding. Never change the launch folder: `trustedSpelling` stays exact-folder, so a canonical-root hit launches from `job.cwd` unchanged.
  4. Tests: a valid worktree is trusted through the main repo's key; a stale back-pointer, a missing `commondir`, a submodule `gitdir`, and a case-mismatched key are each not trusted.
- Known limit, recorded: the CLI helper that spells the final path can't be identified in the minified bundle; it is either a plain normalize or a realpath. If it is realpath, the CLI's key takes the disk's real case and ours takes the case written in the gitdir file. That still errs safe, unless the gitdir spelling's key is trusted and the real-case key isn't.
- FIX-LATER: the general walk from cwd up to the git root, with the same spelling caveat.

### M2, M5, D3, P2, D9a
- **M2**: wrap the `void (async () => …)()` at `src/extension.ts:1660-1682` in a try/catch that remembers the job, releases the claim and logs an `Outcome for` line (final-fix D promises one per fire).
- **M5**: `e.origin?.kind` (`mod/hooks/register.mjs:126`), plus a test; re-run `claude plugin test mod`.
- **D3**: the install offer says the mod loads into every Claude Code session on the machine.
- **P2**: README 81-82 says "launches at once" when nothing is listening; for a terminal it is now the offer.
- **D9a**: log the holder's kind, pid and raw status at each fire. Today an undefined status is logged as idle, because `isIdleStatus` fails open.

## SMOKE

- **D5**: Part 1 rows L1-L9 have never run on 1.1 (the kit's "Last run" is 1.0.0). Record L2's and L3's N, the send-to-confirm time.
- **SM**, rows to add:
  - A panel running a 90 s Bash call when the fallback is due (S3): no launch.
  - The socket path in bypass-permissions mode. The spike noted such a session holds peer messages for approval, until `dialogExpiry`.
  - The `status` at the fire for a panel and for a terminal stopped by a limit (D9a).
  - F1: resume, then Reopen, then a later panel turn: no notice.
  - A bridged panel at the default jitter: no wait line. With this user's +1 to +4 min jitter: the wait line.
  - A worktree session: no false trust warning (F2).

## FIX-LATER details

- **I1**: running the real `pruneOffsets` on 2500 unchanged files re-read 0, 500, 500, 500 and 500 files from byte 0 on passes 1 to 5.
  - Each re-read replays the file's last turn end (a chime, `handleStalePanel`), and an old overload with no timestamp counts as fresh.
  - This is 1.0 code; this machine has 210 transcripts.
  - Fix: baseline a file first seen after start at its size unless it was created after the start, and never evict a live file by count.
- **I2, I3 async, T11**: the watcher scans only the changed path; `claude agents` runs through async `execFile`; one retry on `'unknown'` at the fire.
- **I6**: a node stub of `$` so `register.mjs` runs in CI. Until then, run `claude plugin test mod` before each release.
- **F3b** (comment on #31): stand down on an "armed" line only while the arming process is still the live holder, and keep the check-back. Session 7f8d7cc4 shows the armed line alone would have stranded it: the arming process was gone by the fire, and Limit Break's launch was the only thing that moved it.
- **P1**: `modUsable` stays true after `claude plugin uninstall` done outside Remove; the stale status file outlives it.
- **Minors**:
  - M3: claim stale-takeover race.
  - M4: claims folder mode on multi-user Linux.
  - M6: serialize the mod's status writes.
  - M7: a repeated job id is reported as continued. It is reachable only after the same job really continued, and the manual continued-since modal fires first, so the worst case is a misleading log line.
  - M8: pick the newest key file.
  - M9: control and status files accumulate.
  - M10: `--` before the prompt; first check that the CLI accepts it.
  - M11: oversize-read offset arithmetic.
  - M13: dead or duplicated code.
  - M14: a test that the three version strings agree (they all read 1.1.0 today).
  - M15: pin `vsce`; `--target` on the release.
  - M16: test-suite shape.

## Decisions for the user

Each item below changes, or is asked to change, a decision you made: spec D1-D12, or a recorded ruling.

### U1 (D9b). Should anything follow a socket continue that ends in a question?
- Facts:
  - The confirm step checks only that the `msg_id` reached the transcript (`src/continueInPlace.ts:94-97`). A reply of "I need your go-ahead" counts as continued, and no stall check follows (`src/extension.ts:945-951`).
  - The socket path runs with peer authority. In the 10-08 spike, one run in three held at a force-push and asked for "go ahead".
  - The research note recommended reporting this; D9 (10-09) chose not to.
- Options:
  1. Keep D9, and document in the README that a socket continue may stop before an irreversible step, while the mod (which submits as you) does not. Cost: none in code; you find the question in the transcript when you return.
  2. One check after a socket continue: after the grace, if the holder is `waiting` or there is no new assistant output, show D9's waiting notice. Cost: a new path and tests before merge. The notice is seen when you return, the same moment as the question.
- Recommendation: **1** (agreed by both).

### U2 (D6). Move the prompt out of the control message
- Facts:
  - The mod submits the prompt carried in the message (`mod/hooks/register.mjs:52`).
  - `acceptControl` checks only `jobId`, `nonce` and expiry (`mod/hooks/control.mjs:53-75`).
  - So whatever can read the control file during its 120 s life, and post to the session's inbox, can have any text submitted as you.
  - Reading that file needs your own file access, and anything with that already controls the session (the peer token, the transcripts). This is defence in depth, not a hole, and it is within the threat model D6 states.
- Options:
  1. Keep it as specified. Cost: none now.
  2. Put the prompt in the control-file entry, which only the extension writes. The message carries `jobId` and `nonce` only, and the mod submits the file's prompt; a forged message could then only trigger Limit Break's own prompt. Cost: about 10 lines across `modStatus.ts`, `control.mjs` and `register.mjs`, plus tests in both suites.
- Recommendation: **2, now**. The reason is the protocol, not the threat: v1 hasn't shipped, and changing it after release costs a protocol bump and handling for both versions.

### U3 (D10). A late fire is dropped silently
- Facts: as decided (`src/extension.ts:1600-1607`), the drop leaves a log line in an output channel that isn't usually open. After D12, nothing in the UI lists the sessions that were waiting.
- Options:
  1. Keep D10 for 1.1. Cost: someone who wakes the machine with several stopped sessions has to remember which they were.
  2. One notice on wake: "N resumes came due while VS Code wasn't running: X, Y", with Resume Now. Cost: new UI and tests before merge.
- Recommendation: **1** for 1.1, with an issue for option 2 alongside #36.

### U4 (D11). The bridged head start does nothing at the default settings
- Facts:
  - `randomDelayMinMinutes` defaults to 5 (`package.json:156`), so `baseResumeAtMs + 5 min - now <= 0` at every default fire, and the wait at `src/extension.ts:1662-1670` never runs.
  - What protects a bridged panel at the defaults is the fire-time `hasContinued` check, which is 1.0 behaviour.
  - Your own setting is lower than the default: last night's log shows delays of +1 to +4 minutes. So the floor does bind for you.
- Options:
  1. Keep the 5-minute floor as decided, and make the README and CHANGELOG say "at least 5 minutes after the reset". Cost: wording only.
  2. Drop the wait and the notice text, as the reviewer prefers. Cost: anyone with a delay under 5 minutes, you included, loses the head start.
  3. Count the 5 minutes from the delayed fire time. Cost: every bridged resume comes 5 minutes later.
- Recommendation: **1**. The decision review's OVERTURN is not supported: the mechanism does what D11 says, and it binds for you.

### U5 (D8). An idle terminal at a five-hour limit with native auto-continue on still ends in a click
- Facts: when the native check finds no continue, it offers Resume Now (`src/extension.ts:1220-1225`). README row 210 says so; the claim that the docs overstate #29 is wrong.
- Options:
  1. Keep the offer. Cost: one click in the most common terminal case.
  2. After the check fails, continue in place automatically. That doesn't fork, and native's chance has passed by then. Cost: a new automatic path, which needs a smoke row.
- Recommendation: **2, as FIX-LATER**, after 1.1's smoke run.

### U6 (I3). A failed `claude agents` listing falls back to a launch
- Facts:
  - A listing that times out (`execFileSync`, 10 s) becomes `'unknown'`, and `decideOnFire('unknown')` resumes (`src/holderPolicy.ts:63-69`).
  - The spec's fire table decides this ("None, or the listing failed: launch a terminal, unchanged"). `src/liveSessions.ts:189` gives the reason: failing closed would stop every resume wherever `claude agents` misbehaves.
- Options:
  1. Keep failing open. Add one retry on `'unknown'` at the fire and make the listing async, both FIX-LATER. Cost: small.
  2. Fail closed at the fire: remember the job and offer it. Cost: no automatic resume on a machine with a flaky CLI.
- Recommendation: **1**.

## Field evidence (F3)

- **a.** Session 7a00d6c0's transcript:
  - The last flagged entry is at byte 6308286 (2026-10-12T03:16:17.913Z). After it come metadata lines and two `<task-notification>` user entries (03:16:17.928Z and 03:16:24.527Z), then nothing.
  - The branch's `continuedSince` returns false both from that entry and from the entry after it, so the branch would not have dropped the session.
  - This confirms final-fix C in the field. The controller's "three" counted one notification before the limit entry.
- **b.** Session 7f8d7cc4: an armed line with no native continue. The arming process was gone by 12:23, and Limit Break's 12:23 launch was the only thing that moved the session. This is input for held decision #31 (see FIX-LATER, F3b).
