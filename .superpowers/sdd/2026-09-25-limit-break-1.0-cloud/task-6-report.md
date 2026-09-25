# Task 6 report: Default resume prompt

## What I implemented

Changed the default `resumePrompt` to exactly:

`[Limit Break] I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.`

in both places the brief names:
- `src/config.ts` (`readSettings`): both the `c.get('resumePrompt', ...)` fallback and the outer `str(..., fallback)` fallback.
- `package.json` (`contributes.configuration.properties["claudeLimitBuster.resumePrompt"].default`).

`src/holderPolicy.ts`'s `buildResumePrompt` was not touched, as instructed — it takes the resolved prompt as a parameter and is default-agnostic.

### Files changed
- `src/config.ts` — the two fallback literals.
- `package.json` — the manifest default.
- `test/policy.test.ts` — the assertion pinning `p.job.prompt` for the default-settings case.
- `test/extension.test.ts` — the `PROMPT` fixture constant, which is used both as an injected fixture value (`pastJob()`) and, in several tests that drive `activate()`/`start()` through a config with no `resumePrompt` override, as the expected value of the *real* default flowing out of `readSettings`. Changing only `src/config.ts` left 4 of those live-default tests red (see Mutation/verification below); updating the single constant fixed all of them consistently.
- `test/integration/extension.itest.ts` — the defaults test asserting `config.get('resumePrompt')` (brief says update it; cannot run here — see Integration section).
- `test/config.test.ts` — added one new test, `'a non-string resumePrompt falls back to the default prompt'`, mirroring the existing `claudeCommand` non-string test. This closes a coverage gap the mutation runner found: no existing test forced `c.get()` to hand back a non-string for `resumePrompt`, so the outer `str()` fallback argument was never exercised by anything that would notice if it drifted from the `c.get()` fallback.

Not changed (deliberately, in scope-review):
- `README.md`'s settings table — brief explicitly defers this to Task 9.
- `test/holderPolicy.test.ts` — its three uses of `'Continue where you left off.'` / `'Continue.'` are arbitrary literal arguments passed directly to `buildResumePrompt(userPrompt, busyPeers)` to test that function's generic pass-through/append behavior; they do not read or pin `src/config.ts`'s default, and `buildResumePrompt` was not to be changed. Left as-is under YAGNI — changing them would be cosmetic churn outside the brief.

## Tests and results

### TDD — RED
Updated `test/policy.test.ts`'s default-prompt assertion to the new string first, then ran the suite before touching any implementation:

```
npm test > /tmp/t6_red.log 2>&1; echo "exit=$?"
```
exit=1, with exactly one failure, for the expected reason (implementation still returns the old string):
```
not ok 280 - a limit hit schedules a job for the stated time plus jitter
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    + 'Continue where you left off.'
    - '[Limit Break] I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.'
# pass 481
# fail 1
```

### GREEN (implementation)
Updated `src/config.ts` and `package.json`, then also updated `test/integration/extension.itest.ts` and the `PROMPT` fixture in `test/extension.test.ts` (its use as the expected live-default value meant 4 more tests went red until the constant was updated — this was not a separate RED cycle I staged deliberately, but the immediate next `npm test` run surfaced it, which is the same "make it fail for the expected reason, then fix" loop). Command:

```
npm test > /tmp/t6.log 2>&1; echo "exit=$?"
```
First pass after only touching `src/config.ts`/`package.json`/`policy.test.ts`/`itest.ts`: exit=1, 4 failures (`extension.test.ts`'s `PROMPT`-based assertions comparing against the live config default). After updating the `PROMPT` constant:

```
npm test > /tmp/t6b.log 2>&1; echo "exit=$?"
```
```
# tests 482
# pass 482
# fail 0
exit=0
```

### Coverage gap found by mutation testing, closed
Added `test/config.test.ts`'s new non-string-resumePrompt test, recompiled, reran full suite:
```
npm test > /tmp/t6_final.log 2>&1; echo "exit=$?"
# tests 483
# pass 483
# fail 0
exit=0
```

### Final full-suite run (post-commit, against merge-base diff)
```
npm test > /tmp/t6_final2.log 2>&1; echo "exit=$?"
# pass 483
# fail 0
exit=0
```
`npm run compile` also run clean at every stage (last: exit=0, no tsc errors).

## Mutation table

Runner: `.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/mutate.py`, spec built from the two `resumePrompt` fallback literals in `src/config.ts`.

| Mutation | Result | Named red test |
|---|---|---|
| `c.get('resumePrompt', ...)` fallback reverted to `'Continue where you left off.'` | CAUGHT | `a limit hit schedules a job for the stated time plus jitter` (test/policy.test.ts) |
| Outer `str(..., fallback)` fallback reverted to `'Continue where you left off.'` — first attempt | SURVIVED | *(none — gap)* |
| Same mutation, after adding the non-string-resumePrompt test | CAUGHT | `a non-string resumePrompt falls back to the default prompt` (test/config.test.ts) |

The first run showed the outer `str()` fallback (used only when `ConfigSource.get()` hands back a non-string, e.g. a malformed `settings.json`) had no test forcing that path for `resumePrompt`, unlike the existing `claudeCommand` non-string test. Added the missing test (mirroring the `claudeCommand` one), reran the mutation, now CAUGHT. Both mutations CAUGHT on the final run:
```
python3 .superpowers/sdd/2026-09-25-limit-break-1.0-cloud/mutate.py <spec>
CAUGHT  resumePrompt c.get() fallback reverted to old default string
    red: a limit hit schedules a job for the stated time plus jitter
CAUGHT  resumePrompt str() outer fallback reverted to old default string
    red: a non-string resumePrompt falls back to the default prompt
exit=0
```

## Integration tests changed / affected (pending a run elsewhere)

- `test/integration/extension.itest.ts`, `'the declared settings reach the configuration API with their declared defaults'` — updated its `resumePrompt` assertion to the new default string. This is the only integration test this task touches. Not run here per constraint 6 (network policy blocks the VS Code download); needs a run on the user's machine or in CI before merge.

## Self-review findings

- Grepped `src/`, `test/`, `package.json`, and `docs/` for the old string `'Continue where you left off.'` after the change; every remaining hit is either the (unchanged-by-design) `README.md` table (Task 9's job) or the plan document under `docs/superpowers/plans/` (historical record, not live code).
- Confirmed `buildResumePrompt` in `src/holderPolicy.ts` was not touched and its tests (`test/holderPolicy.test.ts`) still pass — they exercise the function generically with arbitrary prompt strings, independent of the config default.
- Confirmed constraint 10 (strings still say "Claude Limit Buster" until Task 8) is respected: the only user-facing string changed is the resumePrompt text, which the brief calls out as the deliberate exception.
- Confirmed LF line endings preserved on every edited `src/*.ts`/`test/*.ts` file (`git ls-files --eol`).
- No other places in `src/` reference `resumePrompt`'s literal default value (only `src/policy.ts:48` reads `settings.resumePrompt`, which is settings-driven, not a hardcoded literal).
- Full diff against merge-base `3fef8ce` is exactly the 6 files listed above (plus the pre-existing, not-mine `progress.md` ledger commit already on the branch before I started).

## Concerns

None. This was mechanical as scoped. The one wrinkle worth flagging to the controller: `test/extension.test.ts`'s `PROMPT` constant is used in two different roles (an injected fixture value in some tests, and an implicit expectation of the *actual* config default in others that drive `activate()` end-to-end with no `resumePrompt` override) — I updated the single constant, which fixed both, but it's worth knowing that constant is now load-bearing for the real default, not just a fixture, should a future task change the default again.
