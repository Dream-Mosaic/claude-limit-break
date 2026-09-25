# Task 4a report: overload detection gaps and the DST commit

## What was implemented

### 1. Review of `bbff534` (DST fall-back fix, Windows lane)

Read the commit in full (`git show bbff534`). The fall-back handling
(`zonedWallClockToInstant` in `src/parsers/limitParser.ts`) is correct: it
detects the repeated wall-clock hour by checking whether stepping the
candidate forward one hour still reads the same local time, and if so takes
the later instant. Its own test pins America/Chicago 2026-11-01 01:30 to the
LATER instant, `2026-11-01T07:30:00.000Z` (CST), exactly as the brief
requires.

No spring-forward case existed. I added one and, by direct execution against
the unmodified code, found it resolves a **skipped** wall-clock reading
(America/Chicago 2026-03-08 02:30, which never occurs because the clock jumps
01:59:59 → 03:00:00) to `2026-03-08T07:30:00.000Z` — which reads back as
**01:30 CST**, an hour **earlier** than the literal (nonexistent) reading
asked for. That is the unsafe direction by bbff534's own stated reasoning
("late is safe, early is not"): waking early risks resuming into a session
that has not actually reset. Per the brief's "change the implementation only
if a test shows it is wrong," I fixed it: `zonedWallClockToInstant` now
detects a resolved candidate whose own wall-clock reading does not match the
requested hour:minute (proof the reading fell in a skipped hour) and steps
forward one hour onto the safe side of the gap — `2026-03-08T08:30:00.000Z`
(03:30 CDT), symmetric with the fall-back fix.

### 2. Overload detection gaps (`src/parsers/overloadParser.ts`)

- **In-flight retry exclusion** (ruling 2: applies on both paths). Added
  `IN_FLIGHT_RETRY_RE` (`/\bretrying in\s*\d+s\b[^\n]{0,60}\battempt\s*\d{1,2}\/\d{1,2}\b/i`)
  and an early return in `detectOverload` before the RULES loop, so
  `API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10` and
  close variants (other codes, other second counts, `attempt 10/10`, with and
  without the JSON body) schedule nothing. The colon form with no retry
  suffix (`API Error: 529 Overloaded`) is unaffected and stays terminal.
  `detectOverload` has no `trusted` parameter and the transcriptWatcher's
  overload block calls it identically regardless of `flagged`, so the
  exclusion is structurally the same on both paths.

- **Transient-429 routing** (ruling 1). Added `TRANSIENT_429_RE` and a
  counter-exception in `looksLikeOverloadMessage` that wins over the existing
  "hand rate-limit vocabulary to the limit parser" carve-out, plus a
  `transient-429` RULES entry. `API Error: Server is temporarily limiting
  requests (not your usage limit) · Rate limited` is now detected as
  overload. It cannot arm a usage-limit timer on either path: on the
  untrusted path `looksLikeLimitMessage` still trips (due to "Rate limited")
  but no RULES entry in `limitParser.ts` resolves a time from this text, so
  `detectLimit` returns `undefined` regardless of `trusted`; verified with a
  direct test against `detectLimit` with both `trusted: false` and `trusted:
  true`.

