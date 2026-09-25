# Task 2 report: never start a second writer on a live session

Branch `fix/1.0-field-reports`, worktree `C:/Users/thegr/Dream-Mosaic/Projects/claude-limit-buster-lead`.
Base: `dd4f6d6`. First-pass final commit: `512d7ad`. After fix round 1: `1a0e082`.

## Policy corrected by the controller mid-task

The brief's original design was implemented first (commits `3b454bd`..`c1470e4`), then the
controller sent two corrections that changed the policy. Both are reflected in the final code;
this section records what changed and why, since it overrides what the brief says.

### Correction 1: holder `status` decides the outcome, not just its kind

Original design: `panel` always blocked the spawn and offered a notice; `terminal` depended only
on `autoContinueEnabled`.

Corrected design: `classifyHolder` (liveSessions.ts) now reads the row's `status` ("idle" | "busy"
| "waiting", from `claude agents --json`) and carries it on `SessionHolder`. `decideOnFire` and
`manualResumeWarning` (holderPolicy.ts) branch on it:

- **panel, idle** → resume as normal (spawn a terminal, no remember, no notice). This is the
  product's main use case per the controller: someone leaves a panel idle at a limit and walks
  away. The existing #7 stale-panel-tab handling (`handleStalePanel` / `onStale`) runs after the
  resume exactly as it already did - nothing new was needed there.
- **panel, busy or waiting** → drop silently: no spawn, no `rememberReady`, no notification, just
  a log line (naming Remote Control when the panel is bridged).
- **terminal, busy or waiting** → drop silently, same as above, regardless of `autoContinueEnabled`.
- **terminal, idle, `autoContinueEnabled`** → drop silently (Claude Code will continue it).
- **terminal, idle, auto-continue off** → unchanged: remember the job, notify with "Resume in
  Terminal Anyway".
- Any status other than the literal string `'idle'` (including `undefined`, i.e. an unreported
  status) is treated as **not** idle - a conservative default, since Task 2 exists specifically to
  avoid a second writer.
