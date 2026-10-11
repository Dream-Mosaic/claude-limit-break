# 1.1 Live Continue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue a live, idle Claude Code session in place (through a Claude Code mod or the session's inbox socket) instead of launching a second `claude --resume`, plus the other 1.1 decisions (D9 to D12).

**Architecture:** Pure modules with injected IO, like the rest of `src/`: `inbox.ts` (socket transport), `modStatus.ts` (the extension's half of the mod protocol), `continueInPlace.ts` (choose transport, send, confirm, last look), `sessionOpener.ts` (the open-session button), `modInstall.ts` (install the mod), `lateFire.ts` (D10). `holderPolicy.ts` gains the new outcomes; `extension.ts` wires them. The mod is a plain-JavaScript Claude Code plugin in `mod/` (ES modules, `.mjs`), with its pure logic in `mod/hooks/control.mjs`, which the node suite also tests.

**Tech Stack:** TypeScript 5 (commonjs, ES2022), `node:test`, VS Code API ^1.138, Node 24 in CI (needed for `require()` of the `.mjs` module), Claude Code mods API as declared for 2.1.296.

**Spec:** [docs/superpowers/specs/2026-10-09-live-continue-and-mod-design.md](../specs/2026-10-09-live-continue-and-mod-design.md). Read it before any task.

## Progress

Tick a task's box here when its commit lands, and commit this file with it, so a resumed session knows where it is. Branch: `feat/1.1-live-continue`.

- [x] Task 1: Late fire (D10)
- [x] Task 2: No offer-only route (D12)
- [x] Task 3: The `continueInPlace` setting and the new fire-time outcomes (D8, D9)
- [x] Task 4: Session record fields for the inbox
- [ ] Task 5: `inbox.ts`, the socket transport
- [ ] Task 6: The mod
- [ ] Task 7: `modStatus.ts`, the extension's half of the mod protocol
- [ ] Task 8: `continueInPlace.ts`
- [ ] Task 9: `sessionOpener.ts`, the open-session button
- [ ] Task 10: Wire continue-in-place, the waiting notice and the bridged head start into `extension.ts`
- [ ] Task 11: Show bridged sessions (D11 indicator)
- [ ] Task 12: Install the mod (`modInstall.ts`, commands, packaging)
- [ ] Task 13: Docs, version 1.1.0, smoke kit

## Standing permission

The user gave standing permission (2026-10-11) to read a session's `peerToken` from `~/.claude/sessions/<pid>.<hash>.key` for this work. Never print, log or commit a token. Tests use fabricated tokens only.

## Global Constraints

- **No runtime dependencies.** `package.json` has none; add none. Dev tooling stays as is.
- **Node 24** in CI. `require()` of an ES module (`.mjs`) is used by the node suite to test the mod's pure module.
- **`claude --resume` only ever receives a UUID** (`isSessionId`), as today.
- **Never log or show a peer token.**
- **Notices** start with `Limit Break: ` and name a session by its first 8 characters.
- **Constants (exact):** confirm window `60_000` ms, confirm poll `1_000` ms, late fire `10 * 60_000` ms, bridged head start `5 * 60_000` ms after `baseResumeAtMs`, control entry lifetime `120_000` ms, socket close delay `2_000` ms.
- **Files:** `~/.limit-break/sessions/<sessionId>.json` (mod writes), `~/.limit-break/control/<sessionId>.json` (extension writes). `~` is `os.homedir()` in the extension, `USERPROFILE` (Windows) or `HOME` in the mod.
- **Envelope (exact):** `<cross-session-message from="uds:limit-break" from-name="limit-break">` + `\n` + body + `\n` + `</cross-session-message>`.
- **Payload (exact keys):** `{"msgV":1,"msg_id":<uuid>,"type":"user","message":{"role":"user","content":<envelope>},"priority":"next","session_id":<session>}` followed by `\n`; on any platform, an auth line `{"type":"auth","token":<peerToken>}\n` first when a key file exists.
- **Control body (exact):** `[limit-break-control v1] ` + `JSON.stringify({ jobId, nonce, prompt })`. `jobId` is the job's claim key (`claimKeyFor(job)`).
- **Mod id:** plugin `limit-break`, marketplace `limit-break`, so `limit-break@limit-break`, user scope.
- **Version:** 1.1.0 (`package.json` and `mod/.claude-plugin/plugin.json`).
- **Mod source** is `.mjs` (the VSIX excludes `**/*.ts`). The mod uses only `$` and ECMAScript built-ins; no Node APIs.

## Decisions taken while planning (report these at the end)

Each is derived from the code or the 2.1.296 mod types, not from the spec:

1. **The mod can't learn its own pid.** The types expose no pid. So the extension uses the mod only when its status file's `loadedAtMs` is at or after the holder process's `startedAt` (from `~/.claude/sessions/<pid>.json`). A file left by an earlier process is older than the live one and is ignored.
2. **The mod can't delete a file** (`$.fs` has no delete). When the process moves to another session (`/clear`, resume, fork), it marks the old file `movedTo: <new id>` and the extension treats it as absent.
3. **Native auto-continue notices from the mod are logged, not acted on.** The `quota_auto_resume_*` notification types are unverified in the panel (the spike write-up lists them as not tested), so the transcript check stays the authority.
4. **`continueInPlace` is a boolean** (a checkbox: on is `true`), not an `on`/`off` string.
5. **No folder watcher for status files.** They are read on demand while choosing a transport and confirming. So `watchScope` needs no change: only sessions already in scope reach a continue.
6. **`maxResumeTokens` needs no change.** It is enforced at detection (`planResume` refuses), before any fire, so a continue in place is already gated.
7. **An "Install Claude Code mod" command** is added beside "Remove", so "Never" can be undone.
8. **The bridged lookup at schedule time** uses the same synchronous `claude agents --json` listing as the fire, only when a new job is actually scheduled.

## Review Focus

1. **A status file from an earlier process** (the mod since uninstalled, or the session reopened without it): the extension must use the socket, never send a control message the model would read as a peer message. Pinned in Task 7 (`modUsable` false when `loadedAtMs < startedAtMs`).
2. **The process died between the listing and the send** (pipe gone): the send rejects and the continue falls back at once, without waiting 60 s. Pinned in Task 5 (connect to a missing pipe rejects) and Task 8 (send rejects gives `fallback`).
3. **The user types into the panel during the confirm window:** the last look sees the new turn and nothing launches. Pinned in Task 8 (`landed-late`).
4. **A second control message for the same job** (two windows, a replay): the mod refuses a job id it already continued. Pinned in Task 6 (`acceptControl` rejects a job in `continued`).
5. **A half-written status file** (`$.fs.write` isn't atomic): read as absent, so the socket is used. Pinned in Task 7 (`parseModStatus` of a truncated file is `undefined`).

---

### Task 1: Late fire (D10)

**Files:**
- Create: `src/lateFire.ts`, `test/lateFire.test.ts`
- Modify: `src/extension.ts` (in `scheduler.onFire`, right after the claim block that ends `log.info(\`Resume for ... ${holder}; dropping.\`); return; }`)
- Test: `test/extension.test.ts`

**Interfaces:**
- Produces: `LATE_FIRE_MS: number`, `lateByMinutes(resumeAtMs: number, nowMs: number): number | undefined`

- [ ] **Step 1: Branch.** `git checkout spec/1.1-live-continue && git checkout -b feat/1.1-live-continue`. (Task 1 only; later tasks continue on this branch.)

- [ ] **Step 2: Write the failing unit test** `test/lateFire.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LATE_FIRE_MS, lateByMinutes } from '../src/lateFire';

test('a fire up to ten minutes late is on time', () => {
  assert.equal(LATE_FIRE_MS, 600_000);
  assert.equal(lateByMinutes(1_000_000, 1_000_000), undefined);
  assert.equal(lateByMinutes(1_000_000, 1_000_000 + 9 * 60_000), undefined);
  assert.equal(lateByMinutes(1_000_000, 1_000_000 + LATE_FIRE_MS), undefined, 'exactly ten minutes is still on time');
});

test('a fire more than ten minutes late reports whole minutes', () => {
  assert.equal(lateByMinutes(0, LATE_FIRE_MS + 1), 10);
  assert.equal(lateByMinutes(0, 11 * 60_000 + 59_000), 11);
  assert.equal(lateByMinutes(0, 26 * 3_600_000), 1560);
});
```

- [ ] **Step 3: Run it to see it fail.** `npm test` → compile error, `../src/lateFire` not found.

- [ ] **Step 4: Implement** `src/lateFire.ts`:

```ts
/**
 * How late past its scheduled time an automatic fire may be and still resume (D10). Later than this, nothing was running on schedule: VS Code was closed, or the machine slept through the deadline. The person who just opened VS Code or woke the machine is there, so the session is left to them.
 */
export const LATE_FIRE_MS = 10 * 60_000;

/** Whole minutes late when `nowMs` is more than LATE_FIRE_MS past `resumeAtMs`; undefined when the fire is on time. */
export function lateByMinutes(resumeAtMs: number, nowMs: number): number | undefined {
  const late = nowMs - resumeAtMs;
  return late > LATE_FIRE_MS ? Math.floor(late / 60_000) : undefined;
}
```

- [ ] **Step 5: Wire it into `onFire`.** In `src/extension.ts` add `import { lateByMinutes } from './lateFire';` and, directly after the claim block (`if (holdClaim(...) === 'taken') { ... return; }`) and before the `hasContinued(job)` check:

```ts
      // D10: a fire well past its time means nothing was running on schedule (VS
      // Code closed, or the machine asleep), and whoever just opened or woke it is
      // there. Dropped with a log line, whatever autoResume says; the claim is KEPT
      // so other windows drop their copies too. Resume Now is unaffected.
      const lateMin = lateByMinutes(job.resumeAtMs, Date.now());
      if (lateMin !== undefined) {
        log.info(
          `Resume for ${job.sessionId.slice(0, 8)} came due while VS Code wasn't running (${lateMin} min late); leaving it to you.`,
        );
        return;
      }
```

- [ ] **Step 6: Write the extension tests** (append to `test/extension.test.ts`, using its helpers `contextOver`, `start`, `teardown`, `oneTick`, `offers`, `pastJob`, `LAUNCHER`):

```ts
const lateJob = (minutesLate: number) => {
  const resumeAtMs = Date.now() - minutesLate * 60_000;
  return { ...pastJob(), resumeAtMs, baseResumeAtMs: resumeAtMs };
};

test('D10: a resume restored more than ten minutes late is dropped with a log line', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', lateJob(11)]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 0, 'a late fire must not launch');
    assert.equal(offers().length, 0, 'a late fire must not offer either');
    assert.ok(
      vscodeFake.outputLines.some((l) => l.includes("came due while VS Code wasn't running (11 min late)")),
      vscodeFake.outputLines.join('\n'),
    );
  } finally {
    teardown(ctx);
  }
});

test('D10: with autoResume off, a late fire is dropped instead of offered', async () => {
  resetVscodeFake();
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', lateJob(30)]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(offers().length, 0);
    assert.equal(vscodeFake.terminals.length, 0);
  } finally {
    teardown(ctx);
  }
});

test('D10: a fire nine minutes late still resumes', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', lateJob(9)]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(vscodeFake.terminals.length, 1);
  } finally {
    teardown(ctx);
  }
});
```

- [ ] **Step 7: Run `npm test`.** All pass. If an existing test restores a job more than ten minutes old and expects a resume or an offer, make its job recent (`pastJob()`), keeping what it tests; say so in the commit message.

- [ ] **Step 8: Commit.** Tick Task 1 in this plan's Progress list. `git add -A && git commit -m "feat: drop a resume that fires more than ten minutes late (D10)"` (with the Co-Authored-By trailer).

---

### Task 2: No offer-only route (D12)

**Files:**
- Modify: `src/policy.ts`, `src/scheduler.ts`, `src/statusBar.ts`, `src/extension.ts`, `src/parsers/limitParser.ts` (comments only), `src/transcriptWatcher.ts` (comments only), `README.md`, `package.json`, `test/smoke/README.md`
- Test: `test/policy.test.ts`, `test/scheduler.test.ts`, `test/restoreJob.test.ts`, `test/statusBar.test.ts`, `test/extension.test.ts`

**Interfaces:**
- Produces: `Plan` gains `{ kind: 'beyond'; sessionId: string; cwd?: string; resetAtMs: number; rateLimitType?: string }`. `PendingJob.offerOnly` and `ResumeScheduler.onUpgrade` are removed. `LimitDetection.offerOnly` stays: it now means "beyond maxWaitHours" only.

- [ ] **Step 1: Policy test first.** In `test/policy.test.ts`, replace the test(s) asserting `job.offerOnly` with:

```ts
test('a reset beyond maxWaitHours plans nothing: it is announced, not scheduled (D12)', () => {
  const resumeAt = new Date(Date.now() + 3 * 24 * 3_600_000);
  const plan = planResume(
    { detection: { resumeAt, text: 'weekly limit', rateLimitType: 'seven_day', offerOnly: true }, cwd: '/w', file: `/h/.claude/projects/p/${SESSION}.jsonl` },
    'limit', settingsWith({}), () => 10, new Date(), () => 0,
  );
  assert.deepEqual(plan, { kind: 'beyond', sessionId: SESSION, cwd: '/w', resetAtMs: resumeAt.getTime(), rateLimitType: 'seven_day' });
});
```

Use the file's existing helpers for settings and session ids (rename `settingsWith`/`SESSION` to whatever `test/policy.test.ts` already uses). Also assert the budget is not consulted for a `beyond` plan: pass `readUsage` that throws, and expect the same plan.

- [ ] **Step 2: Run `npm test`, see it fail.**

- [ ] **Step 3: Implement in `src/policy.ts`.** Add the `beyond` member to `Plan` with a doc comment ("A reset beyond maxWaitHours (D12): announced once at detection, never scheduled."). After `const session = resolveSession(...)` and its `ignore`, before the budget check:

```ts
  if (hit.detection.offerOnly === true && hit.detection.resumeAt !== undefined) {
    return {
      kind: 'beyond',
      sessionId: session.sessionId,
      ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
      resetAtMs: hit.detection.resumeAt.getTime(),
      ...(hit.detection.rateLimitType !== undefined ? { rateLimitType: hit.detection.rateLimitType } : {}),
    };
  }
