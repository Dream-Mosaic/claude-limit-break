# Final review fix wave — report

Base 61b0103 (resumed on top of ad2e50f after the usage-limit interruption; nothing from the
first attempt survived, all work below was redone from scratch). Branch
`claude/limit-break-1.0-cloud`, not pushed.

## Commits

| SHA | Subject |
|---|---|
| 09bb883 | fix(holderPolicy): native auto-continue covers limits only (final review C1) |
| da1d781 | fix(overloadParser): unflagged overloads need an API Error line (final review I4) |
| 93bcbba | fix(claims): key overload claims on the detection entry, record the window (final review I3) |
| 6698f29 | fix(extension): keep the claim when the holder policy declines (final review I2) |
| 3840e7f | fix(extension): Cancel claims each cancelled job for every window (final review I7) |
| 6c90e99 | fix(extension): check that native auto-continue really continued (final review I6) |
| ae7cf6d | feat(extension): warn when Claude Limit Buster is still installed (final review I5) |
| c3d5141 | fix(holderPolicy): quote, one-line and cap peer names in the resume prompt (final review minor) |
| 0364745 | fix(statusBar): the gave-up reminder lists every way it clears (final review minor) |
| b7be066 | docs: changelog, README and NEXT for the final review fix wave |
| 230fc67 | docs(extension): Cancel's comment points at the shared-globalState limitation |

## Per item

### C1 — overload in an idle terminal silently dropped — DONE
- `decideOnFire(holder, autoContinueOn, shortId, reason)` (new required 4th param). For an idle
  terminal and `reason === 'overload'` it returns remember + "Resume in Terminal Anyway" with an
  overload-worded notice/log ("stopped by a server error ... Continue it there"), regardless of
  auto-continue. `onFire` passes `job.reason`.
- Files: src/holderPolicy.ts, src/extension.ts; tests test/holderPolicy.test.ts (3 new, existing
  calls given `'limit'`), test/extension.test.ts (overload job + idle terminal + auto-continue on →
  offer shown, remembered, no "pick it back up" log).
- RED: holderPolicy C1 test failed with the param added but unused (1 fail / 29 pass).
- Mutations: overload branch never taken → CAUGHT (unit + extension); onFire passes `'limit'` →
  CAUGHT. (A first `if (false)` form did not compile - unused param - replaced.)

### I4 — unflagged prose arms an overload — DONE
- `detectOverload(rawText, { anchored })`: when anchored every rule must match on a physical line
  starting with "API Error" (`matchApiErrorLine`, which now returns the match so the status group
  comes from that line). `LINE_HEAD_RE` widened to `api error\s*[:(]` (colon or parens form; `\s*`
  because the real parens render is "API Error (529 ..."). The watcher passes `anchored: !flagged`
  (`flagged` = isRateLimitEntry, the same flag every other untrusted-text veto uses). Flagged
  entries unchanged (full recall; the two Task 4a lineAnchored rules stay anchored on both paths as
  before).
- Files: src/parsers/overloadParser.ts, src/transcriptWatcher.ts; tests: parser (4 brief strings as
  anchored negatives, each still positive unanchored; 8 real renders - one per rule, two for
  api-error-status - positive flagged, anchored at start, and anchored behind "⏺" on a later line;
  status from the line; parens in-flight still excluded), watcher (4 strings via inspectLine
  unflagged → none; unflagged line-start render → timeout; flagged bare "Request timed out." →
  timeout).
- RED: 8 fails (4 parser, 4 watcher) with the option accepted but ignored.
- Mutations (5): watcher never anchors, watcher anchors flagged too, parser ignores anchored,
  LINE_HEAD_RE colon-only, line-head check dropped → all CAUGHT.

### I3 — repeat overload collides with this window's own claim — DONE
- Threading: `OverloadHit.entryTimestampMs` (the entry's parsed `timestamp`, same `writtenAt` Task 1
  uses) → `planResume` hit → `PendingJob.entryTimestampMs` (optional, only set when present).
  `claimKeyFor` for overload: `<sid>-overload-<entryTimestampMs>`; falls back to the old 10-min
  bucket of `baseResumeAtMs` when absent (older persisted job / entry with no timestamp). Limit keys
  unchanged.
- Window identity: `claimResume(..., owner?)` writes `"<pid> <ms> <owner>"` (prefix format kept);
  new `claimOwner(dir, key, fs)` reads it (undefined for missing/legacy). extension.ts has one
  `claim(key)` helper passing `vscode.env.sessionId`, used by every claim site. A 'taken' at fire
  logs "already claimed by this window" vs "claimed by another window" (log only; still dropped).
- Files: src/claims.ts, src/transcriptWatcher.ts, src/policy.ts, src/scheduler.ts, src/extension.ts;
  test/helpers/vscode.ts (`env.sessionId`, `vscodeFake.envSessionId`), test stub forwards `owner`,
  `FakeWatcher.overloadFor`.
