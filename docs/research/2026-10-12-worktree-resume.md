# Resuming a session from a worktree it moved into (2026-10-12)

**Question.** A panel session started in a repo root, then moved into one of the repo's git worktrees partway through (the Bash tool `cd`'d there, and every later transcript entry records the worktree as `cwd`). Limit Break takes the resume's folder from the last entry, so it launches `claude --resume <id>` in the worktree, while the transcript lives in the root's project folder. Does that fork the conversation?

**Answer: no.** On Claude Code 2.1.296 the resume finds the original transcript and continues the same chain in the same file.

## The field case that raised it

Session 7a00d6c0 ("Lost campaign updates forensics", unwritten-chronicles) moved into `.claude/worktrees/docs+rules-content-map` at 2026-10-11T09:24:59Z with `git worktree add … && cd …`. It hit a limit at 2026-10-12T03:16Z, and the scheduled resume's cwd was the worktree. Its transcript has no entry written from the command line after 2026-10-09, and its parent chain is linear. So Limit Break never resumed it: 1.0 dropped it as "has continued", which is the `<task-notification>` bug fixed on the 1.1 branch.

What looked like a fork was a second session. The worktree raised the false "not trusted" warning (Limit Break checks only the exact folder; the CLI trusts it through the main checkout's record). "Open Claude to Trust" opened a plain `claude` there. No trust dialog appeared, so it was an ordinary prompt, and the message typed into it created session 7f8d7cc4 in the worktree. That session hit the limit too, and Limit Break resumed it at 00:23 with "continue from where you left off". It had no history, so it answered from the worktree's git state and the plan files, and looked like the original carrying on.

## The experiment

A scratch repo with a worktree at `.claude/worktrees/wt`. Throwaway session 95a65e07 was created in the root with `claude -p` (haiku). Then:

1. `claude -p --resume 95a65e07 …` was run from the worktree folder.
2. The result was the same `session_id`. The ORIGINAL transcript (root's project folder) grew from 205461 to 217559 bytes.
3. The new entries record `cwd` = the worktree. The first new entry chains, through a system and an attachment entry, to the previous last assistant entry: no second branch.
4. A project folder for the worktree was created, holding only an empty `memory/`. No transcript was written there.

From the bundle: `--resume <id>` looks the id up in the current folder's project, then in the project folders of the repo's other worktrees (`tengu_resume_worktree_fallback`), then by scanning for the id (`tengu_transcript_id_scan_fallback`). The interactive `--resume` that Limit Break launches goes through the same loader.

**Not reproduced:** moving a session into a worktree under `-p`. The Bash tool's `cd` does not persist between calls there, so every entry kept the root as `cwd`. The panel's move above is the field evidence for that part. The resume behaviour doesn't depend on how the `cwd` changed.

## What follows for Limit Break

- Resuming in the session's latest folder is right. The worktree is where the work was, and resuming in the root would put the agent on the main checkout.
- The real faults in the field case are: the false trust warning for worktrees; the Trust terminal leaving a live Claude prompt that becomes a session Limit Break later auto-resumes; and 1.0's continued-since bug.
- Still open: Claude Code 2.1.296's `--resume` has a live-holder path ("To branch off a copy instead, run: claude --resume <id> --fork-session"). Not tested here: it needs a live interactive holder.