```

Remove the `offerOnly` spread from the scheduled job.

- [ ] **Step 4: Scheduler and restore.** In `src/scheduler.ts`:
  - Delete `offerOnly` from `PendingJob`.
  - In `restoreJob`, replace the `offerOnly` check with: `if (j.offerOnly !== undefined) { return { dropped: 'it is an offer-only resume from 1.0, which this version no longer keeps' }; }` (both the pending and the ready list go through it).
  - In `schedule()`, delete `touchesOffer` and the three offer-only branches; keep `sameLimitReset` only if still used (it isn't: delete it) and keep the exact-base dedupe and `adoptReDetection` as they are.
  - Delete `onUpgradeEmitter`, `onUpgrade` and its `dispose()` line, and the offer-only bullet points from `schedule()`'s doc comment.
  - Tests: in `test/scheduler.test.ts` delete the offer-only and upgrade tests; in `test/restoreJob.test.ts` replace offer-only cases with one asserting `restoreJob({ ...valid, offerOnly: true })` is `{ dropped: 'it is an offer-only resume from 1.0, which this version no longer keeps' }`.

- [ ] **Step 5: Status bar.** In `src/statusBar.ts` remove `offerOnly` from `buildSessionLine`'s entry, the `Entry` interface and the job mapping, the `**manual**` branch, and the `(manual)` pill text (`this.item.text = \`$(clock) Claude resumes in ...\``). Delete the matching tests in `test/statusBar.test.ts`.

- [ ] **Step 6: Extension.** In `src/extension.ts`:
  - Delete `announceOfferOnly`, `announceUpgrade`, the `scheduler.onUpgrade(...)` subscription, the `if (job.offerOnly) {...}` block in `schedule()`, and the `|| job.offerOnly` part of the `onFire` autoResume branch with its offer-only log wording (the branch keeps only `Cooldown elapsed for ...; autoResume is off, so it is waiting for you.`).
  - Widen `announceOnce`'s first parameter to `{ sessionId: string; baseResumeAtMs: number; resumeAtMs: number; reason: 'limit' | 'overload'; entryTimestampMs?: number }`.
  - Add, beside `announceOnce`:

```ts
  /**
   * D12: a limit that resets beyond maxWaitHours is told once (across windows,
   * on its own claim) and never scheduled. Someone at the prompt continues it
   * themselves; hitting it again within maxWaitHours schedules an ordinary resume.
   */
  const announceBeyond = (plan: { sessionId: string; resetAtMs: number; rateLimitType?: string }, s: Settings): void => {
    const label = limitLabel(plan);
    const message =
      `Limit Break: session ${plan.sessionId.slice(0, 8)} hit ${article(label)} ${label} limit that resets ` +
      `${new Date(plan.resetAtMs).toLocaleString()}. That's more than ${s.maxWaitHours} hours away, ` +
      `so it won't resume automatically.`;
    announceOnce(
      { sessionId: plan.sessionId, baseResumeAtMs: plan.resetAtMs, resumeAtMs: plan.resetAtMs, reason: 'limit' },
      s,
      'beyond-notice',
      message,
      'beyond-maxWaitHours',
    );
  };
```

  - In `onDetection`, after the `ignore` return add `if (plan.kind === 'beyond') { if (gaveUp.detected(plan.sessionId)) { render(); } announceBeyond(plan, s); return; }`. Fix the later ternaries so they type-check (`plan.kind === 'refuse' ? plan.sessionId : plan.job.sessionId` stays valid once `beyond` has returned).

- [ ] **Step 7: Extension tests.** In `test/extension.test.ts` remove or rewrite every offer-only test (search `offerOnly`, `(manual)`, `upgrade`). Keep one end-to-end test:

```ts
test('D12: a reset beyond maxWaitHours is announced once and nothing is scheduled', async () => {
  resetVscodeFake();
  vscodeFake.config = { claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 };
  const store = new Map<string, unknown>();
  const ctx = contextOver(store);
  start(ctx);
  try {
    FakeWatcher.latest!.limitFor(SESSION, new Date(Date.now() + 3 * 86_400_000), REAL_CWD, undefined, 'seven_day', true);
    await flush();
    assert.equal(store.get('claudeLimitBreak.pending'), undefined, 'nothing may be scheduled');
    const notice = vscodeFake.info.find((m) => m.message.includes("won't resume automatically"));
    assert.ok(notice, JSON.stringify(vscodeFake.info));
    assert.ok(notice.message.includes('weekly'), notice.message);
    assert.equal(notice.items.length, 0, 'no button: nothing will be offered later');
  } finally {
    teardown(ctx);
  }
});
```

- [ ] **Step 8: Docs.** Rewrite README "## Limits that reset more than a day out":

```markdown
A weekly limit can reset days from now. Limit Break resumes automatically only
when the reset is within `maxWaitHours` (24 hours by default), the same line
Claude Code draws for its own auto-continue. A later reset isn't scheduled:

- When it is detected, you are told once (not once per window) when `notify`
  is on; the output channel always logs it: "Limit Break: session `<id8>` hit
  a weekly limit that resets `<date and time>`. That's more than 24 hours away,
  so it won't resume automatically." Nothing waits for it, so the status bar
  doesn't show it.
- When it resets, continue the session yourself.
- Raising `maxWaitHours` turns a longer reset into an automatic one.
- Each new limit hit is judged again: hit the same limit once its reset is
  within `maxWaitHours`, and it is scheduled like any other.
```

  Keep the paragraph about resets more than 8 days out and the reset-time paragraph after it unchanged. Replace the `maxWaitHours` settings row text and `package.json`'s `claudeLimitBreak.maxWaitHours` description with: "Resume automatically only when the limit resets within this many hours. A later reset (a weekly limit, for example) is announced once and not scheduled; continue the session yourself when it resets. Each new limit hit is judged again. A reset more than 8 days out, or beyond `maxWaitHours` if that is higher, is rejected as a misread." (README row keeps its "See [Limits that reset more than a day out]" link.) In `test/smoke/README.md` Part 2, change session C's and row X2's expectations to "announced once at detection; nothing scheduled; no status-bar line". Update comments in `limitParser.ts` and `transcriptWatcher.ts` that say a beyond-maxWaitHours reset is "offered" to say it is "announced, not scheduled".

- [ ] **Step 9: Run `npm test`.** All pass.

- [ ] **Step 10: Commit.** Tick Task 2. `git commit -m "feat: announce a reset beyond maxWaitHours once and schedule nothing (D12)"`.

---

### Task 3: The `continueInPlace` setting and the new fire-time outcomes

**Files:**
- Modify: `src/config.ts`, `package.json` (configuration), `README.md` (settings table), `src/holderPolicy.ts`, `src/extension.ts` (the one `decideOnFire` call and the one `manualResumeWarning` call: pass `false` for now; Task 10 passes the setting)
- Test: `test/config.test.ts`, `test/holderPolicy.test.ts`

**Interfaces:**
- Produces: `Settings.continueInPlace: boolean` (default `true`).
- Produces: `export function isIdleStatus(status: string | undefined): boolean` (now exported).
- Produces: `decideOnFire(holder, autoContinueOn, shortId, reason, rateLimitType, continueInPlaceOn: boolean)`; `OnFireDecision` gains:

```ts
  /** Continue the live, idle holder in place (mod or socket) instead of launching (D5, D8). */
  continueInPlace?: { pid: number; kind: 'panel' | 'terminal'; bridged: boolean };
  /** The notice's button opens this holder instead of resuming (D9). */
  openSession?: { pid: number; kind: 'panel' | 'terminal' };
```

- Produces: `manualResumeWarning(holder, shortId, continueInPlaceOn = false)`.
- Produces: `export const OPEN_SESSION_BUTTON = 'Open Session';`

- [ ] **Step 1: Failing tests.** In `test/config.test.ts`: `readSettings` default has `continueInPlace: true`; `false` is kept; a non-boolean falls back to `true`. In `test/holderPolicy.test.ts` add (adapting existing helpers):

```ts
const panel = (status: string | undefined, bridged = false) => ({ kind: 'panel' as const, pid: 77, bridged, status });
const terminal = (status: string | undefined) => ({ kind: 'terminal' as const, pid: 88, status });

test('an idle panel is continued in place when the setting is on', () => {
  const d = decideOnFire(panel('idle', true), true, 'abcd1234', 'limit', 'five_hour', true);
  assert.equal(d.resume, false);
  assert.equal(d.remember, false);
  assert.deepEqual(d.continueInPlace, { pid: 77, kind: 'panel', bridged: true });
  assert.equal(d.notice, undefined);
});

test('with the setting off an idle panel launches, as in 1.0', () => {
  const d = decideOnFire(panel('idle'), true, 'abcd1234', 'limit', 'five_hour', false);
  assert.equal(d.resume, true);
  assert.equal(d.continueInPlace, undefined);
});

for (const [name, holder] of [['panel', panel('waiting')], ['terminal', terminal('waiting')]] as const) {
  test(`a waiting ${name} gets a notice with an open-session button, not a silent drop (D9)`, () => {
    const d = decideOnFire(holder, true, 'abcd1234', 'limit', 'five_hour', true);
    assert.equal(d.resume, false);
    assert.equal(d.remember, false);
    assert.equal(d.notice?.button, 'Open Session');
    assert.match(d.notice!.message, /^Limit Break: session abcd1234 is waiting for your input in (a Claude panel|a terminal); the limit has reset\.$/);
    assert.deepEqual(d.openSession, { pid: holder.pid, kind: holder.kind });
  });
}

test('busy stays a silent drop', () => {
  for (const holder of [panel('busy'), terminal('busy')]) {
    const d = decideOnFire(holder, true, 'abcd1234', 'limit', 'five_hour', true);
    assert.equal(d.resume, false);
    assert.equal(d.notice, undefined);
    assert.equal(d.continueInPlace, undefined);
  }
});

test('an idle terminal is continued in place for an overload, another limit type, or native off (#29)', () => {
  assert.deepEqual(decideOnFire(terminal('idle'), true, 'x', 'overload', undefined, true).continueInPlace, { pid: 88, kind: 'terminal', bridged: false });
  assert.deepEqual(decideOnFire(terminal('idle'), true, 'x', 'limit', 'seven_day', true).continueInPlace, { pid: 88, kind: 'terminal', bridged: false });
  assert.deepEqual(decideOnFire(terminal('idle'), false, 'x', 'limit', 'five_hour', true).continueInPlace, { pid: 88, kind: 'terminal', bridged: false });
});

test('an idle terminal at a five-hour limit with native on still stands down for native', () => {
  const d = decideOnFire(terminal('idle'), true, 'x', 'limit', 'five_hour', true);
  assert.equal(d.awaitNativeContinue, true);
  assert.equal(d.continueInPlace, undefined);
});

test('a manual resume into an idle holder needs no warning when continuing in place', () => {
  assert.equal(manualResumeWarning(terminal('idle'), 'x', true), undefined);
  assert.equal(manualResumeWarning(panel('idle'), 'x', true), undefined);
  assert.ok(manualResumeWarning(terminal('idle'), 'x', false));
  assert.ok(manualResumeWarning(terminal('busy'), 'x', true));
});
```

  Existing `decideOnFire` tests: append `false` as the new last argument so they keep testing 1.0's behaviour, except the old "busy or waiting is dropped" assertions for `waiting`, which now expect the D9 notice even with `false` (D9 does not depend on the setting).

- [ ] **Step 2: Run, see failures.**

- [ ] **Step 3: Implement.**
  - `src/config.ts`: `continueInPlace: boolean;` in `Settings`; `continueInPlace: typeof c.get('continueInPlace', true) === 'boolean' ? c.get('continueInPlace', true) : true,`.
  - `package.json` `contributes.configuration.properties`: `"claudeLimitBreak.continueInPlace": { "type": "boolean", "default": true, "description": "When a session's process is still open and idle at the reset, continue it in place, through Limit Break's Claude Code mod or the session's inbox, instead of launching a second process. Off keeps 1.0's terminal launch." }`
  - README settings table row: `| \`continueInPlace\` | \`true\` | <same description> |` (the `readmeSettings` test requires it).
  - `src/holderPolicy.ts`: export `isIdleStatus`; add `OPEN_SESSION_BUTTON`; add `continueInPlaceOn: boolean` as the last parameter of `decideOnFire` and document the new outcomes in its doc comment. Branch order:
    1. `'unknown'` and `none`: unchanged.
    2. A holder (either kind) with status `waiting`: the D9 notice above, with `logMessage: \`Session ${shortId} is waiting for input in ${where} (pid ${pid}); the limit has reset, so telling you.\`` (`where` is `a Claude panel` or `a terminal`).
    3. Idle panel: `continueInPlaceOn` → `{ resume: false, remember: false, continueInPlace: { pid, kind: 'panel', bridged }, logMessage: \`Session ${shortId} is open in an idle Claude panel (pid ${pid}); continuing it in place.\` }`; otherwise unchanged.
    4. Busy panel or terminal: unchanged silent drop.
    5. Idle terminal: overload, another limit type, or `autoContinueOn` false: `continueInPlaceOn` → `{ resume: false, remember: false, continueInPlace: { pid, kind: 'terminal', bridged: false }, logMessage: \`Session ${shortId} is open in an idle terminal (pid ${pid}); continuing it in place.\` }`; otherwise the existing offer. Five-hour or unknown with `autoContinueOn`: unchanged `awaitNativeContinue`.
  - `manualResumeWarning`: new third parameter; `if (continueInPlaceOn && holder !== 'unknown' && holder.kind !== 'none' && isIdleStatus(holder.status)) return undefined;` before the existing logic.
  - `src/extension.ts`: pass `false` as the new argument at the `decideOnFire` call (Task 10 replaces it). The existing notice handler must not resume when `decision.openSession` is set: add `if (decision.openSession) { return; }` as the first line inside its `.then(async (choice) => {` after the `choice !== notice.button` check, with a comment "Task 10 wires the open-session button". (Keeps D9 harmless until then.)

- [ ] **Step 4: Run `npm test`.** All pass. An existing extension test that expects a *waiting* holder to be dropped silently now sees the D9 notice: update its assertion to expect the notice (and still no terminal), and say so in the commit message.

- [ ] **Step 5: Commit.** Tick Task 3. `git commit -m "feat: continueInPlace setting, and fire-time outcomes for continuing in place and for a waiting session (D8, D9)"`.

---

### Task 4: Session record fields for the inbox

**Files:**
- Modify: `src/sessionRegistry.ts`, `src/liveSessions.ts` (`HolderRecord`)
- Test: `test/sessionRegistry.test.ts`

