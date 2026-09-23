# Prior art

Three projects solving something adjacent to this one, reviewed 2026-09-10/11,
re-derived 2026-09-11, and audited again 2026-09-13. Recorded because it is
expensive to re-derive and because several findings changed what this project
does.

Nothing here was copied. Licences are stated so that anything adopted later can
be attributed properly, to the standard [UPSTREAM.md](UPSTREAM.md) already sets.

## How to read the claims below

Each factual claim is marked:

- **Derived** — checked directly against the source, the docs, or this machine,
  by the author of this document. The command or file is named.
- **Reported** — from a research agent's summary, not independently checked.
  Treat as a lead, not a fact.
- **Corrected** — was stated wrongly in an earlier draft. The old claim and what
  replaced it are both kept, because the failure mode is the interesting part.

A claim marked Derived is derived *for the thing it says*. "Their repository
states X" is not "X is true", and where that gap matters it is spelled out.

This document has been wrong in both directions. The first draft marked reported
claims as settled. The re-derivation of 2026-09-11 caught several of those — and
then introduced errors of its own, the largest being that the transcript fork
behind issue #6 had "collapsed". It had not. Two of its corrections rested on an
absence argument: a search too narrow to support "appears nowhere", and an empty
task file taken to mean an agent's report was lost when it was sitting in the
session transcript. The audit of 2026-09-13 found those; see
[Second audit](#second-audit-2026-09-13).

## The three projects

| | Claude-Autopilot | claude-standby | claude-limits-vscode |
|---|---|---|---|
| What it is | VS Code extension wrapping one long-lived PTY | bash CLI + detached daemon, thin editor cockpits | VS Code status-bar usage monitor |
| Detection | regex over terminal stdout | cheap probe + status-line feed | polls `/api/oauth/usage` |
| Resume | types `continue` into the running process | headless `--resume … -p` from the daemon | none — does not resume |
| Licence | MIT | MIT | **none stated** |

Licences *(Derived — cloned all three at HEAD and looked.)* claude-standby has
`LICENSE` at its root, MIT, "Copyright (c) 2026 claude-standby authors".
claude-limits-vscode has no licence file anywhere in the tree and no `license`
field in `package.json`; **nothing in it is adoptable**. Its endpoint use is
confirmed: `/api/oauth/usage` at two call sites in `src/extension.ts`.

`claude-limits-vscode` turned out not to be prior art for this problem at all. It
shows quota percentages in the status bar and never reads a transcript, never
waits out a cooldown, and never resumes anything. It is included only for the two
adjacent findings below and because ruling it out is itself useful.

## What validated this project's approach

**Detection by structured field beats detection by prose, and there is a dated
production failure to prove it.** *(Derived — `gh issue view` on both.)*
Claude-Autopilot matches Claude's human-facing output with regexes over terminal
stdout. Issue #25, opened 2025-08-20, is a user reporting that the CLI had
started writing `5-hour limit reached ∙ resets 1am`, which the pattern did not
match. PR #26, merged the next day, added a second pattern and — in its own words
— "support various bullet characters (∙, •, ·) in limit messages". This project
reads `isApiErrorMessage` / `error: "rate_limit"` / `apiErrorStatus` off the
JSONL transcript instead, which does not move when the prose does.

The separator in the real break was **U+2219 BULLET OPERATOR**, not the U+00B7
MIDDLE DOT this project's corpus had captured. *(Derived — codepoint-dumped the
issue body.)* What that exposed about our own tests is in
[Re-derivation](#re-derivation-2026-09-11).

The prose still has to be parsed for the *reset time*, so this is a reduction in
exposure rather than an escape from it.

**A real limit does not kill the session that hit it.** *(Derived.)* This
project's own supervising session recorded genuine `apiErrorStatus: 429` entries
across several days and was still listed as a live `interactive` process
afterwards by `claude agents --json`. No mock is involved.

**A limit lands on several sessions at once.** *(Derived — every rate-limit
notice in the top-level transcripts on this machine, probe runs and replayed
duplicates excluded.)* Of 61 limit episodes, 16 had two or three different
sessions report the identical reset, most within 90 seconds of each other. This
is what exposed the single pending slot in this project's own scheduler, fixed
in 07a67f9.

## What changed this project

**The resume terminal inherited the editor's environment.** *(Derived — read
`plugin/scripts/daemon.sh:245-258` at HEAD.)* claude-standby's own comment:

> A headless background resume must NOT attach to an editor. When the daemon is
> spawned from the VS Code/Cursor extension it inherits the editor's whole
> environment; claude then decides it is running inside an IDE, opens a bridge
> (writes a "bridge-session" to the transcript) and never exits after answering
> — pinning the task at 'resuming' forever.

