# Task 4b report: the "gave up" state and distinct failure notices

Branch `claude/limit-break-1.0-cloud`, base `10e897f`.

## Design

### The model: `src/gaveUp.ts` (pure, no vscode)

```ts
type GaveUpCause = 'stall' | 'launcher' | 'cwd' | 'budget';
interface GaveUpRecord { sessionId: string; cwd?: string; cause: GaveUpCause; atMs: number }
class GaveUpState {
  record(r): boolean      // stores/replaces the session's record; true = notify (first time for (sessionId, cause))
  detected(sessionId)     // ruling 2: drops the record AND the warn-once memory for that session
  launched(sessionId)     // ruling 2: drops the record only (a later stall records again, quietly)
  clearAll()              // ruling 3 (Cancel): drops every record and all warn-once memory
  list(): GaveUpRecord[]  // oldest first, copies
}
```

- One record per session (the newest failure replaces an older one; a repeat of the same cause refreshes `atMs`).
- Warn-once memory is a separate set keyed `(sessionId, cause)` (ruling 1). It is kept apart from the records on
  purpose: a launched resume clears the record but not the memory. Only a new detection (or Cancel) forgets it.
  The three clear methods return whether a record was removed, which is how the wiring knows to re-render.
- Also in the module: `GAVE_UP_ICON`, `describeGaveUp(record)` (one Markdown tooltip line: short id, folder,
  per-cause reason, time), `gaveUpNotice(...)` (stall/launcher/cwd notification text) and
  `budgetRefusalNotice(sessionId, reason)`.

### Where each cause is recorded (all in `src/extension.ts`)

| Cause | Site | Notice (severity unchanged from before) |
|---|---|---|
| `launcher` | `resume()`, `!launcher` return | error: "could not resume session X: the claude executable was not found. Set claudeLimitBuster.claudeCommand to its full path, then use "Resume Now"." |
| `cwd` | `resume()`, `!cwdExists(...)` return | error: "the folder for session X no longer exists: <cwd>. The resume was not started. Use "Resume Now" again once the folder is back, or check the transcript." (text as before) |
| `stall` | `resume()`'s stall `setTimeout`, verdict `stalled` | warning: "the resume of session X stalled - its transcript has not grown since launch, so it will not be retried automatically." + either "This folder is not trusted by the Claude CLI, which is the most likely reason: Claude is waiting at its trust prompt. Answer it in the resume's terminal." (when `job.folderTrusted === false`, where the code already suspected it) or "Claude may be waiting at a prompt, or may have exited; check the resume's terminal." |
| `budget` | `onDetection`'s refusal `.then`, `choice !== 'Resume anyway'` | the refusal itself: "not resuming session X. <reason with the numbers> Choose "Resume anyway" to go ahead this once, or raise claudeLimitBuster.maxResumeTokens." No second popup on dismissal (see below). |

All three `resume()` sites go through one helper, `giveUp(job, cause, show)`: record, re-render, and call `show` only
when `record` said so; otherwise a log line says it was already warned about. Every site still logs every time
(the launcher-missing site had no log line at all before; it has one now, so a repeat is never silent everywhere).

Budget "dismissed": the refusal is `showWarningMessage(msg, 'Resume anyway')` and the handler already branched on
`choice !== 'Resume anyway'`, which is the promise resolving `undefined` when the notification is closed (there is no
other button). That branch now logs, records `budget`, and re-renders. It does NOT pop a second notification: the
refusal the user just closed already named the cause and both ways through; a second one right after is the nag
warn-once is there to prevent. To support this `planResume`'s `refuse` plan now carries `sessionId` and `cwd`
(`src/policy.ts`; the session is resolved before the budget check anyway).

Clearing:
- detection: `onDetection`, for any plan that names a session (`refuse` or `schedule`, limit or overload), before
  anything else; re-renders when something was cleared (the refused branch never touches the scheduler, so nothing
  else would).
