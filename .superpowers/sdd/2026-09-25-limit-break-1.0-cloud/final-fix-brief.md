### Final review fix wave (one dispatch, the complete list)

The final whole-branch review (28b0eec..8b31dbd) found the tasks solid individually and the hard constraints
intact; the problems are where tasks meet. Each item below carries the reviewer's evidence and the controller's
ruling (also in progress.md under "Final whole-branch review"). TDD and a mutation check for every new guard,
as for every task.

#### Critical 1 — an overload in an idle terminal session is silently never resumed (T2 × T4a)
`src/holderPolicy.ts` ~81, ~123 and `src/extension.ts` ~1022-1026: `decideOnFire` ignores `job.reason`. An idle
terminal holder with native auto-continue on (the default: a missing key reads as on in `src/autoContinue.ts`)
is dropped silently with the log "Claude Code's own auto-continue will pick it back up". But
`autoContinueAtUsageLimit` covers usage limits only — not 529s, transient 429s or stream interruptions (T4a's own
comment on STREAM_INTERRUPTED_RE says Claude Code never resumes those). Regression from 0.1.2.
RULING: native auto-continue counts only when `job.reason === 'limit'`. An overload job with an idle terminal
holder takes the remember + "Resume in Terminal Anyway" branch. Test: an overload job, idle terminal holder,
auto-continue on → remembered + notice, not dropped.

#### Important 2 — the claim is released when the holder policy declines, so every window re-offers (T2 × T10)
`src/extension.ts` ~1075-1080: for an idle terminal with auto-continue off, window A remembers the job, shows
"Resume in Terminal Anyway", then releases the claim. With watchScope machine (the default), windows B..N fire
later on their own jitter, find the claim free, and each shows the same offer. That button has no modal and a
manual click ignores claims: two clicks in two windows = two writers on a session a terminal holds.
RULING: keep the claim (do not release) when the decision remembers/notifies, and when it drops the job for a
busy/waiting holder. Manual retries ignore claims already. Test: after a declining decision the claim file still
exists and a second window's fire of the same key is dropped as taken.

#### Important 3 — a repeat overload collides with this window's own earlier claim (T10 × T4a)
`src/claims.ts` ~85, `src/policy.ts` ~46: the overload claim key is `<sessionId>-overload-<floor(fireMs/600000)>`.
After a successful automatic resume the claim stays fresh for 1 h, so a second overload in the same 10-minute
bucket fires, gets 'taken' from its OWN claim, and is dropped — logged as "claimed by another window".
RULING: key overload claims on the detection entry's own identity — its timestamp (ms), which is identical in every
window (all windows read the same line) and distinct per event — instead of the bucket. Carry what is needed on the
job (read how Task 1 threads the entry timestamp; do not change limit keys). Also write a window identity
(`vscode.env.sessionId`) into the claim file and, when a claim is 'taken' by THIS window's own identity, log it as
such ("already claimed by this window") rather than "another window". Tests: two distinct overload events in the
same 10 minutes both get claimed; the same event seen by two windows collides; the self-collision log text.

#### Important 4 — unflagged assistant prose arms an overload retry (pre-existing; widens a deferred minor)
`src/transcriptWatcher.ts` ~513-529, `src/parsers/overloadParser.ts` ~149-185. Probe: each of these short
UNFLAGGED assistant text blocks armed an overload:
- "npm install failed: fetch failed (proxy)…" → connection-error
- "…one case where the request timed out." → timeout
- "…returned Internal server error…" → server-error
- "Earlier we saw API Error: 529 Overloaded…" → api-error-status
A resume 5-30 min later then fires with the "I hit my usage limit" prompt — Goal 4 and Finding 6.
RULING: on the UNFLAGGED path, every overload rule requires a line that starts with "API Error"
(`matchesApiErrorLine` exists; widen `LINE_HEAD_RE` to accept `api error[:(]` so the parens form still reaches
the in-flight exclusion). FLAGGED entries keep full recall (no anchor). Tests: the four strings above as negatives
on the unflagged path; each rule's real render still positive when flagged, and when unflagged at a line start.

#### Important 5 — nothing warns if Claude Limit Buster 0.1.x is still installed (T8)
Two extensions would detect and resume the same sessions; 0.1.2 has no claim or holder check.
RULING: on activation, if `vscode.extensions.getExtension('dream-mosaic.claude-limit-buster')` is present, show a
warning (once per activation) naming the risk, with a button "Uninstall Claude Limit Buster" that runs
`workbench.extensions.uninstallExtension` with that id. Tests with the fake vscode.

#### Important 6 — "auto-continue on when the key is absent" is unverified; failure is silent (T2)
`src/autoContinue.ts` ~76. The research (docs/research/2026-09-23-prior-art-auto-retry-preheat.md:10) says the
toggle only appears for some accounts. If the account lacks the feature, an idle-terminal LIMIT is dropped silently.
RULING: after standing down for native auto-continue, arm a check (reuse the stall-watch grace period and
transcript-growth test): if the transcript has not grown by then, fall through to rememberReady + a notice
("Claude Code did not continue <short id> on its own. Resume it here?" with the Resume Now button). Tests: grew →
nothing; not grown → remembered + notice. Keep claims consistent with Important 2.

#### Important 7 — Cancel cancels in one window only (pre-existing)
With watchScope machine every window holds the same pending job.
RULING: on Cancel (command and menu), write a claim for each cancelled job's key so other windows drop it when it
fires. (The shared globalState job lists across windows are a separate, pre-existing issue → NEXT.md.) Test.

#### Minors folded in (cheap, user-facing)
- CHANGELOG.md: the Added overload bullet says an in-flight retry is detected as an overload — the code ignores it
  (IN_FLIGHT_RETRY_RE). Fix it. The Fixed sentence "excluded … the same way a genuinely flagged entry is not" is
  garbled; rewrite. Add CHANGELOG bullets for every behaviour change in this wave.
- README "What you will see": the tooltip link says "Trust this folder" (the notification button says "Open Claude
  to Trust"); fix the quote.
- `src/holderPolicy.ts` buildResumePrompt: peer names from `claude agents` are text this extension does not control;
  quote them, strip CR/LF, cap each at 64 chars. Test.
- `src/statusBar.ts` renderTooltip: the gave-up footer names only a new limit or Cancel; list every way it clears
  (a new detection, the session finishing a turn, "Dismiss gave-up notices", Cancel).

#### Docs to update in the same wave
- NEXT.md: add the minors the final review ruled OK TO SHIP and the shared-globalState-across-windows issue; remove
  anything this wave fixes (Important 4 supersedes the "api-error-status fires on mid-sentence prose" item).