**Interfaces:**
- Produces: `SessionRecord` and `HolderRecord` gain optional `startedAtMs?: number` (from the record's `startedAt`, a finite number) and `messagingSocketPath?: string` (non-empty string). Omitted, not `undefined`, when absent.

- [ ] **Step 1: Failing tests** in `test/sessionRegistry.test.ts`, following its existing fabricated-record style: a record with `startedAt: 1791549836625` and `messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-abc'` yields both fields; `startedAt: 'x'` or `messagingSocketPath: ''` omits them; the existing deep-equality tests still pass (no new keys on records without the fields).

- [ ] **Step 2: Implement** in `readSessionRecord`, after the `bridgeSessionId` block:

```ts
  if (typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt)) {
    record.startedAtMs = parsed.startedAt;
  }
  if (typeof parsed.messagingSocketPath === 'string' && parsed.messagingSocketPath.length > 0) {
    record.messagingSocketPath = parsed.messagingSocketPath;
  }
```

  Document both fields on the interfaces: `startedAtMs` — "When the process started, ms since the epoch; a mod status file older than this belongs to an earlier process (modStatus.ts)." `messagingSocketPath` — "The session's cross-session inbox: a Unix socket, or a named pipe on Windows (inbox.ts)."

- [ ] **Step 3: `npm test`, commit.** Tick Task 4. `git commit -m "feat: read a session's start time and inbox path from its record"`.

---

### Task 5: `inbox.ts`, the socket transport

**Files:**
- Create: `src/inbox.ts`, `test/inbox.test.ts`

**Interfaces:**
- Produces:

```ts
export const SENDER = 'limit-break';
export function buildEnvelope(body: string): string;
export interface PeerPayload {
  msgV: 1; msg_id: string; type: 'user';
  message: { role: 'user'; content: string };
  priority: 'next'; session_id: string;
}
export function buildPayload(sessionId: string, content: string, msgId: string): PeerPayload;
export function inboxLines(payload: PeerPayload, token: string | undefined): string[];
export function findPeerToken(dir: string, pid: number, listDir: (d: string) => string[], readFile: (p: string) => string): string | undefined;
export function sendToInbox(socketPath: string, lines: readonly string[], closeAfterMs?: number): Promise<void>;
```

- [ ] **Step 1: Failing tests** `test/inbox.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildEnvelope, buildPayload, inboxLines, findPeerToken, sendToInbox } from '../src/inbox';

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';

test('the envelope is the cross-session-message wrapper that names limit-break', () => {
  assert.equal(
    buildEnvelope('hello'),
    '<cross-session-message from="uds:limit-break" from-name="limit-break">\nhello\n</cross-session-message>',
  );
});

test('the payload has exactly the fields the inbox reads', () => {
  assert.deepEqual(buildPayload(SID, 'body', 'm-1'), {
    msgV: 1, msg_id: 'm-1', type: 'user', message: { role: 'user', content: 'body' }, priority: 'next', session_id: SID,
  });
});

test('the auth line goes first when there is a token, and every line ends in a newline', () => {
  const payload = buildPayload(SID, 'b', 'm');
  assert.deepEqual(inboxLines(payload, 'tok'), ['{"type":"auth","token":"tok"}\n', JSON.stringify(payload) + '\n']);
  assert.deepEqual(inboxLines(payload, undefined), [JSON.stringify(payload) + '\n']);
});

test('the peer token is read from the pid key file, and nothing else', () => {
  const files: Record<string, string> = {
    [path.join('/s', '123.abcd.key')]: JSON.stringify({ peerToken: 'tok-123', procStartFt: 1, pidDomain: 'x' }),
    [path.join('/s', '1234.ffff.key')]: JSON.stringify({ peerToken: 'other' }),
    [path.join('/s', '123.json')]: '{}',
  };
  const list = () => ['123.json', '1234.ffff.key', '123.abcd.key'];
  const read = (p: string) => { const v = files[p]; if (v === undefined) throw new Error('ENOENT'); return v; };
  assert.equal(findPeerToken('/s', 123, list, read), 'tok-123');
  assert.equal(findPeerToken('/s', 999, list, read), undefined);
  assert.equal(findPeerToken('/s', 123, () => { throw new Error('EACCES'); }, read), undefined);
  assert.equal(findPeerToken('/s', 123, list, () => '{"peerToken":""}'), undefined);
});

const pipePath = () =>
  process.platform === 'win32' ? `\\\\.\\pipe\\lb-inbox-test-${randomUUID()}` : path.join(os.tmpdir(), `lb-inbox-${randomUUID()}.sock`);

test('sendToInbox writes the lines in order to a live socket', async () => {
  const where = pipePath();
  let received = '';
  const server = net.createServer((s) => s.on('data', (d) => (received += d.toString('utf8'))));
  await new Promise<void>((r) => server.listen(where, r));
  try {
    await sendToInbox(where, ['a\n', 'b\n'], 50);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(received, 'a\nb\n');
  } finally {
    server.close();
  }
});

test('sendToInbox rejects at once when nothing listens (the process is gone)', async () => {
  await assert.rejects(sendToInbox(pipePath(), ['a\n'], 50));
});
```

- [ ] **Step 2: Run, see it fail.**

- [ ] **Step 3: Implement** `src/inbox.ts`:

```ts
import * as net from 'node:net';
import * as path from 'node:path';

/**
 * Posting into a live session's cross-session inbox (`messagingSocketPath` in `~/.claude/sessions/<pid>.json`): a Unix socket, or a named pipe on Windows. Documented by Anthropic (cross-session messaging); the payload's shape and the auth line were confirmed by spike S1 on Windows 2.1.293 (docs/research/2026-10-08-socket-and-mod-spikes.md).
 *
 * The inbox never replies. Delivery is confirmed elsewhere (continueInPlace.ts): by the payload's msg_id in the transcript, or by the mod's status file.
 */

/** The sender name the envelope carries; the panel shows "Message from @limit-break". */
export const SENDER = 'limit-break';

/** The wrapper a `SendMessage` from another session arrives in. Undocumented, read from claude.exe; only the panel's sender row depends on it, not delivery. */
export function buildEnvelope(body: string): string {
  return `<cross-session-message from="uds:${SENDER}" from-name="${SENDER}">\n${body}\n</cross-session-message>`;
}

export interface PeerPayload {
  msgV: 1;
  msg_id: string;
  type: 'user';
  message: { role: 'user'; content: string };
  priority: 'next';
  session_id: string;
}

export function buildPayload(sessionId: string, content: string, msgId: string): PeerPayload {
  return { msgV: 1, msg_id: msgId, type: 'user', message: { role: 'user', content }, priority: 'next', session_id: sessionId };
}

/** What goes down the socket: the auth line first when there is a token (required on Windows), then the payload; each line newline-terminated. */
export function inboxLines(payload: PeerPayload, token: string | undefined): string[] {
  const lines = [JSON.stringify(payload) + '\n'];
  return token === undefined ? lines : [JSON.stringify({ type: 'auth', token }) + '\n', ...lines];
}

/**
 * The session's `peerToken`, from `<dir>/<pid>.<hash>.key` (JSON: peerToken, procStartFt, pidDomain). Only the user's account can read it. Undefined when there is no such file, it is unreadable, or it holds no non-empty peerToken. Never logged.
 */
export function findPeerToken(
  dir: string,
  pid: number,
  listDir: (d: string) => string[],
  readFile: (p: string) => string,
): string | undefined {
  let names: string[];
  try {
    names = listDir(dir);
  } catch {
    return undefined;
  }
  const prefix = `${pid}.`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.key') || name.split('.').length !== 3) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFile(path.join(dir, name))) as { peerToken?: unknown };
      if (typeof parsed.peerToken === 'string' && parsed.peerToken.length > 0) {
        return parsed.peerToken;
      }
    } catch {
      // An unreadable key file is no token.
    }
  }
  return undefined;
}

/**
 * Connect, write `lines`, and close after `closeAfterMs` (spike S1 closed after 2 s, which is what was tested). Resolves once written; rejects if the connection fails (no such pipe: the process is gone) or errors before the write.
 */
export function sendToInbox(socketPath: string, lines: readonly string[], closeAfterMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let written = false;
    const socket = net.createConnection({ path: socketPath });
    socket.on('error', (err) => {
      if (!written) {
        reject(err);
      }
    });
    socket.on('connect', () => {
      socket.write(lines.join(''), () => {
        written = true;
        resolve();
        setTimeout(() => socket.end(), closeAfterMs).unref?.();
      });
    });
  });
}
```

- [ ] **Step 4: `npm test`, commit.** Tick Task 5. `git commit -m "feat: post to a live session's inbox (socket transport)"`.

---

### Task 6: The mod

**Files:**
- Create: `mod/.claude-plugin/plugin.json`, `mod/hooks/hooks.json`, `mod/hooks/control.mjs`, `mod/hooks/register.mjs`, `mod/hooks/register.test.ts`, `.claude-plugin/marketplace.json` (repo root), `test/modControl.test.ts`

**Interfaces:**
- Produces (`mod/hooks/control.mjs`, ES module, plain JavaScript with JSDoc):

```js
export const PROTOCOL = 1;
export const MOD_VERSION = '1.1.0';
export const CONTROL_MARKER = '[limit-break-control v1]';
export function statusPath(home, sessionId) // `${home}/.limit-break/sessions/${sessionId}.json`
export function controlPath(home, sessionId) // `${home}/.limit-break/control/${sessionId}.json`
export function parseControl(text) // { kind: 'none' } | { kind: 'invalid', reason } | { kind: 'control', jobId, nonce, prompt }
export function acceptControl(control, controlFileText, status, nowMs) // { ok: true } | { ok: false, reason }
export function initialStatus({ sessionId, cwd, entrypoint, loadedAtMs }, previous) // carries previous.continued when previous is the same session
export function parseStatus(text) // status object or undefined
export function withRateLimits(status, rateLimits, atMs)
export function withStopFailure(status, error, atMs)
export function withNativeContinue(status, type, atMs)
export function withContinued(status, jobId, atMs) // newest 20 kept
export function movedTo(status, newSessionId)
```

The status object: `{ protocol, modVersion, sessionId, cwd, entrypoint, loadedAtMs, rateLimits: [], rateLimitsAtMs?, lastStopFailure?: { error, atMs }, nativeContinue?: { type, atMs }, continued: [{ jobId, atMs }], movedTo? }`. The control file the extension writes: `{ protocol: 1, entries: [{ jobId, nonce, expiresAtMs }] }`.

- [ ] **Step 1: Failing node tests** `test/modControl.test.ts`. The module is ESM; Node 24 loads it with `require()`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

interface Control {
  PROTOCOL: number; MOD_VERSION: string; CONTROL_MARKER: string;
  statusPath(home: string, sid: string): string;
  controlPath(home: string, sid: string): string;
  parseControl(text: string): { kind: 'none' } | { kind: 'invalid'; reason: string } | { kind: 'control'; jobId: string; nonce: string; prompt: string };
  acceptControl(c: { jobId: string; nonce: string }, file: string | undefined, status: { continued: { jobId: string }[] }, nowMs: number): { ok: true } | { ok: false; reason: string };
  initialStatus(fields: { sessionId: string; cwd: string; entrypoint?: string; loadedAtMs: number }, previous?: unknown): Record<string, unknown> & { continued: { jobId: string; atMs: number }[] };
  parseStatus(text: string): (Record<string, unknown> & { continued: { jobId: string; atMs: number }[] }) | undefined;
  withContinued(s: unknown, jobId: string, atMs: number): { continued: { jobId: string; atMs: number }[] };
  withRateLimits(s: unknown, rl: unknown[], atMs: number): Record<string, unknown>;
  movedTo(s: unknown, id: string): Record<string, unknown>;
}
const control = require(path.join(__dirname, '..', '..', 'mod', 'hooks', 'control.mjs')) as Control;

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const wrap = (body: string) => `<cross-session-message from="uds:limit-break" from-name="limit-break">\n${body}\n</cross-session-message>`;
const body = (o: unknown) => `${control.CONTROL_MARKER} ${JSON.stringify(o)}`;

test('paths sit under ~/.limit-break', () => {
  assert.equal(control.statusPath('C:/Users/u', SID), `C:/Users/u/.limit-break/sessions/${SID}.json`);
  assert.equal(control.controlPath('/home/u', SID), `/home/u/.limit-break/control/${SID}.json`);
});

test('a control message is found inside its envelope', () => {
  assert.deepEqual(control.parseControl(wrap(body({ jobId: 'j', nonce: 'n', prompt: 'p' }))), { kind: 'control', jobId: 'j', nonce: 'n', prompt: 'p' });
});

test('ordinary text is not a control message', () => {
  assert.deepEqual(control.parseControl(wrap('please continue')), { kind: 'none' });
});

test('a marker with a bad payload is invalid, never passed on as text', () => {
  assert.equal(control.parseControl(wrap(`${control.CONTROL_MARKER} {not json`)).kind, 'invalid');
  assert.equal(control.parseControl(wrap(body({ jobId: '', nonce: 'n', prompt: 'p' }))).kind, 'invalid');
  assert.equal(control.parseControl(wrap(body({ jobId: 'j', nonce: 'n' }))).kind, 'invalid');
});

const file = (entries: unknown[]) => JSON.stringify({ protocol: 1, entries });
const fresh = { continued: [] as { jobId: string }[] };

test('a control message is accepted only with a matching, unexpired, unused entry', () => {
  const c = { jobId: 'j', nonce: 'n' };
  assert.deepEqual(control.acceptControl(c, file([{ jobId: 'j', nonce: 'n', expiresAtMs: 2000 }]), fresh, 1000), { ok: true });
  assert.equal(control.acceptControl(c, file([{ jobId: 'j', nonce: 'other', expiresAtMs: 2000 }]), fresh, 1000).ok, false);
  assert.equal(control.acceptControl(c, file([{ jobId: 'j', nonce: 'n', expiresAtMs: 900 }]), fresh, 1000).ok, false);
  assert.equal(control.acceptControl(c, undefined, fresh, 1000).ok, false);
  assert.equal(control.acceptControl(c, '{', fresh, 1000).ok, false);
});

test('a job already continued is refused: a second control message is a replay', () => {
  const c = { jobId: 'j', nonce: 'n' };
  const status = { continued: [{ jobId: 'j' }] };
  assert.deepEqual(control.acceptControl(c, file([{ jobId: 'j', nonce: 'n', expiresAtMs: 2000 }]), status, 1000), { ok: false, reason: 'job j was already continued' });
});

test('the status carries continued jobs across a reload of the same session, and keeps 20', () => {
  let s = control.initialStatus({ sessionId: SID, cwd: '/w', entrypoint: 'claude-vscode', loadedAtMs: 1 });
  assert.equal(s.protocol, 1);
  for (let i = 0; i < 25; i += 1) s = control.withContinued(s, `j${i}`, i) as typeof s;
  assert.equal(s.continued.length, 20);
  assert.equal(s.continued[0]!.jobId, 'j5');
  const reloaded = control.initialStatus({ sessionId: SID, cwd: '/w', loadedAtMs: 99 }, control.parseStatus(JSON.stringify(s)));
  assert.equal(reloaded.continued.length, 20);
  assert.equal(reloaded.loadedAtMs, 99);
  const other = control.initialStatus({ sessionId: 'another', cwd: '/w', loadedAtMs: 99 }, s);
  assert.equal(other.continued.length, 0);
});

test('a truncated status file parses as nothing', () => {
  assert.equal(control.parseStatus('{"protocol":1,"sessionId":"x"'), undefined);
});
```

- [ ] **Step 2: Run, see it fail** (module missing).

- [ ] **Step 3: Implement `mod/hooks/control.mjs`**:

```js
// Limit Break's Claude Code mod: the pure half, shared with the extension's node tests (test/modControl.test.ts).
// Plain ECMAScript: the mod runs with no Node APIs, and only `$` reaches outside it (register.mjs).

/** The status file's and control file's protocol; the extension uses the mod only on the same major. */
export const PROTOCOL = 1;
export const MOD_VERSION = '1.1.0';
/** Starts the body of a control message: `[limit-break-control v1] {"jobId","nonce","prompt"}`. */
export const CONTROL_MARKER = '[limit-break-control v1]';
const MAX_CONTINUED = 20;

/** @param {string} home @param {string} sessionId */
export function statusPath(home, sessionId) {
  return `${home}/.limit-break/sessions/${sessionId}.json`;
}

/** @param {string} home @param {string} sessionId */
export function controlPath(home, sessionId) {
  return `${home}/.limit-break/control/${sessionId}.json`;
}

const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

/**
 * Find a control message in a delivery's text (the envelope around it included). The JSON runs from the marker to the end of its line.
 * @param {string} text
 */
export function parseControl(text) {
  const at = text.indexOf(CONTROL_MARKER);
  if (at < 0) {
    return { kind: 'none' };
  }
  const rest = text.slice(at + CONTROL_MARKER.length);
  const line = rest.split('\n')[0].trim();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'invalid', reason: 'its payload is not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || !nonEmpty(parsed.jobId) || !nonEmpty(parsed.nonce) || !nonEmpty(parsed.prompt)) {
    return { kind: 'invalid', reason: 'its payload lacks jobId, nonce or prompt' };
  }
  return { kind: 'control', jobId: parsed.jobId, nonce: parsed.nonce, prompt: parsed.prompt };
}

