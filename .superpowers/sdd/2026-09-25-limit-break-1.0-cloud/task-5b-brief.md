### Task 5b: The tooltip lists every waiting session (and every gave-up one), with the trust link

Plan Task 5, the part Task 5a left. The plan text, verbatim:

- `src/statusBar.ts`: the tooltip lists EVERY pending session, counting down or ready, one line each: short id, folder basename, resume time (or "ready"), and a warning marker if untrusted. It drops "this one is due first". The status bar text still counts down to the soonest.
  - Link it [the `claudeLimitBuster.openClaudeToTrust` command, built in Task 5a] from the tooltip line of an untrusted session (MarkdownString command link, `isTrusted` limited to that command).

Cross-task ruling (binding): "T5 tooltip lists gave-up sessions with their reason (from T4) - one status-bar
model, not two". Task 4b added a gave-up record per session (session id, folder, cause, when) and a minimal
tooltip mention. Fold both into ONE list here: pending sessions first (soonest first, "ready" ones marked), then
gave-up sessions with their cause. One line each.

Details:
- From Task 4b (implementer concern 4): a session can be BOTH pending and gave-up (a launcher or folder failure keeps the job in the ready list; a failed Resume Now on a counting-down job leaves it counting down). One line per session: show its pending state and its gave-up cause on that one line.
- `isTrusted` must be `{ enabledCommands: ['claudeLimitBuster.openClaudeToTrust'] }` (limited to that command),
  not `true`. The command link carries the session's cwd as its argument, URI-encoded JSON per the VS Code
  command-URI convention (`command:<id>?<encodeURIComponent(JSON.stringify([cwd]))>`). Test the encoding with a
  Windows path containing a backslash, a space and a `#`.
- Text a user controls (folder names) goes into Markdown: escape it so a folder named e.g. `*x*` or `[a](b)`
  renders literally and cannot inject a link.
- Keep the existing idle and click-for-actions behaviour.
- The status bar item's text still counts down to the soonest pending job; with none pending and something given
  up, keep Task 4b's gave-up text/icon.

Test-first; mutation-check each new branch (escaping, the untrusted marker, the link, ordering, ready vs time).
