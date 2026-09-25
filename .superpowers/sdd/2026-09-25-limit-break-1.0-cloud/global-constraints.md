## Global constraints (every task in the cloud lane)

Adapted from `2026-09-24-limit-break-1.0/global-constraints.md` for a Linux
cloud checkout. Rules 2-4 and 9-11 are unchanged.

1. Work ONLY in `/home/user/claude-limit-break` on branch `claude/limit-break-1.0-cloud`.
   Do not switch branches, rebase, reset, or push. The controller pushes.
2. Never write `~/.claude.json` and never answer Claude Code's folder-trust dialog on the user's behalf. Reading is fine.
3. Never send anything into a Claude session this extension did not create: no writing to another session's transcript, no connecting to its `messagingSocketPath`, no signals or kills.
4. `claude --resume` must only ever receive a UUID session id.
5. TDD. Write the failing test first, see it fail for the expected reason, then implement. For every new guard or branch, verify it with a mutation: break the line, confirm that a named test goes red, then restore it. A runner is at `.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/mutate.py`; read its header before use.
6. Gate on EXIT CODES, never on grep output: `npm test > /tmp/t.log 2>&1; echo "exit=$?"`.
   Integration: `xvfb-run -a npm run test:integration > /tmp/it.log 2>&1; echo "exit=$?"` (downloads VS Code once into
   .vscode-test/; the user allowed *.visualstudio.com and *.microsoft.com on 2026-09-25). Both must be green before
   you report DONE. VS Code's own "Failed to fetch" / SSL handshake lines in that log are its background traffic
   (gallery, GitHub) and are not test noise.
7. Line endings: the repository stores `src/*.ts` and `test/*.ts` as LF (`git ls-files --eol`). Keep LF.
   (The CRLF note in the Windows lane's constraints is an artefact of that checkout's autocrlf.)
8. Commit as you go: one commit per green step, conventional-commit subjects, and end each message with
   these two lines:
   your own model's Co-Authored-By line (the attribution your harness gives you; ledger ruling after Task 6), and
   `Claude-Session: https://claude.ai/code/session_01JRHoU2Jtzz7ZD6EKVKb5bu`
9. Match the surrounding code: dense "why" comments where the code is non-obvious, VS Code fakes in `test/helpers/vscode.ts`, module stubs via the existing `stubModule` pattern in `test/extension.test.ts`.
10. User-facing strings still say "Claude Limit Buster" until Task 8 renames everything. Do not rename early. (Task 6's prompt text is the one deliberate exception: it is specified verbatim.)
11. SPEC: docs/design/2026-09-01-design.md Goals 1-4 (panel and terminal sessions alike; resume the correct session unattended; never escalate autonomy; bound token spend), its Non-goals and Findings table, and the README "The panel tab after a resume" section. Reviewers check every task against these.
12. Never touch `.superpowers push/` or `.superpowers/sdd/2026-09-24-limit-break-1.0/` (the Windows lane's workspace). Read-only reference.