/**
 * Whether a control message may act: the extension's control file (which only it writes) must hold an unexpired entry with this job and nonce, and the job must not have been continued already.
 * @param {{ jobId: string, nonce: string }} control
 * @param {string | undefined} controlFileText
 * @param {{ continued: { jobId: string }[] }} status
 * @param {number} nowMs
 */
export function acceptControl(control, controlFileText, status, nowMs) {
  if (status.continued.some((c) => c.jobId === control.jobId)) {
    return { ok: false, reason: `job ${control.jobId} was already continued` };
  }
  if (controlFileText === undefined) {
    return { ok: false, reason: 'there is no control file for this session' };
  }
  let file;
  try {
    file = JSON.parse(controlFileText);
  } catch {
    return { ok: false, reason: 'the control file is not JSON' };
  }
  const entries = file && file.protocol === PROTOCOL && Array.isArray(file.entries) ? file.entries : [];
  const match = entries.find((e) => e && e.jobId === control.jobId && e.nonce === control.nonce);
  if (!match) {
    return { ok: false, reason: 'no matching entry in the control file' };
  }
  if (!(typeof match.expiresAtMs === 'number' && match.expiresAtMs > nowMs)) {
    return { ok: false, reason: 'its control entry has expired' };
  }
  return { ok: true };
}

/**
 * A fresh status for this process and session. `previous` (the file as last written, parsed) keeps its `continued` list when it is the same session, so a reload of the mod can't continue a job twice.
 */
export function initialStatus(fields, previous) {
  const continued = previous && previous.sessionId === fields.sessionId && Array.isArray(previous.continued) ? previous.continued : [];
  return {
    protocol: PROTOCOL,
    modVersion: MOD_VERSION,
    sessionId: fields.sessionId,
    cwd: fields.cwd,
    ...(fields.entrypoint ? { entrypoint: fields.entrypoint } : {}),
    loadedAtMs: fields.loadedAtMs,
    rateLimits: [],
    continued,
  };
}

/** @param {string} text */
export function parseStatus(text) {
  try {
    const s = JSON.parse(text);
    return s && typeof s === 'object' && typeof s.sessionId === 'string' && Array.isArray(s.continued) ? s : undefined;
  } catch {
    return undefined;
  }
}

export function withRateLimits(status, rateLimits, atMs) {
  return { ...status, rateLimits, rateLimitsAtMs: atMs };
}

export function withStopFailure(status, error, atMs) {
  return { ...status, lastStopFailure: { error: String(error), atMs } };
}

export function withNativeContinue(status, type, atMs) {
  return { ...status, nativeContinue: { type: String(type), atMs } };
}

export function withContinued(status, jobId, atMs) {
  return { ...status, continued: [...status.continued, { jobId, atMs }].slice(-MAX_CONTINUED) };
}

/** The process moved to another session (/clear, resume, fork). The file can't be deleted ($.fs has no delete), so it says where the process went; the extension reads it as absent. */
export function movedTo(status, newSessionId) {
  return { ...status, movedTo: newSessionId };
}
```

- [ ] **Step 4: Run `npm test`.** The node tests pass.

- [ ] **Step 5: Write the plugin files.**

`mod/.claude-plugin/plugin.json`:
```json
{ "name": "limit-break", "version": "1.1.0", "description": "Limit Break's sensor and actuator: reports usage limits to the Limit Break VS Code extension and continues the session when it asks." }
```

`mod/hooks/hooks.json`:
```json
{ "modules": ["./register.mjs"] }
```

`.claude-plugin/marketplace.json` (repo root, for the manual install):
```json
{
  "name": "limit-break",
  "owner": { "name": "Dream Mosaic" },
  "plugins": [{ "name": "limit-break", "source": "./mod" }]
}
```

`mod/hooks/register.mjs`:

```js
// Limit Break's Claude Code mod (spec D1): a sensor that writes ~/.limit-break/sessions/<id>.json, and an actuator that continues the session when the Limit Break extension sends a valid control message. It never acts on its own.
import {
  statusPath, controlPath, parseControl, acceptControl, initialStatus, parseStatus,
  withRateLimits, withStopFailure, withNativeContinue, withContinued, movedTo,
} from './control.mjs';

/** @type {import('claude-code').Register} */
export const register = (on) => {
  /** This process's status, rewritten whole on every change. */
  let status;
  let home;

  const homeDir = async ($) => {
    if (home === undefined) {
      home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '';
    }
    return home;
  };

  const write = async ($) => {
    if (status && (await homeDir($))) {
      await $.fs.write(statusPath(home, status.sessionId), JSON.stringify(status, null, 2));
    }
  };

  const readText = async ($, path) => {
    try {
      return await $.fs.read(path);
    } catch {
      return undefined;
    }
  };

  const start = async ($, sessionId) => {
    const h = await homeDir($);
    const previousText = h ? await readText($, statusPath(h, sessionId)) : undefined;
    status = initialStatus(
      {
        sessionId,
        cwd: await $.session.cwd(),
        entrypoint: await $.env.get('CLAUDE_CODE_ENTRYPOINT'),
        loadedAtMs: await $.clock.now(),
      },
      previousText === undefined ? undefined : parseStatus(previousText),
    );
    await write($);
  };

  on('session.start', async ($, e, next) => {
    await start($, await $.session.id());
    return next(e);
  });

  on('session.measure', async ($, e, next) => {
    if (status && e.changed.includes('rateLimits')) {
      status = withRateLimits(status, e.rateLimits, await $.clock.now());
      await write($);
    }
    return next(e);
  });

  on('classic.StopFailure', async ($, e, next) => {
    if (status && e.agent_id === undefined) {
      status = withStopFailure(status, e.error, await $.clock.now());
      await write($);
    }
    return next(e);
  });

  on('classic.Notification', async ($, e, next) => {
    if (status && typeof e.notification_type === 'string' && e.notification_type.startsWith('quota_auto_resume')) {
      status = withNativeContinue(status, e.notification_type, await $.clock.now());
      await write($);
    }
    return next(e);
  });

  on('classic.SessionStart', async ($, e, next) => {
    if (status && e.session_id !== status.sessionId && (e.source === 'clear' || e.source === 'resume' || e.source === 'fork')) {
      status = movedTo(status, e.session_id);
      await write($);
      await start($, e.session_id);
    }
    return next(e);
  });

  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || e.origin.kind !== 'peer') {
      return next(e);
    }
    const control = parseControl(e.text);
    if (control.kind === 'none') {
      return next(e);
    }
    if (control.kind === 'invalid' || !status) {
      $.ui.log(`limit-break: ignored a control message: ${control.kind === 'invalid' ? control.reason : 'no session status yet'}`);
      return { consumed: 'limit-break control message' };
    }
    const verdict = acceptControl(
      control,
      await readText($, controlPath(await homeDir($), status.sessionId)),
      status,
      await $.clock.now(),
    );
    if (!verdict.ok) {
      $.ui.log(`limit-break: refused a control message: ${verdict.reason}`);
      return { consumed: 'limit-break control message' };
    }
    // Unawaited, as spike S4 ran it from session.receive: the turn starts once the session is idle.
    void $.prompt.submit({ text: control.prompt, asUser: true }).then(async () => {
      status = withContinued(status, control.jobId, await $.clock.now());
      await write($);
    });
    return { consumed: 'limit-break control message' };
  });
};
```

- [ ] **Step 6: Validate the mod with the CLI** (read-only, touches no session): `claude plugin validate mod` and `claude plugin validate .` (the root marketplace). Fix anything it refuses. Expected: it lists the hooks `session.start`, `session.measure`, `classic.StopFailure`, `classic.Notification`, `classic.SessionStart`, `session.receive`, and the env names `USERPROFILE`, `HOME`, `CLAUDE_CODE_ENTRYPOINT`. If validate rejects `.mjs` or the `import` of `./control.mjs`, stop and record the exact message in the progress notes; do not switch the mod to `.ts` (the VSIX excludes `.ts`).

- [ ] **Step 7: The mod's own test** `mod/hooks/register.test.ts` (runs under `claude plugin test mod`, not in CI):

```ts
import { test, expect, mock } from 'claude-code/testing';

