### Task 8: Rename everything to Limit Break

(Verbatim from the Windows lane's brief, which carries the user's 2026-09-24 ruling on ids.)

One mechanical pass, after every behaviour task has landed. The user's ruling is: change it ALL, with no settings migration.
- `package.json`:
  - `name` → `claude-limit-break`;
  - `displayName` → `Limit Break`;
  - description reworded to match;
  - every contributed command, setting and view id `claudeLimitBuster.*` → `claudeLimitBreak.*`;
  - configuration title;
  - repository/bugs/homepage URLs → `https://github.com/Dream-Mosaic/claude-limit-break` (the user already renamed the repo to claude-limit-break on 2026-09-24).
- `src/`: the `NS` constant and every string key, globalState keys, the output channel name, every "Claude Limit Buster:" message prefix → "Limit Break:", and log lines.
- Tests and integration tests to match. `scripts/`, `.github/workflows/`, `.vscodeignore`, and anything that greps the VSIX name.
- Do NOT rewrite historical docs under `docs/research/`, `docs/design/` or `docs/superpowers/plans/`; they record what was true then.
- Verify with `grep -rniE "limit.?buster|claudeLimitBuster" --exclude-dir={node_modules,out,.git,docs} .` returning nothing except intentional mentions (for example the CHANGELOG's history).

Cloud-lane notes:
- Also exclude `.superpowers` and `.vscode-test` from that grep; the SDD workspaces are records, not product.
- The update check (`src/updateCheck.ts`) fetches release tags from the GitHub repo: its owner/repo must be the renamed repo. Check it.
- The resume prompt default (Task 6) already says "[Limit Break]"; do not alter it (pre-flight row T6/T8).
- The trust terminal and resume terminal names use a "Limit Buster: " prefix: rename to "Limit Break: ".
- README.md is Task 9's (it gets rewritten there); leave README alone here except where a test or script greps it.
