# Prior art

Three projects solving something adjacent to this one, reviewed 2026-09-10/11.
Recorded because it is expensive to re-derive and because two of the findings
changed what this project does.

Nothing here was copied. Licences are stated so that anything adopted later can
be attributed properly, to the standard [UPSTREAM.md](../UPSTREAM.md) already
sets.

## How to read the claims below

Each factual claim is marked:

- **Derived** — checked directly against the source, the docs, or this machine,
  by the author of this document. The command or file is named.
- **Reported** — from a research agent's summary, not independently checked.
  Treat as a lead, not a fact.

The distinction is kept because several claims in the first draft of this
document were written as settled when they were only reported, and two of those
turned out to need correction. See [What is still
unverified](#what-is-still-unverified) at the end.

## The three projects

| | Claude-Autopilot | claude-standby | claude-limits-vscode |
|---|---|---|---|
| What it is | VS Code extension wrapping one long-lived PTY | bash CLI + detached daemon, thin editor cockpits | VS Code status-bar usage monitor |
| Detection | regex over terminal stdout | cheap probe + status-line feed | polls `/api/oauth/usage` |
| Resume | types `continue` into the running process | headless `--resume … -p` from the daemon | none — does not resume |
| Licence | MIT | MIT | **none stated** |

`claude-limits-vscode` turned out not to be prior art for this problem at all. It
shows quota percentages in the status bar and never reads a transcript, never
waits out a cooldown, and never resumes anything. It is included only for the two
adjacent findings below and because ruling it out is itself useful.

## What validated this project's approach

**Detection by structured field beats detection by prose, and there is a dated
production failure to prove it.** *(Reported, with a derived component.)*
Claude-Autopilot matches Claude's human-facing output with two regexes over
terminal stdout. Its issue #25 records the CLI's wording changing to `5-hour
limit reached ∙ resets 1am`, which the original single pattern did not match;
PR #26 bolted on a second pattern reactively. This project reads
`isApiErrorMessage` / `error: "rate_limit"` / `apiErrorStatus` off the JSONL
transcript instead, which does not move when the prose does.

The prose still has to be parsed for the *reset time*, so this is a reduction in
exposure rather than an escape from it. Which is why the corpus now pins notices
captured from real transcripts, not only forms taken from the documentation —
see `test/parsers/limitParser.test.ts`.

**A real limit does not kill the session that hit it.** *(Derived.)* This
project's own supervising session recorded five genuine `apiErrorStatus: 429`
entries across 2026-09-10 and 2026-09-11 and was still listed as a live
`interactive` process afterwards by `claude agents --json`. That matters because
it means the session being resumed is *always* alive at detection time — it is
what wrote the notice — which is the premise of the fork problem in issue #6.

This supersedes an earlier, weaker version of the same finding that was measured
against a mock API server. No mock is involved here.

## What changed this project

**The resume terminal inherits the editor's environment.** *(Derived, in part —
see the caveat.)* claude-standby hit this as a reproducible hang: its daemon,
spawned from inside a VS Code extension's process tree, inherited `VSCODE_*` and
IDE-lock signals; `claude` concluded it was running inside an editor, opened an
IDE bridge, answered the prompt, and then never exited. Their fix was to strip
those variables before exec.

Derived for this project: `TerminalOptionsLike` in `src/resumer.ts` has no `env`
field at all, so the terminal inherits whatever the extension host holds, plus
anything other extensions contribute through `environmentVariableCollection`.
The Claude Code extension does contribute to that collection — its activation log
says `Set CLAUDE_CODE_SSE_PORT=… in terminal environment (in-memory)`.

**Not derived, and the distinction matters:** whether the *extension host's*
environment actually carries `CLAUDE_CODE_SESSION_ID` and friends at
`createTerminal` time. The environment inspected during this review belonged to a
shell running *inside* a Claude session, which is a contaminated sample and
proves nothing about the extension host. Tracked as issue #9 with that caveat
stated.

**`rate_limits` is a documented field, not a side channel.** *(Derived, from the
status line documentation.)* Claude Code sends the status line command a JSON
payload on stdin that includes:

- `rate_limits.five_hour.resets_at` — "Unix epoch seconds when the 5-hour or
  7-day rate limit window resets"
- `rate_limits.five_hour.used_percentage` — 0 to 100

An exact reset instant, with no prose to parse and no tokens spent. claude-standby
piggybacks on this by installing a status line that chains any existing one.

The documentation also carries constraints that a first reading of this missed,
and they blunt it considerably. `rate_limits` "appears only for Claude.ai Pro and
Max subscribers, or behind a Claude apps gateway…, and only after the first API
response in the session. Each window … may be independently absent, and Claude
Code drops a window once its `resets_at` time passes." So: absent for Console
users, absent early in a session, and **gone by the time a cooldown elapses** —
it can inform a wait, but cannot confirm one afterwards. Using it also means
installing a status line command into the user's configuration, which is a far
more invasive footprint than tailing a file.

**Hooks are a dead end for detection.** *(Reported.)* claude-standby captured 815
real `Stop`/`SessionEnd` payloads and grepped for `rate_limits|resets_at|
five_hour|used_percentage`; zero hits. Worth not repeating.

## Bugs in their code, checked against ours

Both of these were checked against this repository rather than noted and left.

**A duration constant that lies.** *(Derived — read verbatim from
`src/core/constants/index.ts` at HEAD.)*

```ts
export const TIMEOUT_MS = 60 * 60 * 60 * 1000; // 1 hour
```

That is 216,000,000 ms — sixty hours. Their only stall guard is inert, and open
issue #30 ("basically unusable… Claude keeps getting stuck") reads like the
symptom. The comment survives review because the comment is what gets read.

Checked here: every duration in `src/` is a flat literal — `1000`, `10_000`,
`60_000`, `3_600_000`, `86_400_000`. No multiplication chains, so this class of
slip has nowhere to hide. Keep it that way.

**A recovery path that is never called.** *(Derived — cloned the repository and
grepped the whole tree.)* `recoverWaitingMessages()` recomputes the remaining
wait from a stored deadline, which is exactly the right shape for surviving sleep
and reload. It occurs exactly twice in the source: once as an import in
`src/extension.ts`, once as its own definition. **There are no call sites.** The
live queue is an in-memory array; only completed history is persisted. The
generated documentation for that project states the opposite — that waits survive
reload "since messages are persisted via the queue system" — which is a clean
example of generated docs describing intent rather than behaviour.

Checked here: `ResumeScheduler` reads the memento in its constructor, that
constructor runs in `activate()` (`src/extension.ts`), and two tests pin it —
"a pending job survives reconstruction from the memento" and a legacy-migration
case. Wired, and proven wired.

## Where nobody has an answer

**The fork.** Neither project guards against resuming a session that is still
live. Claude-Autopilot cannot hit it, because it never issues a second `claude`
invocation — it types into one long-lived process. It pays for that with a
strictly weaker guarantee: if that process dies, the conversation is gone, and it
starts a fresh one rather than resuming. claude-standby *can* hit it, resumes
in-place with no liveness check, and says so in its own notes — its double-resume
guard "is currently just a cockpit warning."

So this is not a solved problem being reinvented here. It is unaddressed in both
tools that could hit it.

**The trust dialog.** Invisible to both. No mention of `hasTrustDialogAccepted`,
`~/.claude.json`, or the "Quick safety check" prompt in either repository.
Claude-Autopilot papers over it by defaulting `--dangerously-skip-permissions`
on, which answers every confirmation rather than that one, and is a materially
riskier posture than naming the dialog and checking for it.

An absence of reports is not evidence of absence. It more likely means nobody
looked.

## Worth adopting, in order

1. **Strip the launcher's environment before spawning `claude`.** Tracked as #9.
   Their hang is the warning shot.
2. **Never let a bare non-zero exit code register as a limit.** Only matched
   content may set state. claude-standby hardened this into a rule after being
   burned by it.
3. **Recompute from a stored deadline; never trust an in-flight timer.** Already
   how this project works; worth keeping deliberately rather than accidentally.
4. **Debounce before declaring "ready."** Claude-Autopilot waits for a ready
   signal to hold for 1000 ms of silence before trusting it. Applicable anywhere
   transcript or terminal state is read to decide a resume is underway.

## Worth not repeating

1. **Silent `catch {}` that preserves stale state.** claude-limits-vscode showed
   plausible-looking stale numbers for two weeks because every failure was
   swallowed. This repository has the same shape in at least two places:
   `readClaudeUserConfig` collapses every failure to `undefined`, which
   `isFolderTrusted` reads as "not trusted"; and `transcriptBytes` cannot
   distinguish an unreadable transcript from a stalled one. Both are cautious
   defaults, which is right — but the *reason* has to reach the log, or a
   confident wrong warning is indistinguishable from a correct one. Tracked in #8.
2. **Building on a platform constraint before checking it holds.** They shipped
   and reverted account switching twice before establishing that Anthropic's
   OAuth is single-session-per-device — a second login revokes the first's
   tokens, refresh included.
3. **A blanket permission bypass in place of handling a specific prompt.**
4. **Publishing without a licence.** claude-limits-vscode has 307 installs and no
   LICENSE file, so nothing in it can be adopted at all.

## What is still unverified

Written down because the temptation is to let a confident summary stand in for a
measurement, and this document was drafted wrong once already.

**The fork was measured under conditions this extension does not use.** The
experiment behind issue #6 ran `-p --input-format stream-json` sessions against a
mock API server, and produced the fork by firing two turns *simultaneously* from
two processes anchored on the same parent. This extension resumes into a
**raw-TTY terminal**. The investigating agent said plainly it did not verify that
a raw-TTY resume forks the same way. Forking is most likely a transcript-side
behaviour independent of the client's I/O mode, but "most likely" is an
inference.

**The scenario this extension actually produces was never tested.** The tested
case was two simultaneous turns. The case that matters here is *sequential*: an
external resume appends a turn, and then the user types into a panel that is
still open and still anchored on its pre-resume parent. That is a stale anchor
rather than a race, and it was not exercised. It is the single most valuable
thing left to derive, because it determines whether issue #7's reopen prompt is
polish or a data-loss mitigation.

**The extension host's environment is unmeasured.** See #9. The right test exists
and is cheap: an integration test that has the extension create a terminal whose
shell writes its own environment to a file, then reads it back. The integration
harness for that is already in this repo.

**Issue #7's two integration findings have not been reproduced by anyone else.**
That `TabInputWebview.viewType` is prefixed with `mainThreadWebview-`, and that
`workbench.action.reopenClosedEditor` does not restore a webview panel closed via
`tabGroups.close()`, both come from integration tests on a branch that has not
been merged or re-run independently.

**Every claim about the three projects marked "Reported" above** rests on a
single agent's reading. The ones marked Derived were checked; those were not.
