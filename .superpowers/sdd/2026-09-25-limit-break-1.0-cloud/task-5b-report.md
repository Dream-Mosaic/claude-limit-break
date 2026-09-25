# Task 5b report: unified tooltip session list with the trust hotlink

## What was built

`src/statusBar.ts` was rewritten so `CountdownStatusBar.update()` takes the
full list of counting-down jobs and the full list of ready-for-"Resume Now"
jobs (previously it took only the soonest job and a bare count), plus the
gave-up records from Task 4b, and renders **one Markdown line per session**
in the tooltip - counting down, ready, or both-with-a-gave-up-cause - instead
of verbose fields for only the soonest job.

New pure, exported functions (testable without touching the DOM/vscode APIs
beyond the module's own `require('vscode')` stub):

- `escapeMarkdown(text): string` - backslash-escapes every CommonMark
  special character (`` \ ` * _ { } [ ] ( ) # + - . ! < > | ``) so a folder
  literally named `*x*` or `[a](b)` renders literally and cannot inject a
  link or open a code span.
- `trustCommandUri(cwd): string` - exactly
  `command:claudeLimitBuster.openClaudeToTrust?<encodeURIComponent(JSON.stringify([cwd]))>`,
  the VS Code command-URI convention, for the trust hotlink (Task 5a's
  command).
- `buildSessionLines(jobs, ready, gaveUp): { lines, hasTrustLink, waitingCount }`
  - the whole merge/sort/format pipeline, fully unit-testable on its own.

Line format per session (ruling 1): `` `<id8>` in <escaped folder>, resuming
at **<time>** | **ready**[, **Gave up**: <reason>][, $(warning) not trusted
— [Trust this folder](<uri>)] ``. A session present in more than one input
(Task 4b concern 4: a launcher/cwd failure keeps the job in `ready`; a failed
manual retry on a counting-down job leaves it counting down) gets exactly one
line - `ready` only fills a session `jobs` does not already cover, so a
counting-down job always wins the display over a stale ready entry for the
same session, and any matching gave-up record's cause is appended to
whichever line already exists rather than getting a second line.

Order: pending/ready lines sorted by `resumeAtMs` ascending (a ready job's
own deadline already elapsed, so it naturally sorts first); gave-up-only
lines (no pending/ready job for that session) after, in `GaveUpState.list()`'s
own oldest-first order.

`isTrusted` is only ever set to `{ enabledCommands: ['claudeLimitBuster.openClaudeToTrust'] }`
when at least one line actually carries the link (`hasTrustLink`); otherwise
the `MarkdownString` stays untrusted, per ruling 3.

The status bar pill gained a state Task 5b's brief implies but the old code
never reached: **nothing counting down, but a session is ready** (autoResume
off, or a live-holder deferral). Before this task, `readyJobs` never reached
`CountdownStatusBar` at all - the pill and tooltip said "Nothing pending"
even with a session waiting for a manual click. Now it shows
`$(clock) Claude ready to resume` (with a session count when >1), and the
gave-up icon still wins when anything has ALSO given up (the more urgent
signal), all covered by `buildSessionLines`'s same merge/annotate logic.

Dropped from the old tooltip, per ruling 4 ("keep only what still earns its
place"): the "Resuming at **X**" headline (now redundant with the per-line
time), "this one is due first" (ruling says drop it explicitly), the jitter
padding note, "Reason: limit/overload", the standalone "Session:"/"Folder:"
lines, and the old paragraph-form untrusted warning (now the per-line
marker). Kept: the "Claude Limit Buster" header, the gave-up
clear-it-yourself reminder, and "_Click for actions._".

`src/gaveUp.ts`: `REASON` (the per-cause reason map) is now exported, so the
unified line can quote just the reason without pulling in `describeGaveUp`'s
whole standalone "id in folder: reason (time)" line (which would duplicate
the id/folder already on the merged line).

`src/extension.ts` wiring: `readyJobs` was collected and persisted from
Task 3's/#11's work but **never actually reached the status bar** - `render()`
only ever read `scheduler.current`/`scheduler.jobs`. Fixed:

- `render()` now reads `scheduler.jobs` and `readyJobs` directly (no `job`
  parameter any more - every caller wants the same full picture).
- `rememberReady`/`forgetReady` call `render()` themselves on every actual
  change to the list, rather than relying on some other event to happen to
  follow them. This is the change the last (in-flight) mutation targets.
- The `cancel` command now always calls `render()` at the end (previously
  only when `gaveUp.clearAll()` found something), since a readyJobs-only
  cancel needs to clear its lines from the tooltip too.
- `activate()` now calls `render()` once, unconditionally, right after
  `scheduler.start()` - so a `readyJobs` list restored from a previous
  window (Task #11's persistence) is visible on activation instead of only
  after the next unrelated event.

`test/helpers/vscode.ts`: `FakeMarkdownString` gained a declared `isTrusted`
field (real `vscode.MarkdownString` has one; the fake previously had none),
needed to assert the trust link's scoped grant end-to-end.

## Sample rendered tooltip

Two sessions waiting (one counting down and untrusted, one ready), plus one
session that only gave up:

```
**Claude Limit Buster**

- `0b3d1f66` in my-project, resuming at 9/25/2026, 4:12:03 PM, $(warning) not trusted — [Trust this folder](command:claudeLimitBuster.openClaudeToTrust?%5B%22%2Fhome%2Fme%2Fmy-project%22%5D)
- `7f2a9c41` in other-app, **ready**

- `ffffffff` in gone-folder, **Gave up**: its folder no longer exists

A new limit for a session, or "Cancel Pending Resume", clears this.

_Click for actions._
```

## Files changed

- `src/statusBar.ts` (rewritten: new pure functions, new `update()` signature)
- `src/gaveUp.ts` (export `REASON`)
- `src/extension.ts` (render wiring: see above)
- `test/statusBar.test.ts` (rewritten/expanded: 44 tests)
- `test/extension.test.ts` (2 new tests + 1 updated assertion for the
  basename/escaping change)
- `test/helpers/vscode.ts` (`FakeMarkdownString.isTrusted`)

## TDD evidence

- Wrote the new `statusBar.test.ts` (escapeMarkdown/trustCommandUri/
  buildSessionLines/CountdownStatusBar, referencing the not-yet-existing
  exports and the new `update()` signature) before touching `statusBar.ts`.
  `npm run compile` failed with exactly the expected `TS2339` (missing
  exports) and `TS2345` (old `update()` signature) errors - confirmed red
  for the right reason, then implemented.
- Two test-authoring mistakes surfaced as real failures and were fixed as
  test bugs, not implementation bugs: `escapeMarkdown('my-project_v2')`
  expecting no escaping (wrong - `-`/`_` are in the mandated escape set) and
  a redundant `!/<img/.test(escaped)` assertion (escaping precedes a
  character with `\`, it does not remove it, so the substring is still
  there).
- `test/extension.test.ts`'s pinned assertion
  `barTooltip().includes(MISSING_CWD)` (full path) was updated to
  `barTooltip().includes(escapeMarkdown(path.basename(MISSING_CWD)))` -
  a deliberate, ruling-driven format change (full path -> escaped basename),
  not a workaround.

## Mutation table

Runner: `python3 .superpowers/sdd/2026-09-25-limit-break-1.0-cloud/mutate.py`
against `spec-5b.json` (16 mutations, `tests` scoped to
`out/test/statusBar.test.js` for the pure-function/render-branch mutations,
`out/test/extension.test.js` for the two render-wiring mutations).

| # | Mutation | Result |
|---|---|---|
| 1 | `escapeMarkdown` drops `*` from the escape set | CAUGHT |
| 2 | `trustCommandUri` skips `encodeURIComponent` | CAUGHT |
| 3 | a counting-down job never shows its resume time (state check swapped to `'ready'`) | CAUGHT |
| 4 | a ready job never says "ready" | CAUGHT |
| 5 | a gave-up cause is never appended to its line | DID NOT COMPILE (TS loses the narrowing on `entry.gaveUpCause`; accepted per the runner's own rule - not a survivor) |
| 6 | the untrusted marker/link fires for every job, not just untrusted ones | CAUGHT |
| 7 | a ready job overwrites a counting-down entry for the same session, instead of deferring to it | **SURVIVED on the first pass** - no test exercised a session present in BOTH lists with genuinely different states; added "a session in both jobs and ready keeps its counting-down line, not 'ready' (Task 4b fix round 1, finding 1)" - CAUGHT on rerun |
| 8 | pending/ready lines never sorted soonest-first | CAUGHT |
| 9 | a gave-up record never annotates a matching pending/ready entry (both-state merge breaks) | CAUGHT |
| 10 | the idle branch is never reached | CAUGHT |
| 11 | the gave-up icon never wins over the ready-only pill | CAUGHT |
| 12 | `"pending"` mode hides even a gave-up/ready-only session | CAUGHT |
| 13 | the "clears this" reminder shows even when nothing gave up | CAUGHT |
| 14 | `isTrusted` is set even with no trust link | CAUGHT |
| 15 | `forgetReady` never re-renders on an actual removal | **SURVIVED on the first pass** - no extension-level test asserted the tooltip updates without an unrelated event; added "a session resumed by hand from the ready list drops off the tooltip immediately" - CAUGHT on rerun |
| 16 | `rememberReady` never re-renders | **SURVIVED on the first pass**; added "a session becoming ready is reflected in the tooltip immediately, without any other event" - CAUGHT on rerun |

Final: 15/16 CAUGHT, 1 accepted DID-NOT-COMPILE (#5 - TypeScript loses the
narrowing on `entry.gaveUpCause` once the guard becomes a literal `false`;
tried an alternative mutation (`existing.gaveUpCause = undefined` for the
adjacent, structurally similar merge branch, #9) specifically so that one
would compile and be runtime-caught instead, and it was). 0 SURVIVED,
0 SPEC ERROR - `mutate.py`'s own exit code is 0.

## Unit tests

`npm test > /tmp/t5b.log 2>&1; echo "exit=$?"` → **exit=0**, 604 tests,
0 failures. (One intermediate run showed a single false failure while a
background mutation-verification process had `src/extension.ts` temporarily
mutated for the "forgetReady never re-renders" case - a race with my own
tooling, not a real failure; the clean rerun above is the one that counts.)

## Integration tests

`xvfb-run -a npm run test:integration > /tmp/it5b.log 2>&1; echo "exit=$?"` →
**exit=0**, 9 passing, 0 failing. The "Failed to fetch"/SSL handshake lines
in the log are VS Code's background gallery/GitHub traffic (constraint 6),
not test noise. No integration test touches tooltip content directly (only
a config-default check for `statusBar`), so this run mainly confirms the
extension still activates and registers every command cleanly.

## Self-review

- Re-checked constraint 4 (UUID-only to `claude --resume`): untouched by
  this task, `resume()` in extension.ts is unmodified.
- Re-checked constraint 3 (never write into another session): untouched.
- Re-checked ruling 3 (`isTrusted` scoped, not `true`): `renderTooltip` only
  ever sets the scoped object, and only when `hasTrustLink` - mutation-tested
  (#14).
- Re-checked "one status-bar model, not two" (cross-task ruling): confirmed
  the old separate `appendGaveUp` tooltip section is gone; gave-up state now
  only ever appears woven into `buildSessionLines`'s single list.
- Deliberate scope decision beyond the brief's literal text: added the
  "ready, nothing counting down" pill state (`$(clock) Claude ready to
  resume`). Before this task, a `readyJobs`-only window showed the *idle*
  "$(eye) ... Nothing pending" marker - false, once the tooltip lists a
  waiting session. Flagging this as a deliberate but not explicitly-briefed
  addition in case the controller wants different copy or wants it reverted
  to a narrower fix (tooltip content only, pill text untouched).
- Investigated and deliberately did NOT implement: clearing a stale
  `readyJobs` entry when a fresh detection reschedules the same session.
  This looked at first like a duplicate-line bug my merge function should
  guard against, but `test/extension.test.ts`'s "gave up: two manual
  launches of the same session that both stall are both answered" (Task 4b
  fix round 1, finding 1) explicitly and intentionally exercises a session
  holding both a stale ready job and a fresh counting-down job at once - my
  first instinct (auto-clearing) would have broken that pinned test.
  `buildSessionLines` instead just prefers the counting-down state for
  display (one line, not two), which satisfies "one line per session"
  without touching the underlying `readyJobs`/scheduler state.
- README's "What you will see" section still says the tooltip shows "the
  session, folder, reset time and any random padding" - now stale (jitter
  padding and full session id/folder are gone from the redesigned tooltip).
  Left untouched, following the Task 4b precedent (concern 3) of flagging
  doc staleness for Task 9b rather than editing docs from an implementation
  task; constraint 11 only binds the "panel tab after a resume" section.

## Concerns for the controller

1. The "ready, nothing counting down" pill text/icon (`$(clock) Claude ready
   to resume`) is new UI copy not given verbatim by the brief - flagged above.
2. Task 9b should update README's "What you will see" tooltip description
   (still describes the pre-5b verbose per-job tooltip: jitter padding, a
   full session id/folder line).

## Commits

- `73b7daa` feat(statusBar): unified tooltip session list with the trust
  hotlink (Task 5b) - the full implementation.
- `a331e9e` test(statusBar,extension): mutation-driven coverage for Task 5b's
  new branches - the two tests that closed the mutations that survived the
  first pass (see mutation table).

Both commits carry the required trailer; branch `claude/limit-break-1.0-cloud`,
nothing pushed, no branch switches, no rebase/reset.

## Fix round 1 (review 1: two Important issues)

### Issue 1 (Important): trust link truncated by an unbalanced ")"

`encodeURIComponent` leaves `( ) ! ' *` raw (RFC 3986's own "unreserved"
set). Those characters sit inside a Markdown inline link's `(...)` target
(`[Trust this folder](command:...)`), and a Markdown renderer reads that
target only up to the first UNESCAPED `)`. A cwd containing a raw `)` -
`/home/me/foo)`, or an ordinary `/home/me/project (copy)` - closed the link
target early; VS Code then called `openClaudeToTrust` with no arguments,
which logs "invoked with no folder" and silently no-ops.

Fix: `trustCommandUri` (`src/statusBar.ts`) now percent-encodes `( ) ! ' *`
by hand, after `encodeURIComponent`, using each character's own hex code
point (`%28`, `%29`, `%21`, `%27`, `%2A`).

Red tests first (both failed for the right reason - `not query.includes` /
truncated decode - before the fix):
- `trustCommandUri also percent-encodes the characters encodeURIComponent
  leaves raw: ( ) ! ' *` - five cwds (`)`, `(copy)`, an apostrophe, `*`, `!`),
  asserts no raw special character in the query and an exact
  `JSON.parse(decodeURIComponent(query))` round-trip to `[cwd]`.
- Two `the trust link target is not truncated by an unbalanced paren in the
  cwd (...)` tests - build a real session line via `buildSessionLines` for
  an untrusted job, extract the link target the way a renderer would
  (`/\[Trust this folder\]\(([^)]*)\)/` - up to the first unescaped `)`),
  and confirm THAT substring still decodes to exactly `[cwd]`. This is the
  reviewer's exact repro, reproduced as a test rather than only unit-testing
  `trustCommandUri` in isolation.

Mutation: dropping the extra `.replace(...)` (reverting to a bare
`encodeURIComponent(JSON.stringify([cwd]))`) - CAUGHT by all three tests
above.

### Issue 2 (Important): the untrusted marker goes stale for ready jobs and non-soonest counting jobs

Two separate gaps, both in `src/extension.ts`:
- `scheduler.onChange((job) => { refreshTrust(job); ... })` only ever
  refreshed the SOONEST job (the `job` argument onChange fires with) - a
  counting-down job that was never `scheduler.current` never got re-checked
  at all, on any event.
- The trust-terminal close handler already looped `scheduler.jobs` (every
  counting-down job, from an earlier fix), but never touched `readyJobs` -
  a job trusted while sitting in the ready list (autoResume off, waiting for
  "Resume Now") kept showing "not trusted" forever, and since `readyJobs`
  persists across a reload (`#11`), the stale `folderTrusted: false` would
  keep coming back after a reload too.

Fix: `refreshTrust` now returns whether it actually flipped a job (needed to
know when to persist). A new `refreshAllTrust()` loops both `scheduler.jobs`
and `readyJobs`, calling `refreshTrust` on each; if any READY job flipped,
it calls `persistReady()` so the flip survives a reload. Both
`scheduler.onChange` and the trust-terminal close handler now call
`refreshAllTrust()` instead of refreshing just one job or just
`scheduler.jobs`. `scheduler.onChange` fires on every countdown tick as
well as real topology changes; this is intentional and cheap, since
`refreshTrust`'s own per-session mtime cache turns a no-op tick into one
`fs.statSync` per listed job, not a config re-parse (per the review's own
cost note).

Red tests first (`test/extension.test.ts`, both failed for the right reason
before the fix):
- `closing the trust terminal re-reads trust for a ready job too, and
  persists the flip` - schedules a job with `autoResume: false` so it fires
  into `readyJobs` untrusted, opens the trust hotlink, flips
  `trustedCwds`, closes the terminal, and asserts (a) the tooltip's "not
  trusted" marker clears and (b) `store.get(READY_KEY)` becomes a
  DIFFERENT array reference than before the close (not just an
  in-place-mutated one - the fake's `globalState` never serialises, so a
  stored array's elements are the exact same live objects `refreshTrust`
  mutates regardless of whether anything re-persists; only a genuinely NEW
  `persistReady()` call writes a new array reference, which is what (b)
  actually distinguishes).
- `a non-soonest counting job trusted externally clears on the next
  scheduler change, not just the soonest` - two counting-down jobs
  (SESSION sooner/current, SESSION_B later/never-current), trusts SESSION_B's
  folder "externally" (no trust hotlink, no terminal close - just flips
  `trustedCwds` and waits one ordinary tick via `oneTick()`), asserts
  SESSION_B's persisted `folderTrusted` flips to `true`.

Mutation table (`spec-5b-fix1.json`):

| Mutation | Result |
|---|---|
| `trustCommandUri` drops the extra percent-encoding | CAUGHT |
| `refreshAllTrust` never checks ready jobs | CAUGHT |
| `refreshAllTrust` never checks `scheduler.jobs` (only ready) | CAUGHT |
| a flipped ready job's trust is never re-persisted | CAUGHT |
| `scheduler.onChange` reverts to refreshing only the soonest job | CAUGHT |
| the trust-terminal close handler reverts to `scheduler.jobs` only | CAUGHT |

All 6 CAUGHT, 0 SURVIVED, 0 SPEC ERROR.

### Unit tests (fix round 1)

`npm test > /tmp/t5b_fix1_final.log 2>&1; echo "exit=$?"` → **exit=0**, 609
tests, 0 failures (600 from the original task-5b work + 9 net-new: 3 for
issue 1, 2 for issue 2, plus 4 already covered in the earlier
mutation-driven round of the original task).

### Integration tests (fix round 1)

`xvfb-run -a npm run test:integration > /tmp/it5b_fix1.log 2>&1; echo "exit=$?"`
→ **exit=0**, 9 passing, 0 failing.

### Commit (fix round 1)

`836371a` fix(statusBar,extension): trust link truncation and stale trust
markers.
