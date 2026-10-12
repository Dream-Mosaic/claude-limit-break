# Blind code review: Limit Break (feat/1.1-live-continue at HEAD)

Scope: `src/`, `mod/`, `test/`, `scripts/`, `.github/`, `package.json`, `.vscodeignore`, README and CHANGELOG. Not read, by instruction: `docs/`, `.superpowers/`, git history. Static review. The only things run were read-only probes (`where.exe`, directory counts); no tests were run.

## Summary

The codebase is careful and defensive in the places that matter most. Nothing reaches a shell. The resume prompt is a single argv element. `--resume` only ever receives a validated UUID. Settings that name a program or a prompt are machine-scoped. Persisted state is re-validated on restore. The control protocol between the extension and the mod is nonce- and TTL-gated, and the claim, holder, continued-since and late-fire guards are thoughtfully layered against forking a session. I found no Critical defects. The most important problems are operational rather than logical. (1) The transcript watcher's 2000-entry offset cap, together with scan-then-prune ordering, makes a heavy user's watcher evict and re-read live files forever, replaying old turn-ends (chimes, stale-tab handling) and any timestamp-less old overload. (2) Every window, on every poll and file event, does a full recursive directory listing and a stat of every transcript. (3) The extension host blocks on synchronous child processes (`where`, `claude agents --json`, up to 10 s each) in the detection and fire paths, and a timeout there fails open to a terminal launch. (4) The mod install/update/offer flow is uncoordinated across windows, although the repo already has a cross-window claim mechanism. (5) The mod's actuator (`register.mjs`), which submits prompts as the user, is only tested by a runner that CI never invokes. There is also a plausible Windows launcher-resolution bug for npm-installed Claude (unverified here). The rest is minor robustness and maintainability.

Findings: 0 Critical, 6 Important, 17 Minor.

---

## Critical

None found.

## Important