test('a valid control message is consumed and becomes a user prompt', async ({ on, $ }) => {
  mock.env(on, { HOME: '/h' });
  mock.clock(on, { now: 1_000 });
  const files = new Map<string, string>();
  on('fs.write', ($, e) => { files.set(e.path, e.text); return undefined; });
  on('fs.read', ($, e) => {
    const text = files.get(e.path);
    if (text === undefined) throw new Error('ENOENT');
    return text;
  });
  on('session.id', () => 'S1');
  on('session.cwd', () => '/w');
  const submitted: string[] = [];
  on('prompt.submit', ($, e) => { submitted.push(e.text); return { isSubmitted: true }; });
  // The extension's control file.
  files.set('/h/.limit-break/control/S1.json', JSON.stringify({ protocol: 1, entries: [{ jobId: 'j1', nonce: 'n1', expiresAtMs: 60_000 }] }));
  await $.session.start({});
  const text = '<cross-session-message from="uds:limit-break" from-name="limit-break">\n[limit-break-control v1] {"jobId":"j1","nonce":"n1","prompt":"[Limit Break] continue"}\n</cross-session-message>';
  const result = await $.session.receive({ origin: { kind: 'peer' }, text });
  expect(result).toEqual({ consumed: 'limit-break control message' });
  expect(submitted).toEqual(['[Limit Break] continue']);
});
```

The kit's exact shapes for answering `fs.*`, `session.*` and `prompt.submit` beneath the plugin are in the types file (`declare module 'claude-code/testing'`, about line 14,882 of the 2.1.296 types). Adjust the test to them; the behaviour asserted stays. Run `claude plugin test mod`. If the kit can't run here (no engine in this environment), record that in the progress notes and leave the test in place for the smoke kit.

- [ ] **Step 8: Commit.** Tick Task 6. `git commit -m "feat: Limit Break's Claude Code mod (sensor and actuator)"`.

---

### Task 7: `modStatus.ts`, the extension's half of the mod protocol

**Files:**
- Create: `src/modStatus.ts`, `test/modStatus.test.ts`

**Interfaces:**
- Produces:

```ts
export const MOD_PROTOCOL = 1;
export const CONTROL_MARKER = '[limit-break-control v1]';
export const CONTROL_TTL_MS = 120_000;
export function limitBreakDir(home?: string): string;          // path.join(home ?? os.homedir(), '.limit-break')
export function statusFile(dir: string, sessionId: string): string;   // <dir>/sessions/<id>.json
export function controlFile(dir: string, sessionId: string): string;  // <dir>/control/<id>.json
export interface ModStatus {
  protocol: number; modVersion?: string; sessionId: string; loadedAtMs: number;
  movedTo?: string; continued: { jobId: string; atMs: number }[];
  nativeContinue?: { type: string; atMs: number };
}
export function parseModStatus(text: string): ModStatus | undefined;
export function modUsable(status: ModStatus | undefined, sessionId: string, holderStartedAtMs: number | undefined): boolean;
export function continuedJob(status: ModStatus | undefined, jobId: string): boolean;
export function buildControlBody(jobId: string, nonce: string, prompt: string): string;
export function controlFileText(jobId: string, nonce: string, nowMs: number): string;
```

- [ ] **Step 1: Failing tests** `test/modStatus.test.ts`, including a round trip through the mod's own parser:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  MOD_PROTOCOL, CONTROL_TTL_MS, limitBreakDir, statusFile, controlFile, parseModStatus, modUsable,
  continuedJob, buildControlBody, controlFileText,
} from '../src/modStatus';
import { buildEnvelope } from '../src/inbox';

const mod = require(path.join(__dirname, '..', '..', 'mod', 'hooks', 'control.mjs')) as {
  parseControl(t: string): { kind: string; jobId?: string; nonce?: string; prompt?: string };
  acceptControl(c: { jobId: string; nonce: string }, f: string | undefined, s: { continued: { jobId: string }[] }, now: number): { ok: boolean };
  CONTROL_MARKER: string; PROTOCOL: number;
};

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ protocol: 1, modVersion: '1.1.0', sessionId: SID, loadedAtMs: 5_000, continued: [], ...over });

test('the extension and the mod agree on the protocol', () => {
  assert.equal(MOD_PROTOCOL, mod.PROTOCOL);
  assert.equal(buildControlBody('j', 'n', 'p').startsWith(mod.CONTROL_MARKER), true);
});

test('a control body the extension builds is one the mod parses and accepts', () => {
  const text = buildEnvelope(buildControlBody('job-1', 'nonce-1', '[Limit Break] continue'));
  const parsed = mod.parseControl(text);
  assert.deepEqual(parsed, { kind: 'control', jobId: 'job-1', nonce: 'nonce-1', prompt: '[Limit Break] continue' });
  assert.deepEqual(mod.acceptControl({ jobId: 'job-1', nonce: 'nonce-1' }, controlFileText('job-1', 'nonce-1', 1_000), { continued: [] }, 1_000 + CONTROL_TTL_MS - 1), { ok: true });
  assert.equal(mod.acceptControl({ jobId: 'job-1', nonce: 'nonce-1' }, controlFileText('job-1', 'nonce-1', 1_000), { continued: [] }, 1_000 + CONTROL_TTL_MS).ok, false);
});

test('paths', () => {
  assert.equal(limitBreakDir('/home/u'), path.join('/home/u', '.limit-break'));
  assert.equal(statusFile('/d', SID), path.join('/d', 'sessions', `${SID}.json`));
  assert.equal(controlFile('/d', SID), path.join('/d', 'control', `${SID}.json`));
});

test('a status file parses, and a truncated or foreign one does not', () => {
  assert.equal(parseModStatus(status())?.sessionId, SID);
  assert.equal(parseModStatus(status().slice(0, 30)), undefined, 'a half-written file is "not yet"');
  assert.equal(parseModStatus('[]'), undefined);
  assert.equal(parseModStatus(JSON.stringify({ protocol: 1, sessionId: SID })), undefined, 'no loadedAtMs or continued');
});

test('the mod is used only for this session, this protocol, and this process', () => {
  const s = parseModStatus(status())!;
  assert.equal(modUsable(s, SID, 4_000), true, 'loaded after the process started');
  assert.equal(modUsable(s, SID, 5_000), true, 'loaded in the same millisecond');
  assert.equal(modUsable(s, SID, 6_000), false, 'a file from an earlier process');
  assert.equal(modUsable(s, SID, undefined), false, 'cannot tell which process wrote it');
  assert.equal(modUsable(s, 'other', 4_000), false);
  assert.equal(modUsable(parseModStatus(status({ protocol: 2 })), SID, 4_000), false);
  assert.equal(modUsable(parseModStatus(status({ movedTo: 'x' })), SID, 4_000), false);
  assert.equal(modUsable(undefined, SID, 4_000), false);
});

test('a job counts as continued once the mod lists it', () => {
  assert.equal(continuedJob(parseModStatus(status({ continued: [{ jobId: 'j', atMs: 1 }] })), 'j'), true);
  assert.equal(continuedJob(parseModStatus(status()), 'j'), false);
  assert.equal(continuedJob(undefined, 'j'), false);
});
```

- [ ] **Step 2: Run, see it fail.**

- [ ] **Step 3: Implement** `src/modStatus.ts`:

```ts
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The extension's half of the protocol with Limit Break's Claude Code mod (mod/hooks/control.mjs is the mod's half; test/modStatus.test.ts checks they agree). The mod writes `<dir>/sessions/<id>.json`; the extension writes `<dir>/control/<id>.json`, which the mod checks a control message against. `<dir>` is `~/.limit-break` (spec D7).
 */

export const MOD_PROTOCOL = 1;
export const CONTROL_MARKER = '[limit-break-control v1]';
/** How long a control entry stays valid: long enough for a busy-then-idle session to read its inbox, short enough that a stale one can't be replayed later. */
export const CONTROL_TTL_MS = 120_000;

export function limitBreakDir(home: string = os.homedir()): string {
  return path.join(home, '.limit-break');
}

export function statusFile(dir: string, sessionId: string): string {
  return path.join(dir, 'sessions', `${sessionId}.json`);
}

export function controlFile(dir: string, sessionId: string): string {
  return path.join(dir, 'control', `${sessionId}.json`);
}

export interface ModStatus {
  protocol: number;
  modVersion?: string;
  sessionId: string;
  /** When the mod loaded in its process, ms since the epoch. */
  loadedAtMs: number;
  /** The process moved to this session; this file no longer describes a live one. */
  movedTo?: string;
  continued: { jobId: string; atMs: number }[];
  /** Logged only: the notification types are unverified in the panel. */
  nativeContinue?: { type: string; atMs: number };
}

/** A status file as the mod wrote it, or undefined. `$.fs.write` isn't atomic, so a half-written file is "not yet", read again later. */
export function parseModStatus(text: string): ModStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const s = parsed as Record<string, unknown>;
  if (
    typeof s.protocol !== 'number' ||
    typeof s.sessionId !== 'string' ||
    typeof s.loadedAtMs !== 'number' ||
    !Number.isFinite(s.loadedAtMs) ||
    !Array.isArray(s.continued)
  ) {
    return undefined;
  }
  const continued = s.continued.filter(
    (c): c is { jobId: string; atMs: number } =>
      typeof c === 'object' && c !== null && typeof (c as { jobId?: unknown }).jobId === 'string',
  );
  return {
    protocol: s.protocol,
    ...(typeof s.modVersion === 'string' ? { modVersion: s.modVersion } : {}),
    sessionId: s.sessionId,
    loadedAtMs: s.loadedAtMs,
    ...(typeof s.movedTo === 'string' ? { movedTo: s.movedTo } : {}),
    continued,
    ...(typeof s.nativeContinue === 'object' && s.nativeContinue !== null
      ? { nativeContinue: s.nativeContinue as { type: string; atMs: number } }
      : {}),
  };
}

/**
 * Whether the live holder of `sessionId` runs the mod. The mod can't report its pid, so the file must have been written by a mod that loaded at or after the holder process started: a file left by an earlier process (the mod since removed, or the session reopened without it) is older than the live one. A control message sent to a session without the mod would reach the model as a peer message, so anything uncertain is "no".
 */
export function modUsable(status: ModStatus | undefined, sessionId: string, holderStartedAtMs: number | undefined): boolean {
  return (
    status !== undefined &&
    status.protocol === MOD_PROTOCOL &&
    status.sessionId === sessionId &&
    status.movedTo === undefined &&
    holderStartedAtMs !== undefined &&
    status.loadedAtMs >= holderStartedAtMs
  );
}

export function continuedJob(status: ModStatus | undefined, jobId: string): boolean {
  return status !== undefined && status.continued.some((c) => c.jobId === jobId);
}

export function buildControlBody(jobId: string, nonce: string, prompt: string): string {
  return `${CONTROL_MARKER} ${JSON.stringify({ jobId, nonce, prompt })}`;
}

/** The whole control file for one continue: a single-use entry (the mod refuses a job it already continued) that expires CONTROL_TTL_MS from now. */
export function controlFileText(jobId: string, nonce: string, nowMs: number): string {
  return JSON.stringify({ protocol: MOD_PROTOCOL, entries: [{ jobId, nonce, expiresAtMs: nowMs + CONTROL_TTL_MS }] }, null, 2);
}
```

- [ ] **Step 4: `npm test`, commit.** Tick Task 7. `git commit -m "feat: the extension's half of the mod protocol"`.

---

### Task 8: `continueInPlace.ts`

**Files:**
- Create: `src/continueInPlace.ts`, `test/continueInPlace.test.ts`

**Interfaces:**
- Consumes: `buildEnvelope`, `buildPayload`, `inboxLines` (Task 5); `modUsable`, `continuedJob`, `buildControlBody`, `controlFileText`, `ModStatus` (Task 7); `HolderRecord` with `startedAtMs`, `messagingSocketPath` (Task 4); `Logger` from `./log`.
- Produces:

```ts
export const CONFIRM_WINDOW_MS = 60_000;
export const CONFIRM_POLL_MS = 1_000;
export const BRIDGED_GRACE_MS = 5 * 60_000;
export type Transport = 'mod' | 'socket';
export type ContinueOutcome =
  | { kind: 'continued'; transport: Transport; elapsedMs: number }
  | { kind: 'landed-late'; transport: Transport }
  | { kind: 'fallback'; reason: string };
export interface ContinueJob { sessionId: string; transcript: string; prompt: string; jobId: string }
export interface ContinueDeps {
  platform: NodeJS.Platform;
  now(): number;
  sleep(ms: number): Promise<void>;
  newId(): string;
  readHolderRecord(pid: number): { sessionId: string; startedAtMs?: number; messagingSocketPath?: string } | undefined;
  readModStatus(sessionId: string): ModStatus | undefined;
  peerToken(pid: number): string | undefined;
  writeControlFile(sessionId: string, text: string): void;
  send(socketPath: string, lines: readonly string[]): Promise<void>;
  transcriptBytes(transcript: string): number | undefined;
  transcriptContains(transcript: string, needle: string, fromBytes: number): boolean;
  continuedSince(transcript: string, bytes: number | undefined): boolean;
}
export function continueInPlace(job: ContinueJob, holderPid: number, deps: ContinueDeps): Promise<ContinueOutcome>;
export function transcriptContains(file: string, needle: string, fromBytes: number, fs: { openSync; readSync; closeSync; statSync }): boolean;
```

- [ ] **Step 1: Failing tests** `test/continueInPlace.test.ts`. Build a fake-deps factory whose `sleep(ms)` advances a fake clock, and whose fields each test overrides:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { continueInPlace, transcriptContains, CONFIRM_WINDOW_MS, type ContinueDeps } from '../src/continueInPlace';
import type { ModStatus } from '../src/modStatus';

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const JOB = { sessionId: SID, transcript: '/t.jsonl', prompt: '[Limit Break] continue', jobId: `${SID}-1000` };

function fakeDeps(over: Partial<ContinueDeps> = {}) {
  let clock = 0;
  let ids = 0;
  const sent: { socketPath: string; lines: readonly string[] }[] = [];
  const controls: string[] = [];
  const deps: ContinueDeps = {
    platform: 'win32',
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    newId: () => `id-${++ids}`,
    readHolderRecord: () => ({ sessionId: SID, startedAtMs: 100, messagingSocketPath: '\\\\.\\pipe\\x' }),
    readModStatus: () => undefined,
    peerToken: () => 'tok',
    writeControlFile: (_sid, text) => { controls.push(text); },
    send: async (socketPath, lines) => { sent.push({ socketPath, lines }); },
    transcriptBytes: () => 500,
    transcriptContains: () => false,
    continuedSince: () => false,
    ...over,
  };
  return { deps, sent, controls, advance: (ms: number) => { clock += ms; } };
}