- launch: `resume()`, right after `createTerminal` + the "Resumed ..." log.
- Cancel: the `cancel` command (which the status-bar menu's "Cancel Pending Resume" runs) calls `clearAll()` after
  `scheduler.cancel()` and re-renders itself (with nothing pending the scheduler fires no onChange).

Task 5a's untrusted-folder notice is untouched and never recorded (a test pins that dismissing it records nothing).

### Status bar (`src/statusBar.ts`, minimal)

- `update(job, waiting, mode, gaveUp = [])` - one new optional parameter.
- Nothing pending and >=1 gave-up: text `$(circle-slash) Resume gave up` (+ ` (N sessions)` when >1), tooltip =
  title + the gave-up section + "Click for actions".
- A job pending: countdown text and tooltip exactly as before, with the gave-up section appended before
  "Click for actions".
- The gave-up section is one function, `appendGaveUp(tip, records)`: a heading, one `- ` line per record from
  `describeGaveUp`, and "A new limit for a session, or "Cancel Pending Resume", clears this."
- `statusBar: "pending"` still shows the gave-up state (it hides the idle marker; a gave-up session is not idle);
  `"never"` hides it.
- extension.ts draws the bar from one `render(job = scheduler.current)` helper that always passes `gaveUp.list()`;
  both previous `status.update` calls (scheduler.onChange, the trust-terminal close hook) now go through it.

### The icon: `$(circle-slash)`

`$(error)` reads as the extension itself having crashed, which it has not. `$(warning)` reads as a caution about
something in progress, and the countdown already turns the item warning-coloured in its last minute. circle-slash
is "stopped, not trying", which is the state. Justified in the comment on `GAVE_UP_ICON`, pinned in
`test/gaveUp.test.ts` ("the icon is circle-slash") and used by the statusBar/extension tests via the constant.

### Menu

"Cancel Pending Resume"'s description now says what it will clear: `Clear N session(s) that gave up` when nothing
is waiting, and appends ` and clear what gave up` when both exist, instead of "Nothing to cancel" beside a bar that
says otherwise.

## Files changed

- `src/gaveUp.ts` (new), `test/gaveUp.test.ts` (new)
- `src/statusBar.ts`, `test/statusBar.test.ts`
- `src/policy.ts`, `test/policy.test.ts`
- `src/extension.ts`, `test/extension.test.ts`

### Task 10's claim calls

Not touched. All recording on launcher-missing / cwd-missing happens INSIDE `resume()`, before its `return false`;
every `claimResume` / `releaseClaim` call lives at the call sites after `resume()` returns and is byte-for-byte as
before, in the same order under the same conditions. `git diff 10e897f -- src/extension.ts | grep -E '^[+-]' | grep -i claim`
shows only one added comment line ("Never touches claims: ...").

## TDD evidence

Commits (base 10e897f): cd14cdd gaveUp module; 0297df6 statusBar; b11ecb6 policy; eca15a8 extension wiring;
6155dd3 three more tests.

RED, then GREEN, for each step:
- gaveUp: test file first. `tsc` failed with "Cannot find module '../src/gaveUp'". After the module: 18/18 pass.
- statusBar: 7 new tests. 5 failed (TS2554 "Expected 1-3 arguments, but got 4"; the gave-up icon, tooltip, count,
  'pending' and countdown+tooltip tests). The 2 negative tests passed as expected. After the change: 19/19.
- policy: the new refusal test failed (`sessionId`/`cwd` missing on the refuse plan). After the change: 10/10.
- extension: 12 new tests plus 4 existing assertions changed (below). 14 failed for the expected reasons: no
  gave-up icon, the refusal not naming the session, the stall text lacking "stalled", and a second error popup on
  the retry. The 2 negative tests (Resume anyway; the Task 5a trust notice) passed. After the wiring: 100/100. One
  new stall test first failed after the implementation, on a timing race in the test itself: `oneTick()` could land
  after the 300ms stubbed grace. It now polls for the launch, the way the existing "transcript grows" test does.
- 6155dd3 added 2 wiring tests (a refused detection clears; an untrusted stall blames trust). They passed against
  the implementation already in place, and mutations X1b and X13 show that each one catches its change.

**Existing tests changed (ruling 1):** four tests pinned "a manual retry into a missing folder shows the error
again" (`errors.length === 2`): "an autoResume that lands on a deleted folder...", "accepting a Resume Now offer
into a deleted folder...", "resumeNow does not cancel the counting-down job...", "Resume Now from the palette into
a deleted folder...". Ruling 1 says the second failure of the same cause logs but does not notify. They now assert
`errors.length === 1` and that the log shows the refusal twice (`cwdFailureLogs(SESSION) === 2`). That keeps what
they were for: the job is still there, and the retry really ran and failed the same way.

### Mutation table (mutate.py, focused test files; 38 mutations, all CAUGHT)

| # | Mutation | Caught by |
|---|---|---|
| G1 | warn-once gate `if (warned.has)` -> false | same-cause-again test (+2) |
| G2 | warned never marked | same-cause-again test (+2) |
| G3 | detected() keeps warn memory | detection clears record and memory |
| G4 | detected() clears every session's memory | detection clears ... (other session still remembers) |
| G5 | detected() keeps the record | detection clears ... |
| G6 | launched() keeps the record | launched clears record not memory; clear-reports-change |
| G7 | launched() also forgets warnings | launched clears record not memory |
| G8 | clearAll keeps warn memory | clearAll test |
| G9 | clearAll keeps records | clearAll test |
| G10 | list newest first | list is oldest first |
| G11 | list returns live objects | list returns copies |
| G12 | no-folder branch removed | no-folder line (first run SURVIVED: the test passed `undefined` into a default parameter; fixed, re-run CAUGHT) |
| G13 | stall notice blames trust unless trusted | trust blamed only when untrusted |
| G14 | icon -> `$(warning)` | the icon is circle-slash |
| G15 | clearAll always reports a change | clear-reports-change |
| S1 | gave-up branch removed | 4 statusBar tests |
| S2 | gave-up beats the countdown | countdown still wins |
| S3 | count shown for one | counts sessions when more than one |
| S4 | countdown tooltip omits gave-up | countdown still wins ... tooltip mentions |
| S5 | empty section rendered | no gave-up section when nothing gave up |
| P1 | refuse plan sessionId -> '' | refusal names the session (first run SPEC ERROR, non-unique anchor; re-run CAUGHT) |
| X1 | detection does not clear | 3 extension tests |
| X1b | detection clears without re-render | refused detection still clears |
| X2 | budget dismissal not recorded | 3 extension tests |
| X3 | budget dismissal not rendered | 2 extension tests |
| X3b | budget dismissal not logged | dismissed budget refusal |
| X4 | launcher failure not recorded | missing claude executable |
| X5 | launcher failure not logged | missing claude executable (logged every time) |
| X6 | cwd failure not recorded | 8 tests |
| X7 | stall not recorded | 4 tests |
| X8 | launch does not clear | a resume that launches clears the record |
| X9 | warn-once bypassed in giveUp | 5 tests (incl. the 4 changed ones) |
| X10 | giveUp does not re-render | 6 tests |
| X11 | cancel keeps gave-up | cancel command; menu Cancel |
| X12 | menu says "Nothing to cancel" | menu offers Cancel |
| X13 | stall notice drops folderTrusted | untrusted stall blames trust |
| X14 | render drops the gave-up list | 8 tests |
| X15 | refusal loses the session | dismissed budget refusal |

### Results

- Unit: `npm test > /tmp/t4b.log 2>&1; echo "exit=$?"` gave exit=0, 564/564 pass (baseline 524).
- Integration: `xvfb-run -a npm run test:integration > /tmp/it4b.log 2>&1; echo "exit=$?"` gave exit=0, 9 passing.
- LF preserved (`git ls-files --eol`: i/lf w/lf on all touched files).

## Self-review

- Constraints: no `~/.claude.json` writes, nothing sent into foreign sessions, `--resume` still only gets the
  resolved UUID, user-facing strings still say "Claude Limit Buster", and nothing is persisted (the brief does not
  require it, and the ready-job persistence is untouched). No new failure detection was invented; the four causes
  are the ones the code already observed.
- extension.ts changes are wiring only: one state object, one `render` helper, one `giveUp` helper, and calls at
  the existing sites. No restructuring.

### Concerns

1. **Ruling 1 silences manual retries.** In practice the only way to hit the same (session, cause) twice without
   a detection in between is a manual retry: Resume Now, or a notification button, on a job whose folder or
   launcher is still missing. The automatic path never retries by itself, and a new fire needs a new detection,
   which clears the memory. So warn-once only ever suppresses the popup for a user's own click. The second click
   now shows nothing except the log line and the (already showing) gave-up status bar. I followed the ruling and
   changed the four tests that pinned the old "error again" behaviour. If the controller would rather have
   explicit user actions always notify, it is a one-line change in `giveUp`: pass a `manual` flag and skip the
   gate. Tell me and I will do it.
2. **Budget: no second popup on dismissal.** The refusal the user just closed is the budget cause's notice (it now
   names the session, the numbers, "Resume anyway" and `claudeLimitBuster.maxResumeTokens`). Dismissing it records
   the gave-up state and logs, but pops nothing else. Because the detection that produced the refusal has just
   cleared the warn memory, a popup here would fire on every dismissal.
