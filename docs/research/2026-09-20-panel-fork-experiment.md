# Does an external resume fork a session still open in a panel? — run 2026-09-20

**Yes, and the turn that is lost is this extension's own.** Issue [#6] described
the experiment; this is the run that settled it, on a disposable session in a
temp folder, with a script reading the transcript rather than a person reading
the tab.

Everything below is derived from
`~/.claude/projects/c--Users-thegr-AppData-Local-Temp-clb6-20260919-2208/0974ef20-b626-4aa3-9fe2-c35aaae9c9d4.jsonl`.
Line numbers refer to that file. The protocol and the two scripts are in
[`scripts/fork6.js`](../../scripts/fork6.js) and
[`scripts/clb6-snap.ps1`](../../scripts/clb6-snap.ps1); the protocol itself is
in [#6].

## Method

Three marked turns in one panel-created session, no tools used, so no permission
prompts and no parallel tool calls to muddy the tree:

1. `CLB6-P1` typed into a Claude Code panel tab.
2. `CLB6-CLI` sent by `claude --resume <id> "…"` from the integrated terminal —
   the same path the extension's resume takes.
3. `CLB6-P2` typed into the **still-open** panel tab, with no reload and no
   reopen.

Each prompt asked the model to list every `CLB6` marker it could see. That gives
two independent measures: the shape of the tree, and what the model was actually
given.

## What happened

**The panel forked.** Its last node before the resume was `a4c58759` (line 27,
its own `stop_hook_summary`). The CLI attached to that node correctly at line 31.
Two minutes later the panel attached `CLB6-P2` to the *same* node at line 44:
one parent, two children, one `cli`, one `claude-vscode`.

**The panel's model never received the resumed turn.** Its reply at line 48
lists `CLB6-P1`, `CLB6-P2` and the folder name. No `CLB6-CLI`. The fork is not
only a shape in the file; it is a hole in the context.

**Both live processes were blind, in both directions.** A later turn typed into
the CLI ("how about now?", line 51) answered "No new ones" — it could not see
`CLB6-P2` either. Two live processes on one session each continue from their own
in-memory anchor and neither notices the other.

**The panel's branch is the one that survives.** A fresh `claude --resume` at
line 68 attached to `3fceb50b`, the *panel's* leaf, and its reply (line 75)
treats `CLB6-CLI` as a new marker it had not seen. Walking the parent chain back
from the session's final leaf confirms it: the first resumed turn `05733d05` is
not on it, while `CLB6-P2` and the second resume are.

So of the two forked branches, the one that is abandoned is the one holding the
turn this extension exists to produce.

**Reopening the tab resyncs it.** After a window reload, the panel's next turn
(line 94) attached to `b1ef6c76`, the CLI's leaf, and appended cleanly. Same
session, same panel, correct behaviour — because a restarted panel reads the
transcript instead of its memory.

## Confounds

**A restarted panel cannot manufacture this result.** The pid was not captured
during the run, but the confound only runs one way: a panel that restarted would
have read the file and appended, which is exactly what the reload at line 94
did. A restart can turn a fork into an append, never the reverse.

**Replayed segments and parallel tool calls** are the two things that inflate
naive branch counts. `fork6.js` counts each `uuid` once, and this run used no
tools at all. The script's verdicts were checked first against three transcripts
whose answers were already known: the `71a56ee0` probe's race (FORK), that same
probe's sequential turns (APPEND), and the 2026-09-09 smoke test (PENDING — the
panel never sent a turn after the resume, which is why that test did not settle
this).

**An inherited session identity** ([#9]) was excluded by opening the window from
a plain shell with `CLAUDECODE` unset.

**Not covered:** a panel whose last turn ended in a real usage-limit error. The
[#6] probe found that a process in the panel's mode stays alive and keeps
working after a 429, which suggests the state is the same, but that remains
inferred.

## A signal that looks useful and is not

Asked which client sent which turn, the model reasoned from two observations.
One holds, one does not.

**The tool roster does change with the client, and it is on disk.** Line 33,
written by the CLI, is a `deferred_tools_delta` attachment adding
`EndConversation` and `SendFeedback` and removing the MCP tools; line 96,
written by the panel, removes those two and re-adds them.

**The drive-letter casing is a confound.** In this transcript the split looks
perfect — 37 panel lines with `c:\Users\…`, 30 CLI lines with `C:\Users\…`. But
the session that ran this analysis has one client — all 2,191 of its lines that
carry a `cwd` are `claude-vscode` — and still 35 casing flips, 33 of them
immediately after a Bash tool call: Git Bash lowercases the drive letter and the next environment block
reports it. Casing tracks whatever last set the cwd, not who sent the turn. It
was clean here only because this run used no tools.

The transcript carries the direct signal, `entrypoint`, on every line. The model
cannot see it.

## What this means for the extension

1. **[#7] is loss prevention, not polish.** A stale tab is not merely showing old
   text; typing into it discards the resumed turn, silently, on both sides.
2. **The remedy is a reopen**, and it is demonstrated above rather than assumed.
3. **[#7] should not read `~/.claude/sessions/<pid>.json`** to decide whether a
   panel is live. That store is keyed by pid, written once and never refreshed,
   and outlives the process. `claude agents --json` is the CLI's own consumer of
   it and does the staleness work, including a `procStart` check against pid
   reuse.
4. **[#11] is now on the critical path.** A reload is what we are about to
   recommend, and a reload currently destroys a job waiting for Resume Now.

## Still open

- **Whether `claude agents --json` is a trustworthy liveness oracle for a panel
  tab**: whether the row survives a closed tab, how long a dead one lingers, and
  whether a reopen gets a new pid. This only matters for a panel tab in a
  *different* VS Code window, where `vscode.window.tabGroups` cannot see or close
  it and a warning is all that is available.
- **What triggers the systemic panel forks** seen in real sessions with no second
  process involved. Unchanged by this run.

[#6]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/6
[#7]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/7
[#9]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/9
[#11]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/11
