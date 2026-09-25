## Global constraints (every task)

1. Work ONLY in the worktree above. Never edit, check out or commit in the main checkout `C:/Users/thegr/Dream-Mosaic/Projects/claude-limit-buster`. Do not push.
2. Never write `~/.claude.json` and never answer Claude Code's folder-trust dialog on the user's behalf. Reading is fine.
3. Never send anything into a Claude session this extension did not create: no writing to another session's transcript, no connecting to its `messagingSocketPath`, no signals or kills.
4. `claude --resume` must only ever receive a UUID session id.
5. TDD. Write the failing test first, see it fail for the expected reason, then implement. For every new guard or branch, verify it with a mutation: break the line, confirm that a named test goes red, then restore it. A reusable runner is at `C:/Users/thegr/AppData/Local/Temp/claude/c--Users-thegr-Dream-Mosaic-Projects-claude-limit-buster/05690955-d99d-46e1-bc06-109e58dadc2f/scratchpad/mutate.py` (JSON spec: a list of `{file, name, old, new}`); read it before use.
6. Gate on EXIT CODES, never on grep output: `npm test > "$TEMP/t.log" 2>&1; echo "exit=$?"`. Integration: `npm run test:integration` (downloads VS Code once; slow). Both must be green before the task is reported DONE.
7. Tooling traps, all observed on this repo:
   - The Bash tool HALVES doubled backslashes in heredocs and inline scripts (`'c:\\x'` lands as `'c:\x'`). Write any text containing `\\` with the Write or Edit tool.
   - `src/*.ts` and `test/*.ts` are CRLF, except `src/policy.ts`, which is LF. Use the Edit tool rather than scripted patches.
8. Commit as you go: one commit per green step, conventional-commit subjects, and end each message with
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
9. Match the surrounding code: dense "why" comments where the code is non-obvious, VS Code fakes in `test/helpers/vscode.ts`, module stubs via the existing `stubModule` pattern in `test/extension.test.ts`.
10. User-facing strings still say "Claude Limit Buster" until Task 8 renames everything. Do not rename early.


11. SPEC: docs/design/2026-09-01-design.md Goals 1-4 (panel and terminal sessions alike; resume the correct session unattended; never escalate autonomy; bound token spend), its Non-goals and Findings table, and the README "The panel tab after a resume" section. Reviewers check every task against these.
