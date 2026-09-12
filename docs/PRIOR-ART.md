# Prior art

Three projects solving something adjacent to this one, reviewed 2026-09-10/11
and re-derived 2026-09-11. Recorded because it is expensive to re-derive and
because several findings changed what this project does.

Nothing here was copied. Licences are stated so that anything adopted later can
be attributed properly, to the standard [UPSTREAM.md](../UPSTREAM.md) already
sets.

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

The first draft marked several claims settled when they were only reported. The
re-derivation pass of 2026-09-11 checked all of them: three were materially
wrong, two were unsupported by anything in the repository they were attributed
to, and one test in **this** project turned out to prove nothing. That pass is
recorded in [Re-derivation](#re-derivation-2026-09-11).

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
[Re-derivation](#re-derivation-2026-09-11), and it is not flattering.

The prose still has to be parsed for the *reset time*, so this is a reduction in
exposure rather than an escape from it.

**A real limit does not kill the session that hit it.** *(Derived.)* This
project's own supervising session recorded five genuine `apiErrorStatus: 429`
entries across 2026-09-10 and 2026-09-11 and was still listed as a live
`interactive` process afterwards by `claude agents --json`. No mock is involved;
this supersedes an earlier version of the same finding measured against a mock
API server.

## What changed this project

**The resume terminal inherits the editor's environment.** *(Derived — read
`plugin/scripts/daemon.sh:245-258` at HEAD.)* The one item that survived
re-derivation intact, and came back stronger. claude-standby's own comment:

> A headless background resume must NOT attach to an editor. When the daemon is
> spawned from the VS Code/Cursor extension it inherits the editor's whole
> environment; claude then decides it is running inside an IDE, opens a bridge
> (writes a "bridge-session" to the transcript) and never exits after answering
> — pinning the task at 'resuming' forever.

They strip, in a subshell immediately before exec: everything matching
`^(VSCODE|CLAUDE_CODE|CURSOR|__CF)[A-Za-z0-9_]*`, plus `TERM_PROGRAM`,
`TERM_PROGRAM_VERSION`, and `ENABLE_IDE_INTEGRATION`.

Two things the first draft missed, both of which matter to us:

1. **The failure has an observable signature we already understand.** The hung
   resume writes a `bridge-session` entry to the transcript. This project already
   knows what those are — only panel-created sessions have them. A
   `bridge-session` appearing in a session *we* resumed into a terminal is a
   direct tell for this exact hang, and cheaper than the byte-growth heuristic in
   `src/stallWatch.ts`.
2. **The hang is silent and permanent**, not a crash. It is precisely the shape
   `stallWatch` exists to catch — the transcript would not grow.

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
payload on stdin that includes `rate_limits.five_hour.resets_at` (Unix epoch
seconds) and `rate_limits.five_hour.used_percentage` (0–100). An exact reset
instant, with no prose to parse and no tokens spent. claude-standby piggybacks on
this by installing a status line that chains any existing one.

The documentation also carries constraints that a first reading of this missed,
and they blunt it considerably: `rate_limits` appears only for Pro and Max
subscribers or behind a Claude apps gateway, and only after the first API
response in the session; each window may be independently absent; and Claude Code
**drops a window once its `resets_at` passes**. So it can inform a wait but cannot
confirm one afterwards. Using it also means installing a status line command into
the user's configuration — a far more invasive footprint than tailing a file.

claude-standby's own notes flag the same field as **unverified at a real limit**:
they never observed what `used_percentage` does when the account is actually
limited, and their sensor's threshold is a guess they label as such.

**Hooks are a dead end for detection.** *(Derived — read
`docs/HOOK-FINDINGS.md:149-151`.)* claude-standby captured 815 real hook payloads
and grepped for `rate_limits|resets_at|five_hour|used_percentage`; zero hits.
Their observations of those fields are real, but they came from the status line,
not from hooks. Worth not repeating.

## Bugs in their code, checked against ours

**A duration constant that lies.** *(Derived — read verbatim from
`src/core/constants/index.ts` at HEAD.)*

```ts
export const TIMEOUT_MS = 60 * 60 * 60 * 1000; // 1 hour
```

That is 216,000,000 ms — sixty hours. Their only stall guard is inert. The
comment survives review because the comment is what gets read.

**Corrected.** The first draft added: "open issue #30 ('basically unusable…
Claude keeps getting stuck') reads like the symptom." Wrong three ways. Issue #30
is written in Chinese; the English was my translation, presented as a quotation.
The ellipsis removed the reporter's own stated context — the full text is
`根本无法使用，我的是中文任务，并且一直是出现claude 卡住`: *basically unusable, **my task is in
Chinese**, and Claude keeps getting stuck*. A non-English workload is a plausible
competing explanation for a stdout-regex tool getting stuck, and the issue says
nothing about timeouts at all. The constant is a real bug; #30 is not evidence
for it. Worse, the section header read *(Derived — read verbatim from
`src/core/constants/index.ts`)*, and a reader carries that label across the whole
section — but the clone covered their **source**, not their **issues**.

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
reload "since messages are persisted via the queue system" — a clean example of
generated docs describing intent rather than behaviour.

Checked here: `ResumeScheduler` reads the memento in its constructor, that
constructor runs in `activate()` (`src/extension.ts`), and two tests pin it —
"a pending job survives reconstruction from the memento" and a legacy-migration
case. Wired, and proven wired.

**Every error swallowed.** *(Derived — counted.)* claude-limits-vscode has 24
`catch` blocks in `src/`. **Zero** of them log anything. That is how it came to
show plausible stale numbers rather than an error.

## Where nobody has an answer

**The fork — and whether it is even real.** *(Corrected. The biggest change in
the re-derivation pass.)*

The first draft treated "resuming a live session forks the transcript" as
established, and built the framing of issues #6 and #7 on it. It is not
established, and three independent lines of evidence point the other way:

1. **Anthropic's documentation says interleave, not fork.** Quoted in issue #6
   itself: *"If you resume the same session in two terminals without forking,
   messages from both interleave into one transcript."* Interleaving into one
   transcript is the opposite of divergence.
2. **claude-standby measured append-in-place.** *(Derived —
   `docs/HOOK-FINDINGS.md` Q6, dated 2026-07-23.)* "A headless `claude --resume
   <id> -p '…'` continues the SAME session, and reopening `claude --resume <id>`
   shows the headless exchange… `--fork-session` (F3) is the only branch path and
   the daemon never passes it." An independent measurement, on real hardware, by
   someone with no stake in our conclusion.
3. **The detector that produced our "fork" does not work.** See
   [Re-derivation](#re-derivation-2026-09-11).

Note that issue #6 **as filed** is careful — it poses the fork as a question to
be answered, not a fact. The overstatement was introduced downstream, in how the
investigating agent's answer was recorded. That agent's output file is 0 bytes,
so its method cannot be inspected and its conclusion cannot be checked.

What remains true and unchanged: neither project guards against resuming a
session that is still live. Claude-Autopilot cannot hit the situation, because it
never issues a second `claude` invocation — it types into one long-lived process,
and pays for that with a strictly weaker guarantee: if that process dies, the
conversation is gone. claude-standby resumes in-place with no liveness check.

**The trust dialog.** Invisible to both. No mention of `hasTrustDialogAccepted`,
`~/.claude.json`, or the "Quick safety check" prompt in either repository.
Claude-Autopilot papers over it by defaulting `--dangerously-skip-permissions`
on, which answers every confirmation rather than that one, and is a materially
riskier posture than naming the dialog and checking for it.

An absence of reports is not evidence of absence. It more likely means nobody
looked.

## Re-derivation, 2026-09-11

### Confound: does our parser handle the separator that broke theirs?

The obvious test says yes — all six separators parse, to the identical instant:
U+2219, U+00B7, U+2022, U+2027, U+25CF, and the ASCII hyphen.

**The confound: so does `BANANA`.** `5-hour limit reached BANANA resets 1am`
parses. So does the emoji form, and so does the notice with nothing between the
two halves at all. The separator is never consulted — `LIMIT_HINTS` matches the
first half and the time matcher finds the second, with arbitrary text between.
The immunity is real, but it has nothing to do with the bullet class in
`normalize`, and a test showing a bullet parsing measures the wrong thing.

Proof that it was measuring the wrong thing: deleting the bullet-normalisation
line from the compiled parser left **138 of 138 tests green** — including the two
"real notice" regressions added the day before, which the previous draft
described as pinning the middot form. They did not pin it. They would have passed
had the line never existed.

The bullet class changes the outcome in exactly **one** of six probed shapes: a
bullet with no surrounding spaces between `resets` and the time
(`5-hour limit reached resets∙1am`), which reaches the time matcher as a single
token. That case is now a test, and it discriminates — with the line removed the
suite fails 1 of 139, where before it failed 0 of 138.

### Confound: is `parentUuid` divergence evidence of a fork?

No, and this is why the fork claim collapsed.

Scanning 27 session transcripts across 12 project directories for parents with
more than one child gives **387 branch points in 16 files** — which looks like
overwhelming evidence that forking is routine. It is evidence of nothing.

Two confounds had to be cleared first. Subagents do **not** branch the main
transcript: they are written to separate files under
`<session-id>/subagents/agent-*.jsonl`, which is where 182 of the 209 `.jsonl`
files on this machine live, and `isSidechain` is never `true` in a session that
demonstrably ran nine of them. So the 27-file population was the right one.

The real confound is the *shape* of the branches. All five in this project's own
supervising session — never once resumed externally — are identical: parent is an
assistant `tool_use`, one child is the *next* `tool_use`, the other is the
parent's own `tool_result`. That is **two parallel tool calls in one message**,
serialised into a linear file. Classifying every branch point across all 27
transcripts shows the same thing at scale:

| count | shape |
|---|---|
| 1806 | `assistant → [result-of-parent, result-of-parent]` |
| 1204 | `user → [attachment, attachment]` |
| 1022 | `assistant → [sibling-tool_use, sibling-tool_use]` |
| 951 | `assistant → [result-of-parent ×3]` |
| 729 | `attachment → [assistant, assistant]` |

Roughly twelve thousand branch points, essentially all structural. **`parentUuid`
is not a conversation-lineage field**, and "divergent children of one parent
UUID" is not a fork detector. Any conclusion built on it — including ours — has
to be re-derived with a criterion that survives this.

### Claims that had no support at all

**"Its double-resume guard is currently just a cockpit warning."** Presented as a
quotation from claude-standby. It appears nowhere in the repository. What is
there (`docs/DECISIONS.md` D44) is a different and less convenient finding: a
headless resume ran detached and invisible, so *the user* could not tell it had
worked and manually re-resumed — a human double-run, fixed by streaming the
resume output into the cockpit. Not a guard, and not about concurrency.

**The OAuth single-session claim.** The first draft said, under claude-standby's
lessons: "They shipped and reverted account switching twice before establishing
that Anthropic's OAuth is single-session-per-device — a second login revokes the
first's tokens, refresh included." Wrong on attribution, mechanism, and count.

- It is **claude-limits-vscode**, not claude-standby. claude-standby's tree has no
  mention of OAuth, revocation, or account switching.
- The mechanism they recorded is self-inflicted, not a platform constraint:
  `CHANGELOG.md` says the button "was calling `claude auth logout` globally,
  which logged out all active Claude Code sessions".
- "Twice" is unsupported — the changelog records one removal, and the repo's own
  two records disagree about which version it happened in (a memory note says
  v0.3.1, the memory index says v0.5.0).
- The single-session-per-device claim does exist, but only inside an untranslated
  Russian internal note asserting it, with no measurement attached.

The lesson is still worth keeping, but it is a different lesson: *check whether
the platform constraint you are blaming is actually your own code.*

### One generalisation limit worth stating

claude-standby's on-disk findings were measured on **macOS, Claude Code 2.1.214**.
This project runs on Windows. Their transcript-layout and resume-behaviour
results are the best independent evidence available, and they are not from this
platform.

## Worth adopting, in order

1. **Strip the launcher's environment before spawning `claude`.** Tracked as #9.
   Their hang is the warning shot, and the `bridge-session` entry it leaves is a
   cheap detector for it.
2. **Never let an exit code alone decide anything.** *(Corrected.)* The first
   draft said "never let a bare non-zero exit code register as a limit", which
   inverted the hazard. Their measured problem is the opposite: a resume that
   bounces off a still-active limit **exits 0**, and their guard is to match the
   limit text in the output regardless of status. Their own note is franker still
   — the original exit-code reading was confounded by a `tee` in the pipeline, so
   `$?` reported tee's status, and the finding is marked as needing a re-run.
   Their rule exists because they *could not* measure it, not because they did.
3. **Recompute from a stored deadline; never trust an in-flight timer.** Already
   how this project works; worth keeping deliberately rather than accidentally.
4. **Debounce before declaring "ready."** *(Reported — not re-derived.)*

## Worth not repeating

1. **Silent `catch {}` that preserves stale state.** 24 catches, 0 logs, in
   claude-limits-vscode. This repository has the same shape in at least two
   places: `readClaudeUserConfig` collapses every failure to `undefined`, which
   `isFolderTrusted` reads as "not trusted"; and `transcriptBytes` cannot
   distinguish an unreadable transcript from a stalled one. Both are cautious
   defaults, which is right — but the *reason* has to reach the log, or a
   confident wrong warning is indistinguishable from a correct one. Tracked in #8.
2. **Blaming the platform for your own code.** See the OAuth correction above.
3. **A blanket permission bypass in place of handling a specific prompt.**
4. **Publishing without a licence.** claude-limits-vscode has no LICENSE file, so
   nothing in it can be adopted at all.
5. **A test that passes for a reason unrelated to what it claims to test.** Ours,
   not theirs. The check is cheap: break the line the test is meant to be pinning
   and confirm the test goes red.

## What is still unverified

**Whether a raw-TTY sequential resume forks, appends, or interleaves.** Now the
open question rather than a settled hazard. The evidence for appending is
Anthropic's documentation plus one macOS measurement of the `-p` headless path.
The evidence for forking has evaporated. Nobody has measured the case this
extension actually produces: an external resume appends a turn, then the user
types into a panel still anchored on its pre-resume state. Until that is run,
**issue #7's reopen prompt cannot be called a data-loss mitigation**, and #6's
premise needs restating.

**The extension host's environment is unmeasured.** See #9. The right test exists
and is cheap: an integration test that has the extension create a terminal whose
shell writes its own environment to a file, then reads it back. The integration
harness for that is already in this repo.

**Issue #7's two integration findings have not been reproduced by anyone else.**
That `TabInputWebview.viewType` is prefixed with `mainThreadWebview-`, and that
`workbench.action.reopenClosedEditor` does not restore a webview panel closed via
`tabGroups.close()`, both come from integration tests on a branch that has not
been merged or re-run independently.

**`used_percentage` at a real limit.** Neither project has seen it. This project
has the rarer asset — five real 429s in its own transcripts — and did not think
to look at the status line at the time.

**Claims still marked Reported** rest on a single agent's reading. After this
pass there is one left: item 4 under "Worth adopting".
