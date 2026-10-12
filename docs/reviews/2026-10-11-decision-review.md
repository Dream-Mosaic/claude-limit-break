# Adversarial review of the Limit Break 1.1 decisions

Branch `feat/1.1-live-continue` at `ea227ca`. Written independently: the other reviewer's report in this folder was not read. Method: read the spec, plan, ledger, final-fix list, the three research notes, README, CHANGELOG and smoke kit, then checked each argument against `src/` and `mod/`. Nothing was run. Where the code or docs don't say, the text says so.

## Summary

The shape of 1.1 is sound: the dangerous fallbacks (a terminal never gets an automatic second terminal; a late delivery is never followed by a launch; a rejected send is distinguished from an ambiguous one) were all thought through. The weak points are not in the transport mechanics. They are in what happens **after the transport reports success**, and in **how much of the new behaviour rests on untested ground**.

- Every live-continue path (L1 to L9 in `test/smoke/README.md`) is **unrun**. The kit's "Last run" is 1.0.0 (`test/smoke/README.md:111`). 1.1.0 is dated 2026-10-11 in the CHANGELOG. The only live evidence is the 2026-10-08 spikes: one machine, Claude Code 2.1.293, idle panels that had been interrupted with Esc, not stopped by a real limit or overload.
- "Confirmed" means "delivered", not "working". After a confirmed socket continue nothing watches for the model replying "I won't act on a peer message without your confirmation", which is what the spike's third run did. D9 ("nothing follows a resume") contradicts the research note's own recommendation.
- The 60 s fallback can launch a second writer into a session that is busy, not stuck. Nothing re-checks the holder's status before the fallback launch.
- D11's 5-minute head start is a no-op at the default settings (jitter minimum is 5 minutes).
- D6's control message carries the prompt itself, so anyone who can read the control file can make the mod submit arbitrary text as the user.

## Verdict table

| Id | Decision | Verdict |
|---|---|---|
| D1 | Mod = actuator plus sensor; extension decides | STANDS |
| D2 | Mod continues with `asUser: true` | STANDS |
| D3 | Offer to install the mod, user scope | WEAKENED |
| D5 | Socket as fallback, peer-authority continue | WEAKENED |
| D6 | Nonce, replay guard; prompt travels in the message | WEAKENED |
| D7 | Fixed `~/.limit-break/` folder | STANDS |
| D8 | Idle terminals continued in place | WEAKENED |
| D9a | Waiting session gets a notice | STANDS (status semantics unverified) |
| D9b | Nothing follows a resume | OVERTURN (narrowly: for the socket path) |
| D10 | Late fire (>10 min) dropped, log line only | WEAKENED |
| D11 | Bridged panel: 5-minute head start | OVERTURN (as specified; it does nothing by default) |
| D12 | Offer-only route removed | STANDS |
| Spec step 3 | 60 s confirm window, then fall back to a launch | WEAKENED |
| Spec step 3 | "Last look" before falling back | STANDS (but incomplete: see 60 s entry) |
| Ledger T8 | ENOENT/ECONNREFUSED fall back at once; other rejections run the confirm loop | STANDS |
| Ledger T6 | `continued` written only after submit resolves; in-memory in-flight set | STANDS |
| Ledger T11 | Keep `detectAgentRows` placement; sync listing at schedule time | WEAKENED (minor) |
| Final A1 | Terminal fallback = 1.0 offer, never an automatic second terminal | STANDS |
| Final A2 | Open Session only when `process.pid` is in the holder's 4 nearest ancestors | STANDS (safe direction; unmeasured) |
| Final B1 | Don't promise limit sensing | STANDS |
| Final C | Inbound deliveries are neutral in `continuedSince` | STANDS (one-transcript evidence) |
| Final D | Log every fire and outcome | STANDS |

Counts: STANDS 13, WEAKENED 7, OVERTURN 2 (D9b, D11). D9a and D9b are counted separately.

## Details

### Spec step 3: the 60 s window and the fallback launch (WEAKENED)

**Decision.** If a continue isn't confirmed within 60 s, take a last look, then fall back to `resume()` for a panel (`src/continueInPlace.ts:98-120`, `src/extension.ts:983-984`).