- Tests: claims (entry-timestamp key; two events same bucket both claimed; same event two windows
  with different base/jitter collides; limit key ignores it; owner written/read; legacy → undefined),
  policy (carried / absent), watcher (hit carries it / absent), extension (two distinct overloads in
  10 min both resume end-to-end with real claims; claim records window id; self-collision log;
  other-window log).
- RED: extension owner/self-collision tests failed (2/4) before the wiring; the claims tests were
  written against a not-yet-existing API (compile-red), so mutations are the evidence there.
- Mutations (7): key ignores timestamp, owner not written, owner parse off by one, hit drops
  timestamp, job drops timestamp, self-collision comparison inverted, claim helper drops owner →
  all CAUGHT.

### I2 — claim released on a declining decision — DONE
- `if (!decision.resume) return;` no longer releases. Kept for remember/notify, busy/waiting drop,
  and the native stand-down. Comments on the "Resume in Terminal Anyway" path and
  `releaseClaim`'s doc updated.
- Tests: the old "declining releases the claim too" test replaced by (a) busy holder drop keeps the
  claim (releasedKeys empty); (b) real-claims two-window scenario: window A offers, claim file still
  exists, window B (different envSessionId) fires the same job → "claimed by another window", no
  second offer, no terminal.
- RED: both failed before the change. Mutation (re-adding the release) → CAUGHT by both.
- Invariants kept: manual paths still release only a claim they took; a failed automatic LAUNCH
  still releases its own claim (that code path is untouched).

### I7 — Cancel cancels in one window only — DONE
- Cancel (command; the menu runs the command) claims every cancelled job - counting-down and ready -
  with new `holdClaim(dir, key, now, untilMs, fs, log, owner)`, which claims and then sets the claim
  file's mtime to `untilMs` (the job's own `resumeAtMs`). Reason: staleness is mtime-based with a 1h
  life, a limit can count down for hours, so a plain claim written at cancel time would be stale by
  the time another window fires. Another window's copy fires within its jitter (≤30 min default) of
  that deadline, well inside the hour. A 'taken' claim is left untouched (its life is not
  extended); a utimes failure is logged and the claim still stands.
- Tests: claims (held fresh past the deadline + 30 min, ages out by +2h, past deadline = ordinary,
  someone else's claim left alone and not extended, utimes failure logged); extension (real claims:
  cancel claims both jobs with untilMs = resumeAtMs and owner, then a second window firing the same
  reset drops it; menu Cancel claims; nothing waiting → nothing claimed). `holdClaim` is stubbed in
  extension.test so no test writes the real claims dir.
- RED: 2 extension tests failed before wiring. Mutations (6): no claims, hold until now, ready jobs
  skipped, no mtime extension, past deadline set, taken claim extended (initially SURVIVED → test
  strengthened with an "other window's claim ages out normally" assertion → CAUGHT). All CAUGHT.

### I6 — native auto-continue unverified — DONE
- `decideOnFire` sets `awaitNativeContinue: true` only in the limit / idle terminal / auto-continue
  on stand-down (log now "should pick it back up ... Checking that it did."). onFire then arms
  `armNativeContinueCheck`: after `GRACE_MS`, `stallVerdict` on the transcript; grew → log only;
  otherwise warn log + `rememberReady(job)` + notice "Limit Break: Claude Code did not continue
  <short> on its own. Resume it here?" with "Resume Now".
- Baseline choice (a judgement call inside the ruling): growth is measured from the transcript size
  at DETECTION (`PendingJob.transcriptBytesAtDetection`, set by planResume from
  `resolveSession(...).bytes` when > 0), falling back to the size at fire for older jobs. Measuring
  from the fire would misfire in the common case: the fire is padded 5-30 min past the reset
  (randomDelay defaults), so a working native auto-continue has usually already written and
  finished before this window fires.
- The "Resume Now" button reuses the off-autoResume handler, extracted into `offerResumeNow(job,
  claimKey, message)` (same confirmManualResume modal - an idle terminal holds the session, so the
  fork warning shows - same forgetReady ownership, same claim-only-if-claimed release). Claims:
  kept throughout (I2). Cancel clears pending native checks (new `nativeChecks` set, also cleared
  on dispose).
- Tests: holderPolicy flag matrix; policy baseline recorded / left off when unreadable; extension:
  not grown → notice (exact text, one button) → click → modal → Resume Anyway → terminal; job
  persisted to ready only after the grace; grown since detection → nothing offered, log says so;
  no baseline + growth during grace → nothing; no baseline + no growth → offered; claim never
  released; Cancel during grace → no notice. Timing uses a poll for the stand-down log line rather
  than a fixed sleep (first draft raced the 1s tick).
- RED: 2 unit + 5 extension fails before implementation. Mutations (7): no flag, check never armed,
  baseline at fire only, verdict inverted, not remembered, Cancel keeps checks, zero bytes recorded →
  all CAUGHT.

### I5 — Claude Limit Buster still installed — DONE
- On activation, `vscode.extensions.getExtension('dream-mosaic.claude-limit-buster')` → log.warn +
  one warning naming the double-resume / no-holder-check risk, button "Uninstall Claude Limit
  Buster" → `workbench.extensions.uninstallExtension` with that id (errors logged).
