### Task 9: Docs and 1.0.0 staging

- CHANGELOG: a 1.0.0 entry covering everything since 0.1.2 (read `git log 0.1.2..HEAD` or the last tag), grouped Added / Changed / Fixed. It includes the install note: "Limit Break is a new extension id. Uninstall Claude Limit Buster 0.1.x first; its settings do not carry over."
- README:
  - new name and banner;
  - settings table complete, with `watchScope`, `checkForUpdates`, `onStale`, `statusBar`, `maxResumeTokens` 500000 and the new `resumePrompt`;
  - a "Works with Claude Code's own auto-continue" section explaining panel vs terminal;
  - a "Staying up to date" section;
  - install from a GitHub release.
- `docs/NEXT.md`: refresh. Remove what shipped; keep open items, including the synthesis "Consider" list.
- `package.json` `version` → `1.0.0`. This commit goes on a new branch `release/1.0.0` cut from this branch. It is NOT merged to main, because `release.yml` publishes on any push to main whose version is untagged; the controller opens the PR.
