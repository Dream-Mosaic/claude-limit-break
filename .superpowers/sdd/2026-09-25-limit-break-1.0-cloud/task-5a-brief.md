### Task 5a: Trust hotlink (the half of Task 5 that does not wait on Task 4)

Source: plan Task 5, second bullet group, verbatim below. The tooltip rewrite (first bullet) and
the tooltip link to this command are Task 5b, which waits on Task 4's gave-up state (Windows lane
ruling: "T5 tooltip lists gave-up sessions with their reason (from T4) - one status-bar model, not
two"). Do NOT change `src/statusBar.ts` in this task.

From the plan:

- Trust hotlink. Add a command `claudeLimitBuster.openClaudeToTrust` (argument: cwd) that opens a VS Code terminal running plain `claude` (no `--resume`, no prompt) in that folder, so the user answers the trust dialog themselves. Build the environment the way `buildTerminalOptions` does, including stripping the parent-session variables, and launch from `trustedSpelling`'s spelling if there is one. Never write the trust record.
  - (Task 5b, not now:) Link it from the tooltip line of an untrusted session (MarkdownString command link, `isTrusted` limited to that command).
  - Link it from the untrusted-folder warning notification as a button, `Open Claude to Trust`.
- After the user trusts, the existing per-session `trustStamps` cache sees the config mtime change on the next refresh. Also re-run `refreshTrust` when that terminal closes, so the marker clears without waiting.

Pointers (verify, do not trust blindly):
- The untrusted-folder warning is the `showInformationMessage` in `schedule()` in `src/extension.ts` (the `trustNote` branch, gated on `s.notify`).
- `refreshTrust`, `trustStamps`, and the resume launch (which already uses `trustedSpelling` + `buildTerminalOptions`) are in `src/extension.ts`; `buildTerminalOptions` and `PARENT_SESSION_VARIABLES` are in `src/resumer.ts`; `trustedSpelling` is in `src/trust.ts`.
- `buildTerminalOptions` builds resume args by default; the claude args are injectable. A plain `claude` launch passes no claude args. Keep any new pure builder in `src/resumer.ts` and test it there.
- Constraint 2 is the heart of this task: the extension opens the terminal; the user answers the dialog. Nothing here reads keystrokes into that terminal or writes `~/.claude.json`.
- The command must be contributed in `package.json` (`contributes.commands`) with a title using the existing "Claude Limit Buster" category/prefix convention, and it must not appear in the Command Palette without an argument if it cannot work without one (check how the existing commands handle `menus.commandPalette`; follow the repo's pattern, and if there is none, hide it with `"when": "false"` and say so in the report).
