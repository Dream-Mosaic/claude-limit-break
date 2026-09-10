# Research

Findings behind the release and versioning decisions, kept because they were
verified against sources rather than reasoned from memory, and re-deriving them
is expensive.

- [Release tooling](2026-09-09-release-tooling.md) — release-please, changesets,
  semantic-release and plain `npm version`, judged against this repo's
  zero-dependency and no-registry constraints.
- [VS Code release practice](2026-09-09-vscode-release-practice.md) — what real
  extensions do, read from their workflows; the odd-minor pre-release convention
  and why it does not apply here; and the auto-update trap for a `.vsix`
  distributed outside the Marketplace. Includes findings read from vsce's own
  source about where version rules are actually enforced.
- [Workflow critique](2026-09-09-workflow-critique.md) — a correctness review of
  the hand-rolled workflows, including the `gh release create` partial-failure
  mode that the draft-then-publish flow exists to avoid.

Decisions taken from these live in [../../README.md](../../README.md) under
"Versioning and releases". Where a report recommends something this project did
not adopt, the report is the record of the argument, not of the outcome.
