# Task 5a: Trust hotlink — report

Branch `claude/limit-break-1.0-cloud`, base `f1cb859`. Three commits (see below).

## What was implemented

1. **`buildTrustTerminalOptions(cwd, launcher)`** in `src/resumer.ts` — a pure
   options builder for a plain `claude` terminal: no `--resume`, no prompt
   argument, `cwd` as given, and the environment stripped of every
   `PARENT_SESSION_VARIABLE` exactly like `buildTerminalOptions` does. Named
   `Limit Buster: Trust <basename(cwd)>`, following the existing "Limit
   Buster: " prefix convention. Kept separate from `buildTerminalOptions`
   (rather than calling it with a fake `ResolvedSession`) because that
   function's shape and its embedded session id don't fit a launch that has
   no session.

2. **`claudeLimitBuster.openClaudeToTrust` command** in `src/extension.ts`,
   argument `cwd`:
   - Invoked with anything other than a string (bare Command Palette
     invocation, stale keybinding): logs a warning and does nothing. Hidden
     from the Command Palette via `contributes.menus.commandPalette` +
     `"when": "false"` in `package.json` — the repo had no prior
     `menus.commandPalette` entry to follow, so this is the pattern
     established for it, as the brief allowed.
   - Otherwise: resolves the launcher via the same `findLauncher` the resume
     path's `agents --json` call uses. If no launcher is found, logs an error
     and shows the identical user-visible error the resume launch shows
     (`could not find the claude executable...`) — ruling 1.
   - Resolves `trustedSpelling(cwd, ...)` and launches from that spelling
     when the CLI has one on record, else from `cwd` as given — mirroring
     `resume()`'s own `onRecord ?? job.cwd` pattern.
   - Opens the terminal via `buildTrustTerminalOptions`, calls `.show()`,
     tracks the returned `vscode.Terminal` in a `trustTerminals` Set, and
     logs an info line. Never sends any input into the terminal, never
     writes `~/.claude.json` — constraint 2.

3. **Terminal-close hook** (`vscode.window.onDidCloseTerminal`), also in
   `activate()`: if the closed terminal isn't one `openClaudeToTrust`
   tracked, it's a no-op. If it is: `refreshTrust` runs for **every** pending
   job (ruling 2 — cheap, since `refreshTrust` is mtime-cached per session,
   and it's what catches a job whose `cwd` is a different spelling of the
   folder just trusted), then `status.update(scheduler.current,
   scheduler.jobs.length, settings().statusBar)` is called directly — the
   same render call `scheduler.onChange`'s handler already uses a few lines
   above — so the tooltip's "not trusted" marker clears immediately instead
   of waiting for the next countdown tick. `statusBar.ts` itself is
   untouched.

4. **Notification button**: the untrusted-folder `showInformationMessage` in
   `schedule()` (still gated on `s.notify`, message text unchanged) now adds
   an `Open Claude to Trust` button when `folderTrusted === false`. Clicking
   it runs `claudeLimitBuster.openClaudeToTrust` with that job's `cwd`. A
   trusted folder's notice is unchanged (no button, single-arg
   `showInformationMessage` call as before).

5. **`package.json`**: added the `claudeLimitBuster.openClaudeToTrust`
   command contribution (title following the "Claude Limit Buster: " prefix
   convention) and the `menus.commandPalette` entry hiding it.

### Files changed
- `src/resumer.ts` — `buildTrustTerminalOptions`
- `src/extension.ts` — notification button, command registration, close hook
  (scope kept exactly to those three areas, per the task's scope boundary;
  `src/statusBar.ts` untouched — confirmed via `git diff f1cb859 HEAD --
  src/statusBar.ts` producing zero lines)
