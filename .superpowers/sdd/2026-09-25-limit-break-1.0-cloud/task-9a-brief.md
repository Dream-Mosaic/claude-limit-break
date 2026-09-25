### Task 9a: Merge origin/main into the 1.0 work

Split out of plan Task 9 ("Task 9 must merge origin/main into this branch first"; Windows-lane ledger:
"expect package.json + workflow + transcriptWatcher.ts conflicts. User ruling: drop old VS Code support
(install base 1, on 1.138)"). The user approved this lane doing the merge (2026-09-25): a MERGE COMMIT,
never a rebase, never a force-push.

`origin/main` is at `28b0eec` and carries, since the merge base `53d1a88`:
- #17 `c97591e` chore: harden the public repo (SHA-pinned actions, SECURITY.md, dependabot.yml)
- #18 `885fb5c` build(deps): bump the actions group with 3 updates
- #22 `9d8302a` chore: target VS Code 1.138 and Node 24 (`engines.vscode` ^1.138.0, `@types/node` ^24,
  Node 24 in CI, the `Dirent.path` fallback removed from `src/transcriptWatcher.ts`, a
  `serialize-javascript` override)

Do:
1. `git fetch origin main` then `git merge --no-ff origin/main` on `claude/limit-break-1.0-cloud`.
2. Resolve every conflict so that BOTH sides' intent survives:
   - main's side wins on: engines, @types/node, the override, workflows, dependabot, SECURITY.md, and the removal
     of the `Dirent.path` fallback;
   - this branch's side wins on everything the 1.0 tasks changed (limit/overload detection, the watcher's
     trust/veto logic, the new commands and settings, the icon, the resume prompt default).
   - `package-lock.json`: never hand-merge. Take main's lockfile, then run `npm install` so it matches the merged
     package.json, and commit the result. Check that `npm ci` then succeeds.
3. Build and test the MERGED tree: `npm ci`, full unit suite, integration suite (constraint 6), and
   `bash scripts/check-vsix.sh` (it packages; delete any .vsix afterwards).
4. If a test fails only because main changed an assumption (e.g. the Dirent.path removal), fix it in a separate
   commit AFTER the merge commit, with its own explanation. Do not bury behaviour changes in the merge commit.
5. The merge commit message lists each conflicted file and how it was resolved.

No TDD cycle applies to the merge itself; the evidence is the conflict list, the resolution for each, and the
green suites on the merged tree.
