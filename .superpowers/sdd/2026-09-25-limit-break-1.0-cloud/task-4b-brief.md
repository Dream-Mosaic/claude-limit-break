### Task 4b: The "gave up" state and distinct failure notices (synthesis A8, A9)

Plan Task 4, split: this is its failure-state half. The plan text, verbatim:

- A distinct "gave up" state (A8/A9). When a resume fails in a way we stop retrying on, the status bar shows a distinct icon and a tooltip saying why, instead of looking idle. Those failures are: stall watch fired, launcher missing, cwd missing, or the budget refusal dismissed. Warn once per session per failure, then stay quiet. It clears on the next successful detection or resume for that session, or on Cancel from the menu. Failure notifications name their cause distinctly.

Synthesis A9 (docs/research/2026-09-23-prior-art-auto-retry-preheat.md): "Give distinct notifications for auth
failure, still limited, and generic failure." In this codebase that means: each of the four causes above gets
its own notification text naming the cause and what the user can do about it. Do not invent new failure
detection (e.g. auth failure) that the code cannot observe today; name the four causes the plan lists.

Cross-task ruling (Windows lane pre-flight, binding): "T5 tooltip lists gave-up sessions with their reason (from
T4) - one status-bar model, not two". So:
- Model the gave-up state as data the status bar can render per session: session id, folder (cwd), cause,
  and when. Keep it in one place that Task 5b's tooltip rewrite can list alongside pending jobs. Prefer a small
  pure module (e.g. `src/gaveUp.ts`) with the state transitions (record, warn-once check, clear on detection,
  clear on resume, clear on Cancel) unit-tested without vscode.
- The status bar: when nothing is pending and at least one session has given up, show a distinct icon (a
  codicon, e.g. `$(warning)`, `$(error)` or `$(circle-slash)` — pick one and justify it) and a tooltip naming each
  gave-up session and its cause. When jobs ARE pending, the countdown still wins the text; the tooltip still
  mentions gave-up sessions. Task 5b will rewrite the tooltip into one list — keep your tooltip code minimal and
  easy to fold into that.
- Cancel from the status-bar menu clears gave-up state as well as pending jobs (read the existing
  `statusBarMenu` / `cancel` commands first).

Find each failure site before writing code (all in `src/extension.ts` unless noted): the stall watch firing
(`stallVerdict` / the setTimeout after launch), the launcher-missing return, the `cwdExists` refusal, and the
budget refusal (read `src/budget.ts` and where its refusal notice is shown; "dismissed" means the user closed
the refusal without choosing to go ahead — read the code to see what the notice offers). Some of these already
log or notify; make each one record the gave-up cause and notify once per session per cause.

"Clears on the next successful detection or resume for that session": a new detection for that sessionId, or a
resume that launches, removes its gave-up record. Persisting gave-up state across a window reload is NOT
required (the ready-job persistence from #11 is a separate mechanism; do not extend it).

Mutation-check every new guard. Integration suite must stay green.
