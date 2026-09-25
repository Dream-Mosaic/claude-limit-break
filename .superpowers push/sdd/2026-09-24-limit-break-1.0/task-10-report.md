# Task 10 report: Cross-window claim

Branch `fix/1.0-field-reports`, worked from HEAD `417773f` (clean). Final HEAD after this task: `f492f7b`.

## What was built

### 1. `src/claims.ts` (new, pure module, filesystem injected)

A machine-wide filesystem claim so only one VS Code window launches a resume for a given usage-limit reset. Exports:

- `claimsDir()` — `path.join(os.tmpdir(), 'claude-limit-break', 'claims')`.
- `claimKeyFor(job)` — `<sessionId>-<baseResumeAtMs>` for a `limit` job (the un-jittered reset, identical across every window's own jitter roll); `<sessionId>-overload-<floor(resumeAtMs / 600_000)>` for an `overload` job (no shared deadline exists for overload, so the actual fire time is bucketed into 10-minute windows instead).
- `claimResume(dir, key, nowMs, fs, log?)` → `'claimed' | 'taken'`. Creates `<dir>/<key>.claim` atomically via `fs.openSync(path, 'wx')`, writing `<pid> <nowMs>`. An existing file younger than 1h → `'taken'`. Older → stale: unlinked and retried once; a second `'retry'` (pathological double-stale race) fails open rather than looping. Any other filesystem error (permissions, full disk, etc.) fails open (`'claimed'`) and is logged via an optional injected `Logger` (defaults to a no-op, so the brief's exact 4-arg call form `claimResume(dir, key, nowMs, fs)` still works).
- `releaseClaim(dir, key, fs, log?)` — unlinks; a missing file is a silent no-op (ENOENT), any other error is logged.
- `cleanupStaleClaims(dir, nowMs, fs, log?)` — deletes `*.claim` files older than 24h; a missing directory is a no-op.

No locking library — plain `fs` calls throughout, real `node:fs` in production, real `fs` pointed at `fs.mkdtempSync` temp directories in most tests, with a fake `fs` object only for the two error-injection tests (fail-open, pathological retry).

### 2. `src/scheduler.ts` fix: same-reset re-detection

`ResumeScheduler.schedule()`'s dedupe previously compared only `resumeAtMs` (which includes each detection's own freshly-rolled jitter), so a repeat notice for the *same* un-jittered reset that happened to re-roll a *smaller* jitter had an earlier `resumeAtMs` than the job already scheduled, slipped past the "later deadline is ignored" guard, and replaced it — the field incident that moved a window's resume from 2:27:19 to 2:20:11. The dedupe now also compares `baseResumeAtMs`: once a reset is scheduled, neither direction of re-rolled jitter can move it; only a genuinely different reset (different `baseResumeAtMs`) still replaces an earlier one, exactly as before.

### 3. `src/extension.ts` wiring (minimal, per the brief)

- On activation: `cleanupStaleClaims(claimsDir(), Date.now(), fs, log)`.
- `scheduler.onFire`: claims the job's key **before** the Task 2 holder decision. `'taken'` → drop entirely (before the `autoResume` split, so the off-autoResume path cannot become a backdoor around a lost claim), log only, no notification, no `rememberReady`. `releaseClaim` is called when the holder decision declines (`!decision.resume`) and when the automatic launch itself fails (`!resume(resumeJob)`). A successful launch keeps its claim until the 24h sweep.
- `resumeNow` command (both the counting-down branch and the ready-list branch): calls `claimResume` for its write side-effect only — the result is ignored (manual resume bypasses an existing claim, the user's explicit intent) — then releases the freshly-written claim if `resume()` itself fails.

## TDD evidence

Each of the three source changes was driven RED → GREEN:

- **claims.ts**: `test/claims.test.ts` written first; `npm run compile` failed with `TS2307: Cannot find module '../src/claims'` (RED) before `src/claims.ts` existed. All 15 (later 19) tests green after implementation.
- **scheduler.ts**: three new tests added to `test/scheduler.test.ts`; the smaller-re-roll case failed with `AssertionError: a re-detection of the same reset must be dropped, not accepted (true !== false)` (RED) against the unmodified `schedule()`. Green after the `baseResumeAtMs` comparison was added.
- **extension.ts**: six new tests added to `test/extension.test.ts` (plus two more added after mutation testing found a gap); all six failed against the unwired extension (RED — e.g. `scheduler.onFire drops a job whose claim is already taken by another window` failed because nothing dropped it). Green after wiring `claimResume`/`releaseClaim` into `onFire` and `resumeNow`.

`npm run compile && node --test out/test/<file>.test.js` was used for each focused RED/GREEN check; the full `npm test` (exit 0, 451 passing) and `npm run test:integration` (exit 0, 9 passing) were run before the final commit.

## Mutation table

Every new guard was broken with `mutate_fast.py`, confirmed to turn a named test red (or fail to compile, itself a valid catch for two guards TypeScript's own narrowing also enforces), then restored. `git diff --stat` on each mutated file showed no diff after each run, confirming the runner's restore worked.

### `src/claims.ts` (9 mutants, all caught)

| Guard | Mutation | Result |
|---|---|---|
| Stale threshold (`< STALE_MS`) | flipped to `>=` | CAUGHT — `two claimers on one key: exactly one gets claimed` |
| EEXIST branch | `!== 'EEXIST'` → `=== 'EEXIST'` | CAUGHT — `two claimers on one key: exactly one gets claimed` |
| Cleanup age check | `>= CLEANUP_MS` → `< CLEANUP_MS` | CAUGHT — `cleanupStaleClaims removes claim files older than 24h and keeps newer ones` |
| `.claim` suffix filter | inverted | CAUGHT — `cleanupStaleClaims removes claim files older than 24h and keeps newer ones` |
| Retry-exhaustion fail-open | `second === 'retry' ? 'claimed' : second` → `... ? 'taken' : second` | CAUGHT — `claimResume retries a stale claim exactly once, then fails open rather than looping` |
| First-attempt early return | `first !== 'retry'` → `first === 'retry'` | DID NOT COMPILE (TS narrows `first` to `'retry'` inside the branch, which is not assignable to the return type — a compile-time catch) |
| `releaseClaim` ENOENT check | inverted | CAUGHT — `releaseClaim on a claim that does not exist is a silent no-op` (log-emptiness assertion) |
| `claimKeyFor` limit/overload split | inverted | CAUGHT — `claimKeyFor for a limit job is sessionId-baseResumeAtMs, the un-jittered reset` |
| `claimKeyFor` overload bucket size | 600_000 → 60_000 | CAUGHT — `claimKeyFor for an overload job buckets the fire time into 10-minute windows` |

### `src/scheduler.ts` (3 mutants, all caught)

| Guard | Mutation | Result |
|---|---|---|
| `sameReset` equality | `===` → `!==` | CAUGHT — `an earlier deadline does replace a later one` |
| Same-reset earlier-jitter OR clause | dropped entirely | CAUGHT — `a re-detection of the same reset with a smaller re-rolled jitter does not move the resume earlier` |
| Same-reset direction | `<` → `<=` | CAUGHT — `an identical deadline for the same session is accepted, not ignored` |

### `src/extension.ts` wiring (8 mutants, all caught)

| Guard | Mutation | Result |
|---|---|---|
| `onFire` taken-claim check | `'taken'` → unreachable `'never'` | DID NOT COMPILE (TS flags the comparison against a value outside the `ClaimResult` union — a compile-time catch) |
| `onFire` taken-claim check | inverted (`!== 'taken'`) | CAUGHT — `with autoResume off, a fired job stays recoverable instead of vanishing` (43 failures) |
| Release on holder decline | removed | CAUGHT — `the Task 2 holder decision declining a resume releases the claim too` |
| Release on failed automatic launch | removed | CAUGHT — `a failed automatic launch releases its claim, so a later attempt is not blocked` |
| `resumeNow` counting-branch claim write | removed | CAUGHT — `resumeNow bypasses an existing claim` |
| `resumeNow` counting-branch release-on-failure | removed | CAUGHT — `a failed manual launch on the counting-down job releases the claim it just wrote` (added after first pass SURVIVED) |
| `resumeNow` ready-branch claim write | removed | CAUGHT — `resumeNow on an already-fired, remembered job also bypasses but rewrites its claim` |
| `resumeNow` ready-branch release-on-failure | removed | CAUGHT — `a failed manual launch on a ready job releases the claim it just wrote` (added after first pass SURVIVED) |

Note: the first mutation pass on the two `resumeNow` release-on-failure branches SURVIVED (no test exercised a *manual* launch failing). Two tests were added (jobs pointed at a nonexistent cwd so `resume()` fails deterministically) and the mutation re-run confirmed both are now caught.

## Files changed

- `src/claims.ts` (new)
- `test/claims.test.ts` (new)
- `src/scheduler.ts` (dedupe fix + doc comment)
- `test/scheduler.test.ts` (3 new tests + `jobWithBase` helper)
- `src/extension.ts` (import + activation cleanup call + `onFire`/`resumeNow` wiring, ~20 net lines)
- `test/extension.test.ts` (`./claims` stub block + 8 new tests in a "Task 10" section)

## Commits (5, all with the Opus 5.5 trailer)

1. `af5d44e` feat: add src/claims.ts, a filesystem claim for cross-window resume dedupe
2. `62c309e` test: strengthen claims.ts tests for mutation coverage of every guard
3. `62d857f` fix: keep the first schedule on a same-reset re-detection
4. `250bd58` feat: wire the cross-window claim into scheduler.onFire and Resume Now
5. `f492f7b` test: cover claim release on a failed MANUAL launch too

## Gate results

- `npm test` → exit 0, 451 passing, 0 failing.
- `npm run test:integration` → exit 0, 9 passing, 0 failing.

## Concerns / judgment calls made

1. **`claimResume` signature**: the brief gives `claimResume(dir, key, nowMs, fs)` and separately requires the fail-open path to be "logged." Since a 4-arg pure function can't log anywhere without an injected sink, I added a 5th, *optional*, trailing `log: Logger = noop` parameter — the brief's exact 4-arg call form still works verbatim, and production code (`extension.ts`) passes the real logger. `releaseClaim`/`cleanupStaleClaims` follow the same pattern for consistency.

2. **`fireMs` for the overload key**: the brief's formula (`floor(fireMs / 600_000)`) doesn't pin down which instant "fireMs" is. I used `job.resumeAtMs` (the deadline the scheduler's tick actually fires on) rather than a fresh `Date.now()` read at claim time, so `claimKeyFor` stays a pure function of the job alone — easier to test, and `Date.now()` at fire time is within ~1s of `resumeAtMs` anyway (the scheduler ticks every second). Two windows whose independently-rolled overload backoffs (5–30 min apart by default) land in different 10-minute buckets will *not* collide — this is an inherent limitation of bucketing with no shared deadline to key on, not something this implementation can improve on; I did not try to widen the bucket, since the brief gives the bucket size explicitly.

3. **Release-on-decline residual gap**: per the brief, `onFire` releases the claim as soon as the Task 2 holder decision declines (including the "idle terminal, autoContinue off" case that still offers a "Resume in Terminal Anyway" button). That means if the user later clicks that button, the click does **not** rewrite a fresh claim — only `resumeNow` and the off-autoResume "Resume Now" button's underlying job (whose claim from `onFire` was never released, since `decision.resume` was `true` there) are covered by an explicit re-claim write. In the narrow window between the decline and the button click, a second window could in principle also decide to auto-resume if conditions changed. I judged this an acceptable, intentionally-scoped gap: it matches the brief's literal instructions, the "Resume in Terminal Anyway" path wasn't in the brief's required test list, and closing it would mean guessing at unrequested behavior. Flagging it here rather than silently deciding it for the team.

4. **Overload key never exercised end-to-end**: `claimKeyFor`'s overload branch has direct unit coverage in `claims.test.ts`, but no `extension.test.ts` wiring test fires an overload job through `onFire` with the claim check — the existing wiring tests all use `reason: 'limit'` jobs (via `pastJob()`/`futureJob()`). The wiring itself doesn't branch on `reason` (it calls `claimKeyFor(job)` uniformly), so I judged the risk low, but it wasn't explicitly verified end-to-end.

## Fix round 1

Four items from the coordinator's review, addressed on top of `f492f7b`. Final HEAD after this round: `6ee702a`.

### 1. `src/claims.ts`: overload key now keys on `baseResumeAtMs`, not `resumeAtMs`

This directly resolves concern #2 from the original report. `resumeAtMs` includes each window's own independently-rolled jitter (`randomDelayMinMinutes`..`randomDelayMaxMinutes`, 5–30 minutes apart by default), so two windows that detected the identical overload almost always floored into *different* 10-minute buckets and both fired — the exact bug this claim exists to prevent. `baseResumeAtMs` is not a deadline for an overload job (there is none — "the jitter *is* the backoff", policy.ts); it is simply the instant `planResume` read `now` at detection time, which is near-identical across every window watching the same account (millisecond-scale apart, per the original 2026-09-24 field incident). Flooring that instead is what makes two windows actually collide.

```ts
// src/claims.ts, claimKeyFor
if (job.reason === 'overload') {
  return `${job.sessionId}-overload-${Math.floor(job.baseResumeAtMs / 600_000)}`;
}
```

**TDD**: `test/claims.test.ts`'s two overload tests were rewritten first to assert the new (correct) behaviour — one job with `baseResumeAtMs` in one bucket and `resumeAtMs` in a *different* bucket (must key on the base), and two jobs sharing `baseResumeAtMs` but with `resumeAtMs` 1.5 minutes apart (must produce the same key), plus a new test proving two DIFFERENT `baseResumeAtMs` values with the SAME `resumeAtMs` produce different keys. Verified RED by `git stash push -- src/claims.ts` (reverting only the implementation, keeping the new tests), compiling, and running `node --test out/test/claims.test.js`:

```
✖ claimKeyFor for an overload job buckets the DETECTION instant (baseResumeAtMs), not the padded fire time
✖ claimKeyFor gives two overload jobs with the same detection instant the same key, however far apart their jitter rolled
✖ claimKeyFor gives two overload jobs a different key when their detection instants land in different buckets, even with identical resumeAtMs
ℹ pass 15
ℹ fail 3
```

`git stash pop` restored the implementation fix; re-running showed all 18 claims.ts tests green (exit 0).

**Mutation check** (`mutate_fast.py` against `out/test/claims.test.js`):

| Guard | Mutation | Result |
|---|---|---|
| Overload key source | `job.baseResumeAtMs` → `job.resumeAtMs` (revert to the bug) | CAUGHT (3) — `claimKeyFor for an overload job buckets the DETECTION instant...` |

Commit: `a5534ac fix: key an overload claim on baseResumeAtMs, not the jittered resumeAtMs`.

### 2. `extension.test.ts`: an end-to-end two-window overload collision test

Every existing `onFire` wiring test drove `claimResume` through a scripted `'claimed'`/`'taken'` fake (`fakeClaimResult`), which cannot show whether the real key computation makes two windows collide — it only proves the wiring reacts correctly to a given answer. The `./claims` stub gained a third mode: `fakeClaimResult = 'real'` makes `claimResume`/`releaseClaim`/`claimsDir` delegate to the genuine `src/claims.ts` implementation against a throwaway `fs.mkdtempSync` directory (`realClaimsDir`), instead of returning the canned value. The new test:

1. Builds two `PendingJob`s sharing one `baseResumeAtMs` (`base`, "detected" 2 minutes ago) but very different `resumeAtMs` — window A: `Date.now() - 1000` (already elapsed, fires immediately); window B: `base + 25 * 60_000`.
2. Drives the REAL `claimResume` directly against `dir` for window B's key, standing in for a second VS Code window whose own `onFire` already ran and won the race first. Asserts it returns `'claimed'`.
3. Starts this window's own `activate()` with window A's job pending and already elapsed, lets the scheduler's tick fire it through the real `onFire` wiring, and asserts `vscodeFake.terminals.length === 0` — window A must find the key already taken and drop, never launching a second `claude --resume`.
4. A setup assertion pins `realClaims.claimKeyFor(jobA) === realClaims.claimKeyFor(jobB)` — both windows must compute the identical key despite the very different jitter, which is the property fix #1 establishes.

**TDD**: this test was added and confirmed green against the (already fixed) `claimKeyFor`, then confirmed as a genuine regression test by re-mutating `claimKeyFor`'s overload branch back to `resumeAtMs` (`mutate_fast.py` against `out/test/extension.test.js`):

```
overload key reverted to resumeAtMs (pre-fix) - checked against the e2e wiring test:
  CAUGHT (1): scheduler.onFire on an overload job collides across two windows sharing one claims dir, despite very different jitter
```

`git diff --stat src/claims.ts` showed no diff after the run (clean restore). Full `node --test out/test/extension.test.js` after restoring: 74 passing, 0 failing.

Commit: `6ee702a test: an end-to-end two-window collision test for the overload claim key`.

### 3. `src/extension.ts`: "Resume in Terminal Anyway" now claims like manual Resume Now

This closes concern #3 from the original report. The button (from `decideOnFire`'s `notice`, reached only when `decision.resume` is `false`) used to resume straight off `forgetReady` with no claim interaction at all — and since `onFire`'s own `!decision.resume` branch had *already* released this job's original claim moments earlier, the claim was gone by the time anyone could click the button, leaving a real gap: a second window could in principle also auto-resume in between. The click now calls `claimResume` (ignoring its result, exactly as `resumeNow` does — this is the user's own explicit action) immediately before `resume(job)`, and `releaseClaim` if that launch fails:

```ts
// src/extension.ts, inside the decision.notice handler
claimResume(claimsDir(), claimKey, Date.now(), fs, log);
if (!resume(job)) {
  rememberReady(job);
  releaseClaim(claimsDir(), claimKey, fs, log);
}
```

Also reworded the stale comment above it ("'Resume in Terminal Anyway' claims the job exactly as..." → "...takes ownership of the job (forgetReady) exactly as...") — flagged by the coordinator as ambiguous now that "claim" also means the Task 10 cross-window file claim in this file.

**TDD**: two tests added first (RED — both failed against the unmodified extension: the write-test found `claimCalls.length` unchanged after the click, the release-test found `releasedKeys` empty after a failed launch):

```
✖ "Resume in Terminal Anyway" writes a fresh claim before resuming, exactly as manual Resume Now does
✖ "Resume in Terminal Anyway" releases its own claim if the launch fails
```

Green after the wiring change (`node --test out/test/extension.test.js`: 73 passing, 0 failing, before item 2's test was added).

**Mutation check**:

| Guard | Mutation | Result |
|---|---|---|
| Claim write before resume | removed | CAUGHT (1) — `"Resume in Terminal Anyway" writes a fresh claim before resuming...` |
| Release on failed launch | removed | CAUGHT (1) — `"Resume in Terminal Anyway" releases its own claim if the launch fails` |

### 4. `src/extension.ts`: the off-autoResume "Resume Now" button now releases on a failed launch

Symmetric with every other failed-launch path (the automatic path, `resumeNow`'s two branches, and item 3's button). This path already held a claim (written by `onFire`'s top-of-function check, never released on this branch since `decideOnFire` is not even called when `autoResume` is off) — it only needed the release added, not a fresh write:

```ts
if (!resume(job)) {
  rememberReady(job);
  releaseClaim(claimsDir(), claimKey, fs, log);
}
```

**TDD**: one test added first (RED — failed because `releasedKeys` stayed empty after a failed launch), green after the one-line addition (`node --test out/test/extension.test.js`: part of the same 73-passing run as item 3).

**Mutation check**:

| Guard | Mutation | Result |
|---|---|---|
| Release on failed launch | removed | CAUGHT (1) — `the off-autoResume "Resume Now" notification button releases its claim when the launch fails` |

Items 3 and 4 committed together: `3ebe73c fix: claim symmetry for the two remaining manual-ish resume buttons`.

### Commands and final gate output (fix round 1)

```
npm test > "$TEMP/fr1-full3.log" 2>&1; echo "exit=$?"
```
→ `exit=0`, `ℹ tests 456`, `ℹ pass 456`, `ℹ fail 0`.

```
npm run test:integration > "$TEMP/fr1-integ.log" 2>&1; echo "exit=$?"
```
→ `exit=0`, `9 passing`, `Exit code:   0`.

### Fix round 1 commits (3, all with the Opus 5.5 trailer)

1. `a5534ac` fix: key an overload claim on baseResumeAtMs, not the jittered resumeAtMs
2. `3ebe73c` fix: claim symmetry for the two remaining manual-ish resume buttons
3. `6ee702a` test: an end-to-end two-window collision test for the overload claim key

### Fix round 1 concerns

- Item 4 (off-autoResume button) was scoped by the coordinator to *release only*, not a fresh claim write like items 2's button and `resumeNow`. Left as specified rather than adding an unrequested write — this path's claim (from `onFire`'s initial check) is only ever released here now, on failure, matching the instruction literally. If the user waits long enough between the notification appearing and clicking "Resume Now" that the original claim goes stale (>1h), nothing here refreshes it before the launch, unlike items 2 and `resumeNow`. Flagging in case that asymmetry wasn't intentional.
- Original concern #3 (release-on-decline residual gap) is now fully closed by item 3: the "Resume in Terminal Anyway" click writes its own fresh claim, so a second window cannot slip in between the decline and the click.
- Original concern #4 (overload key never exercised end-to-end) is now closed by item 2's test.

### Post-resume re-verification

The session hit its usage limit right after committing `a5534ac`, `3ebe73c` and `6ee702a`, before this section was appended. On resume: `git status` showed a clean working tree on `fix/1.0-field-reports` at `6ee702a` (no uncommitted changes, no unexpected commits from a parallel writer), matching the state above exactly. Both gates were re-run fresh, in the foreground, with exit codes:

```
npm test > "$TEMP/fr1-resume-full.log" 2>&1; echo "exit=$?"
```
→ `exit=0`, `ℹ tests 456`, `ℹ pass 456`, `ℹ fail 0`.

```
npm run test:integration > "$TEMP/fr1-resume-integ.log" 2>&1; echo "exit=$?"
```
→ `exit=0`, `9 passing`, `Exit code:   0`.

Identical to the pre-interruption run. This section was then completed and appended.

## Fix round 2

Three items from the re-review, addressed on top of `6ee702a`. Final HEAD after this round: `012e973`.

### 1. IMPORTANT: releasing a claim this window does not own

**The bug.** Every manual bypass path — "Resume in Terminal Anyway" (`src/extension.ts`, inside `decision.notice`'s handler), and both `resumeNow` branches (counting-down, ready-list) — correctly ignores `claimResume`'s return value to decide *whether to launch* (that is the bypass: the user's explicit intent overrides another window's claim). Round 1 also called `releaseClaim` unconditionally on a failed launch, regardless of what that same call's `claimResume` had just reported. If it reported `'taken'` — meaning another window genuinely holds this exact key right now — the unconditional release deleted **that other window's live claim**, on the one code path most likely to run concurrently with a second window's own attempt. This defeated Task 10's whole purpose on its most exposed path.

**The fix**, applied identically at all three sites: capture the `claimResume` result, and release only when this call actually won the claim itself (`'claimed'`, which also covers a stale takeover it just performed):

```ts
// src/extension.ts - "Resume in Terminal Anyway" (inside decision.notice's handler)
const buttonClaim = claimResume(claimsDir(), claimKey, Date.now(), fs, log);
if (!resume(job)) {
  rememberReady(job);
  if (buttonClaim === 'claimed') {
    releaseClaim(claimsDir(), claimKey, fs, log);
  }
}
```

```ts
// src/extension.ts - resumeNow, counting-down branch
const countingClaim = claimResume(claimsDir(), key, Date.now(), fs, log);
if (resume(counting)) {
  scheduler.cancel(counting.sessionId);
} else if (countingClaim === 'claimed') {
  releaseClaim(claimsDir(), key, fs, log);
}
```

```ts
// src/extension.ts - resumeNow, ready-list branch
const readyClaim = claimResume(claimsDir(), key, Date.now(), fs, log);
if (resume(ready)) {
  forgetReady(ready.sessionId);
} else if (readyClaim === 'claimed') {
  releaseClaim(claimsDir(), key, fs, log);
}
```

Note the off-autoResume "Resume Now" button (the fix round 1 item 4 path) needed **no change** here: it never calls `claimResume` at all — it only releases the claim `onFire`'s own top-of-function check already wrote for *this* window, so an unconditional release there was always correct (there is nothing to "not own").

**TDD.** `test/extension.test.ts`'s `./claims` stub gained a `claimResultQueue: ('claimed' | 'taken')[]`, popped in order by successive `claimResume` calls before falling back to the existing single-answer `fakeClaimResult` — needed because two of the three sites require the job's *first* claim (at `onFire` fire time) to succeed (so the job actually reaches a manual button/list) while that *same site's own later call* reports `'taken'` (simulating a second window having taken it in between). Three new tests were added first and confirmed RED against the unfixed code (all three failed because `releasedKeys` was non-empty when it should have stayed empty):

```
✖ "Resume in Terminal Anyway" does not release a claim it does not own (its own bypassed call reported "taken")
✖ resumeNow (counting-down branch) does not release a claim it does not own (its own bypassed call reported "taken")
✖ resumeNow (ready-list branch) does not release a claim it does not own (its own bypassed call reported "taken")
ℹ pass 74
ℹ fail 3
```

Green after the fix (`node --test out/test/extension.test.js`): 77 passing, 0 failing. The three existing round-1 "claimed → release" tests (`"Resume in Terminal Anyway" releases its own claim if the launch fails`, `a failed manual launch on the counting-down job releases the claim it just wrote`, `a failed manual launch on a ready job releases the claim it just wrote`) remained green throughout, unchanged — they still exercise the `'claimed'` side of the new guard.

**Mutation check** (`mutate_fast.py` against `out/test/extension.test.js`, each guard's `=== 'claimed'` inverted to `!== 'claimed'`):

| Guard | Mutation | Result |
|---|---|---|
| "Resume in Terminal Anyway" ownership check | `buttonClaim === 'claimed'` → `!==` | CAUGHT (2) — both the round-1 "releases... if the launch fails" test and the new "does not release a claim it does not own" test |
| `resumeNow` counting-branch ownership check | `countingClaim === 'claimed'` → `!==` | CAUGHT (2) — same pair, counting-branch versions |
| `resumeNow` ready-branch ownership check | `readyClaim === 'claimed'` → `!==` | CAUGHT (2) — same pair, ready-branch versions |

`git diff --stat src/extension.ts` after the run showed only the intended (round 1 + round 2) diff versus `6ee702a` — clean restore.

### 2. MINOR: stale "claims" wording in the off-autoResume "Resume Now" branch

The comments at (then) ~819-826 and ~833-835 said "this click claims it" / "the claim must be undone", meaning `forgetReady`'s ownership of the job in the `readyJobs` list — not the Task 10 cross-window file claim, which this branch never touches directly (see above). Reworded to "takes ownership of it (forgetReady)" and "that ownership must be undone (rememberReady)", matching the wording already used in the sibling "Resume in Terminal Anyway" branch since round 1, plus an explicit note that the claim released in the failed-launch case is always this window's own (from `onFire`'s top-of-function check), since this branch never calls `claimResume` itself.

### 3. MINOR: the e2e overload test's temp directory was never removed

`scheduler.onFire on an overload job collides across two windows sharing one claims dir...` (round 1, item 2) creates a real directory via `fs.mkdtempSync` and writes a real claim file into it (`fakeClaimResult = 'real'`), unlike every other test in the file. Added `fs.rmSync(dir, { recursive: true, force: true })` in the test's `finally` block, alongside the existing `teardown(ctx)`.

### Commands and final gate output (fix round 2)

```
npm test > "$TEMP/fr2-full.log" 2>&1; echo "exit=$?"
```
→ `exit=0`, `ℹ tests 459`, `ℹ pass 459`, `ℹ fail 0`.

```
npm run test:integration > "$TEMP/fr2-integ.log" 2>&1; echo "exit=$?"
```
→ `exit=0`, `9 passing`, `Exit code:   0`.

### Fix round 2 commit

`012e973 fix: never release a cross-window claim this window does not own` (all three items — the important fix, both comment rewords, and the temp-dir cleanup — landed together, since items 2 and 3 were small edits to files already being touched for item 1).

### Fix round 2 concerns

None new. Item 1 closes the most significant residual risk in the whole feature — round 1's claim-symmetry work had made every failed-launch path release *something*, but never checked that the something was its own, which is precisely the scenario Task 10 exists to protect (two windows racing over one resume). Verified with both a scripted unit-level test per site and confirmed the existing "claimed → release" tests keep the other half of each guard honest.

## Fix round 3

The last item from the sweep, addressed on top of `012e973`. Final HEAD after this round: `6f334ae`.

### The remaining site of the same bug class

Round 2 fixed "releasing a claim you don't own" on three of the four manual bypass paths — "Resume in Terminal Anyway", and both `resumeNow` branches — but deliberately left the off-autoResume "Resume Now" notification button as release-only, reasoning (in a comment written in round 1 and left unchanged through round 2) that since this button never calls `claimResume` itself, whatever it releases on a failed launch must always be this window's own claim from `onFire`'s top-of-function check.

That reasoning had a gap: `autoResume` being off means this specific notification can sit unanswered indefinitely — nothing else resumes the session in the meantime. If the original claim (written when the job fired) goes stale (>1h, `STALE_MS` in `src/claims.ts`) before the click, and another window takes over that same key in between, the unconditional `releaseClaim` at click time deleted *that other window's* live claim — the exact bug round 2 fixed everywhere else, missed on this one site because it looked structurally different (no bypass write existed yet).

**The fix**, matching the other three sites exactly: the click now calls `claimResume` itself (the bypass — launch proceeds regardless of the result, same as every other manual path), captures the result, and releases only when it actually won the claim (`'claimed'`, including a stale takeover it just performed):

```ts
// src/extension.ts - the off-autoResume "Resume Now" notification's click handler
const notifyClaim = claimResume(claimsDir(), claimKey, Date.now(), fs, log);
if (!resume(job)) {
  rememberReady(job);
  if (notifyClaim === 'claimed') {
    releaseClaim(claimsDir(), claimKey, fs, log);
  }
}
```

(Named `notifyClaim`, not `buttonClaim` like the "Resume in Terminal Anyway" branch's equivalent variable, to avoid implying they share scope — they are two separate closures.)

This also closes the asymmetry flagged as a concern back in the original report: all four manual-ish resume triggers (`resumeNow`'s two branches, "Resume in Terminal Anyway", and this notification button) now uniformly write/refresh their own claim at click time and release only what they themselves won.

**TDD.** One new test added first, confirmed RED against the unfixed code (`releasedKeys` was non-empty when it should have stayed empty, because the click still released unconditionally):

```
✖ the off-autoResume "Resume Now" notification button does not release a claim it does not own (its own bypassed call reported "taken")
ℹ pass 77
ℹ fail 1
```

The existing round-1 "claimed → release" test for this button was adjusted (not just kept unchanged) per the coordinator's instruction: renamed to `writes/refreshes its own claim and releases it when the launch fails`, its stale comment (which said the release was "always" of this window's own claim - no longer literally true now that this branch writes its own claim too) was corrected, and it now also asserts `claimCalls.length` increased across the click, matching the assertion style already used for "Resume in Terminal Anyway"'s equivalent test. Green after the fix (`node --test out/test/extension.test.js`): 78 passing, 0 failing.

**Mutation check** (`mutate_fast.py` against `out/test/extension.test.js`):

| Guard | Mutation | Result |
|---|---|---|
| Ownership check | `notifyClaim === 'claimed'` → `!==` | CAUGHT (2) — the adjusted "claimed" test and the new "taken" test |
| The claim write itself | `claimResume(...)` call replaced with a hardcoded `'claimed'` | CAUGHT (2) — same pair (the `claimCalls.length` assertion in the adjusted test, and the new test finding a stale write never happened to be overridden) |
| The whole guard | reverted to the round-1/round-2 unconditional `releaseClaim(...)` | CAUGHT (1) — the new "taken" test |

`git diff --stat src/extension.ts` after each run showed only the intended diff versus `012e973` — clean restore.

### Commands and final gate output (fix round 3)

```
npm test > "$TEMP/fr3-full.log" 2>&1; echo "exit=$?"
```
→ `exit=0`, `ℹ tests 460`, `ℹ pass 460`, `ℹ fail 0`.

```
npm run test:integration > "$TEMP/fr3-integ.log" 2>&1; echo "exit=$?"
```
→ `exit=0`, `9 passing`, `Exit code:   0`.

### Fix round 3 commit

`6f334ae fix: the off-autoResume "Resume Now" button no longer releases another window's claim`

### Fix round 3 concerns

None. All four manual bypass paths now follow one uniform pattern (write/refresh own claim, bypass the answer to decide whether to launch, release only on 'claimed'), and the sweep that found this was explicitly checking for the same bug class round 2 fixed - no reason to expect a fifth site.