**Case against.**
1. *The cost the window guards is a fork, and the window is not tied to what the session is doing.* The README says a busy session "reads it between tool calls" (`2026-10-08-socket-and-mod-spikes.md:28-29`). The holder was classified idle when the fire read `claude agents`, but the field notes show idle is not inert: a task notification starts a turn on an idle panel (`2026-09-field-observations.md:78-86`). If that happens between the listing and the send, the message waits for a tool-call boundary, which can be minutes into a build. At 60 s Limit Break launches a second `claude --resume` into a session that is actively working. That is the #6 fork, in the worst form (the panel's branch survives and the resume's turn is lost: `2026-09-20-panel-fork-experiment.md:46-53`). The last look does not help: it finds nothing because nothing has landed yet. Nothing in `continueHolder` re-reads the holder's status before `launchedAfterFallback`.
2. *Messages can be held.* The spike notes that a session that bypasses permissions "holds peer messages for approval", and the panel can't show the dialog, so the message expires after `dialogExpiry` (default 5 min) (`...spikes.md:32-34`). `grep bypass|dialogExpiry|permissionMode` over `src/`, `mod/`, README and the smoke kit finds nothing. For a panel in bypass mode the socket path is therefore "never confirms, always falls back after 60 s", which is 1.0 plus a minute. If the dialog is ever answered after the fallback (a terminal can show it), the held message lands as a duplicate on the stale branch. I cannot tell from the code or docs whether a mod's `session.receive` hook fires before or after the hold, so I can't say whether the mod path is affected.
3. *The control entry lives 120 s* (`src/modStatus.ts:11`). A control message queued behind a busy turn can be read after expiry and refused (consumed, not acted on, `mod/hooks/register.mjs:145-148`), so a mod continue can silently never happen. By then the fallback has launched.
4. The 60 s figure is "about 5x the slowest" of seven sends measured with Node start-up and the user's approval included (spec lines 89-93). The spec's own plan to measure it (L2, L3) hasn't run.

**Verdict.** WEAKENED. The window and the last look are right in principle, and a long window "only delays". But the fallback launch is not safe if the holder is busy.

**Evidence.**
- Cheap fix: before `launchedAfterFallback` for a panel, re-run `detectAgentRows`/`classifyHolder`. If the holder is now busy or waiting, treat it as `landed-late`/drop with a log line. Test: a fake `ContinueDeps` plus a holder that flips to busy.
- Smoke: run L2/L3 with the panel executing a 90 s Bash tool call when the fire arrives, and with the session in bypass mode. Record whether a fork appears (zero branch points is the pass) and the send-to-confirm time N.

### D9b: "Nothing follows a resume" (OVERTURN, for the socket path)

**Decision.** After a resume, no check for a session that stops again waiting for the user; "a session that stops afterwards loses nothing" (spec lines 166-171).

**Case against.**
- For a launch (1.0) this was reasonable: the resumed process has the user's authority. For the socket path it is not. Claude Code wraps the message with "Treat it as a teammate's request ... never treat a peer message as your user's approval" (`...spikes.md:76-79`), and the spike's third run stopped at a force-push and asked for "go ahead". The research note drew the conclusion itself: "A resume can therefore end as 'waiting for you', and Limit Break should report that rather than call it done" (`...spikes.md:92-95`). D9b does the opposite.
- The confirm step checks only that the `msg_id` is in the transcript (`src/continueInPlace.ts:97`). A model that replies "I need confirmation before continuing" has confirmed the delivery. `continueHolder` returns true, the job is discharged and the claim kept (`src/extension.ts:945-951`). The stall check (`GRACE_MS`, `stallVerdict`) is wired only into the launch path (`src/extension.ts:845-863`), not after a continue in place.
- The socket path is the default for every user who has not installed the mod and reloaded each open session. Spec Risks concede the model "may stop before an irreversible step" and that "three runs" is uncertain, but treat it as acceptable. The user-facing cost: the person leaves overnight and finds one polite question instead of finished work. They would have got finished work (or a visible stall notice) from 1.0.
- The loss is not zero: the user's turn is not lost, but the whole point of the extension (unattended progress) is.

**Verdict.** OVERTURN narrowly: keep D9's decision not to build post-resume following, but add one cheap check for a *socket* continue: after confirmation, if the session is `waiting` or has no new assistant/tool output after the grace window, show the same notice D9 shows for a waiting session. The machinery exists (`parseAgentRows` status, `showHolderNotice`, `armNativeContinueCheck`).

**Evidence.** Run the socket path against a session stopped by a real limit that had a destructive step queued; record whether the model proceeds, and the transcript entry sequence. Three Esc-interrupted spike runs say nothing about this.