3. **`statusBar: "pending"` shows the gave-up state.** That setting reads "nothing while idle", and gave-up is not
   idle. The package.json enumDescription ("Show the countdown only; nothing while idle.") was not edited. Task 9b
   (docs) may want to mention it.
4. **For Task 5b, one session can be both pending and given up.** (a) A launcher or cwd failure leaves the job in
   `readyJobs` by design, so Resume Now can retry it. It is therefore "ready" and "gave up" at the same time.
   (b) A failed manual Resume Now on a job still counting down records gave-up while the scheduler keeps counting
   it down, and it will try again at its deadline. 5b's one list should show one line per session. The simplest
   rule is that the gave-up cause annotates the pending line when the session is in both lists. The data allows
   that: `gaveUp.list()` is keyed by the same sessionId.
5. **For Task 5b, escaping.** `describeGaveUp` puts the folder inside a Markdown code span unescaped, like the
   existing tooltip does. 5b's escaping work should cover it, or replace the line builder.
6. **For Task 5b, the interface.** `CountdownStatusBar.update(job, waiting, mode, gaveUp: readonly GaveUpRecord[])`.
   extension.ts always calls it through `render()`. The tooltip section is `appendGaveUp` in statusBar.ts; the
   per-line text is `describeGaveUp` in gaveUp.ts.