test('socket: the enveloped prompt goes out after the auth line, and the msg_id in the transcript confirms it', async () => {
  let polls = 0;
  const { deps, sent } = fakeDeps({ transcriptContains: (_t, needle, from) => { assert.equal(from, 500); polls += 1; return needle === 'id-1' && polls >= 3; } });
  const out = await continueInPlace(JOB, 77, deps);
  assert.deepEqual(out, { kind: 'continued', transport: 'socket', elapsedMs: 2_000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.lines[0], '{"type":"auth","token":"tok"}\n');
  const payload = JSON.parse(sent[0]!.lines[1]!);
  assert.equal(payload.msg_id, 'id-1');
  assert.equal(payload.session_id, SID);
  assert.match(payload.message.content, /^<cross-session-message from="uds:limit-break" from-name="limit-break">\n\[Limit Break\] continue\n<\/cross-session-message>$/);
});

const usableStatus = (continued: { jobId: string; atMs: number }[] = []): ModStatus =>
  ({ protocol: 1, sessionId: SID, loadedAtMs: 200, continued });

test('mod: a control message goes out with a fresh nonce, and the mod listing the job confirms it', async () => {
  let reads = 0;
  const { deps, sent, controls } = fakeDeps({ readModStatus: () => (++reads >= 3 ? usableStatus([{ jobId: JOB.jobId, atMs: 1 }]) : usableStatus()) });
  const out = await continueInPlace(JOB, 77, deps);
  assert.equal(out.kind, 'continued');
  assert.equal(out.kind === 'continued' && out.transport, 'mod');
  const control = JSON.parse(controls[0]!);
  assert.equal(control.entries[0].jobId, JOB.jobId);
  assert.equal(control.entries[0].nonce, 'id-1');
  const payload = JSON.parse(sent[0]!.lines[1]!);
  assert.ok(payload.message.content.includes(`[limit-break-control v1] {"jobId":"${JOB.jobId}","nonce":"id-1","prompt":"[Limit Break] continue"}`));
});

test('a status file from an earlier process means the socket, never a control message', async () => {
  const { deps, controls } = fakeDeps({
    readModStatus: () => ({ ...usableStatus(), loadedAtMs: 50 }),
    transcriptContains: () => true,
  });
  const out = await continueInPlace(JOB, 77, deps);
  assert.equal(out.kind === 'continued' && out.transport, 'socket');
  assert.equal(controls.length, 0);
});

test('no record, a record for another session, or no inbox path: fall back at once', async () => {
  for (const rec of [undefined, { sessionId: 'other', messagingSocketPath: 'p' }, { sessionId: SID }]) {
    const { deps, sent } = fakeDeps({ readHolderRecord: () => rec });
    const out = await continueInPlace(JOB, 77, deps);
    assert.equal(out.kind, 'fallback');
    assert.equal(sent.length, 0);
  }
});

test('on Windows, no peer token: fall back at once (the pipe would close silently)', async () => {
  const { deps, sent } = fakeDeps({ peerToken: () => undefined });
  assert.deepEqual(await continueInPlace(JOB, 77, deps), { kind: 'fallback', reason: 'no inbox token for the holder' });
  assert.equal(sent.length, 0);
});

test('elsewhere, no token: send without an auth line', async () => {
  const { deps, sent } = fakeDeps({ platform: 'linux', peerToken: () => undefined, transcriptContains: () => true });
  await continueInPlace(JOB, 77, deps);
  assert.equal(sent[0]!.lines.length, 1);
});

test('a failed send falls back at once, without waiting out the window', async () => {
  const { deps } = fakeDeps({ send: async () => { throw new Error('ENOENT'); } });
  const started = Date.now();
  const out = await continueInPlace(JOB, 77, deps);
  assert.deepEqual(out, { kind: 'fallback', reason: 'send failed: ENOENT' });
  assert.ok(Date.now() - started < 1_000);
});

test('nothing within the window and no sign at the last look: fall back', async () => {
  const { deps } = fakeDeps();
  const out = await continueInPlace(JOB, 77, deps);
  assert.deepEqual(out, { kind: 'fallback', reason: `not confirmed within ${CONFIRM_WINDOW_MS / 1000} s` });
});

test('a turn since the send at the last look means it landed late: no launch', async () => {
  let checks = 0;
  const { deps } = fakeDeps({ continuedSince: (_t, bytes) => { assert.equal(bytes, 500); return ++checks >= 1; } });
  assert.deepEqual(await continueInPlace(JOB, 77, deps), { kind: 'landed-late', transport: 'socket' });
});

test('transcriptContains reads only from the given offset', () => {
  const file = path.join(os.tmpdir(), `lb-cip-${process.pid}.jsonl`);
  fs.writeFileSync(file, 'aaaa needle bbbb');
  try {
    assert.equal(transcriptContains(file, 'needle', 0, fs), true);
    assert.equal(transcriptContains(file, 'needle', 6, fs), false);
    assert.equal(transcriptContains(path.join(os.tmpdir(), 'missing-lb.jsonl'), 'x', 0, fs), false);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
```

  The "nothing within the window" test's poll loop must not depend on wall time: `sleep` advances the fake clock, so it ends after `CONFIRM_WINDOW_MS / CONFIRM_POLL_MS` polls.

- [ ] **Step 2: Run, see it fail.**

- [ ] **Step 3: Implement** `src/continueInPlace.ts`:

```ts
import { buildEnvelope, buildPayload, inboxLines } from './inbox';
import { modUsable, continuedJob, buildControlBody, controlFileText, type ModStatus } from './modStatus';

/**
 * Continue a live, idle session in place (spec: "Continuing in place"), instead of launching a second `claude --resume`:
 * 1. Choose a transport: the mod when the holder runs it (modStatus.ts modUsable), otherwise the socket.
 * 2. Send through the session's inbox (inbox.ts): a control message the mod consumes, or the enveloped resume prompt.
 * 3. Confirm within CONFIRM_WINDOW_MS: the mod lists the job as continued, or the payload's msg_id is in the transcript.
 * 4. Last look before giving up: the msg_id, or any new turn since the send, means it landed late, and nothing may launch (a launch then would be the fork 1.1 exists to prevent).
 * Anything else is `fallback`, and the caller launches as 1.0 did.
 */

/** No documented delivery time; the spikes' slowest ceiling was 11.5 s. A long window only delays; a short one risks a fork. */
export const CONFIRM_WINDOW_MS = 60_000;
export const CONFIRM_POLL_MS = 1_000;
/** D11: the web client's head start on a bridged panel, from the un-jittered reset. The two continues seen came about 90 s after it. */
export const BRIDGED_GRACE_MS = 5 * 60_000;

export type Transport = 'mod' | 'socket';

export type ContinueOutcome =
  | { kind: 'continued'; transport: Transport; elapsedMs: number }
  | { kind: 'landed-late'; transport: Transport }
  | { kind: 'fallback'; reason: string };

export interface ContinueJob {
  sessionId: string;
  transcript: string;
  prompt: string;
  /** The job's claim key: the control entry's and the mod's job id. */
  jobId: string;
}

export interface ContinueDeps {
  platform: NodeJS.Platform;
  now(): number;
  sleep(ms: number): Promise<void>;
  newId(): string;
  readHolderRecord(pid: number): { sessionId: string; startedAtMs?: number; messagingSocketPath?: string } | undefined;
  readModStatus(sessionId: string): ModStatus | undefined;
  peerToken(pid: number): string | undefined;
  writeControlFile(sessionId: string, text: string): void;
  send(socketPath: string, lines: readonly string[]): Promise<void>;
  transcriptBytes(transcript: string): number | undefined;
  transcriptContains(transcript: string, needle: string, fromBytes: number): boolean;
  continuedSince(transcript: string, bytes: number | undefined): boolean;
}

export async function continueInPlace(job: ContinueJob, holderPid: number, deps: ContinueDeps): Promise<ContinueOutcome> {
  const record = deps.readHolderRecord(holderPid);
  if (!record || record.sessionId !== job.sessionId) {
    return { kind: 'fallback', reason: 'no session record for the holder' };
  }
  if (!record.messagingSocketPath) {
    return { kind: 'fallback', reason: 'the holder has no inbox' };
  }
  const token = deps.peerToken(holderPid);
  if (token === undefined && deps.platform === 'win32') {
    return { kind: 'fallback', reason: 'no inbox token for the holder' };
  }
  const transport: Transport = modUsable(deps.readModStatus(job.sessionId), job.sessionId, record.startedAtMs) ? 'mod' : 'socket';
  const bytesAtSend = deps.transcriptBytes(job.transcript);
  let body = job.prompt;
  if (transport === 'mod') {
    const nonce = deps.newId();
    try {
      deps.writeControlFile(job.sessionId, controlFileText(job.jobId, nonce, deps.now()));
    } catch (err) {
      return { kind: 'fallback', reason: `could not write the control file: ${(err as Error).message}` };
    }
    body = buildControlBody(job.jobId, nonce, job.prompt);
  }
  const msgId = deps.newId();
  const payload = buildPayload(job.sessionId, buildEnvelope(body), msgId);
  const sentAt = deps.now();
  try {
    await deps.send(record.messagingSocketPath, inboxLines(payload, token));
  } catch (err) {
    return { kind: 'fallback', reason: `send failed: ${(err as Error).message}` };
  }
  const confirmed = () =>
    transport === 'mod'
      ? continuedJob(deps.readModStatus(job.sessionId), job.jobId)
      : deps.transcriptContains(job.transcript, msgId, bytesAtSend ?? 0);
  while (deps.now() - sentAt < CONFIRM_WINDOW_MS) {
    if (confirmed()) {
      return { kind: 'continued', transport, elapsedMs: deps.now() - sentAt };
    }
    await deps.sleep(CONFIRM_POLL_MS);
  }
  if (confirmed() || deps.transcriptContains(job.transcript, msgId, bytesAtSend ?? 0) || deps.continuedSince(job.transcript, bytesAtSend)) {
    return { kind: 'landed-late', transport };
  }
  return { kind: 'fallback', reason: `not confirmed within ${CONFIRM_WINDOW_MS / 1000} s` };
}

/** Whether `needle` occurs in `file` at or after byte `fromBytes`. Unreadable is false. */
export function transcriptContains(
  file: string,
  needle: string,
  fromBytes: number,
  fs: {
    statSync(p: string): { size: number };
    openSync(p: string, flags: string): number;
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
    closeSync(fd: number): void;
  },
): boolean {
  try {
    const size = fs.statSync(file).size;
    const length = size - fromBytes;
    if (length <= 0) {
      return false;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, fromBytes);
      return buffer.toString('utf8').includes(needle);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}
```

  In the socket test, the expected `elapsedMs` follows from the fake clock: two sleeps of 1 000 ms before the third poll confirms. If your loop structure differs, fix the expectation only if the behaviour (poll, then sleep) is unchanged.

- [ ] **Step 4: `npm test`, commit.** Tick Task 8. `git commit -m "feat: continue a live session in place, confirm it, and fall back safely"`.

---

### Task 9: `sessionOpener.ts`, the open-session button

**Files:**
- Create: `src/sessionOpener.ts`, `test/sessionOpener.test.ts`

**Interfaces:**
- Produces:

```ts
export const PANEL_OPEN_COMMAND = 'claude-vscode.editor.open';
export interface OpenerDeps {
  commands(): Promise<string[]>;
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  terminals(): { processId: Thenable<number | undefined>; show(): void }[];
  parentPid(pid: number): Promise<number | undefined>;
}
export function openSession(target: { kind: 'panel' | 'terminal'; pid: number; sessionId: string }, deps: OpenerDeps): Promise<boolean>;
export function parentPidCommand(pid: number, platform: NodeJS.Platform): { file: string; args: string[] } | undefined;
```

- [ ] **Step 1: Failing tests:**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSession, parentPidCommand, PANEL_OPEN_COMMAND, type OpenerDeps } from '../src/sessionOpener';

const SID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
function deps(over: Partial<OpenerDeps> = {}) {
  const executed: unknown[][] = [];
  const shown: number[] = [];
  const d: OpenerDeps = {
    commands: async () => [PANEL_OPEN_COMMAND],
    executeCommand: async (...args) => { executed.push(args); },
    terminals: () => [10, 20].map((pid) => ({ processId: Promise.resolve(pid), show: () => shown.push(pid) })),
    parentPid: async (pid) => ({ 300: 200, 200: 20 } as Record<number, number>)[pid],
    ...over,
  };
  return { d, executed, shown };
}

test('a panel opens through the Claude Code extension when it has the command', async () => {
  const { d, executed } = deps();
  assert.equal(await openSession({ kind: 'panel', pid: 1, sessionId: SID }, d), true);
  assert.deepEqual(executed, [[PANEL_OPEN_COMMAND, SID]]);
});

test('without the command, a panel cannot be opened', async () => {
  const { d } = deps({ commands: async () => [] });
  assert.equal(await openSession({ kind: 'panel', pid: 1, sessionId: SID }, d), false);
});

test('a terminal is found by its own pid or an ancestor of the claude process, up to three levels', async () => {
  const direct = deps();
  assert.equal(await openSession({ kind: 'terminal', pid: 10, sessionId: SID }, direct.d), true);
  assert.deepEqual(direct.shown, [10]);
  const nested = deps();
  assert.equal(await openSession({ kind: 'terminal', pid: 300, sessionId: SID }, nested.d), true);
  assert.deepEqual(nested.shown, [20]);
  const absent = deps();
  assert.equal(await openSession({ kind: 'terminal', pid: 999, sessionId: SID }, absent.d), false);
});

test('the parent-pid command takes only an integer pid', () => {
  assert.deepEqual(parentPidCommand(42, 'linux'), { file: 'ps', args: ['-o', 'ppid=', '-p', '42'] });
  assert.equal(parentPidCommand(42, 'win32')!.file, 'powershell');
  assert.ok(parentPidCommand(42, 'win32')!.args.join(' ').includes('ProcessId=42'));
  assert.equal(parentPidCommand(4.2, 'linux'), undefined);
  assert.equal(parentPidCommand(-1, 'linux'), undefined);
});
```

- [ ] **Step 2: Run, see it fail.**

- [ ] **Step 3: Implement** `src/sessionOpener.ts`:

```ts
/**
 * The D9 notice's "Open Session" button: bring the session that is waiting into view, in this window only.
 * - A panel: the Claude Code extension's private `claude-vscode.editor.open`, which takes a session id first (read from the 2.1.295 extension's minified source; not smoke-tested). Checked for at run time, like reopenOffer.ts's command.
 * - A terminal: a VS Code terminal whose shell is the claude process or one of its three nearest ancestors.
 */

export const PANEL_OPEN_COMMAND = 'claude-vscode.editor.open';
const MAX_ANCESTORS = 3;

export interface OpenerDeps {
  commands(): Promise<string[]>;
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  terminals(): { processId: Thenable<number | undefined>; show(): void }[];
  parentPid(pid: number): Promise<number | undefined>;
}

export async function openSession(
  target: { kind: 'panel' | 'terminal'; pid: number; sessionId: string },
  deps: OpenerDeps,
): Promise<boolean> {
  if (target.kind === 'panel') {
    if (!(await deps.commands()).includes(PANEL_OPEN_COMMAND)) {
      return false;
    }
    await deps.executeCommand(PANEL_OPEN_COMMAND, target.sessionId);
    return true;
  }
  const lineage = [target.pid];
  for (let i = 0; i < MAX_ANCESTORS; i += 1) {
    const parent = await deps.parentPid(lineage[lineage.length - 1]!);
    if (parent === undefined || parent <= 0 || lineage.includes(parent)) {
      break;
    }
    lineage.push(parent);
  }
  for (const terminal of deps.terminals()) {
    const pid = await Promise.resolve(terminal.processId).catch(() => undefined);
    if (pid !== undefined && lineage.includes(pid)) {
      terminal.show();
      return true;
    }
  }
  return false;
}

/** The command that prints `pid`'s parent pid; undefined for anything but a positive integer, so nothing else reaches a command line. */
export function parentPidCommand(pid: number, platform: NodeJS.Platform): { file: string; args: string[] } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (platform === 'win32') {
    return {
      file: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
    };
  }
  return { file: 'ps', args: ['-o', 'ppid=', '-p', String(pid)] };
}
```

- [ ] **Step 4: `npm test`, commit.** Tick Task 9. `git commit -m "feat: open a waiting session from a notice"`.

---

### Task 10: Wire it into `extension.ts`

**Files:**
- Modify: `src/extension.ts`
- Test: `test/extension.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3 to 9.

- [ ] **Step 1: Test harness stubs.** At the top of `test/extension.test.ts`, before `require('../src/extension')`, add a stub for `./continueInPlace` that records calls and answers a configurable outcome, with a short bridged grace:

```ts
import type { ContinueOutcome } from '../src/continueInPlace';
/** What the fake continueInPlace answers during one test; default: fall back, so 1.0's launch tests keep launching. */
let continueOutcome: ContinueOutcome = { kind: 'fallback', reason: 'test default' };
const continueCalls: { sessionId: string; prompt: string; jobId: string; pid: number }[] = [];
stubModule('./continueInPlace', {
  ...(require('../src/continueInPlace') as Record<string, unknown>),
  BRIDGED_GRACE_MS: 400,
  continueInPlace: async (job: { sessionId: string; prompt: string; jobId: string }, pid: number) => {
    continueCalls.push({ sessionId: job.sessionId, prompt: job.prompt, jobId: job.jobId, pid });
    return continueOutcome;
  },
});
```

  Reset `continueOutcome` and `continueCalls.length = 0` wherever the file resets its other fakes (follow how `fakeAgentRows` is reset). Note the stub's `BRIDGED_GRACE_MS` only takes effect if `extension.ts` reads it through the module (`import { BRIDGED_GRACE_MS } from './continueInPlace'` compiles to a property read at use time under commonjs; keep it used inside functions, not copied into a top-level constant).

- [ ] **Step 2: Failing extension tests** (use `fakeAgentRows`, `sessionRecordFor`, `pastJob`, `oneTick`, `flush`, `LAUNCHER`; holder pid 77):

```ts
const idlePanel = (bridged = false) => {
  fakeAgentRows = [{ pid: 77, kind: 'interactive', sessionId: SESSION, status: 'idle', cwd: REAL_CWD }];
  sessionRecordFor.set(77, { sessionId: SESSION, entrypoint: 'claude-vscode', ...(bridged ? { bridgeSessionId: 'b' } : {}) });
};
const autoConfig = () => ({ claudeCommand: LAUNCHER, randomDelayMinMinutes: 0, randomDelayMaxMinutes: 0 });

test('an idle panel at the reset is continued in place, not launched', async () => {
  resetVscodeFake(); idlePanel(); continueOutcome = { kind: 'continued', transport: 'socket', elapsedMs: 1200 };
  vscodeFake.config = autoConfig();
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick(); await flush();
    assert.equal(vscodeFake.terminals.length, 0);
    assert.deepEqual(continueCalls.map((c) => [c.sessionId, c.pid]), [[SESSION, 77]]);
    assert.ok(vscodeFake.outputLines.some((l) => l.includes('Continued session 0b3d1f66 in place by socket (confirmed after 1200 ms)')));
  } finally { teardown(ctx); }
});

test('a continue that falls back launches a terminal, as 1.0 did', async () => {
  resetVscodeFake(); idlePanel(); continueOutcome = { kind: 'fallback', reason: 'not confirmed within 60 s' };
  vscodeFake.config = autoConfig();
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick(); await flush();
    assert.equal(vscodeFake.terminals.length, 1);
    assert.ok(vscodeFake.outputLines.some((l) => l.includes('Could not continue session 0b3d1f66 in place (not confirmed within 60 s); launching a terminal instead.')));
  } finally { teardown(ctx); }
});

test('a continue that landed late launches nothing', async () => {
  resetVscodeFake(); idlePanel(); continueOutcome = { kind: 'landed-late', transport: 'mod' };
  vscodeFake.config = autoConfig();
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick(); await flush();
    assert.equal(vscodeFake.terminals.length, 0);
  } finally { teardown(ctx); }
});

test('with continueInPlace off, an idle panel launches and nothing is sent', async () => {
  resetVscodeFake(); idlePanel();
  vscodeFake.config = { ...autoConfig(), continueInPlace: false };
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick(); await flush();
    assert.equal(continueCalls.length, 0);
    assert.equal(vscodeFake.terminals.length, 1);
  } finally { teardown(ctx); }
});

test('a waiting panel at the reset gets the waiting notice, and its button opens the panel (D9)', async () => {
  resetVscodeFake();
  fakeAgentRows = [{ pid: 77, kind: 'interactive', sessionId: SESSION, status: 'waiting', cwd: REAL_CWD }];
  sessionRecordFor.set(77, { sessionId: SESSION, entrypoint: 'claude-vscode' });
  const opened: unknown[] = [];
  vscodeFake.commands.set('claude-vscode.editor.open', (...args: unknown[]) => { opened.push(args); });
  vscodeFake.config = autoConfig();
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    const notice = vscodeFake.info.find((m) => m.items.includes('Open Session'));
    assert.ok(notice, JSON.stringify(vscodeFake.info));
    notice.answer('Open Session'); await flush(); await flush();
    assert.deepEqual(opened, [[SESSION]]);
    assert.equal(vscodeFake.terminals.length, 0);
    assert.equal(continueCalls.length, 0);
  } finally { teardown(ctx); }
});