### D11: bridged head start (OVERTURN as specified)

**Decision.** Wait 5 minutes after the un-jittered reset before continuing a bridged panel (`src/extension.ts:1661-1670`, `BRIDGED_GRACE_MS`).

**Case against.** `resumeAtMs` is the reset plus jitter, and the default jitter is 5 to 30 minutes (`package.json:154-165`). `headStartMs = baseResumeAtMs + 5 min - Date.now()` is therefore `<= 0` at every fire with the defaults, so the `await wait(...)` never runs. The scheduled-notice text (`src/extension.ts:326`) still promises the web client "until <base+5 min>". The two continues seen came about 90 s after the reset, so jitter already provides a head start of 3 to 28 times that. What actually protects a bridged panel is the existing `hasContinued` check at fire time (`src/extension.ts:1671`, and earlier at 1614), which is 1.0 behaviour. The grace only does something for users who set `randomDelayMinMinutes` below 5.
- Counter-cost: the README and CHANGELOG describe a "5-minute head start" as a feature. It is accurate only with a low jitter.
- Evidence base is two observations on one account, plus "the user reports the web client is sometimes flaky" (spec lines 214-216).
- When the wait does run it is an in-memory `await`: closing the window during it loses the job (claim kept, job cleared), which the ledger's "window closed mid-continue" known limit covers for 60 s but not for 5 minutes.

**Verdict.** OVERTURN as a mechanism. Either base the head start on `resumeAtMs` (so it adds time on top of jitter, which would then be a real decision about delaying all bridged users by 5 more minutes), or drop the wait and the claim in the notice and document that the fire-time `hasContinued` check is the protection. I'd drop it.

**Evidence.** Unit: with default jitter, assert `headStartMs <= 0` for any jitter draw. Field: a log of bridged panels at a reset, with the web client's continue time relative to `baseResumeAtMs` and to the jittered fire.

### D6: control message carries the prompt (WEAKENED)

**Decision.** The message body is `[limit-break-control v1] {jobId, nonce, prompt}`; the mod checks jobId and nonce against the control file and then submits `control.prompt` (`mod/hooks/register.mjs:129-152`, `mod/hooks/control.mjs:53-75`).

**Case against.** The nonce is checked, the prompt is not. Anything that can read `~/.limit-break/control/<id>.json` during its 120 s life, and send to the session's inbox (the `peerToken` file in `~/.claude/sessions` is user-readable, and a model's file tools can read both), can get the mod to submit arbitrary text as the user into a session. That is a prompt injected with user authority, which skips the peer-message hold. The spec says plainly that it does not defend against a process "that runs as the user and sets out to read the file" (D6). But a model with file tools following a prompt-injected instruction is not the same as a hostile process, and the fix costs little: put the prompt in the control entry (written only by the extension) and let the message carry only `jobId` and `nonce`. A forged message could then only trigger the extension's own prompt. Reading the file would no longer be enough to inject text.

**Verdict.** WEAKENED. The decision matches its stated threat model, but a stronger variant is nearly free. The residual: the control file is written with `0o600` on POSIX only (ledger "parked" item), and on Windows file mode isn't enforced.

**Evidence.** A mod test where the message prompt differs from the file's prompt and the mod must submit the file's.

### D5 and the socket as the default path (WEAKENED)

**Decision.** Without the mod, post the enveloped `resumePrompt` as a peer message.

**Case against.** See D9b for the model-authority risk and the 60 s entry for the hold. In addition: the spec's own Risk list says "Continuing an idle terminal session has not been tested" and the spikes never put a session through a real usage-limit stop; the field notes record only that a panel process "stays alive and keeps working after a 429", "inferred" (`2026-09-20-panel-fork-experiment.md:78-81,153-155`). Default `continueInPlace: true` makes a path with those gaps the primary 1.1 behaviour. The 1.0 behaviour for an idle panel (a second process) was a known fork risk, but also a *known-to-work* resume.

**Verdict.** WEAKENED. Defensible because the fallback returns to 1.0 behaviour on failure and the failure modes are mostly delay, not loss. The unmeasured part is the "confirmed but did nothing useful" case (D9b).

**Evidence.** The smoke kit rows L2, L3, L4 with the stop injected by a real limit (not Esc), on 2.1.296 or whichever version ships.

### D10: late fire dropped with a log line only (WEAKENED)