- Fake: `vscode.extensions.getExtension` driven by `vscodeFake.installedExtensions`.
- Tests: present → exactly one warning, prefixed, names the risk, one button; click uninstalls
  exactly that id; dismiss uninstalls nothing; absent → no warning. RED: 3 fails.
- Mutations (4): never warns, always warns, uninstall on dismiss, wrong id → all CAUGHT (two
  re-run in compile-safe form).

### Minors — DONE
- Peer names: new exported `peerLabel` (CR/LF → space, `"` → `'`, cap 64, quoted; pid fallback bare),
  used by `buildResumePrompt` and the busy-folder notice/log in extension.ts. Tests updated/added;
  5 mutations CAUGHT.
- Tooltip gave-up footer: "This clears on a new detection for the session, when the session
  finishes a turn or is resumed, or with "Dismiss gave-up notices" or "Cancel Pending Resume" from
  the menu." Test RED then GREEN; mutation (old text) CAUGHT.
- CHANGELOG / README: see Docs.

## Docs
- CHANGELOG.md (1.0.0): Added - holder bullet now says the idle-terminal deferral is for limits
  only, overloads always get the offer, peer names quoted/capped; new bullet for the native
  auto-continue check; claim bullet gains keep-on-decline, per-failure overload claims, Cancel
  propagation, manual bypass; new bullet for the old-extension warning; gave-up bullet lists every
  way it clears; overload bullet rewritten (in-flight retry is recognised and LEFT ALONE, not
  treated as an overload). Fixed - garbled untrusted-text sentence rewritten; new bullet for I4.
- README.md: auto-continue covers limits only; holder table rows for the native check and for
  overloads; claims paragraph (kept on decline, Cancel claims, manual bypass); tooltip link quoted
  as "Trust this folder" (notification button "Open Claude to Trust"); gave-up clearing; "ready"
  pill covers idle-terminal offers; Install notes the startup warning.
- docs/NEXT.md: removed the api-error-status mid-sentence item (fixed by I4); added the
  shared-globalState-across-windows limitation and the ruled costs of I2/I7 claims; final review
  minors (reason-specific default prompt, execFileSync 10s, budget-dismiss gave-up while counting,
  Resume Now "nothing pending" vs gave-up, UUID subagent fixtures, real-timer tests, duplicated
  which/readShim, readmeSettings padded rows, I6 baseline edge); open question on a flagged
  in-flight 429 carrying quotaLimits. (The README tooltip-quote deferred item is fixed; the Task 4b
  package.json statusBar description was already fixed in 9b.)

## Verification
- Unit: `npm test` exit=0, 675/675 (baseline was 610).
- Integration: `xvfb-run -a npm run test:integration` exit=0, 9 passing.
- check-vsix: `npx @vscode/vsce package --out limit-break.vsix` then
  `bash scripts/check-vsix.sh limit-break.vsix` exit=0 ("The .vsix contents are correct."); the
  .vsix was deleted afterwards.

## Self-review
- Read the whole src diff. Settled invariants: manual bypass paths still release only a claim they
  took (all four go through `claim()` and the unchanged `=== 'claimed'` release guard, and the
  extracted `offerResumeNow` keeps it); a failed automatic launch still releases its own claim;
  flagged entries still exempt from every untrusted-text veto (I4 anchors only `!flagged`);
  warn-once untouched; `--resume` still only gets resolved session ids; nothing writes
  ~/.claude.json or answers trust; nothing is sent into a session this extension did not create
  (the uninstall is VS Code's own command on an explicit click).
- `vscode.env.sessionId` contains no spaces, so the `"<pid> <ms> <owner>"` format parses; an older
  claim file reads as no owner.
- The C1 overload notice says "server error" also for a transient 429 / sleep interruption - close
  enough for a notice, noted.

## Concerns
1. I6 baseline: measured from detection, not from the fire (reasoning above). Anything written
   between detection and the check (e.g. the user typing in the terminal during the wait) reads as
   "continued" and the check stays silent - the old behaviour, not a false alarm. In NEXT.md.
2. I7 uses the claim file's mtime as "valid until" (set into the future). Deliberate and
   documented in `holdClaim`; the 24h sweep still collects it. Cost of the ruling (NEXT.md): the same
   reset re-detected in the cancelling window is dropped as "already claimed by this window" until
   the hold lapses.
3. I2 cost, as ruled: after a failed launch from "Resume in Terminal Anyway" the fire's own claim
   stays (the button only releases a claim it took, and its own claim call was 'taken' by the fire's
   claim). The job is re-remembered and manual paths bypass claims, so nothing is lost.
4. "Flagged" for I4 is `isRateLimitEntry` (isApiErrorMessage / rate_limit / 429), the flag every
   other veto uses - an entry that is only `apiError` (e.g. a 5xx status field or a non-empty
   `error` like "tool execution failed") without isApiErrorMessage now needs the "API Error" line
   head. Claude Code's own error entries carry isApiErrorMessage.
