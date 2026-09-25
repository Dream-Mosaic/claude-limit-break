# Task 1 report: replayed limits, the grace window, and `quotaLimits.resetsAt`

Branch `fix/1.0-field-reports`, worktree `C:/Users/thegr/Dream-Mosaic/Projects/claude-limit-buster-lead`.
Commits: `9b42a35`, `2767d66`, `fd0b23d`, `dd4f6d6` (on top of `6c97fd0`).

## What was built

`TranscriptWatcher.inspectLine` (`src/transcriptWatcher.ts`) now resolves a limit
notice against the transcript entry's own `timestamp`, not the time of reading:

- A new `basis` (the entry's parsed `timestamp`, or `now` when missing/unparseable)
  is fed to `detectLimit` as the time relative expressions ("in 5 hours", "resets
  1am") are resolved against.
- The real current time (`now`) is fed separately as `detectLimit`'s new
  `opts.readAt`, which decides staleness: a resolved reset lying up to
  `RESET_GRACE_MS` (15 min, exported from `src/parsers/limitParser.ts`) in the past
  relative to `readAt` is still returned (an event due now, `resumeAt <= now`);
  further back than that, `detectLimit` returns nothing (history).
- `quotaLimits.resetsAt` (epoch seconds) is read directly off a flagged entry
  (`isRateLimitEntry`) and resolved via the new exported `resolveStructuredReset`
  (same grace/horizon rules, but only one time reference since the value is
  already absolute). It wins over the text outright - present and valid, it
  returns immediately; present but rejected (stale or beyond `maxWaitHours`), it
  returns "no limit" without ever consulting the text. Absent or non-numeric, it
  falls through to the existing text-candidate loop unchanged.
- `nextZonedOccurrence` (the clock-reset/clock-retry rollover, `limitParser.ts`
  ~line 219) is now grace-aware: a candidate up to `RESET_GRACE_MS` in the past
  relative to its own `now` is accepted rather than skipped to tomorrow. Final
  accept/reject for staleness still belongs to `detectLimit`'s `readAt` check;
  this only stops the rollover from throwing away a candidate that check might
  still want.
- Overloads have no reset time, so replay staleness is judged by entry age: a new
  `MAX_OVERLOAD_AGE_MS` (10 min, exported from `transcriptWatcher.ts`) gates the
  overload-detection block - an entry whose own timestamp is older than that
  triggers nothing.

### Ambiguity resolved: how the scheduler treats a past `resumeAt`

Checked `src/policy.ts` (`planResume`) and `src/scheduler.ts`
(`ResumeScheduler.tick`). `planResume` computes
`base = hit.detection.resumeAt?.getTime() ?? now.getTime()` and
`resumeAtMs = base + jitterMs` with no floor against "now" - a past `resumeAt`
flows straight through into a past (or barely-future, if jitter pushes it there)
`resumeAtMs`. `ResumeScheduler.tick` runs every second and fires any job where
`now >= job.resumeAtMs`, with no special-casing for a deadline that was already
past when scheduled (its own doc comment: "A deadline that already passed while
VS Code was closed is not treated specially: the next tick sees it is due and
fires it there"). So a `resumeAt <= now` returned by this task's grace window
fires within one second of being scheduled - exactly the "due now" behaviour the
brief asked for, with no changes needed in `policy.ts` or `scheduler.ts`.

## TDD evidence

### RED (baseline, before any change)

```
cd claude-limit-buster-lead && npm test > "$TEMP/t.log" 2>&1; echo "exit=$?"
```
```
exit=1
```
Exactly seven failures, matching the brief's claim:
```
✖ a limit notice whose reset passed before it was read is ignored (1.1789ms)
✖ a notice is resolved against when it was written, not when it was read (0.1613ms)
✖ an old server error replayed into a new file does not trigger a retry (0.4672ms)
✖ a reset that passed minutes ago still resumes, and resumes now (0.1616ms)
✖ the structured reset time wins over the text (0.2476ms)
✖ the structured reset time works when the text cannot be parsed at all (0.1745ms)
✖ a structured reset hours in the past is history, not an event (12.3924ms)
```
(328 tests total, 321 passing, 7 failing - confirmed via `ℹ tests`/`ℹ pass`/`ℹ fail`.)

### GREEN (after `src/transcriptWatcher.ts` + `src/parsers/limitParser.ts`, commit `9b42a35`)

```
cd claude-limit-buster-lead && npm test > "$TEMP/t1.log" 2>&1; echo "exit=$?"
```
```
exit=0
ℹ tests 328
ℹ pass 328
ℹ fail 0
```
All seven target tests pass; no regressions in the other 321.

### Additional tests (per brief: "Also add tests for...") - RED would have required temporarily reverting the implementation; instead these were designed against the finished implementation and immediately mutation-verified (see below), which is the equivalent proof that each is load-bearing:

- Both sides of `RESET_GRACE_MS` (watcher-level, via `quotaLimits.resetsAt`, with
  a few seconds of headroom to avoid raciness against the real clock; exact-
  millisecond boundaries pinned separately and deterministically in
  `resolveStructuredReset`'s and `detectLimit`'s own unit tests against a fixed
  `now`).
- Both sides of `MAX_OVERLOAD_AGE_MS` (same headroom rationale).
- A flagged entry whose `quotaLimits` has no numeric `resetsAt` (falls back to
  the text).
- A structured reset far beyond `maxWaitHours` (rejected, same as a parsed one -
  proves "Keep maxWait semantics").
- The grace-aware clock-reset rollover, pinned directly with a fixed `now`
  (America/Chicago, winter/CST to sidestep DST): 5 minutes after "resets 1am"
  still resolves to today's occurrence; 20 minutes after rolls to tomorrow's.
- `resolveStructuredReset`'s own boundary/horizon/NaN unit tests.
- An unparseable (not just missing) `entry.timestamp` falls back to `now`.
- `quotaLimits.resetsAt` is decisive: a rejected structured value does not defer
  to an independently-valid text-parsed one.

Final gate:
```
cd claude-limit-buster-lead && npm test > "$TEMP/t_final.log" 2>&1; echo "exit=$?"
```
```
exit=0
ℹ tests 343
ℹ pass 343
ℹ fail 0
```
```
cd claude-limit-buster-lead && npm run test:integration
```
```
exit=0
  claude-limit-buster activation
    ✔ the extension is present and activates
    ✔ every command the manifest declares is registered
    ✔ resuming with nothing pending opens no terminal
    ✔ cancelling with nothing pending is harmless
    ✔ the declared settings reach the configuration API with their declared defaults
    ✔ the execution-adjacent settings are machine-scoped in the running instance
  resume terminal environment
    ✔ a variable set to null in TerminalOptions.env is removed from the child process (695ms)
  9 passing (1s)
```

## Mutations and the tests that killed them

Used the provided reusable runner
(`.../scratchpad/mutate.py`), which applies one mutation, runs `npm test`,
restores the file, and reports CAUGHT/SURVIVED/DID NOT COMPILE. All 11 ran from
`claude-limit-buster-lead` as cwd; the working tree was clean (`git status`) both
before and after the run, confirming every mutant was fully restored.

| # | Guard mutated | Result |
|---|---|---|
| 1 | `nextZonedOccurrence`'s grace-aware rollover threshold reverted to strictly-future (`>= now - RESET_GRACE_MS` → `> now`) | CAUGHT by `the clock-reset rollover accepts a today occurrence still inside the grace window` |
| 2 | `detectLimit`'s grace/history rejection disabled (`if (at < readAt - RESET_GRACE_MS)` → `if (false)`) | CAUGHT by `rejects a reset time already in the past` (+2 more) |
| 3 | `detectLimit`'s `readAt` no longer distinct from `now` (`opts.readAt ?? now` → `now`) | CAUGHT by `detectLimit: RESET_GRACE_MS boundary, decided against readAt rather than the resolving basis` |
| 4 | `resolveStructuredReset`'s grace/history rejection disabled | CAUGHT by `resolveStructuredReset: RESET_GRACE_MS boundary, both sides` (+3 more) |
| 5 | `resolveStructuredReset`'s wait-horizon rejection disabled | CAUGHT by `resolveStructuredReset: wait-horizon boundary accepts an exact tie, rejects beyond it` (+1 more) |
| 6 | `resolveStructuredReset`'s non-finite guard disabled | CAUGHT by `resolveStructuredReset: a non-finite value is rejected outright` |
| 7 | `inspectLine`'s `basis` no longer falls back to the entry's own timestamp (`writtenAt ?? now` → `now`) | CAUGHT by `a limit notice whose reset passed before it was read is ignored` (+2 more) |
| 8 | `inspectLine`'s `quotaLimits` trust gate removed (`if (flagged)` → `if (true)`) | CAUGHT by `a structured reset time is only trusted on an entry Claude Code flagged` |
| 9 | `inspectLine`'s numeric-`resetsAt` guard disabled | **DID NOT COMPILE** - see note below |
| 10 | `inspectLine`'s structured-reset decisiveness removed (falls through to text on rejection instead of returning) | CAUGHT by `a structured reset hours in the past is history, not an event` (+1 more) |
| 11 | `inspectLine`'s overload age gate removed | CAUGHT by `an old server error replayed into a new file does not trigger a retry` (+1 more) |

**Note on #9**: `if (typeof resetsAt === 'number' && Number.isFinite(resetsAt))`
is both a runtime guard and the sole source of TypeScript's narrowing of
`resetsAt: unknown` to `number` for the two lines that follow. Deleting the
condition (`if (false)`) removes the narrowing along with the check, so `tsc`
itself fails (`TS2345`, `TS2322`) before any test can run - `npm test` runs
`tsc -p .` first and exits nonzero. I judged this an even stronger proof the
guard is load-bearing than a runtime test failure would be (the build cannot
even produce output without it), and did not force an artificial rewording
that would dodge the type system just to get a runtime red; I'm flagging the
substitution here rather than silently counting it as an ordinary "CAUGHT".

Two mutations were dropped from the original plan as redundant once written out
precisely: mutating `RESET_GRACE_MS`/`MAX_OVERLOAD_AGE_MS` themselves would only
re-exercise the same guards already killed above (the constants have no
independent branch of their own).

## Files changed

- `src/transcriptWatcher.ts` - `basis`/`writtenAt` resolution, the
  `quotaLimits.resetsAt` branch, `MAX_OVERLOAD_AGE_MS` and the overload-age gate.
- `src/parsers/limitParser.ts` - `RESET_GRACE_MS`, `detectLimit`'s `readAt`
  parameter and grace check, the grace-aware `nextZonedOccurrence`, and the new
  `resolveStructuredReset`.
- `test/transcriptWatcher.test.ts` - imports for `MAX_OVERLOAD_AGE_MS` and
  `RESET_GRACE_MS`; the boundary, fallback, decisiveness and unparseable-
  timestamp tests described above.
- `test/parsers/limitParser.test.ts` - imports for `RESET_GRACE_MS` and
  `resolveStructuredReset`; the `readAt`-vs-`basis` boundary test, the
  `resolveStructuredReset` unit tests, and the two rollover-grace tests.

## Concerns

- The one design call not spelled out verbatim in the brief: `quotaLimits`
  trust is gated on the existing `isRateLimitEntry` (which also trusts a bare
  `apiErrorStatus === 429`/`status === 429`), rather than literally only
  `isApiErrorMessage === true || error === 'rate_limit'` as the brief's prose
  lists. No test in the given seven or the ones I added distinguishes the two
  definitions, and reusing the existing predicate avoids a second, narrower
  duplicate of the same "is this entry trustworthy" question. Worth a second
  look if a real transcript turns up `quotaLimits` on a 429 entry that has
  neither of the other two markers.
- Mutation #9 above did not produce a runtime-red the way the constraint's
  wording expects; see the note there for why, and that it's arguably a
  stronger signal, not a weaker one.
- The two `quotaLimits`-boundary test pairs (`RESET_GRACE_MS`,
  `MAX_OVERLOAD_AGE_MS`) at the watcher/integration level use 5 seconds of
  headroom rather than the exact millisecond edge, because `resetsAt` is epoch
  *seconds* and the real clock keeps running between test setup and
  `inspectLine`'s own `Date.now()` - an exact-edge assertion there was flaky (it
  failed once during development, confirmed and fixed before the last commit).
  The exact edge is still pinned deterministically in the parser-level unit
  tests against a fixed `now`.