**Decision.** A fire more than 10 minutes past `resumeAtMs` is dropped, with no notice, and Resume Now doesn't know about it (spec lines 104-127; `src/extension.ts:1596-1607`).

**Case against.**
- The justification is that the person who just opened VS Code is there. But a stopped session is not visible at a glance: someone who closes the lid at 11 pm with three limit-stopped sessions opens it at 8 am to a quiet window. Limit Break's value is that they don't have to remember which sessions were waiting. After D10 and D12 (no ready list), nothing in the UI records them. The log line is in an output channel that isn't open (persistent logs are held for #36).
- Not all late fires mean "the person is there": VS Code can reopen at login, or from a restored window, with nobody at the machine.
- It applies even if `autoResume` is off (spec line 123-125), where the old behaviour was a Resume Now offer, so the user loses an offer that was harmless.
- The claim is kept, so every other window drops its copy too.
- Counter: at a threshold of 10 min a laptop that sleeps through a reset really did not run anything, and firing on wake into a session the user has just started to work in could collide. The `hasContinued` check already covers a user who has typed.

**Verdict.** WEAKENED. The rule is defensible, but "silent" is the weak half. One notice on wake ("N resume(s) came due while VS Code wasn't running: sessions X, Y. Resume now?") would keep the safety (no automatic action) and keep the inventory. It would also restore what D12 took out.

**Evidence.** L7 in the smoke kit covers the drop. A measurement that would settle the wider question: how long between lid-open and a first keystroke in the session on the maintainer's machine, over a week of logs.

### D3: install offer, user scope (WEAKENED)

**Case against.** A user-scope plugin loads into every Claude Code session on the machine, including terminals outside VS Code and any other IDE, and runs `session.receive` for every inbound message. The benefit in 1.1 is small: the extension doesn't read `rateLimits` or `lastStopFailure` (README and CHANGELOG now say so after B1), and the mod's only 1.1 contribution is "continue with user authority". The status file is rewritten whole on each event and one file per session is left behind forever (`$.fs` has no delete; only the Remove command clears them). The mod's behaviour in the VS Code panel is "undocumented" and rests on one run on 2.1.293 (spec Risks). A bug in `register.mjs` is a bug in all the user's sessions, not only the ones Limit Break touches.

**Verdict.** WEAKENED. Optional, one-time offer with Never, and Remove exists, so it's defensible. The offer's wording (B1) is now honest. I would still want the offer to say it loads into all Claude Code sessions.

**Evidence.** `claude plugin test mod` plus L1; a session-count run to see how many files accumulate.

### D8: idle terminals continued in place (WEAKENED)

**Case against.** Untested on terminals (spec Risks, smoke L4). The native auto-continue check path (idle terminal, five-hour limit, native on) still ends in a *click* ("Claude Code did not continue it on its own. Resume it here?", `src/extension.ts:1223-1226`), even though continuing in place is non-forking. So D8's headline goal (closing #29: idle terminals unattended) is met for overloads, other limit types and native-off, but not for the most common terminal case, a five-hour limit with the Claude Code default of auto-continue on. Whether the click then uses `resumeOrContinue` (it does: `src/extension.ts:995-1004`) doesn't change that it needs a person.

**Verdict.** WEAKENED. The conservative choice avoids a double-continue race with native, which is a real risk. Not wrong, but the README should not suggest #29 is closed for five-hour limits.

**Evidence.** A measurement of how often native auto-continue fires in terminals on the maintainer's machine; L4 with native on.

### D9a: waiting notice (STANDS, with a gap)

The decision itself is right: continuing in place into a prompt would answer it by accident. The gap: nothing in the record says what `claude agents --json` reports as `status` for a session stopped on a rate limit in a panel or terminal. If Claude Code shows a limit dialog that counts as `waiting`, every limit-stopped terminal would route to "Open Session" instead of being continued. `parseAgentRows` fails open for *missing* status only. The spec's blocked/waiting section (lines 183-210) is about background jobs. **Evidence:** log the status at the fire for the L2 and L4 runs.

### D2, D1: `asUser` submit, mod as dumb actuator (STANDS)

The 1.0 terminal resume already carries the user's authority; `asUser` gives the same. The spec records the cost that `asUser` turns look like typing (the `[Limit Break]` prefix marks them). It also clears the model's hold on irreversible steps, which the spikes noted. That is a behaviour the user decided, and it matches 1.0. The `register.mjs` handler follows the spike's S4 shape (unawaited submit from `session.receive`), and the S2 finding (a submit inside a command handler is dropped) is respected.

