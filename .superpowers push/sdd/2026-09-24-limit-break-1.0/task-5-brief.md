### Task 5: Tooltip lists every waiting session, and trust hotlink

- `src/statusBar.ts`: the tooltip lists EVERY pending session, counting down or ready, one line each: short id, folder basename, resume time (or "ready"), and a warning marker if untrusted. It drops "this one is due first". The status bar text still counts down to the soonest.
- Trust hotlink. Add a command `claudeLimitBuster.openClaudeToTrust` (argument: cwd) that opens a VS Code terminal running plain `claude` (no `--resume`, no prompt) in that folder, so the user answers the trust dialog themselves. Build the environment the way `buildTerminalOptions` does, including stripping the parent-session variables, and launch from `trustedSpelling`'s spelling if there is one. Never write the trust record.
  - Link it from the tooltip line of an untrusted session (MarkdownString command link, `isTrusted` limited to that command).
  - Link it from the untrusted-folder warning notification as a button, `Open Claude to Trust`.
- After the user trusts, the existing per-session `trustStamps` cache sees the config mtime change on the next refresh. Also re-run `refreshTrust` when that terminal closes, so the marker clears without waiting.