7. Minor: the launcher-missing error in `openClaudeToTrust` (Task 5a) is unchanged and not recorded. It is not a
   resume failure.

## Pre-review change: manual clicks are always answered (controller ruling on concern 1)

Commit: 06dd962 ("fix(gaveUp): a failure answering a user's click is always notified"), on top of 762dbb6.

- `GaveUpState.record(entry, manual = false)`: returns true when `manual` even if (sessionId, cause) was already
  warned; a manual failure still marks the pair warned, so an automatic repeat after it stays quiet.
- `giveUp(job, cause, show, manual = false)` passes it through; `resume(job, manual = false)` passes it to the
  launcher and cwd sites. `true` at: the off-autoResume "Resume Now" notification button, "Resume in Terminal
  Anyway", and both resumeNow command branches (counting-down, ready). scheduler.onFire's automatic
  `resume(resumeJob)` stays automatic.
- Stall does not take the flag: once a resume launches its job is gone, so a second stall needs a new detection,
  which already resets warn-once. No observable difference, so no untestable flag.
- Task 10: only the `resume(...)` argument lists on the lines after each `claimResume` changed
  (`if (!resume(job, true))` etc.); every `claimResume` / `releaseClaim` call is byte-identical, same order, same
  conditions. `git diff | grep -i claim` over the change shows only doc-comment lines.

Tests:
- The 4 existing tests are back to `errors.length === 2` on the manual retry (plus the log count); the launcher test
  expects 2 notices for 2 clicks.
- New pure tests: "an explicit user action always warns, even for a cause already warned about"; "a manual failure
  counts as warned, so an automatic repeat after it stays quiet".
- New extension tests: "gave up: an AUTOMATIC repeat of a failure already notified stays silent, but is logged and
  recorded" (manual Resume Now on a job counting down fails, then its own scheduled fire fails the same way: 1
  notice, 2 log lines, still gave-up); "the Resume Now notification button is answered even when the same failure
  was already notified"; "\"Resume in Terminal Anyway\" is answered even when ...".
- RED: tsc TS2554 on `record(..., true)`; 6 failures (the 4 restored tests, the launcher test, the pure manual
  test). The automatic-repeat test and the two button tests passed before the change as expected (old behaviour
  silenced every repeat / the first-ever failure notifies anyway); their bite is shown by M10, M6, M7 below.

Mutations (all CAUGHT):

| # | Mutation | Caught by |
|---|---|---|
| M1 | pure: `&& !manual` dropped | explicit user action always warns |
| M2 | pure: manual does not mark warned | manual failure counts as warned ... automatic repeat quiet |
| M3 | giveUp does not pass manual | 7 tests |
| M4 | launcher site drops manual | missing claude executable |
| M5 | cwd site drops manual | 6 tests |
| M6 | notification button resume not manual | the Resume Now notification button is answered ... |
| M7 | Terminal Anyway resume not manual | "Resume in Terminal Anyway" is answered ... |
| M8 | resumeNow counting-down branch not manual | resumeNow does not cancel the counting-down job ... |
| M9 | resumeNow ready branch not manual | 4 tests |
| M10 | automatic onFire resume treated as manual | AUTOMATIC repeat ... stays silent |

Results: unit exit=0, 569/569; integration exit=0, 9 passing.

Concern 1 above is resolved by this change; concerns 2-4 stand as accepted.