### D7: fixed `~/.limit-break/` folder (STANDS)

Attack: wrong home on exotic setups (WSL, a `HOME` override on Windows). The mod reads `USERPROFILE` first, so a Git-Bash `HOME` doesn't mislead it on Windows. Remote setups run both ends in the same host (`extensionKind: workspace`). No case found where the two disagree and a wrong decision follows: the worst case is the mod isn't recognised and the socket is used.

### D12: offer-only route removed (STANDS)

Attack: a user with several weekly-limited sessions has no list of them. The argument for removal (an offer days later, mid other work, lingering after a manual continue) is sound, and the cost is small. Mitigation exists (the once-per-detection notice). Worth revisiting only if D10 gets a "came due while closed" notice, since that would be the natural place for both.

### Ledger rulings

- **T8 (ENOENT/ECONNREFUSED fall back at once, others confirm):** STANDS. Derived from the fact that those codes precede any write. The cost, up to 60 s of delay, is the safe side. I can't verify the exact Windows error for a missing named pipe from the repo; `inbox.ts` and its tests cover the path.
- **T6 (`continued` only after submit resolves as entered; in-memory in-flight set):** STANDS. Writing `continued` before the submit would confirm a continue that then fails. The cost named (a double continue across a mod reload mid-submit) is narrow.
- **T11 (sync `claude agents --json` at schedule time, 10 s timeout):** WEAKENED, minor. `runAgentsListing` is `execFileSync` on the extension host, now run once per newly scheduled job as well as at each fire. A hung `claude agents` blocks the host for up to 10 s per detection. Not a fork or loss risk. Evidence: time the call under a loaded machine.
- **Final A1 (terminal fallback = remember + offer; manual shows the fork modal):** STANDS. It honours spec goal 3 ("keep 1.0's behaviour wherever the new paths can't be used") over the spec's "fall back to `resume()`" line. It also means the stall check never covers a terminal's continue, consistent with 1.0's offer.
- **Final A2 (Open Session only if `process.pid` is within the 4 nearest ancestors):** STANDS. Fails toward "another window" with no fork. Unmeasured: depth 4 on Windows (`claude.exe` through a wrapper) and with extensions in separate hosts. A wrong depth makes the button useless but not harmful. `extensionKind: workspace` makes the same-host assumption plausible. Evidence: L6 and L9.
- **Final C (task notifications and cross-session messages are neutral in `continuedSince`):** STANDS. Derived from a real transcript at three baselines, and the failure it removes (a resume skipped as "continued") is the user's own report. Residual: it rests on one transcript, and that session (7a00d6c0) was a background (`template: "bg"`) job per spec lines 187-198, where "queued into a stopped session without waking it" may not describe a live panel. The field notes show a live panel wakes on a task notification (`2026-09-field-observations.md:78-86`); there the wake leaves an assistant entry, which still counts, so the rule degrades correctly.
- **Final B1 (don't promise limit sensing):** STANDS. README and CHANGELOG now match the code (`nativeContinue` logged only; nothing reads `rateLimits`).
- **Final D (log every fire and outcome):** STANDS. Logging only; it is how every item above can be checked from a real run.
- **Ledger "known limits" (window closed mid-continue leaves the claim held; two processes on one session can fool `loadedAtMs`):** accepted as recorded. Added consideration: the bridged wait (D11) and the 60 s window make the first one a window of minutes only with unusual jitter settings.

### Smaller points, not rated

- `modUsable` is true after the mod is removed with `claude plugin uninstall` plus `/reload-plugins` outside the Remove command, because the stale status file's `loadedAtMs` is still `>=` the process start. The control message then reaches the model as a peer message containing the prompt and a nonce. Confirmation never comes from the mod; the transcript last look catches a model that acted on it. Low probability.
- README line 81-82 still says "launches at once" when nothing is listening; for a terminal it is now an offer (ledger parked item).

## What to run first

1. L2/L3/L4 on the shipping Claude Code version, with the stop produced by a real limit or an injected `isApiErrorMessage` entry plus a live process, recording N, zero branch points, and the model's reaction to a peer continue.
2. The same with the panel running a long Bash call at the fire, and in bypass mode.
3. A bridged panel with default jitter: confirm no wait occurs.
4. `status` at the fire for a limit-stopped panel and terminal.