test('a bridged panel waits its head start, then is continued if the web client did not (D11)', async () => {
  resetVscodeFake(); idlePanel(true); continueOutcome = { kind: 'continued', transport: 'socket', elapsedMs: 5 };
  vscodeFake.config = autoConfig();
  const job = { ...pastJob(), baseResumeAtMs: Date.now() - 1000 };
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', job]]));
  start(ctx);
  try {
    await oneTick();
    assert.equal(continueCalls.length, 0, 'still inside the head start');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(continueCalls.length, 1);
  } finally { teardown(ctx); }
});

test('Resume Now on a session whose idle panel is open continues it in place', async () => {
  resetVscodeFake(); idlePanel(); continueOutcome = { kind: 'continued', transport: 'mod', elapsedMs: 5 };
  vscodeFake.config = manualConfig();
  const ctx = contextOver(new Map<string, unknown>([['claudeLimitBreak.pending', pastJob()]]));
  start(ctx);
  try {
    await oneTick();
    await vscodeFake.commands.get('claudeLimitBreak.resumeNow')!();
    await flush();
    assert.equal(vscodeFake.terminals.length, 0);
    assert.equal(continueCalls.length, 1);
  } finally { teardown(ctx); }
});
```

  Also: a bridged-panel test where the transcript gets a real turn during the head start, so nothing is sent. Follow the existing continued-since tests in this file (search `has continued since it stopped`) to create a real transcript with `transcriptBytesAtDetection` and append a user entry during the wait.

- [ ] **Step 3: Run, see them fail.**

- [ ] **Step 4: Implement in `src/extension.ts`.**
  1. Imports: `randomUUID` from `node:crypto`; `continueInPlace, transcriptContains, BRIDGED_GRACE_MS, CONFIRM_WINDOW_MS, type ContinueDeps, type ContinueOutcome` from `./continueInPlace`; `findPeerToken, sendToInbox` from `./inbox`; `limitBreakDir, statusFile, controlFile, parseModStatus` from `./modStatus`; `openSession, parentPidCommand` from `./sessionOpener`; `isIdleStatus` from `./holderPolicy`; `execFile` from `node:child_process`.
  2. In `activate`, after `readHolderRecord`:

```ts
  /** The real IO behind continueInPlace (continueInPlace.ts). */
  const continueDeps: ContinueDeps = {
    platform: process.platform,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newId: () => randomUUID(),
    readHolderRecord,
    readModStatus: (sessionId) => {
      try {
        return parseModStatus(fs.readFileSync(statusFile(limitBreakDir(), sessionId), 'utf8'));
      } catch {
        return undefined;
      }
    },
    peerToken: (pid) => findPeerToken(sessionRegistryDir(), pid, (d) => fs.readdirSync(d), (f) => fs.readFileSync(f, 'utf8')),
    writeControlFile: (sessionId, text) => {
      const file = controlFile(limitBreakDir(), sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
    send: (socketPath, lines) => sendToInbox(socketPath, lines),
    transcriptBytes,
    transcriptContains: (t, needle, from) => transcriptContains(t, needle, from, fs),
    continuedSince: (t, bytes) => continuedSince(t, bytes),
  };
```

  3. Extract the busy-folder block of `onFire` into a helper used by both launch and continue:

```ts
  /** The job with the coordination sentence when a DIFFERENT session is busy in its folder (holderPolicy.ts buildResumePrompt); notified once. */
  const coordinated = (job: PendingJob, rows: AgentRow[] | 'unknown'): PendingJob => { /* the existing block, returning resumeJob */ };
```

  4. A tracked wait for the bridged head start, cancelled by Cancel and on dispose (add its timers to `nativeChecks`, which both already clear):

```ts
  const wait = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const t = setTimeout(() => { nativeChecks.delete(t); resolve(true); }, ms);
      nativeChecks.add(t);
    });
```

  (A cancelled wait never resolves, which drops the continue; that is what Cancel means.)
  5. Continue a live holder; used by `onFire` and the manual paths:

```ts
  /**
   * Continue `job` in its live holder (continueInPlace.ts). Resolves whether the job is discharged: continued, landed late, or launched after a fallback. False only when the fallback launch itself could not start.
   */
  const continueHolder = async (job: PendingJob, pid: number, manual: boolean): Promise<boolean> => {
    const id8 = job.sessionId.slice(0, 8);
    if (settings().notify) {
      void vscode.window.showInformationMessage(`Limit Break: continuing session ${id8} in place.`);
    }
    const outcome: ContinueOutcome = await continueInPlace(
      { sessionId: job.sessionId, transcript: job.transcript, prompt: job.prompt, jobId: claimKeyFor(job) },
      pid,
      continueDeps,
    );
    if (outcome.kind === 'continued') {
      log.info(`Continued session ${id8} in place by ${outcome.transport} (confirmed after ${outcome.elapsedMs} ms).`);
      if (gaveUp.launched(job.sessionId)) {
        render();
      }
      return true;
    }
    if (outcome.kind === 'landed-late') {
      log.info(`Session ${id8}'s continue by ${outcome.transport} landed after the ${CONFIRM_WINDOW_MS / 1000} s window; not launching a second process.`);
      return true;
    }
    log.warn(`Could not continue session ${id8} in place (${outcome.reason}); launching a terminal instead.`);
    return resume(job, manual);
  };
```

  6. In `onFire`, pass `s.continueInPlace` to `decideOnFire`. After the decision's log/remember handling and before the notice handling, add:

```ts
      if (decision.continueInPlace) {
        const target = decision.continueInPlace;
        void (async () => {
          if (target.bridged) {
            const headStartMs = job.baseResumeAtMs + BRIDGED_GRACE_MS - Date.now();
            if (headStartMs > 0) {
              log.info(
                `Session ${job.sessionId.slice(0, 8)} is bridged to Remote Control; giving the web client until ` +
                  `${new Date(job.baseResumeAtMs + BRIDGED_GRACE_MS).toLocaleTimeString()} to continue it.`,
              );
              await wait(headStartMs);
            }
            if (hasContinued(job)) {
              log.info(`Remote Control continued session ${job.sessionId.slice(0, 8)}; not continuing it here.`);
              return;
            }
          }
          if (!(await continueHolder(coordinated(job, rows), target.pid, false))) {
            rememberReady(job);
            releaseClaim(claimsDir(), claimKey, fs, log);
          }
        })();
        return;
      }
```

  7. The notice handler: replace Task 3's placeholder `if (decision.openSession) { return; }` with:

```ts
          if (decision.openSession) {
            const opened = await openSession(
              { ...decision.openSession, sessionId: job.sessionId },
              {
                commands: () => Promise.resolve(vscode.commands.getCommands(true)),
                executeCommand: (id, ...args) => Promise.resolve(vscode.commands.executeCommand(id, ...args)),
                terminals: () => vscode.window.terminals,
                parentPid: (pid) => readParentPid(pid),
              },
            );
            if (!opened) {
              void vscode.window.showInformationMessage(
                `Limit Break: couldn't find session ${job.sessionId.slice(0, 8)} in this window.`,
              );
            }
            return;
          }
```

  with `readParentPid`:

```ts
  const readParentPid = (pid: number): Promise<number | undefined> =>
    new Promise((resolve) => {
      const cmd = parentPidCommand(pid, process.platform);
      if (!cmd) {
        resolve(undefined);
        return;
      }
      execFile(cmd.file, cmd.args, { timeout: 5_000, windowsHide: true }, (err, stdout) => {
        const n = Number.parseInt(String(stdout).trim(), 10);
        resolve(err || !Number.isInteger(n) ? undefined : n);
      });
    });
```

  The fake `vscode` has no `window.terminals`: add `terminals: [] as FakeTerminal[]` access via a getter returning `vscodeFake.terminals` in `test/helpers/vscode.ts` (`get terminals() { return vscodeFake.terminals; }` inside `window`).
  8. Manual paths. Add:

```ts
  /** A manual resume: continue an idle live holder in place when the setting is on, otherwise launch (resume()). */
  const resumeOrContinue = async (job: PendingJob): Promise<boolean> => {
    if (settings().continueInPlace) {
      const rows = detectAgentRows();
      const holder = rows === 'unknown' ? 'unknown' : classifyHolder(rows, job.sessionId, undefined, readHolderRecord);
      if (holder !== 'unknown' && holder.kind !== 'none' && isIdleStatus(holder.status)) {
        return continueHolder(job, holder.pid, true);
      }
    }
    return resume(job, true);
  };