- `manualResumeWarning`'s modal is now **silent for an idle panel** too (no live conflict); every
  other holder still warns - busy/waiting of either kind, or a terminal of any status (an idle
  terminal still has no #7 auto-resync, unlike an idle panel).

### Correction 2: a busy folder no longer blocks the resume - it tells the resumed model to coordinate

Original design (matching the brief literally): "none, but a different session is busy in the same
folder" was treated the same as a panel holder - blocked, remembered, notified with a button.

Corrected design: the extension **resumes anyway**, and asks the *resumed* Claude session to
coordinate with the busy one, because the extension itself must never write into a session it did
not create (global constraint #3 - it cannot message the other session). `holderPolicy.ts`'s new
`buildResumePrompt(userPrompt, busyPeers)` appends one sentence to the job's prompt, naming each
busy/waiting peer (by its `claude agents --json` `name`, falling back to its pid) and asking the
resumed model to use SendMessage to coordinate before editing anything. The prompt still travels as
a single argv element to `claude --resume` (`resumer.ts`'s `buildResumeArgs`), never shell-quoted
by hand - nothing needed to escape.

`liveSessions.ts`'s `busyFolderHolder` (single match, `status: 'busy'` only) was broadened into
`busyFolderPeers` (every match, `status: 'busy' | 'waiting'`), since the coordination sentence
names all of them, not just one. `AgentRow` gained a `name` field.

This removed the whole `'busy-elsewhere'`-as-blocking-kind machinery the first implementation had
built (`FireHolder`, `classifyFireHolder`, `fireHolderDetector` in holderPolicy.ts; `holderDetector`
in liveSessions.ts) - once a busy folder no longer blocks anything, `decideOnFire` only ever needs
`SessionHolder | 'unknown'`, and `scheduler.onFire` can compose `classifyHolder` and
`busyFolderPeers` directly off one shared listing snapshot (`agentRowsDetector`, replacing both
removed factories). This is a net simplification versus the first implementation, not just a
patch.

## What was built

- **`src/liveSessions.ts`**: `AgentRow` now carries `cwd`, `status`, `name` (all optional, omitted
  when the listing didn't report them). `classifyHolder(rows, sessionId, ourPid, readRecord):
  SessionHolder` - `{kind:'none'}` / `{kind:'panel', pid, bridged, status}` /
  `{kind:'terminal', pid, status}`, panel winning over terminal. `busyFolderPeers(rows, sessionId,
  cwd, platform): AgentRow[]` - every different session busy or waiting in the same normalized
  folder. `agentRowsDetector(runAgents): () => AgentRow[] | 'unknown'` - the one impure listing
  fetch both the manual-resume check and `scheduler.onFire` build on. `livePanelDetector` /
  `hasLivePanel` / `otherLivePids` / `parseAgentRows` are unchanged (still used by
  `handleStalePanel`, issue #7).
- **`src/autoContinue.ts`** (new): `autoContinueEnabled(cwd, platform, readFile)` - the four-layer
  `autoContinueAtUsageLimit` precedence (managed settings → `<cwd>/.claude/settings.local.json` →
  `<cwd>/.claude/settings.json` → `<CLAUDE_CONFIG_DIR||~/.claude>/settings.json`), defaulting to
  on when no layer sets the key as a boolean, matching claude.exe 2.1.281's own
  `setting ?? (autoContinueKeyPresence === "absent")`.
- **`src/holderPolicy.ts`** (new): `decideOnFire(holder, autoContinueOn, shortId): OnFireDecision`
  and `manualResumeWarning(holder, shortId)` - the two decision functions above. `buildResumePrompt
  (userPrompt, busyPeers)` - the coordination-sentence builder. Kept as a separate module per the
  brief's ~950-line guidance for `extension.ts` (see below); `extension.ts` only does wiring.
- **`src/sessionRegistry.ts`**: `SessionRecord` gained `bridgeSessionId?` (present only when
  Remote Control has bridged the session), read by `readSessionRecord`.
- **`src/extension.ts`**: `runAgentsListing` (the shared `execFileSync` closure, unchanged
  substance, now shared by `detectLivePanel` and `detectAgentRows`); `confirmManualResume(job)` -
  the gate every manual resume (the `resumeNow` command's two branches, and the off-autoResume
  "Resume Now" notification's own button) goes through, showing a *modal* warning
  (`{modal: true}`) when `manualResumeWarning` returns one. `scheduler.onFire`, with `autoResume`
  on: classifies the holder, applies `decideOnFire`'s decision (log / remember / notice / resume),
  and - independently, only when nobody is on this session - checks `busyFolderPeers` and builds a
  prompt-modified `resumeJob` for the actual `resume()` call while always `rememberReady`-ing the
  *original* job on a failed launch (so a later manual resume never carries a stale coordination
  sentence tied to one fire's folder snapshot).
- **`test/helpers/vscode.ts`**: `showWarningMessage`'s fake now accepts VS Code's real
  `MessageOptions` overload (`{modal?: boolean}` ahead of the buttons), recording `modal` on the
  warning offer.

extension.ts line count: 987 (`wc -l`) at HEAD - over the brief's ~950-line guidance. The decision
logic was put in a new module (`holderPolicy.ts`) from the start, given the size of the branch
table; `extension.ts`'s growth past 987 is wiring alone (the holder-classification call, the
decision dispatch, the busy-peers composition, and `confirmManualResume`), which is what the
brief's guidance anticipated - the "say which you chose" call: **new module
(`holderPolicy.ts`)**.

## TDD evidence

Every new unit was test-first. Representative RED/GREEN pairs (full detail in the commit history):

- `bridgeSessionId`: RED - `readSessionRecord carries bridgeSessionId...` failed with the exact
  expected/actual mismatch (missing key) before `sessionRegistry.ts` was touched. GREEN after.
- `classifyHolder`/`busyFolderPeers`/`agentRowsDetector`: RED - `error TS2305: Module
  "../src/liveSessions" has no exported member 'classifyHolder'` (etc.) before implementation.
  GREEN after (63/63 in `liveSessions.test.ts` + `holderPolicy.test.ts` together, final state).
- `autoContinueEnabled`: RED - `error TS2307: Cannot find module '../src/autoContinue'`. GREEN
  after (14/14).
- `holderPolicy.ts` (`decideOnFire`/`manualResumeWarning`/`buildResumePrompt`): RED on each new
  export before implementation; GREEN after each.
- Extension wiring: RED - 9 pre-existing `resumeNow`-related tests failed
  (`AssertionError: 0 !== 1` / `actual: undefined` for shellArgs) the moment `resumeNow` became
  `async` and callers weren't updated to `await` it; fixed by awaiting every call site (`await
  resumeNow()`), confirmed GREEN (49/49, then growing to 62/62 as new wiring tests were added).
- The two controller corrections were also applied test-first: the new status-driven
  `decideOnFire`/`manualResumeWarning` tests were written to the *new* expected behaviour, run
  (RED - old implementation didn't compile against the new `SessionHolder.status` field / didn't
  have `buildResumePrompt` at all), then implemented to GREEN.

Final gate: `npm test > "$TEMP/t.log" 2>&1; echo "exit=$?"` → **exit=0, 420 tests, 420 pass, 0
fail**. `npm run test:integration` → **exit 0, 9 passing** (panel-reopen, activation, command
registration, settings defaults, terminal environment).

## Mutation table

Runner: the provided `mutate.py` for the first few batches; a faster variant (`mutate_fast.py`,
same semantics - one mutant at a time, applied then reverted in a `finally`, `error TS` → "DID NOT
COMPILE" - but `npm run compile` + `node --test <focused file(s)>` instead of the full `npm test`,
since the full suite's ~52-66s is almost entirely `node:test` running everything, not `tsc`) for
the rest, at the coordinator's direction, once discovered. All mutants were applied to CRLF source
with CRLF-matching `old`/`new` text (a repo-specific trap: the Bash tool halves doubled backslashes
in inline scripts, and a `\n`-only mutation pattern silently fails to match a CRLF file with
"PATTERN NOT FOUND" - both were hit and fixed during this task; see Concerns).

Two rows below (16, 23) are "not caught by a runtime test" for the same reason, confirmed genuine
and not a tooling gap: TypeScript's own strict-null-checks / discriminated-union narrowing rejects
the mutation outright (the mutated file will not compile), which is a *stronger* guarantee than a
runtime test - confirmed by hand for each.

| # | File | Mutation | Result |
|---|------|----------|--------|
| 1 | liveSessions.ts | `parseAgentRows`: cwd guard removed (always assigns) | CAUGHT - `parseAgentRows reads pid, kind and sessionId...` |
| 2 | liveSessions.ts | `parseAgentRows`: status guard removed | CAUGHT - same test |
| 3 | liveSessions.ts | `classifyHolder`: `record.sessionId !== sessionId` flipped to `===` | CAUGHT - `classifyHolder reports a panel, not bridged...` |
| 4 | liveSessions.ts | `classifyHolder`: panel-entrypoint check always true | CAUGHT - `classifyHolder reports a terminal for a cli entrypoint` |
| 5 | liveSessions.ts | `classifyHolder`: `bridged` always true | CAUGHT - `classifyHolder reports a panel, not bridged...` |
| 6 | liveSessions.ts | `classifyHolder`: final ternary always `{kind:'none'}` | CAUGHT - `classifyHolder reports a terminal for a cli entrypoint` |
| 7 | liveSessions.ts | `classifyHolder`: status lookup pid comparison broken (`r.pid === -1`) | CAUGHT - `classifyHolder reads status off the matching row...` |
| 8 | liveSessions.ts | `busyFolderPeers`(orig. `busyFolderHolder`): sessionId exclusion removed | CAUGHT - `...ignores the same session...` |
| 9 | liveSessions.ts | `busyFolderPeers`: busy-status check removed | CAUGHT - `...ignores a different session that is only idle` |
| 10 | liveSessions.ts | `busyFolderPeers`: cwd-defined guard removed | CAUGHT - `...skips a busy row with no cwd rather than throwing` |
| 11 | liveSessions.ts | `busyFolderPeers`: `waiting` disjunct removed | CAUGHT - `...also finds a different session that is waiting...` |
| 12 | liveSessions.ts | `agentRowsDetector` (orig. `holderDetector`): catch swallowed into empty listing instead of `'unknown'` | CAUGHT - `...reports unknown, not none, when the listing cannot be run` |
| 13 | holderPolicy.ts | `decideOnFire`: `'unknown'` branch `resume` flipped false | CAUGHT - `decideOnFire resumes as today when the listing failed...` |
| 14 | holderPolicy.ts | `decideOnFire`: `'unknown'` branch `logLevel` flipped to `'info'` | CAUGHT - same test |
| 15 | holderPolicy.ts | `decideOnFire`: `'none'` branch `resume` flipped false | CAUGHT - `decideOnFire resumes as today when nobody holds the session` |
| 16 | holderPolicy.ts | `decideOnFire`: idle-panel guard drops the status check | **DID NOT COMPILE** - TS2367/TS2339, the unconditional-return branch makes the later `'panel'` branch's fields `never` |
| 17 | holderPolicy.ts | `decideOnFire`: bridgeNote condition inverted | CAUGHT - `decideOnFire mentions Remote Control...` |
| 18 | holderPolicy.ts | `decideOnFire`: terminal not-idle guard inverted | CAUGHT - `decideOnFire drops the job silently for a WAITING terminal...` |
| 19 | holderPolicy.ts | `decideOnFire`: autoContinueOn guard inverted | CAUGHT - `decideOnFire leaves an IDLE terminal alone...when auto-continue is on` |
| 20 | holderPolicy.ts | `manualResumeWarning`: idle-panel exemption guard removed | CAUGHT - `manualResumeWarning is silent for an idle panel` |
| 21 | holderPolicy.ts | `buildResumePrompt`: no-peers guard removed | CAUGHT - `buildResumePrompt returns exactly the user prompt when there are no busy peers` |
| 22 | holderPolicy.ts | `buildResumePrompt`: name-fallback removed (always pid) | CAUGHT - `buildResumePrompt appends a sentence naming one busy peer by its name` |
| 23 | extension.ts | `confirmManualResume`: `!warning` guard removed | **DID NOT COMPILE** - TS18048 `'warning' is possibly 'undefined'` at every later use, confirmed by hand |
| 24 | extension.ts | `confirmManualResume`: `pick === warning.button` replaced with `true` | CAUGHT - `resumeNow shows a modal fork warning...; declining leaves it unresumed` |
| 25 | extension.ts | off-autoResume "Resume Now" button: `confirmManualResume` check removed | CAUGHT - `the off-autoResume "Resume Now" notification button also warns modally...` |
| 26 | extension.ts | `onFire`: `decision.remember` guard removed | CAUGHT - `scheduler.onFire remembers and offers Resume in Terminal Anyway for an IDLE terminal...off` |
| 27 | extension.ts | `onFire`: `decision.notice` guard removed | CAUGHT - same test |
| 28 | extension.ts | `onFire`: `decision.resume` early-return removed | CAUGHT - `scheduler.onFire silently drops the job when...BUSY panel` |
| 29 | extension.ts | `onFire`: busy-peers `holder.kind === 'none'` check removed | CAUGHT - `scheduler.onFire does not run the folder-busy check for an idle-panel resume` |
| 30 | extension.ts | `onFire`: `peers.length > 0` guard removed | CAUGHT - `scheduler.onFire does not touch the prompt when the folder is quiet` |
| 31 | extension.ts | `resumeNow`: scheduler.current branch drops the `confirmManualResume` gate | CAUGHT - `resumeNow shows a modal fork warning...; declining leaves it unresumed` |
| 32 | extension.ts | `resumeNow`: readyJobs branch drops the `confirmManualResume` gate | CAUGHT - `resumeNow also warns modally for a busy holder on a job waiting in the ready list...` |

32 mutations across every new guard/branch in `liveSessions.ts`, `holderPolicy.ts` and the
`extension.ts` wiring. 30 caught by a named test; 2 rejected by the compiler itself (rows 16 and
23) - confirmed by hand in each case that the compile failure is exactly the narrowing/null-check
the removed guard was providing, not an unrelated syntax slip.

Not separately mutation-tested: `src/autoContinue.ts`'s branches were mutation-tested in an
earlier pass, before the two corrections (which did not touch that file) - 8/8 caught, including
the platform-path branches, the non-object-JSON guard, the cwd-scoped-layers guard, and the
default-on fallback.

## Files changed

- `src/liveSessions.ts` - `AgentRow` (`cwd`, `status`, `name`), `classifyHolder`,
  `busyFolderPeers`, `agentRowsDetector`.
- `src/autoContinue.ts` (new) - `autoContinueEnabled`.
- `src/holderPolicy.ts` (new) - `decideOnFire`, `manualResumeWarning`, `buildResumePrompt`.
- `src/sessionRegistry.ts` - `bridgeSessionId`.
- `src/extension.ts` - `confirmManualResume`, `scheduler.onFire`'s holder classification and
  busy-peers coordination, `resumeNow`'s modal gate, shared `runAgentsListing`/`detectAgentRows`.
- `test/liveSessions.test.ts`, `test/holderPolicy.test.ts`, `test/autoContinue.test.ts`,
  `test/sessionRegistry.test.ts`, `test/extension.test.ts` - unit and wiring tests for all of the
  above.
- `test/helpers/vscode.ts` - `showWarningMessage` fake gained `MessageOptions`/`modal` support.

## Concerns

- **Ambiguity resolved by inference, flag for review**: the busy-folder-peers notice's button text.
  The brief originally said "Resume in Terminal Anyway" for this case; the controller's second
  correction, in listing what stays the same, wrote "notify with 'Resume Anyway'" without
  explicitly flagging it as a rename. Since that case no longer blocks anything (it resumes
  immediately, no button is shown at all in the corrected design - the "notice" is a plain
  non-blocking information message with no action needed), this ended up moot: there is no button
  for the busy-folder-peers case in the final code, only a log line and an informational message.
  Worth a second look to confirm that reading is right.
- **Unreported/unknown `status` treated as not-idle** (holderPolicy.ts): the brief's correction
  only spelled out `'idle'` and `'busy' | 'waiting'` explicitly; an absent or unrecognised status
  string is treated as *not* idle (conservative - errs toward not spawning), documented at the top
  of `decideOnFire`. This is an inference, not an instruction; flagging it in case the intended
  default was the other way.
- **`docs/superpowers/plans/2026-09-24-limit-break-1.0.md`** shows as modified in `git status`
  with an empty `git diff` (a pure CRLF/LF eol-normalization flag from git, not a content change
  from this session). Left unstaged and untouched throughout; not part of any commit here.
- **Line-ending trap hit twice**: every new file created with the `Write` tool defaults to LF, but
  this repo's `src/*.ts`/`test/*.ts` convention is CRLF (constraint #7). `src/autoContinue.ts`,
  `test/autoContinue.test.ts`, `src/holderPolicy.ts` and `test/holderPolicy.test.ts` were all
  written LF-first and had to be converted; this also caused several early mutation-runner
  "PATTERN NOT FOUND" results (the JSON mutation specs used `\r\n`, matching CRLF source, but two
  early files were briefly LF between creation and conversion). All confirmed fixed by the final
  green run.
- **Never touched `~/.claude` for real**: every test that needs `claude agents --json` output, a
  per-pid session record, or an `autoContinueAtUsageLimit` setting uses an injected fake
  (`fakeAgentRows`, `sessionRecordFor`, the `./autoContinue` stub) - none of it reads real files on
  this machine. Confirmed by inspection of every new/changed stub in `test/extension.test.ts`.
- **No process was ever signalled or killed** by anything added in this task - `resume()`'s only
  side effect is `vscode.window.createTerminal`, and every holder-detection path only *reads*
  (`execFileSync 'agents' '--json'`, `fs.readFileSync` on session records and settings files). This
  was checked explicitly after the coordinator's note about a `taskkill //F` incident elsewhere;
  nothing in this task's diff runs `taskkill`, sends a signal, or writes to another session's
  transcript or socket.

## Fix round 1

Review found one required change and one scope ruling; everything else in the policy table
passed. Commit `1a0e082`, on top of `512d7ad`.

### 1. CRITICAL - unknown/missing holder status now fails OPEN (counts as idle)

The controller's ruling: Goal 2 is to resume unattended, and a listing failure (`'unknown'`)
already resumes rather than blocking - a single row whose status is missing or unrecognised must
not be read more cautiously than that. The first pass had this backwards: it treated anything
other than the literal string `'idle'` as not-idle.

Fixed by adding one helper, `isIdleStatus(status): boolean` in `src/holderPolicy.ts` - `true`
unless `status` is explicitly `'busy'` or `'waiting'` - and rewiring all three guards the review
named through it:

- `src/holderPolicy.ts`, `decideOnFire`'s idle-panel check (was `holder.status === 'idle'`, now
  `isIdleStatus(holder.status)`).
- `src/holderPolicy.ts`, `decideOnFire`'s terminal busy/waiting check (was
  `holder.status !== 'idle'`, now `!isIdleStatus(holder.status)`).
- `src/holderPolicy.ts`, `manualResumeWarning`'s idle-panel exemption (same rewrite as the first).

`test/holderPolicy.test.ts:69` ("decideOnFire treats an unreported panel status as not-idle
(conservative default)") asserted the old, now-backwards behaviour; rewritten to
`decideOnFire treats an unreported panel status as IDLE (fail open) - resumes as normal`, asserting
`resume: true`. Checked `test/liveSessions.test.ts:221` (`classifyHolder carries status undefined
when the listing did not report it`) as instructed: it only asserts `classifyHolder`'s output shape
(the classifier itself does not interpret idle vs. not-idle - that judgment lives entirely in
`decideOnFire`/`manualResumeWarning`), so it needed no change.

### 2. IMPORTANT - killing test for an unknown-status terminal through decideOnFire

Two new tests in `test/holderPolicy.test.ts`, both going through `decideOnFire` with
`{ kind: 'terminal', pid: 222, status: undefined }`:

- `...auto-continue on leaves it alone` - `autoContinueOn: true` → `resume: false, remember: false,
  notice: undefined`, log message matches `/auto-continue/i` (the same outcome as an explicitly
  idle terminal with auto-continue on).
- `...auto-continue off notifies and remembers` - `autoContinueOn: false` → `resume: false,
  remember: true`, a notice with button `'Resume in Terminal Anyway'`.

Also added, for symmetry/defence (not explicitly required but the same class of gap):
`manualResumeWarning is silent for a panel with an unreported status too (fail open)`.

Mutation-checked both unknown-status paths (and the panel one) by mutating `isIdleStatus` itself
three ways (drop the `'busy'` check, drop the `'waiting'` check, make it always `true`) and each of
the three call sites' negation - **7/7 caught**, run with the fast, focused runner:

```
$ python mutate_fast.py mutate-fixround1-holderpolicy.json out/test/holderPolicy.test.js
isIdleStatus: busy disjunct removed: CAUGHT (3): decideOnFire drops the job silently for a BUSY panel - no spawn, no remember, no notice
isIdleStatus: waiting disjunct removed: CAUGHT (3): decideOnFire drops the job silently for a WAITING panel too
isIdleStatus: always true (everything counts as idle): CAUGHT (6): decideOnFire drops the job silently for a BUSY panel - no spawn, no remember, no notice
decideOnFire: panel isIdleStatus call negated: CAUGHT (5): decideOnFire resumes an IDLE panel as normal - the product's main use case
decideOnFire: terminal !isIdleStatus call double-negated: CAUGHT (6): decideOnFire drops the job silently for a WAITING terminal, regardless of auto-continue
manualResumeWarning: panel isIdleStatus call negated: CAUGHT (4): manualResumeWarning is silent for an idle panel
```

### 3. SCOPE RULING - coordinate on every resume, not only when the holder is `none`

User's ruling: "resume and coordinate" with no condition on which holder made the resume happen.
`src/extension.ts`'s busy-folder-peers gate changed from `holder.kind === 'none'` to
`decision.resume` (still guarded by `rows !== 'unknown'`, which already excludes the listing-failure
case): `decision.resume` is `true` for exactly `'none'`, an idle panel, and a listing failure, and
the last of those has no `rows` to check anyway, so the net effect is "run the check whenever we are
actually about to spawn and have a listing to check" - `'none'` and now an idle panel too.

`test/extension.test.ts`'s `scheduler.onFire does not run the folder-busy check for an idle-panel
resume` asserted the OLD scope; replaced with `scheduler.onFire also adds the coordination sentence
when resuming an IDLE panel, not only "none" (fix round 1 scope ruling)`, which sets up an idle
panel holding the session AND a different, busy session in the same folder, and asserts the resumed
prompt names the peer and mentions SendMessage.

Mutation (reverting the gate to `holder.kind === 'none'` only) - **CAUGHT**:

```
$ python mutate_fast.py mutate-fixround1-extension.json out/test/extension.test.js
onFire: decision.resume gate for busy-peers reverted to holder.kind === 'none' only: CAUGHT (1): scheduler.onFire also adds the coordination sentence when resuming an IDLE panel, not only "none"
```

### 4. MINOR - actual tsc error text for mutation rows 16 and 23

Both reproduced by hand during the first pass and confirmed genuine (not a runner artifact); pasted
here verbatim as requested. Row 16's mutation and line numbers are against the pre-fix-round-1 code
(`holder.status === 'idle'`, not yet `isIdleStatus`) - the underlying TS error class (a branch that
returns unconditionally for a whole discriminant narrows the next branch's type to `never`) is
unchanged by the `isIdleStatus` refactor; the same shape of error reproduces against the current
code for the same reason.

Row 16 - `decideOnFire`, mutating the idle-panel guard from `if (holder.kind === 'panel' &&
holder.status === 'idle')` to `if (holder.kind === 'panel')` (i.e., returning unconditionally for
every panel, which starves the later `if (holder.kind === 'panel')` branch of any possible type):

```
src/holderPolicy.ts(81,7): error TS2367: This comparison appears to be unintentional because the types '"terminal"' and '"panel"' have no overlap.
src/holderPolicy.ts(82,31): error TS2339: Property 'bridged' does not exist on type 'never'.
src/holderPolicy.ts(87,69): error TS2339: Property 'pid' does not exist on type 'never'.
src/holderPolicy.ts(88,19): error TS2339: Property 'status' does not exist on type 'never'.
```

Row 23 - `confirmManualResume`, mutating `if (!warning) { return true; }` to `if (true) { return
true; }` (removing the narrowing that told TypeScript `warning` is defined below):

```
src/extension.ts(561,40): error TS18048: 'warning' is possibly 'undefined'.
src/extension.ts(561,74): error TS18048: 'warning' is possibly 'undefined'.
src/extension.ts(563,21): error TS18048: 'warning' is possibly 'undefined'.
```

### Tests run

```
$ npm test > "$TEMP/t.log" 2>&1; echo "exit=$?"
exit=0
ℹ tests 423
ℹ pass 423
ℹ fail 0

$ npm run test:integration > "$TEMP/it.log" 2>&1; echo "exit=$?"
exit=0
  9 passing (1s)
```

(423 = 420 from the first pass + 3 net new tests: item 1's and item 3's rewritten tests each stayed
a single test in place (net 0 each), and item 2 added 3 - the two terminal-unknown-status
`decideOnFire` tests plus the one panel-unknown-status `manualResumeWarning` test.)

### Files changed (fix round 1)

- `src/holderPolicy.ts` - `isIdleStatus`, and the three guards rewired through it.
- `src/extension.ts` - the busy-folder-peers gate in `scheduler.onFire`.
- `test/holderPolicy.test.ts` - one test rewritten, four new tests.
- `test/extension.test.ts` - one test rewritten (same name changed to describe the new behaviour).
