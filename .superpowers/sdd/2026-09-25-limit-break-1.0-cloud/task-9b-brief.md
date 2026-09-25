### Task 9b: Docs and 1.0.0 staging

Plan Task 9 minus the main merge (Task 9a did that). The plan text, verbatim:

- CHANGELOG: a 1.0.0 entry covering everything since 0.1.2 (read `git log 0.1.2..HEAD` or the last tag), grouped Added / Changed / Fixed. It includes the install note: "Limit Break is a new extension id. Uninstall Claude Limit Buster 0.1.x first; its settings do not carry over."
- README:
  - new name and banner;
  - settings table complete, with `watchScope`, `checkForUpdates`, `onStale`, `statusBar`, `maxResumeTokens` 500000 and the new `resumePrompt`;
  - a "Works with Claude Code's own auto-continue" section explaining panel vs terminal;
  - a "Staying up to date" section;
  - install from a GitHub release.
- `docs/NEXT.md`: refresh. Remove what shipped; keep open items, including the synthesis "Consider" list.
- `package.json` `version` → `1.0.0`. This commit goes on a new branch `release/1.0.0` cut from this branch. It is NOT merged to main, because `release.yml` publishes on any push to main whose version is untagged; the controller opens the PR.

Cloud-lane notes (rulings in the ledger):
- Setting names are `claudeLimitBreak.*` after Task 8. Read `package.json` for the full, current list and defaults;
  the README table must match it exactly (a test comparing them is welcome if cheap).
- The banner: `media/banner.png` is not shipped in the VSIX (Task 7). Reference it by its absolute GitHub raw URL
  on the default branch so it renders in both GitHub and VS Code's Details tab:
  `https://raw.githubusercontent.com/Dream-Mosaic/claude-limit-break/main/media/banner.png`
  (it resolves once this work reaches main).
- "Works with Claude Code's own auto-continue": the truth is in `src/holderPolicy.ts` and `src/autoContinue.ts`
  (Task 2) and the synthesis doc's Finding 1 (the panel has no native auto-continue; an interactive terminal
  does by default unless `autoContinueAtUsageLimit` is false). Describe what the extension does in each case.
- NEXT.md must also carry: the v1.1 sidebar (activity-bar view container listing pending/ready/gave-up sessions,
  icon `media/logo-mono.svg`, redraw on a 24px grid with ~2px margin — see the cloud ledger's SVG ruling); every
  deferred Minor and parked finding from both lanes' ledgers that is still open; the two-windows limitation's
  status after Task 10's cross-window claim.
- CHANGELOG: `git log --oneline 0.1.2..HEAD` (tag `0.1.2` or `v0.1.2`; check `git tag`). Group by user-visible
  effect, not by commit. Mention the rename and the new id prominently.
- Branch mechanics: commit the docs on `claude/limit-break-1.0-cloud`. Then the version bump ONLY: create
  `release/1.0.0` from that head (`git switch -c release/1.0.0`), bump `version` in package.json AND
  package-lock.json (`npm version 1.0.0 --no-git-tag-version`), run the unit + integration suites and
  `bash scripts/check-vsix.sh`, commit `chore(release): 1.0.0`, and switch back to
  `claude/limit-break-1.0-cloud`. Do not push; the controller pushes and opens the draft PR.