### I1. Offset-table cap plus scan-then-prune makes the watcher thrash on large histories
- Where: `src/transcriptWatcher.ts:94` (`MAX_OFFSET_ENTRIES = 2000`), `:107-132` (`pruneOffsets`), `:238-273` (`scan` then `prune`), `:285-288` (new file read from 0), `:524-525` (no timestamp counts as fresh).
- What is wrong: `start()` baselines every existing `.jsonl`, and the listing is recursive, so it includes `subagents/` transcripts. `scan()` ends with `prune(files)`. If more than 2000 files exist, `pruneOffsets` evicts the surplus. At startup every entry has an identical `lastActivity`, so the evicted ones are arbitrary live files. On the next pass an evicted file has `previous === undefined`, so it is treated as a brand-new session and read from byte 0 (the last 2 MB). Each pass then re-adds those files and evicts a different set, so the churn never stops.
- Failure scenario: a heavy agent user with about 2500 transcript files, subagents included. Each 5 s poll re-reads up to about 500 old files. Every re-read old file produces `onInputNeeded` for its last turn-end, so the chime plays and `handleStalePanel` runs for any file inside the open workspace. Old `past` limit notices are logged once per file. An old flagged overload entry with no `timestamp` is treated as fresh (line 524) and can schedule a retry of a long-dead session. The test at `test/transcriptWatcher.test.ts:180` only asserts the constant is 2000, never the behaviour above the cap. (Derived from reading; not reproduced, since the module imports `vscode` and the author's machine has only 207 transcripts.)
- Fix: prune only entries whose files no longer exist or are idle. Never evict an existing file just because of count (or, when over the cap, evict by oldest real activity and record the file's current size as the offset instead of forgetting it). Do not treat first-seen files at scan time as "from 0" unless they were created after `startedAt` (check `birthtime`/mtime). Add a test with more than the cap.

### I2. Full recursive listing and N stats on every poll and file event, in every window
- Where: `src/transcriptWatcher.ts:199` (recursive `fs.watch` calling `scheduleScan`), `:207` (poll), `:210-215` (300 ms debounce), `:217-236` (`listTranscripts`), `:244-247` (`scanFile` stats every file serially).
- What is wrong: while any session is active, the recursive watcher fires on every append. Roughly every 300 ms (and at least every 5 s) each window does a recursive `readdir` of `~/.claude/projects` and an `await stat` per transcript. With `watchScope: machine` (the default) every open VS Code window does this independently.
- Failure scenario: thousands of transcripts and several windows cause steady disk and CPU churn and delayed detection while the scan is serialized behind `scanning`.
- Fix: on a watch event, scan only the changed path (`fs.watch` gives a filename). Keep the full listing for the poll backstop at a much lower frequency, or cache the directory listing and only re-list directories whose mtime changed.

### I3. Synchronous child processes on the extension host, with a fail-open that can fork a session
- Where: `src/extension.ts:582-598` (`which` via `execFileSync`), `:614-623` (`runAgentsListing`, `execFileSync`, 10 s timeout), `:316` (called in `schedule()` for every new job), `:912`, `:997`, `:1054`, `:1641` (fire path); `:753-767` (a second `execFileSync('where')` per `resume()`).
- What is wrong: every listing runs `where claude` and then `claude agents --json` synchronously. This blocks the extension host (and with it the 1 s scheduler tick, the watcher and every other extension feature in that host) for as long as the CLI takes, up to 10 s each. N sessions detected at once cost N listings. A listing that times out returns `'unknown'`, and `decideOnFire('unknown')` resumes (`holderPolicy.ts:63-69`), so a slow CLI turns "is someone holding this session" into "launch a second `claude --resume`" (the fork the rest of the design avoids).
- Fix: use async `execFile` for listings (cache the resolved launcher per settings value). Consider retrying once, or failing closed, for an unknown listing at fire time rather than launching immediately.

### I4. Windows launcher resolution may pick the extensionless npm shim (unverified here)
- Where: `src/extension.ts:582-588` (`where` output, first line), `src/resumer.ts:124-151`.
- What is wrong: `where claude` also matches the extensionless file of that name. For an npm-installed Claude Code, the npm folder holds `claude` (a sh script), `claude.cmd` and `claude.ps1`. I believe `where` lists the extensionless one first. `resolveClaudeLauncher` takes the first line, sees an empty extension, and returns `{ file: 'C:\...\npm\claude', args: [] }`, which cannot be spawned on Windows. The shim branch (`.cmd`/`.bat`/`.ps1`) is never reached. On this machine `claude` is a native `.exe`, so I could not reproduce it. The tests only feed `claude.cmd` directly (`test/resumer.test.ts:119-187`).
- Failure scenario: an npm-install Windows user gets a dead terminal on every launch, listing and mod install.
- Fix: scan all `where` lines and prefer ones with a known executable extension, ignoring extensionless ones on win32. Add a test where `which` returns the extensionless path first.

### I5. Mod install/update/offer is uncoordinated across windows and runs on every activation
- Where: `src/extension.ts:1450-1488` (`maybeOfferMod`), `src/modInstall.ts:87-103` (`copyMod`), `:177-187` (`updateMod`), `:153-175` (`installMod`).
- What is wrong: every window, on every activation, spawns `claude plugin list --json` (60 s timeout) before consulting the user's "Never" answer. After an extension update every window sees the old stored version at the same moment and each runs `rmSync(dest)`, then copy, then `plugin update` against the same `globalStorage/marketplace/mod` folder. A running Claude Code that reads the plugin folder mid-copy sees a half-written or missing mod. With the mod not installed, every window shows the "Install / Not now / Never" prompt. The repo already has a cross-window claim mechanism (`claims.ts`) used for notices, and it is not used here.
- Fix: read the stored "never" and the stored version first (skip the spawn when there is nothing to decide). Take a claim around update/install and around the offer prompt. Copy into a temp dir and rename it into place.

### I6. The mod actuator is not tested in CI
- Where: `package.json:238` (`npm test` runs `out/test/**` only), `.github/workflows/ci.yml`, `mod/hooks/register.test.ts`, README Development section.
- What is wrong: `register.mjs` is the code that submits a prompt as the user on a message from the inbox. Its tests (`register.test.ts`, run by `claude plugin test mod`) are outside `tsconfig.json`'s include and are not run by `npm test` or any workflow. Only the pure half (`control.mjs`) is covered by `test/modControl.test.ts`. A regression in origin gating, in-flight de-duplication or session-switch handling would ship green.
- Fix: run `claude plugin validate mod` and `claude plugin test mod` in CI (if the CLI is installable on runners), or test `register.mjs` with a small node stub of `$`.

## Minor

### M1. Shared `globalState` job lists are last-writer-wins across windows
`src/scheduler.ts:271-273` and `src/extension.ts:219-221` write the whole pending and ready lists under one key shared by all windows. A tick in window B (`consume`) or any cancel overwrites window A's persisted jobs, so a restart restores only the last writer's view, and a ready job parked for "Resume Now" can vanish. The README and CHANGELOG already mention it as a known limitation. Key the state per window, or merge on write.

### M2. Unhandled rejection in the in-place continue path
`src/extension.ts:1660-1682`: the `void (async () => { ... })()` has no `catch`. Anything that throws (`continueInPlace`, `coordinated`, `vscode` calls) rejects silently, the job is neither remembered nor its claim released, and no "Outcome for" line is logged, which the README promises for every fire. Wrap in try/catch that calls `rememberReady`, `releaseClaim` and `logOutcome`.

### M3. Claim stale-takeover race
`src/claims.ts:101-111`: two windows can both see the same stale file; A unlinks and creates a fresh claim, B then unlinks A's fresh file and creates its own, so both return `claimed`. Only reachable after the 1 h staleness window, but it is exactly the double-resume the module exists to stop. Rename the stale file to a unique name (atomic) rather than unlink, or re-check mtime before unlinking.

### M4. Claims directory is predictable and creatable by any local user on multi-user Linux
`src/claims.ts:37-39`: `os.tmpdir()/claude-limit-break/claims` is created with the default mode. On a shared host another local user can create the directory first and pre-plant `<sessionId>-<ms>.claim` files, so the victim's windows see `taken` and silently drop resumes. It needs the session id, so the risk is low. Create it with mode 0700 and verify ownership, or use a per-user directory.

### M5. Mod: `e.origin.kind` is unguarded
`mod/hooks/register.mjs:126`: if a delivery arrives with no `origin`, this throws on every receive. Use `e.origin?.kind`.

### M6. Mod: concurrent whole-file status writes can regress the file
`mod/hooks/register.mjs:16-20, 66-79, 94-100`: `session.measure` writes the full status on each rate-limit change and `recordContinued` writes it again, both non-atomic and not serialized. A slower older write can land after a newer one and drop a `continued` entry. The extension's last look (`continuedSince`) mostly saves this (the outcome becomes `landed-late` instead of `continued`), but the in-memory and on-disk views can disagree. Serialize writes through a promise chain.

### M7. A stale `continued` record can satisfy a new continue's confirmation
`src/continueInPlace.ts:94-97` with `mod/hooks/control.mjs:54-56`: the job id is the claim key (`<session>-<baseResumeAtMs>`). If the same key is continued again (manual Resume Now after an in-place continue of the same reset), the mod refuses it as "already continued" while `continuedJob()` is already true, so the extension reports `continued` at the first poll though nothing was sent. Record the nonce with the continued entry, or use a fresh job id per send.

### M8. Stale peer token / key file selection
`src/inbox.ts:52-66`: the first `<pid>.<hash>.key` is used. A reused pid can leave an older key file; authentication then fails silently (the inbox never replies), costing a 60 s wait before fallback. Prefer the newest by mtime.

### M9. Control and status files accumulate
`src/extension.ts:660-665` writes `~/.limit-break/control/<id>.json` per session and nothing deletes them. `removeMod` clears only `sessions/*.json`. Delete the control file after confirmation or expiry, and prune dead sessions' files on activation.

### M10. Prompt beginning with `-`
`src/resumer.ts:51-53`: `['--resume', id, prompt]`. A `resumePrompt` (or restored job) starting with `-` would be parsed as an option by the CLI. The value is machine-scoped, so it is self-inflicted, but inserting `--` before the prompt is free.

### M11. Oversize-read offset arithmetic
`src/transcriptWatcher.ts:298-323`: when `size - from > MAX_READ_BYTES`, `from` can land mid-UTF-8 sequence. The decoded replacement characters are re-encoded by `Buffer.byteLength` at a different length, so the stored offset can overshoot by a few bytes and the next line's head is lost. `handle.read`'s `bytesRead` is also ignored. Advance the offset from the Buffer (last 0x0a byte) rather than from decoded text.

### M12. `which`/`readShim` duplicated and shadowed
`src/extension.ts:582-596` defines them once; `resume()` redefines them (`:753-767`) instead of using `findLauncher`. Same logic twice invites drift (and causes an extra synchronous spawn, see I3).

### M13. Dead or odd code
`IncidentBudget` (`src/budget.ts:110-136`) is never used. `src/config.ts:65` calls `c.get` twice in a ternary for a boolean. `isInsideWorkspace` (`extension.ts:128`) and `isInScope` (`transcriptWatcher.ts:66`) are copies. `resumedSessions` and `trustStamps` maps never shrink (tiny).

### M14. Three hand-synced version strings, no test
`package.json`, `mod/.claude-plugin/plugin.json` and `MOD_VERSION` in `mod/hooks/control.mjs:6` must agree, and `claude plugin update` is likely keyed on `plugin.json`'s version. If a release forgets to bump the mod's, `updateMod` copies but the CLI may report up to date. Add a test asserting the three match.

### M15. Release workflow details
`.github/workflows/release.yml:102` runs `npx --yes @vscode/vsce package` unpinned (release-time supply chain, unlike the pinned actions). The draft is created without `--target`, so the tag lands on the default branch tip at publish time, not necessarily the commit that was tested if another merge lands in between.

### M16. Test suite shape
`test/extension.test.ts` is 6249 lines (218 tests) and leans on real wall-clock sleeps (1.4 s ticks, 1.9 s and 2.5 s graces: lines 368, 2538, 5860 and others); `test/scheduler.test.ts:106, 190` also sleep 1.2 s. That is the bulk of the ~5 minute run and a flake source on loaded CI. `activate()` in `src/extension.ts` is a roughly 1,800-line closure, which is why the tests need that much harness; extracting the fire handler and the manual-resume handlers into injectable modules would let them be tested without timers.

### M17. Update-check response unbounded
`src/updateCheck.ts:200-204` accumulates the whole body with no size cap (only a 5 s timeout). Opt-in and talking to a fixed GitHub URL, so negligible, but a byte cap is one line.

---

## Strengths

- No shell anywhere on the command path: argv arrays, `execFile`, the Windows npm shim is parsed into a `node cli.js` launch instead of going through `cmd.exe`, and `parentPidCommand` only accepts a positive safe integer.
- Trust boundaries are drawn well: machine-scoped settings for anything that names a program, a prompt or a file; `untrustedWorkspaces.supported: false`; globalState re-validated (`restoreJob`), including rejecting `--dangerously-skip-permissions` as a session id (with a test); peer names are quoted, folded and capped before entering a prompt; status-bar markdown escapes untrusted folder names and only enables the one trust command.
- Detection admission is strict: only `isApiErrorMessage === true` entries (plus the single compaction shape) can arm anything, source-code and quotation guards exist for the unflagged path, and a past, absurd or unparseable reset is rejected with a logged reason. Time-zone handling around DST gaps and overlaps is thoughtful.
- The layered fork-avoidance (claims, holder classification, busy/waiting handling, continued-since with last-entry-wins semantics, late-fire drop, native-cancel stand-down, last look before launch) is coherent, and the manual paths consistently re-check the world at click time.
- Control protocol: single-use nonce plus TTL plus job-id replay list plus in-flight set; the file is written 0700/0600; the mod consumes invalid and refused messages so they never reach the model; the README is honest about what this does and does not protect against.
- `sendToInbox` always settles, destroys on timeout, and treats ambiguous failures as possibly delivered (only ENOENT/ECONNREFUSED prove nothing was written).
- README is largely accurate against the code (checked: late-fire drop, 5-minute bridged head start, terminal never auto-forked, claim hold deadline, machine scope, Cancel semantics) and the settings table is checked against `package.json` by a test. `check-vsix.sh` and pinned action SHAs are good release hygiene.

## What I did not get to

- I did not run the test suite, the smoke harnesses (`test/smoke/*`), the integration tests, or any live Claude Code. All findings are from reading; I4 in particular needs a check on a Windows machine with an npm-installed Claude, and I1 would be best confirmed with a synthetic tree of more than 2000 transcripts.
- `test/helpers/vscode.ts` (the hand-written `vscode` fake) was not audited for fidelity; the unit suite's confidence rests on it.
- `src/panelTab.ts`, `src/reopenOffer.ts` and the UI flows in `src/sessionOpener.ts` were read only at the interface level; the private Claude Code commands they call (`claude-vscode.editor.open`, `claude-vscode.reopenClosedSession`) cannot be verified from this repo.
- I did not test the limit-notice regexes against adversarial or real-world corpora (`test/corpus` was not opened) or check them for catastrophic backtracking beyond reading them; the 400-character length cap bounds the cost.
- The mod's behaviour against the real Claude Code hook engine (event shapes such as `session.receive` origins) was not verified.
- `scripts/fork6.js`, `scripts/clb6-snap.ps1`, `scripts/changelog-section.sh` and the `test/smoke` PowerShell launchers were only skimmed.