- **Sleep/stream-interruption family** (retry-class interruption). Added
  `STREAM_INTERRUPTED_RE` and a `stream-interrupted` RULES entry, anchored on
  the literal `API Error:` head. Covers the spec string plus the six close
  variants the prior-art evidence actually names (no invented phrasings, per
  ruling 3): `went to sleep before a response was produced`
  (`2-autoretry-resume.md:296-297`), and `the response stopped arriving`,
  `connection lost mid-response`, `connection lost before a response was
  produced`, `server error mid-response`, `the response stalled before a
  response was produced` (all `1-autoretry-detection.md:80-81` — seven total
  variants, matching `5-history-issues.md` bug entry #3's "all seven render
  variants").

### 3. Untrusted-text vetoes on the overload path (`src/transcriptWatcher.ts`)

Routing the two new textual overload renders through `detectOverload` reopens
the false-positive class Task 3 closed for limits: a tool's raw output or a
quoted copy is evidence, not a live notice. Added the same tool-result and
`looksLikeQuotedNotice` guards the limit loop already has to the overload
loop, gated on `!flagged` — flagged entries stay exempt, same as every other
veto in this module. The subagent-file veto is **deliberately left out** of
the overload path, unchanged: the surrounding comment already documents that
omission as intentional ("turn-end and overload detection below still run
over subagent files exactly as before"), and an existing test
(`a subagent file still reports turn-end and overload...`) pins it. I did not
touch it — it wasn't needed by any of this task's cases.

## Files changed

- `src/parsers/limitParser.ts` — spring-forward gap fix + doc comment.
- `src/parsers/overloadParser.ts` — three new rules/guards.
- `src/transcriptWatcher.ts` — untrusted-text vetoes extended to overload.
- `test/parsers/limitParser.test.ts` — spring-forward DST test.
- `test/parsers/overloadParser.test.ts` — in-flight-retry, transient-429,
  stream-interrupted positive/negative tests, head-anchor isolation test.
- `test/transcriptWatcher.test.ts` — wiring tests for all three rules, the
  MAX_OVERLOAD_AGE_MS boundary for the sleep render, and the new
  tool-result/quoted-notice veto tests (positive + negative + flagged
  exemption).

## Commits

- `912d21a` fix(limitParser): resolve a DST spring-forward skipped hour to the safe LATER instant
- `583ada4` feat(overloadParser): cover three detection gaps (in-flight retry, transient-429, sleep/stream-interruption)
- `abc9ccf` fix(transcriptWatcher): apply the untrusted-text overload vetoes to the new overload rules

## TDD evidence (RED then GREEN)

All new tests were written first and run to confirm failure for the expected
reason before any implementation change.

**overloadParser.test.ts**, before implementation (`node --test out/test/parsers/overloadParser.test.js`):
```
not ok 8 - an in-flight retry (parens form, ...) must not schedule anything
    API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10
    + { rule: 'api-error-status', status: 529, ... }
    - undefined
not ok 10 - a transient 429 that disclaims being a usage limit routes to overload
    error: 'must be detected as overload'
not ok 12 - sleep/stream-interruption renders route to overload
    error: 'spec string: API Error: Your computer went to sleep mid-response...'
# tests 13
# pass 10
# fail 3
```

**limitParser.test.ts**, before implementation:
```
not ok 18 - a wall-clock time inside a DST spring-forward SKIPPED hour resolves to the safe, LATER side of the gap (A7)
    + actual - expected
    + '2026-03-08T07:30:00.000Z'
    - '2026-03-08T08:30:00.000Z'
```

**transcriptWatcher.test.ts**, before implementation
(`node --test out/test/transcriptWatcher.test.js`):
```
not ok 37 - the sleep-interruption render also obeys MAX_OVERLOAD_AGE_MS
not ok 49 - an in-flight retry does not report overload, even from a flagged entry
not ok 50 - an in-flight retry from an unflagged entry also does not report overload
not ok 51 - the transient-429 render (non-flagged, non-user entry) schedules an overload retry, not a limit timer
not ok 52 - a sleep-interruption render (non-flagged, non-user entry) schedules an overload retry
not ok 55 - a flagged entry is exempt from the new tool-result/quoted vetoes on the overload path
# tests 55
# pass 49
# fail 6
```
(The two untrusted-veto tests, #53/#54, already passed pre-implementation
trivially — the new renders weren't detected as overload *at all* yet, so
nothing scheduled regardless of the veto. They become meaningful once the
positive rules exist, and stayed green after implementation, confirmed by the
mutation run below which shows them going red when the veto is disabled.)

After implementing all three parser rules and the transcriptWatcher veto, all
of the above turned GREEN (see full-suite result below).

## Mutation table

Run: `python3 .superpowers/sdd/2026-09-25-limit-break-1.0-cloud/mutate.py <spec>`

| Guard | Mutation | Result | Named red test |
|---|---|---|---|
| `IN_FLIGHT_RETRY_RE` check in `detectOverload` | `if (IN_FLIGHT_RETRY_RE.test(text))` → `if (false)` | CAUGHT | `an in-flight retry (parens form, "Retrying in"/"attempt k/n") must not schedule anything`, `an in-flight retry does not report overload, even from a flagged entry`, `an in-flight retry from an unflagged entry also does not report overload` |
| `TRANSIENT_429_RE` carve-out in `looksLikeOverloadMessage` | `if (TRANSIENT_429_RE.test(t))` → `if (false)` | CAUGHT | `a transient 429 that disclaims being a usage limit routes to overload`, `the transient-429 render (non-flagged, non-user entry) schedules an overload retry, not a limit timer` |
| `TRANSIENT_429_RE` regex ("not your usage limit" clause) | dropped the clause | CAUGHT | same two tests as above |
| `STREAM_INTERRUPTED_RE` regex ("stalled before a response was produced" variant) | broke that alternative | CAUGHT | `sleep/stream-interruption renders route to overload` |
| `STREAM_INTERRUPTED_RE` head anchor (`API Error:`) | removed the anchor | CAUGHT (after adding a dedicated isolation test — see below) | `the exact stream-interruption wording without the API Error: head does not match, even when other overload vocabulary is present` |
| Overload path tool-result/quoted-notice veto in `transcriptWatcher.ts` | `if (!flagged && (...))` → `if (false)` | CAUGHT | `a grep-style quoted copy of the transient-429 render does not schedule an overload retry`, `a quoted copy of the sleep-interruption render inside a tool_result block does not schedule an overload retry` |
| DST fall-back guard (bbff534, reviewed) | disabled the repeated-hour check | CAUGHT | `a wall-clock time inside a DST fall-back repeated hour resolves to the LATER instant (A7)` |
| DST spring-forward guard (new) | disabled the skipped-hour check | CAUGHT | `a wall-clock time inside a DST spring-forward SKIPPED hour resolves to the safe, LATER side of the gap (A7)` |

Note on the head-anchor mutation: my first negative test for "prose merely
mentioning sleep" didn't actually exercise the regex's `RULES` loop at all —
it lacked any `ERROR_MARKERS` trigger word, so it was rejected earlier by
`looksLikeOverloadMessage` regardless of the anchor, and the mutation
**SURVIVED** on the first run. I added a second, more targeted negative test
(`There was an error: your computer went to sleep mid-response, apparently.`
— carries `error` so it clears the gate, but has a bare `error:` instead of
`API Error:` ahead of the sleep phrase) that isolates the anchor itself.
Re-ran the full mutation set after adding it: all 8 mutations CAUGHT, 0
survived.

Final run:
```
$ python3 .superpowers/sdd/2026-09-25-limit-break-1.0-cloud/mutate.py <spec>
CAUGHT  in-flight-retry guard: 'Retrying in Ns .. attempt k/n' no longer excluded
CAUGHT  transient-429 carve-out: no longer wins over the 'rate limit' -> limit-parser carve-out
CAUGHT  transient-429 regex: 'not your usage limit' clause dropped
CAUGHT  stream-interrupted regex: the 'stalled before a response was produced' variant dropped
CAUGHT  stream-interrupted regex: 'API Error:' head anchor removed
CAUGHT  overload path: new tool-result/quoted-notice veto disabled
CAUGHT  DST fall-back guard (bbff534): repeated-hour detection disabled
CAUGHT  DST spring-forward guard: skipped-hour detection disabled
mutate_exit=0
```

## Full test results

Unit suite: `npm test > /tmp/t4a.log 2>&1; echo "exit=$?"`
```
exit=0
# tests 514
# pass 514
# fail 0
```

Integration suite: `xvfb-run -a npm run test:integration > /tmp/it4a.log 2>&1; echo "exit=$?"`
```
exit=0
  9 passing (2s)
```
(The `Failed to fetch` / SSL handshake lines in that log are VS Code's own
background gallery/GitHub traffic, per global constraint 6 — not test noise.)

## Self-review

- Re-read the full diff (`git diff 8923bc0..abc9ccf`) for `overloadParser.ts`
  and `transcriptWatcher.ts` after implementation; placement of the
  in-flight-retry check (before the code-guard, so it wins even over a
  matching status-code rule) and the transient-429 carve-out (before the
  "rate limit → limit parser" carve-out) are both confirmed correct by
  reading the surrounding control flow, not just by the tests passing.
- Confirmed structurally, not just by test, that ruling 2 (in-flight-retry
  exclusion applies on both paths) holds: `detectOverload` takes no
  `trusted`/`flagged` parameter at all, and the transcriptWatcher's overload
  block calls it identically regardless of `flagged` — there is no code path
  where the exclusion could apply on one path and not the other.
- Confirmed ruling 1 (transient-429 never arms a usage-limit timer) holds
  structurally on the *flagged* path too, not just tested on `trusted`/`
  untrusted` `detectLimit` calls directly: in `transcriptWatcher.inspectLine`,
  a flagged entry with this text has no `quotaLimits.resetsAt` in the
  brief's fixture, so it falls through to the per-candidate loop, which
  calls `detectLimit(..., { trusted: true })` — and since no RULES entry
  resolves a time from this text, that returns `undefined` regardless of
  `trusted`, letting execution reach the overload check below. This is
  exercised structurally by `detectLimit`'s own RULES design (no rule
  matches this vocabulary), not by a new special case.
- Left the subagent-file veto out of the overload path on purpose (see
  above) — flagged that reasoning explicitly rather than silently deviating
  from the brief's mention of "subagent files" among the Task 3 guards.
- The one process gap I caught myself: my first head-anchor negative test
  was too weak to actually exercise the anchor (see mutation table note
  above) — caught by the mutation run itself, not by a reviewer, and fixed
  before reporting.

## Concerns

None outstanding. One judgment call worth flagging explicitly: the brief's
"quoted text, tool results, subagent files, percentage warnings" sentence
lists all four of Task 3's guards, but only two (quoted text, tool results)
are structurally applicable to the new overload renders — percentage-usage
phrasing has no overload analogue, and the subagent-file veto is documented
elsewhere as deliberately not applying to the overload path at all. I
applied the two that are relevant and left the other two out, rather than
inventing an overload-specific percentage guard or subagent veto that
nothing in the brief's fixtures needs.