They strip, in a subshell immediately before exec: everything matching
`^(VSCODE|CLAUDE_CODE|CURSOR|__CF)[A-Za-z0-9_]*`, plus `TERM_PROGRAM`,
`TERM_PROGRAM_VERSION`, and `ENABLE_IDE_INTEGRATION`.

For this project it is now measured rather than inferred *(Derived — integration
test in `test/integration/extension.itest.ts`)*. A VS Code window started from a
Claude session's shell carries `CLAUDECODE` into a terminal child, and a
variable set to `null` in `TerminalOptions.env` is removed from the child while
the rest of the environment still comes through. Fixed in 8d32487 (issue #9) —
but as a named list of the variables a session sets for its children, not their
prefix strip. People export `CLAUDE_CODE_*` settings on purpose, and the Claude
Code extension injects `CLAUDE_CODE_SSE_PORT` into integrated terminals so the
CLI can find the editor; clearing those would change what the resume does.

**Corrected.** The previous draft recommended treating a `bridge-session` entry
in a resumed session as a cheap detector for claude-standby's hang. Not adopted.
Their hang is a headless `-p` run that should exit; this project resumes
interactively into a VS Code terminal, where connecting to the editor may be
entirely normal *(Inferred — not measured)*. The signal would risk warning about
healthy resumes. Also not established: that an inherited identity ever made an
*interactive* resume hang.

**`rate_limits` is a documented field, not a side channel.** *(Derived, from the
status line documentation.)* Claude Code sends the status line command a JSON
payload on stdin that includes `rate_limits.five_hour.resets_at` (Unix epoch
seconds) and `rate_limits.five_hour.used_percentage` (0–100). An exact reset
instant, with no prose to parse and no tokens spent. claude-standby piggybacks on
this by installing a status line that chains any existing one.

The documentation also carries constraints that blunt it considerably:
`rate_limits` appears only for Pro and Max subscribers or behind a Claude apps
gateway, and only after the first API response in the session; each window may
be independently absent; and Claude Code **drops a window once its `resets_at`
passes**. So it can inform a wait but cannot confirm one afterwards. Using it
also means installing a status line command into the user's configuration — a far
more invasive footprint than tailing a file.

claude-standby's own notes flag the same field as **unverified at a real limit**:
they never observed what `used_percentage` does when the account is actually
limited, and their sensor's threshold is a guess they label as such.

**Hooks are a dead end for detection.** *(Derived — read
`docs/HOOK-FINDINGS.md:149-151`.)* claude-standby captured 815 real hook payloads
and grepped for `rate_limits|resets_at|five_hour|used_percentage`; zero hits.
Their observations of those fields came from the status line, not from hooks.

## Bugs in their code, checked against ours

**A duration constant that lies.** *(Derived — read verbatim from
`src/core/constants/index.ts` at HEAD.)*

```ts
export const TIMEOUT_MS = 60 * 60 * 60 * 1000; // 1 hour
```

That is 216,000,000 ms — sixty hours. Their only stall guard is inert. The
comment survives review because the comment is what gets read.

**Corrected.** An earlier draft cited Autopilot issue #30 ("basically unusable…
Claude keeps getting stuck") as the symptom. Issue #30 is written in Chinese, the
English was a translation presented as a quotation, and the ellipsis removed the
reporter's own context — *my task is in Chinese* — which is a plausible competing
explanation for a stdout-regex tool getting stuck. The issue says nothing about
timeouts. The constant is a real bug; #30 is not evidence for it.

Checked here: every duration in `src/` is a flat literal — `1000`, `10_000`,
`60_000`, `3_600_000`, `86_400_000`. No multiplication chains, so this class of
slip has nowhere to hide. Keep it that way.

**A recovery path that is never called.** *(Derived — cloned the repository and
read the queue code.)* `recoverWaitingMessages()` recomputes the remaining wait
from a stored deadline and restarts the countdown. It occurs exactly twice in the
source: once as an import in `src/extension.ts`, once as its own definition.
**There are no call sites.**

**Corrected.** Earlier drafts added that "the live queue is an in-memory array;
only completed history is persisted", and called the project's generated
documentation an example of docs describing intent rather than behaviour. Wrong.
`savePendingQueue()` saves messages whose status is `pending` **or `waiting`** to
`globalState` (`src/queue/processor/history.ts`), behind
`history.persistPendingQueue`, which defaults to `true`, and `loadPendingQueue()`
restores them at activation. The generated documentation describes that
correctly. What is missing is narrower: a restored waiting message comes back
with its deadline but nothing restarts its countdown. The quotation previously
attributed to that documentation — "since messages are persisted via the queue
system" — was not found verbatim on the page or in the repository.

Checked here: `ResumeScheduler` reads the memento in its constructor, that
constructor runs in `activate()` (`src/extension.ts`), and tests pin both a
pending job and several pending jobs surviving reconstruction. The one hole the
audit found on this side is issue #11: a job that has already fired and is
waiting for `Resume Now` is held in memory only.

**Every error swallowed.** *(Derived — counted.)* claude-limits-vscode has 24
`catch` blocks in `src/`. **Zero** of them log anything. That is how it came to
show plausible stale numbers rather than an error.

## Where nobody has an answer

**The fork.** *(Corrected twice, then settled by experiment on 2026-09-20. See
[Second audit](#second-audit-2026-09-13).)*

The first draft recorded "resuming a live session forks the transcript" as
established. The re-derivation of 2026-09-11 then declared that claim collapsed.
Both overstated, in opposite directions. Point 4 below is no longer an open
question; the rest of this section stands as the record of how long it took to
stop arguing about it and run the test. What is derived:

1. **A second live process writing on a stale parent forks the transcript.** In
   the probe session behind issue #6, two user turns share one `parentUuid`. The
   second was written 42 seconds after the first was already on disk — not a
   simultaneous race but a process anchored on a parent that had gone stale. The
   investigating agent's report, which is in the session transcript, says a later
   resume followed one branch and left the other turn on disk but unreachable.
   That run used `-p --input-format stream-json` against a mock API.
2. **A sequential resume appends.** In the 2026-09-09 smoke test the CLI's first
   line attached straight onto the panel's last node. claude-standby measured the
   same for a headless resume (`docs/HOOK-FINDINGS.md` Q6), and Anthropic's
   documentation describes two terminals on one session as interleaving into one
   transcript.
3. **Claude Code panels fork on their own.** Seven cases in real sessions on this
   machine share one shape: an old node is written into the file again, and a new
   branch continues from it hours to days later. They cluster across sessions
   within minutes, so they are systemic rather than deliberate rewinds. One
   explanation — `--resume` following a stale `last-prompt` record — was tested
   and ruled out; the trigger is unknown.

4. **The case this extension produces forks, and the resumed turn is the one
   that is lost.** *(Derived 2026-09-20 — the experiment issue #6 asked for was
   run.)* An external resume appended a turn; the panel tab, still open on its
   pre-resume state, anchored the user's next message to the node from before the
   resume. The panel's branch is the one a later resume and a reopened tab both
   follow, so the resumed turn is left on disk and unreachable. Neither model
   reports anything wrong: the panel's context lacks the resumed turn, and the
   resumed process's context lacks the panel's. Reopening the tab resyncs it.
   Full write-up in
   [research/2026-09-20-panel-fork-experiment.md](research/2026-09-20-panel-fork-experiment.md).

Neither prior-art project guards against resuming a live session.
Claude-Autopilot cannot hit the situation, because it never issues a second
`claude` invocation — it types into one long-lived process, and pays for that with
a strictly weaker guarantee: if that process dies, the conversation is gone.
claude-standby resumes in place with no liveness check, and its notes say so:
"The double-resume guard is currently just a cockpit warning (can't block a
user's own `claude`)" (`PROGRESS.md:418`).

**The trust dialog.** Invisible to both. No mention of `hasTrustDialogAccepted`,
`~/.claude.json`, or the "Quick safety check" prompt in either repository.
Claude-Autopilot papers over it by defaulting `--dangerously-skip-permissions`
on, which answers every confirmation rather than that one, and is a materially
riskier posture than naming the dialog and checking for it.

## Re-derivation, 2026-09-11

### Confound: does our parser handle the separator that broke theirs?

The obvious test says yes — all six separators parse, to the identical instant:
U+2219, U+00B7, U+2022, U+2027, U+25CF, and the ASCII hyphen.

**The confound: so does `BANANA`.** `5-hour limit reached BANANA resets 1am`
parses. The separator is never consulted — `LIMIT_HINTS` matches the first half
and the time matcher finds the second, with arbitrary text between. Deleting the
bullet-normalisation line from the compiled parser left 138 of 138 tests green,
including two "real notice" regressions that had been described as pinning it.

The bullet class changes the outcome in exactly one probed shape: a bullet with no
surrounding spaces between `resets` and the time (`resets∙1am`). That case is now
a test, and it fails when the line is removed.

The 2026-09-13 mutation testing found the same pattern across the rest of the
hint list: 10 of 12 `LIMIT_HINTS` entries can each be deleted without a test
failing. Issue #12.

### Confound: is `parentUuid` divergence evidence of a fork?

Not on its own. Counting parents with more than one child across 27 session
transcripts gives thousands of branch points, and almost none are forks.

**Corrected.** This section previously said "roughly twelve thousand branch
points, essentially all structural". Only one shape had been explained — two
parallel tool calls, where the second `tool_use` and the first's `tool_result`
both hang off the first — and the table offered summed to 5,712. The 2026-09-13
audit derived the rest. One API response is written as several chained lines
sharing a `message.id`. Reloads **replay** earlier segments into the file
verbatim, same uuids and timestamps, which inflates naive counts enormously.
Deduplicating by uuid leaves about 380 branch points, 331 of them parallel tool
calls *(Reported — the audit's scanner output, not recounted by hand)*. A
criterion that requires two children each leading to a distinct later prompt the
user typed finds 8 forks *(Derived — each one checked at its raw lines)*,
described above.

And the conclusion drawn from this section was wrong: it assumed the agent
behind issue #6 had used the naive count. It had not.

### Claims about the other projects

**Corrected.** This section previously said claude-standby's "double-resume
guard is currently just a cockpit warning" appeared nowhere in that repository.
It is at `PROGRESS.md:418`. The search that concluded otherwise covered
`docs/*.md` and `plugin/scripts/*.sh` only.

**The OAuth single-session claim.** An earlier draft said, under claude-standby's
lessons, that they "shipped and reverted account switching twice before
establishing that Anthropic's OAuth is single-session-per-device". Wrong on
attribution, mechanism, and count:

- It is **claude-limits-vscode**, not claude-standby.
- The mechanism they recorded is self-inflicted: `CHANGELOG.md` says the button
  "was calling `claude auth logout` globally, which logged out all active Claude
  Code sessions".
- "Twice" is unsupported — the changelog records one removal, and the repo's own
  notes disagree about which version.
- The single-session-per-device claim does exist, in an untranslated Russian
  internal note, supported by one observation of a 401 on an unexpired token.

The lesson is still worth keeping, but it is a different lesson: *check whether
the platform constraint you are blaming is actually your own code.*

### A generalisation limit

claude-standby's on-disk findings were measured on **macOS, Claude Code 2.1.214**.
This project runs on Windows.

## Second audit, 2026-09-13

Seven parallel reviews — code, mutation testing, open issues, the #7 branch,
documentation, transcript structure, and release and security — each marking
every claim derived or inferred, with the main findings re-checked by hand.

What it changed in this document: the fork is reinstated with its real scope; the
cockpit-warning quotation is restored; Autopilot's persistence is described
correctly; the branch-point analysis is completed; and the environment finding
moves from inferred to measured.

The failure mode worth remembering is the one that produced two of those errors:
**an absence argument from an incomplete search.** A grep scoped to two
directories became "appears nowhere in the repository", and an empty task output
file became "the report is lost". Both would have been caught by looking in one
more place. Neither looked like a guess when it was written.

## Worth adopting, in order

1. **Clear the launcher's session identity before spawning `claude`.** Done
   (8d32487, issue #9), as a named list.
2. **Never let an exit code alone decide anything.** Their measured problem: a
   resume that bounces off a still-active limit **exits 0**, and their guard
   matches the limit text in the output regardless of status. Their own note is
   franker still — the original exit-code reading was confounded by a `tee` in
   the pipeline, and the finding is marked as needing a re-run.
3. **Recompute from a stored deadline; never trust an in-flight timer.** Already
   how this project works.
4. **Debounce before declaring "ready."** *(Reported — not re-derived.)*

## Worth not repeating

1. **Silent `catch {}` that preserves stale state.** 24 catches, 0 logs, in
   claude-limits-vscode. This repository has the same shape in at least two
   places — `readClaudeUserConfig` and `transcriptBytes` — tracked in #8.
2. **Blaming the platform for your own code.** See the OAuth correction above.
3. **A blanket permission bypass in place of handling a specific prompt.**
4. **Publishing without a licence.**
5. **A test that passes for a reason unrelated to what it claims to test.** Ours.
   The check is cheap: break the line the test is meant to be pinning and confirm
   the test goes red.
6. **Concluding absence from a search that could not have found it.** Also ours.

## What is still unverified

- **What triggers the systemic panel forks.** Seven cases, clustered in time; the
  one hypothesis tested was ruled out.
- **Issue #7's integration findings for the real Claude Code panel.** Both were
  re-run in VS Code 1.137 and hold, but with a synthetic webview, not the Claude
  Code panel itself.
- **Whether `CLAUDE_CONFIG_DIR` moves `~/.claude.json`.** The documentation does
  not say either way. Issue #8.
- **`used_percentage` at a real limit.** Neither project has seen it.
- **Claims still marked Reported:** item 4 under "Worth adopting".