- `package.json` — command + commandPalette contribution
- `test/resumer.test.ts` — builder tests
- `test/extension.test.ts` — command/notification/close-hook tests
- `test/helpers/vscode.ts` — added `onDidCloseTerminal` to the fake
  `vscode.window` API and an exported `fireTerminalClose()` helper (module-
  level `FakeEventEmitter`, reused across tests since each test's
  `teardown()` disposes the extension's own subscription)

## Tests and results

### TDD evidence

**Step 1 — `buildTrustTerminalOptions` (RED):**
```
$ npm run compile > /tmp/compile1.log 2>&1; echo exit=$?
exit=2
test/resumer.test.ts(7,3): error TS2724: '"../src/resumer"' has no exported
member named 'buildTrustTerminalOptions'. Did you mean 'buildTerminalOptions'?
```
Expected: the tests were written against a function that did not exist yet.

**Step 1 (GREEN)** after implementing the builder:
```
$ npm run compile && node --test out/test/resumer.test.js
...
# tests 27
# pass 27
# fail 0
```

**Step 2 — command/notification/close-hook (RED):**
```
$ npm run compile   # exit=0 (command lookup is dynamic, so this compiles;
                     # the failure surfaces at runtime instead)
$ node --test out/test/extension.test.js
not ok 35 - the command opens exactly one plain-claude terminal at the given cwd
not ok 36 - the command launches from the trusted spelling on record, not the given cwd, when one exists
not ok 37 - invoked with no cwd (e.g. the Command Palette), the command opens nothing and logs
not ok 38 - the command shows an error and opens nothing when claude cannot be found
not ok 39 - the untrusted-folder notice offers "Open Claude to Trust", and clicking it opens the terminal
not ok 41 - closing the trust terminal re-reads trust immediately, without waiting for the next tick
```
Failure detail for test 35 (representative — `trustCommand()` resolves to
`undefined` because the command was not yet registered):
```
error: 'trustCommand(...) is not a function'
name: 'TypeError'
```
Expected: the command didn't exist, so every test that calls it failed the
same way; the two negative tests (40, 42 — "must not offer/trigger") passed
vacuously, which is correct for assertions of absence.

**Step 2 (GREEN)** after implementing extension.ts + package.json:
```
$ npm run compile && node --test out/test/extension.test.js
...
# tests 87
# pass 87
# fail 0
```

### Full unit suite
```
$ npm test > /tmp/t5a.log 2>&1; echo "exit=$?"
exit=0
# tests 496
# pass 496
# fail 0
# cancelled 0
# skipped 0
```
(496 = 495 pre-existing + 1 mutation-guard test added after the mutation
pass below found a gap.)

## Mutation table

Runner: `python3 .superpowers/sdd/2026-09-25-limit-break-1.0-cloud/mutate.py`
against a spec of the 6 new guards/branches this task introduced (focused on
`out/test/extension.test.js`; `buildTrustTerminalOptions` has no
conditionals to mutate — its three assertions in `test/resumer.test.ts`
directly pin every field it returns).

| Guard (file:approx.) | Mutation | Result | Red test |
|---|---|---|---|
| `if (folderTrusted === false) {` selecting the button-vs-plain notice, `extension.ts` (schedule) | condition forced to `false` (button never shown) | **CAUGHT** | `the untrusted-folder notice offers "Open Claude to Trust", and clicking it opens the terminal` |
| `if (choice === TRUST_BUTTON) {` dispatching the command on click | condition forced to `true` (any answer dispatches) | **CAUGHT** | `dismissing the untrusted-folder notice opens no terminal` (added after this mutation surfaced the gap — see below) |
| `if (typeof cwd !== 'string') {` no-cwd guard, `openClaudeToTrust` | condition forced to `false` | **DID NOT COMPILE** — with the guard gone, `cwd` stays `string \| undefined` past this point and every later use (`trustedSpelling(cwd, ...)`, `buildTrustTerminalOptions(... , cwd)`, template interpolation aside) fails `tsc`'s strict check | n/a — compiler itself is the check |
| `if (!launcher) {` missing-launcher guard, `openClaudeToTrust` | condition forced to `false` | **DID NOT COMPILE** — `launcher` stays `Launcher \| undefined`, and `buildTrustTerminalOptions(onRecord ?? cwd, launcher)` requires `Launcher` | n/a — compiler itself is the check |
| `onRecord ?? cwd` spelling fallback | forced to always use `cwd` (ignore the trusted spelling) | **CAUGHT** | `the command launches from the trusted spelling on record, not the given cwd, when one exists` |
| `if (!trustTerminals.delete(terminal)) { return; }` close-hook guard | guard dropped (every closing terminal re-checks trust) | **CAUGHT** | `closing an unrelated terminal does not re-read trust` |

Runner output (all 6, `SPEC ERROR` count 0, overall exit 0 — both `CAUGHT`
and `DID NOT COMPILE` count as pass per the runner's own header):
```
CAUGHT  notice button branch: folderTrusted===false always false (never offer the button)
    red: the untrusted-folder notice offers "Open Claude to Trust", and clicking it opens the terminal
CAUGHT  clicking the trust button guard dropped (any answer opens the terminal)
    red: dismissing the untrusted-folder notice opens no terminal
DID NOT COMPILE  openClaudeToTrust no-cwd guard dropped
DID NOT COMPILE  openClaudeToTrust missing-launcher guard dropped
CAUGHT  trust terminal launches from the given cwd, ignoring the recorded spelling
    red: the command launches from the trusted spelling on record, not the given cwd, when one exists
CAUGHT  close hook re-checks trust for every closing terminal, not just ours
    red: closing an unrelated terminal does not re-read trust
```
After the run, `git status`/`git diff --stat` confirmed `src/extension.ts`
was byte-identical to its pre-mutation state (mutate.py's own restore, plus
independent confirmation here) — only `test/extension.test.ts` had a diff,
which was the deliberate dismiss-path test added afterward. Full suite was
re-run green (496/496, exit 0) after that addition, and committed separately.

## Integration tests

`test/integration/extension.itest.ts` was **not** changed. Its "every
command the manifest declares is registered" test only enumerates
`resumeNow`, `cancel`, `showLog` (it already omits `statusBarMenu`, an
existing command), so it does not assert an exhaustive command list and
needed no update for the new `openClaudeToTrust` command. It compiles
cleanly as part of `npm run compile` (included via the `test/**/*.ts`
tsconfig glob) — confirmed with the same `tsc -p .` run used for the unit
suite above.

**Cannot run here** (constraint 6: `vscode-test` needs
`update.code.visualstudio.com`, blocked in this container).
**Integration-pending for a run elsewhere:**
- `the extension is present and activates` — unaffected in substance, but
  worth a real run since `activate()` grew a new subscription
  (`onDidCloseTerminal`) and a new Set.
- `every command the manifest declares is registered` — would be worth
  extending, on a future task or by the controller, to also assert
  `openClaudeToTrust` is registered; not required by this task's brief
  since the test doesn't currently enumerate the full list, but flagging it
  as a natural follow-up.
- No existing integration test exercises trust or terminals beyond the
  `resume terminal environment` suite (which is about `TerminalOptions.env`
  nulling generally, not this command) — nothing there needed updating.

## Self-review

- **Scope boundary**: `src/statusBar.ts` diff against `f1cb859` is empty
  (`git diff f1cb859 HEAD -- src/statusBar.ts | wc -l` → 0). `extension.ts`
  edits are confined to the notification in `schedule()`, the new command
  registration, and the terminal-close hook, as instructed; no reformatting
  or moving of unrelated code (diff is a clean insertion, verified by
  reading the full `git diff f1cb859 HEAD -- src/extension.ts`).
- **Constraint 2**: nothing in the new code calls `terminal.sendText`,
  writes to `~/.claude.json`, or otherwise answers the trust dialog. The
  only writes are `trustTerminals.add/delete` (an in-memory Set) and the
  usual log/notification calls. `readClaudeUserConfig` is read-only, as
  before.
- **Constraint 4** (`--resume` only ever gets a UUID): untouched by this
  task — the trust terminal never passes `--resume` at all.
- **Tests assert behaviour, not mocks**: every new extension-level test
  drives `activate()` through the real command/event wiring and asserts on
  the fake terminal's recorded `options` (shellPath/shellArgs/cwd/name) and
  the status-bar tooltip text, not on internal call counts.
- **YAGNI**: no tooltip/statusBar changes (Task 5b), no attempt to detect
  *when* the user actually answers the dialog beyond the terminal closing
  (as specified), no extra configuration surface.
- **Command palette hiding**: repo had no prior `menus.commandPalette`
  entry; used `"when": "false"` as the brief's fallback instructs, and said
  so above.
- **Pristine output**: `npm test` output is quiet apart from the standard
  `node --test` TAP summary; no stray `console.log`/debug output was added.

### Concerns

- **Possible textual overlap with Task 4**: Task 4 is described as
  editing `extension.ts` "around resume-failure paths" in a separate
  branch. My changes don't touch `resume()` itself, but they do add a new
  `trustTerminals` Set declaration and a large block at the very end of the
  `context.subscriptions.push(...)` array (right after the existing
  `statusBarMenu` registration), plus one `import` line and one top-level
  `const TRUST_BUTTON` near `NS`. A merge with Task 4's branch will most
  likely be a clean interleave (different call sites), but if Task 4 also
  appends to the end of that same `push(...)` array or edits the exact
  `if (s.notify) { ... }` block in `schedule()`, expect a textual conflict
  there — nothing semantic, just adjacent lines.
- The launcher-missing-executable unit test
  (`the command shows an error and opens nothing when claude cannot be
  found`) relies on a made-up command name
  (`clb-test-definitely-not-a-real-claude-binary`) not being resolvable via
  `which`/`where` on the machine running the suite. This is the same
  assumption other tests in this file already make about `LAUNCHER` (a
  fixed path) being usable without touching PATH; it held on this
  container, but is worth knowing if it's ever run somewhere `which`
  behaves unusually.
- `buildTrustTerminalOptions`'s terminal name is
  `Limit Buster: Trust <basename(cwd)>` — a naming choice (not specified
  verbatim by the brief beyond "a recognisable terminal name using the
  existing 'Limit Buster: ' prefix convention"). Flagging in case Task 8's
  rename or a reviewer wants a different suffix.

## Commits

- `69ad673` — feat(resumer): add buildTrustTerminalOptions for the trust hotlink
- `d70840d` — feat: add openClaudeToTrust command (Task 5a trust hotlink)
- `9b44133` — test: cover the dismiss path of the trust-hotlink notice button

Not pushed (controller pushes, per constraint 1). No branch switches, no
rebase/reset.

---

## Fix round 1

Base for this round: current HEAD at the time (`25b6b28`, after the
controller's `.superpowers/`-only bookkeeping commits `a14e475`, `650d7a5`,
`25b6b28`) — no rebase, no reset; those commits were already present locally.

### Issue

Reviewer: ruling 2 ("`refreshTrust` for EVERY pending job") was untested. The
only close-hook test schedules a single job, so narrowing the loop at
`src/extension.ts` (`for (const job of scheduler.jobs) { refreshTrust(job); }`)
to `refreshTrust(scheduler.current)` passes the whole suite unnoticed
(reviewer's mutation: SURVIVED, 87/87).

### What changed

Added one test to `test/extension.test.ts`: **"closing the trust terminal
re-reads trust for every pending job, not just the current one"**.

The status-bar tooltip only ever renders `scheduler.current` (the soonest
job), so a test built around the tooltip structurally cannot distinguish
"refreshed every job" from "refreshed only the current one" unless the
non-current job is later promoted to current — and promoting it via any
scheduler event (`cancel`, a new `schedule`, a tick) itself fires
`onChange`, whose handler already calls `refreshTrust` on the new current
job, which would silently repair the very state the mutation broke and mask
the bug again.

Instead the new test reads the second job's `folderTrusted` directly back
out of the scheduler's persisted state (the `Map` the fake `globalState`
wraps, captured via `contextOver(store)`). `ResumeScheduler.persist()` writes
`this.jobs` — an array of the *same* `PendingJob` object references held in
its internal `Map` — into that store, and `refreshTrust` mutates
`job.folderTrusted` in place on those same references. So reading
`store.get('claudeLimitBuster.pending')` after the close event reflects
exactly what the close hook did to a job that was never current and never
rendered anywhere, with no dependency on any later promotion or on-tick
refresh.

Test shape:
1. Two pending jobs, `SESSION` (sooner deadline, stays `scheduler.current`
   for the whole test, cwd = `REAL_CWD`) and `SESSION_B` (later deadline,
   never current, cwd = a fresh `fs.mkdtempSync` directory) — both start
   untrusted.
2. Open the trust terminal for `SESSION_B`'s folder specifically
   (`trustCommand()!(dirB)`), then mark only `dirB` as trusted
   (`trustedCwds = new Set([dirB])`) — `SESSION`'s folder is deliberately
   left untrusted throughout, so nothing about `SESSION`'s own tooltip can
   make the test pass by accident.
3. Fire the close event and assert `SESSION_B`'s persisted `folderTrusted`
   flipped to `true`.

### Covering tests / commands / output

**Compile + the new test, in isolation (confirms it's green against the
correct implementation):**
```
$ npm run compile; echo exit=$?
exit=0
$ node --test out/test/extension.test.js | grep -A3 "every pending job"
ok 43 - closing the trust terminal re-reads trust for every pending job, not just the current one
  ---
  duration_ms: 3.632192
```

**Mutation re-run, the reviewer's exact mutation:**
```json
{
  "file": "src/extension.ts",
  "name": "close hook narrowed to refreshTrust(scheduler.current) only",
  "old": "      for (const job of scheduler.jobs) {\n        refreshTrust(job);\n      }",
  "new": "      refreshTrust(scheduler.current);",
  "tests": ["out/test/extension.test.js"]
}
```
```
$ python3 .superpowers/sdd/2026-09-25-limit-break-1.0-cloud/mutate.py <spec>
CAUGHT  close hook narrowed to refreshTrust(scheduler.current) only
    red: closing the trust terminal re-reads trust for every pending job, not just the current one
```
Confirmed: **CAUGHT**, with the new test as the named red test — matches the
reviewer's ask exactly. `src/extension.ts` verified byte-restored afterward
(`git diff --stat` showed only `test/extension.test.ts`).

**Full unit suite:**
```
$ npm test > /tmp/t5a.log 2>&1; echo "exit=$?"
exit=0
# tests 497
# pass 497
# fail 0
```
(497 = 496 from the initial round + this one new test.)

**Integration suite (now runnable in this container):**
```
$ xvfb-run -a npm run test:integration > /tmp/it5a.log 2>&1; echo "exit=$?"
...
  claude-limit-buster activation
    ✔ the extension is present and activates
    ✔ every command the manifest declares is registered
    ✔ resuming with nothing pending opens no terminal
    ✔ cancelling with nothing pending is harmless
    ✔ the declared settings reach the configuration API with their declared defaults
    ✔ the execution-adjacent settings are machine-scoped in the running instance
  resume terminal environment
    ✔ a variable set to null in TerminalOptions.env is removed from the child process (919ms)
  9 passing (2s)
exit=0
```
The `Failed to fetch` / SSL-handshake lines earlier in that log are VS Code's
own background marketplace/update calls, as noted — not related to this
extension's code.

### Commit

- `18fad58` — test: cover refreshTrust for every pending job, not just current (fix round 1)

Nothing outside `test/extension.test.ts` and this report file was touched
this round; `.superpowers/` was left alone apart from this report, per the
coordinator's note.