```

  Use it in `offerResumeNow`'s click (`if (!(await resumeOrContinue(job))) { ... }`) and in both branches of the `resumeNow` command (`if (await resumeOrContinue(counting)) { scheduler.cancel(...) } else if ...`, same for `ready`). Leave "Resume in Terminal Anyway" on `resume()`: its label promises a terminal, and it is only offered with the setting off. Pass `settings().continueInPlace` as `manualResumeWarning`'s third argument in `confirmManualResume`.
  9. Planning decision 3: in `armNativeContinueCheck`'s timer, before the `continuedSince` check, log what the mod saw, if anything: `const seen = continueDeps.readModStatus(job.sessionId)?.nativeContinue; if (seen) { log.info(\`The Limit Break mod saw Claude Code's auto-continue notice "${seen.type}" for ${job.sessionId.slice(0, 8)} at ${new Date(seen.atMs).toISOString()}.\`); }`. The transcript check still decides.

- [ ] **Step 5: Run `npm test`.** All pass, including every 1.0 launch test (the stub's default outcome is `fallback`). If a 1.0 test fails because a waiting holder now shows a notice, update its assertion to the D9 behaviour and say so in the commit message.

- [ ] **Step 6: Commit.** Tick Task 10. `git commit -m "feat: continue live sessions in place at the reset and from Resume Now; open a waiting session; give bridged panels a head start"`.

---

### Task 11: Show bridged sessions (D11 indicator)

**Files:**
- Modify: `src/scheduler.ts`, `src/statusBar.ts`, `src/extension.ts` (`schedule`)
- Test: `test/scheduler.test.ts`, `test/restoreJob.test.ts`, `test/statusBar.test.ts`, `test/extension.test.ts`

**Interfaces:**
- Produces: `PendingJob.bridged?: true`; `ResumeScheduler.markBridged(sessionId: string): boolean`.

- [ ] **Step 1: Failing tests.**
  - `restoreJob`: `bridged: true` kept; `bridged: 'yes'` → the field is deleted and the job kept (it's a hint, like `rateLimitType`).
  - `scheduler.markBridged(id)`: sets `bridged: true` on the pending job, persists, fires `onChange`, returns true; false for an unknown session.
  - `buildSessionLines`: a counting job with `bridged: true` has `, bridged to Remote Control` after its resume time.
  - Extension: with `fakeAgentRows`/`sessionRecordFor` describing a bridged idle panel for SESSION, a limit detection (`FakeWatcher.latest!.limitFor(SESSION, new Date(Date.now() + 3_600_000))`) makes the "resuming at" notice end with ` It's bridged to Remote Control, so the web client gets until <time> to continue it first.` and the stored pending job has `bridged: true`.

- [ ] **Step 2: Implement.**
  - `PendingJob.bridged?: true` with a doc comment ("Seen open in a panel bridged to Remote Control when scheduled (D11); a display hint. The fire decides from the live holder, not from this.").
  - `restoreJob`: delete a non-`true` `bridged` (extend the existing `badType` repair so both hints are repaired in one copy).
  - `markBridged`:

```ts
  /** D11: note that the pending job's session is open in a bridged panel, for the status bar. */
  markBridged(sessionId: string): boolean {
    const job = this.pending.get(sessionId);
    if (!job || job.bridged) {
      return false;
    }
    job.bridged = true;
    this.persist();
    this.onChangeEmitter.fire(this.current);
    return true;
  }
```

  - `statusBar.ts`: carry `bridged` through `Entry` and add `bits.push('bridged to Remote Control')` after the state bit when set.
  - `extension.ts` `schedule()`, after `scheduler.schedule(job)` returned true and before the notice:

```ts
    // D11: say so when the session is open in a panel bridged to Remote Control.
    // The same listing the fire uses, run only when a new job was scheduled.
    const rows = detectAgentRows();
    const holderNow = rows === 'unknown' ? 'unknown' : classifyHolder(rows, job.sessionId, undefined, readHolderRecord);
    const bridged = holderNow !== 'unknown' && holderNow.kind === 'panel' && holderNow.bridged;
    if (bridged) {
      scheduler.markBridged(job.sessionId);
    }
```

  and append to the "resuming at" message when `bridged`: `` ` It's bridged to Remote Control, so the web client gets until ${new Date(job.baseResumeAtMs + BRIDGED_GRACE_MS).toLocaleTimeString()} to continue it first.` ``. `readHolderRecord` and `detectAgentRows` are defined after `schedule` in `activate`; they are `const` arrow functions, so move their definitions above `schedule` (no behaviour change).

- [ ] **Step 3: `npm test`, commit.** Tick Task 11. `git commit -m "feat: show when a pending session is bridged to Remote Control (D11)"`.

---

### Task 12: Install the mod

**Files:**
- Create: `src/modInstall.ts`, `test/modInstall.test.ts`
- Modify: `src/extension.ts`, `package.json` (commands), `scripts/check-vsix.sh`, `.vscodeignore` (only if needed), `test/extension.test.ts` (stub)

**Interfaces:**
- Produces:

```ts
export const MOD_ID = 'limit-break@limit-break';
export const MARKETPLACE = 'limit-break';
export const OFFER_KEY = 'claudeLimitBreak.modOffer';         // 'never' | undefined
export const INSTALLED_VERSION_KEY = 'claudeLimitBreak.modVersion';
export function marketplaceJson(): string;
export function isModInstalled(listJson: string): boolean;
export function installSteps(marketplaceDir: string): string[][];
export function updateSteps(): string[][];
export function removeSteps(): string[][];
export function copyMod(srcDir: string, destDir: string, fs: CopyFs): void; // skips *.test.ts
export function shouldOfferInstall(i: { enabled: boolean; continueInPlace: boolean; installed: boolean; offer: string | undefined }): boolean;
export function runSteps(steps: string[][], run: (args: string[]) => Promise<string>): Promise<{ ok: true } | { ok: false; step: string[]; error: string }>;
```

- [ ] **Step 1: Failing tests** `test/modInstall.test.ts`:

```ts
test('the marketplace lists the mod from ./mod', () => {
  assert.deepEqual(JSON.parse(marketplaceJson()), { name: 'limit-break', owner: { name: 'Dream Mosaic' }, plugins: [{ name: 'limit-break', source: './mod' }] });
});
test('installed means an entry with the mod id', () => {
  assert.equal(isModInstalled(JSON.stringify([{ id: 'limit-break@limit-break', enabled: true }])), true);
  assert.equal(isModInstalled(JSON.stringify([{ id: 'other@x' }])), false);
  assert.equal(isModInstalled('not json'), false);
});
test('the CLI steps', () => {
  assert.deepEqual(installSteps('/g/marketplace'), [['plugin', 'marketplace', 'add', '/g/marketplace'], ['plugin', 'install', 'limit-break@limit-break', '--scope', 'user']]);
  assert.deepEqual(updateSteps(), [['plugin', 'marketplace', 'update', 'limit-break'], ['plugin', 'update', 'limit-break@limit-break']]);
  assert.deepEqual(removeSteps(), [['plugin', 'uninstall', 'limit-break@limit-break', '--scope', 'user'], ['plugin', 'marketplace', 'remove', 'limit-break']]);
});
test('the offer is made only when it can help and was not refused for good', () => {
  const base = { enabled: true, continueInPlace: true, installed: false, offer: undefined };
  assert.equal(shouldOfferInstall(base), true);
  assert.equal(shouldOfferInstall({ ...base, installed: true }), false);
  assert.equal(shouldOfferInstall({ ...base, offer: 'never' }), false);
  assert.equal(shouldOfferInstall({ ...base, continueInPlace: false }), false);
  assert.equal(shouldOfferInstall({ ...base, enabled: false }), false);
});
test('runSteps stops at the first failure and names it', async () => {
  const ran: string[][] = [];
  const out = await runSteps([['a'], ['b'], ['c']], async (args) => { ran.push(args); if (args[0] === 'b') throw new Error('boom'); return ''; });
  assert.deepEqual(out, { ok: false, step: ['b'], error: 'boom' });
  assert.deepEqual(ran, [['a'], ['b']]);
});
test('copyMod copies the plugin files and skips tests', () => { /* real temp dirs: mod/.claude-plugin/plugin.json, mod/hooks/register.mjs, mod/hooks/register.test.ts → only the first two copied */ });
```

  Write the `copyMod` test against real temp directories (`fs.mkdtempSync`).

- [ ] **Step 2: Implement** `src/modInstall.ts` (pure, plus `copyMod` over an injected `fs`), with doc comments explaining: the mod is copied out of the versioned extension folder into `globalStorage/marketplace/mod`, a stable folder marketplace that Claude Code reads in place; `runSteps` takes the `claude` runner so tests never run the CLI.

- [ ] **Step 3: Wire into `extension.ts`.**
  - A runner: `const runClaude = (args: string[]): Promise<string>` using the launcher from `findLauncher(settings().claudeCommand)` and `execFile(launcher.file, [...launcher.args, ...args], { timeout: 60_000, windowsHide: true, encoding: 'utf8' })`; rejects with stderr's first line on failure.
  - `marketplaceDir = path.join(context.globalStorageUri.fsPath, 'marketplace')`; `installMod()`: `copyMod(path.join(context.extensionPath, 'mod'), path.join(marketplaceDir, 'mod'), fs)`, write `path.join(marketplaceDir, '.claude-plugin', 'marketplace.json')`, `runSteps(installSteps(marketplaceDir), runClaude)`, then store `INSTALLED_VERSION_KEY` = the extension's version and show "Limit Break: the Claude Code mod is installed. Sessions started from now on load it; an open session loads it after /reload-plugins." or the failure ("Limit Break: couldn't install the Claude Code mod (`claude <step>`: <error>). Limit Break still works through each session's inbox.").
  - `maybeOfferMod()`, called fire-and-forget at the end of `activate` like the update check (`.catch(() => {})`): reads `plugin list --json` through `runClaude`; if installed and `INSTALLED_VERSION_KEY` differs from the extension's version, re-copy and run `updateSteps()` (log only); if `shouldOfferInstall(...)`, show "Limit Break can install a small Claude Code mod. It lets Limit Break continue a session as you, and read limits exactly. Without it, Limit Break uses each session's inbox." with `Install`, `Not now`, `Never`; `Never` stores `OFFER_KEY = 'never'`.
  - Commands `claudeLimitBreak.installMod` ("Limit Break: Install Claude Code mod") and `claudeLimitBreak.removeMod` ("Limit Break: Remove Claude Code mod"; runs `removeSteps()`, clears `INSTALLED_VERSION_KEY`, reports the result) registered in `activate` and declared in `package.json` `contributes.commands`.
  - `test/extension.test.ts`: stub `./modInstall` with the real module spread and `shouldOfferInstall: () => false`, and stub the runner path so activation never runs `claude` (make `maybeOfferMod` call `runClaude` only after `shouldOfferInstall` could be true is not possible since it needs the list: instead export from `modInstall.ts` a `listInstalledPlugins(run)` and stub it to resolve `'[]'`). Add one test: with `shouldOfferInstall` stubbed true, activation shows the offer and `Never` stores `claudeLimitBreak.modOffer = 'never'`.
  - The fake context has no `globalStorageUri`/`extensionPath`: give `contextOver` `globalStorageUri: { fsPath: path.join(os.tmpdir(), 'clb-global') }` and `extensionPath: process.cwd()`, and `extension: { packageJSON: { version: '1.1.0' } }`.
- [ ] **Step 4: Packaging.** Make sure the VSIX ships `mod/.claude-plugin/plugin.json`, `mod/hooks/hooks.json`, `mod/hooks/register.mjs`, `mod/hooks/control.mjs` and not `mod/hooks/register.test.ts` (already excluded by `**/*.ts`). Add the four to `scripts/check-vsix.sh`'s must-ship list (follow its existing pattern). Run `npx @vscode/vsce ls` (or the repo's packaging command from `package.json`/README "Development") and confirm the four appear.
- [ ] **Step 5: `npm test`, commit.** Tick Task 12. `git commit -m "feat: offer to install the Claude Code mod, with install and remove commands"`.

---

### Task 13: Docs, version 1.1.0, smoke kit

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json` (version), `test/smoke/README.md`, `docs/superpowers/specs/2026-10-09-live-continue-and-mod-design.md` (note the planning decisions)

- [ ] **Step 1: README.**
  - "## How it resumes": a live, idle session is continued in place; a launch only when no live process holds the session, or a continue in place fails.
  - New "## Continuing a live session in place": the two transports (mod, else the session's inbox), the 60 s confirmation and what "landed late" means, the fallback launch, and that a socket continue reaches the model as a message from another session (it may stop before an irreversible step and ask you). Bridged panels: the 5-minute head start. A session waiting on a prompt at the reset: the notice and Open Session.
  - New "## The Claude Code mod": what it does (status files in `~/.limit-break/sessions/`, consumes Limit Break's control messages, continues as you), that it never acts on its own, the install offer, the commands, and the manual install:

    ```
    /plugin install limit-break --marketplace Dream-Mosaic/claude-limit-break
    ```

    then `y`, then the user scope; `/reload-plugins` for sessions already open.
  - New "## A resume that comes due while VS Code is closed" (D10): more than 10 minutes late is dropped with a log line.
  - "## The panel tab after a resume": the stale-tab offer applies only to a launch.
  - Settings table: `resumePrompt` (goes out on all three paths), `resumeMode`/`headlessPermissionMode` and `onStale` (launch only) wording per the spec's table.
  - "## Development": `claude plugin validate mod` and `claude plugin test mod`.
- [ ] **Step 2: CHANGELOG** `## 1.1.0` in the file's existing format: Added (continue in place, the mod, waiting notice, bridged head start, install/remove commands), Changed (late fire dropped; resets beyond `maxWaitHours` announced not scheduled), Removed (offer-only route).
- [ ] **Step 3: `package.json` version `1.1.0`.** (`mod/.claude-plugin/plugin.json` and `MOD_VERSION` are already 1.1.0.)
- [ ] **Step 4: Smoke kit Part 1 rows** in `test/smoke/README.md` (by hand, with the user):

  | # | What | Expect |
  |---|------|--------|
  | L1 | Mod install offer | On first activation with the mod absent: the offer; Install runs `claude plugin marketplace add` and `claude plugin install`; `claude plugin list` shows `limit-break@limit-break` |
  | L2 | Idle panel, mod | Leave A's panel open and idle at the injected limit. At the reset: no new terminal; the log says `Continued session <A> in place by mod (confirmed after N ms)`; the transcript has no branch points. Record N. |
  | L3 | Idle panel, socket | Remove the mod (command), restart the panel, repeat L2: `by socket`; the panel shows "Message from @limit-break". Record N. |
  | L4 | Idle terminal (#29) | A open in a terminal instead, native auto-continue off: continued in place, no second terminal. |
  | L5 | Fallback | Point `messagingSocketPath` at nothing (close the panel right after the listing; or edit the record): falls back to a launch after the send fails. |
  | L6 | Waiting | Leave A at a permission prompt at the reset: the waiting notice; Open Session focuses the panel. |
  | L7 | Late fire | Close VS Code before A's reset; reopen more than 10 minutes after it: nothing resumes; the log says it came due while VS Code wasn't running. |
  | L8 | Open button, terminal | As L6 with A in a terminal: Open Session shows that terminal. |

  Add a line: "Record L2 and L3's N in `docs/research/` with the date and Claude Code version; the 60 s window should rest on these."
- [ ] **Step 5: Spec note.** Under the spec's "## The mod", add a short "Planning notes (2026-10-11)" list: the pid substitute (`loadedAtMs` ≥ process `startedAt`), `movedTo` instead of a delete, native notices logged only, `.mjs`, the install command. Mark each "[derived from the 2.1.296 mod types]".
- [ ] **Step 6: Full check.** `npm test` passes; `claude plugin validate mod` passes; package the VSIX and run `bash scripts/check-vsix.sh <vsix>`.
- [ ] **Step 7: Commit.** Tick Task 13. `git commit -m "docs: 1.1.0: continue in place, the mod, and the smoke checks"`. Push the branch (`git push -u origin feat/1.1-live-continue`). Do not open a PR or merge.
