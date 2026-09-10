# Automated versioning/release tooling for Node.js — research for Dream-Mosaic/claude-limit-buster

Repo constraints restated: VS Code extension, TypeScript, **zero runtime `dependencies`** (hard constraint —
must stay `{}`), devDependencies limited to `typescript` + `@types/*`, single maintainer, public repo,
**never published to VS Code Marketplace or npm** — the only distribution channel is a `.vsix` file attached
to a GitHub Release. Currently 0.1.0, no releases yet.

---

## 1. release-please (googleapis/release-please)

**What it is.** A GitHub Action (backed by an npm-published CLI/library, but you don't need to install
that library — you consume it as a pinned Action) that parses Conventional Commit history on your default
branch and maintains a standing "Release PR" that bumps the version and rewrites CHANGELOG.md. Merging that
PR is the release trigger: release-please then tags the commit and creates a GitHub Release.
Source: [googleapis/release-please README](https://github.com/googleapis/release-please/blob/main/README.md), [release-please-action on GitHub Marketplace](https://github.com/marketplace/actions/release-please-action).

**How it determines versions.** Strictly from Conventional Commits on the default branch since the last
release: `fix:` → patch, `feat:` → minor, `feat!:`/`BREAKING CHANGE:` footer → major. A commit that doesn't
match a recognized prefix is not a "releasable unit" and is ignored for version-bump purposes (though some
prefixes like `deps:` also count, and language-specific strategies vary on which prefixes count, e.g. `docs:`
counts for Java/Python but not others). A `Release-As: x.x.x` trailer in a commit body forces an explicit
version. [README](https://github.com/googleapis/release-please/blob/main/README.md)

**Commit message requirement.** Full Conventional Commits discipline is mandatory — this is the entire input
signal. There is no manual "I want a minor bump" override other than the `Release-As:` trailer or hand-editing
the release PR's own commit before merging.

**`node` vs `simple` release type.** These are two of ~18 built-in "strategies" release-please ships:
- `node`: expects a `package.json` (and updates its `version` field) plus `CHANGELOG.md`. It knows how to also
  bump `package-lock.json`.
- `simple`: expects a generic `version.txt` (or similar) plus `CHANGELOG.md`, with no assumption of a package
  manager at all.
Both strategies only touch version-bearing files and the changelog — **neither strategy runs `npm publish` or
any registry push**. The README is explicit: release-please "does not handle publication to package managers
... it leaves that to the CI system." [README](https://github.com/googleapis/release-please/blob/main/README.md)
This means `node` type is actually a very natural fit here: it bumps `package.json`'s version (which VS Code
extension tooling like `vsce package` reads to name the `.vsix`) and writes the changelog, and your own
follow-up CI step does `vsce package` + attach the artifact to the GitHub Release release-please just cut.

**Non-registry / artifact-attached repos.** This is a well-trodden path, not a workaround: the Action exposes
outputs `release_created` (boolean), `tag_name`, `version`, `upload_url`, `html_url` on the job that runs the
Action, and the canonical pattern is a second step gated on `if: steps.release.outputs.release_created` that
builds the artifact and runs `gh release upload <tag> ./artifact.vsix` (or an upload-release-asset Action).
[release-please-action marketplace page](https://github.com/marketplace/actions/release-please-action)

**Dependencies.** None to `dependencies`, and typically **none to `devDependencies` either** — it's consumed
purely as a pinned third-party GitHub Action (`googleapis/release-please-action@v4`) plus two JSON config
files committed to the repo (`release-please-config.json`, `.release-please-manifest.json`). No `npm install`
of release-please itself is required for the Action-based workflow. Confirmed by inspecting the action's own
docs and Marketplace page — it "operates as a standalone GitHub Action without requiring npm package
installation or project dependencies." This is the cleanest fit of any tool here against the zero-deps
constraint.

**Changelog.** Yes, auto-generated from commit messages into `CHANGELOG.md`, grouped by type (Features, Bug
Fixes, etc.) with links to commits/PRs. For a single-maintainer project, whether this is signal or noise
depends entirely on whether the maintainer actually writes disciplined Conventional Commits — if commits are
terse or exploratory (normal for solo work), the changelog reads as flat "fix: x", "fix: y" bullets rather
than curated user-facing notes.

**Real failure modes.**
- **Historical-tag validation blocks all future releases.** [Issue #2546](https://github.com/googleapis/release-please/issues/2546):
  a repo with tags predating release-please's naming convention causes release-please to log a warning about
  an unconfigured "component" and **abort the entire release pipeline** — not just skip the mismatched tag.
  Reported workarounds are destructive (delete hundreds of historical tags) or manual (bypass automation
  release-by-release). Relevant here only in that adopting release-please **before** any tags exist (which is
  this repo's actual state — no releases yet) sidesteps this class of bug entirely; retrofitting it onto an
  established tag history is the risky part.
- **Bootstrapping/manifest ceremony.** Even for a single artifact, manifest mode wants a
  `release-please-config.json` + `.release-please-manifest.json` pair (the manifest can start `{}` but must
  exist). It's not heavy, but it is two extra files whose schema you have to get right once.
  [manifest-releaser.md](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- **Full dependence on commit-message discipline** — see the Conventional Commits critique under
  semantic-release below; it applies identically here since release-please's *only* input is commit prefixes.
- **A real migration story, in reverse of complexity:** Camunda's [orchestration-cluster-api-js#84](https://github.com/camunda/orchestration-cluster-api-js/issues/84)
  documents moving **from semantic-release to release-please** specifically to cut "5 npm devDependencies
  (~170 transitive packages)" and to get Conventional Commits support "natively with zero local dependencies."
  This is a strong real-world data point that release-please is the lower-dependency-footprint choice between
  the two automated options.

---

## 2. changesets (changesets/changesets)

**What it is.** An "intent file" model: a contributor making a change runs `npx changeset` (or `yarn
changeset`), which interactively asks which package(s) changed and how (major/minor/patch), and writes a
small Markdown file into `.changeset/` describing the bump and changelog text. These files accumulate on
branches/PRs. A maintainer later runs `changeset version`, which consumes all pending changeset files,
computes the resulting version bump(s), rewrites `CHANGELOG.md`, and deletes the consumed files. A separate
`changeset publish` step then runs `npm publish` for any package whose `package.json` version is ahead of
what's on the registry. [intro-to-using-changesets.md](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)

**Fit for single-maintainer, non-monorepo.** Explicitly confirmed by a changesets maintainer: "Yes, you can
totally do this" — referencing their own use of changesets on a single-package repo
(react-textarea-autosize). [Discussion #892](https://github.com/changesets/changesets/discussions/892) It
works mechanically. But its entire value proposition — computing correct, independent version bumps *across
a dependency graph of packages in a monorepo* — evaporates in a single-package repo. What's left is: a
manual step (writing a changeset file) that a solo maintainer could just as easily express by hand-editing
CHANGELOG.md, because there's no second contributor whose "intent" needs capturing into a durable file for
someone else to reconcile later. The project's own README self-describes as "a tool to manage versioning and
changelogs **with a focus on monorepos**." [changesets/changesets README](https://github.com/changesets/changesets)

**GitHub Action (`changesets/action`).** Wraps `changeset version` (opens/updates a "Version Packages" PR)
and `changeset publish` (runs a user-supplied `publish-script`, normally `npm publish`) as two modes gated by
whether unreleased changesets exist. It does support **not** publishing to npm: you can use only the
`version` sub-action to get the version-bump PR, and separately set `create-github-releases: true` to have it
tag + create a GitHub Release without ever calling `npm publish` — the maintainer's own `publish-script` could
be a no-op or replaced with your own artifact-build-and-attach step. [changesets/action README](https://github.com/changesets/action)
But this is explicitly a secondary, less-documented usage — "the primary action is designed for npm
workflows."

**Dependencies.** `@changesets/cli` must be added — **as a devDependency**, never a runtime dependency (it's
a CLI tool, not something the extension imports). So it satisfies the zero-`dependencies` constraint, but at
the cost of a devDependency (and its own transitive dev-dependency tree) plus a `.changeset/` directory
(config.json + a template README) permanently living in the repo.

**Changelog.** Yes — arguably higher-quality prose than release-please's, since a human writes free-form
changelog text per changeset at the time of the change, rather than it being mechanically derived from a
commit-type prefix. For a single maintainer this is genuinely nicer *if* the maintainer is willing to stop
mid-work and write a changeset file — which is an extra artifact on top of already writing the code and the
commit message, for no one else to consume.

**How it behaves for an artifact-only release.** No native concept of "attach a build to a GitHub Release."
`changeset publish` is fundamentally registry-shaped (it diffs local `package.json` version against what's
published on npm to decide what to publish). For a never-published package you'd skip `publish` entirely and
use only `version` + your own tag/release/build steps — at which point you are using changesets purely as "a
fancier way to write CHANGELOG.md entries and bump package.json," discarding most of the tool.

**Real complaints / friction.** The tool's own pitch material acknowledges the underlying problem it targets
is maintainer changelog-writing tedium across many contributor PRs
([Mitchell Hashimoto, "Reorient GitHub Pull Requests Around Changesets"](https://mitchellh.com/writing/github-changesets)) —
i.e., its ROI is a function of contributor volume, which a single-maintainer repo doesn't have. No major
"people are abandoning changesets" complaint threads turned up in search (unlike semantic-release); the tool
is well-regarded, but the complaints that exist are architectural-fit complaints (monorepo focus baked into
the CLI's prompts and the publish/registry-diff design), not bug reports.

---

## 3. semantic-release (semantic-release/semantic-release)

**What it is.** Fully automated, no-PR-in-the-loop releases: on every push to the release branch (after CI
passes), it analyzes commits since the last release, computes the next version, generates release notes,
publishes, tags, and creates the GitHub release — all in one CI run, no human merge step.
[GitHub README](https://github.com/semantic-release/semantic-release/blob/master/README.md)

**Commit convention.** Angular Commit Message Convention by default (a Conventional-Commits dialect):
`fix:`→patch, `feat:`→minor, `BREAKING CHANGE:`/`!`→major.
[semantic-release.gitbook.io](https://semantic-release.gitbook.io/)

**Default plugin pipeline — this is the important part.** With no config, semantic-release runs exactly four
plugins: `@semantic-release/commit-analyzer`, `@semantic-release/release-notes-generator`,
`@semantic-release/npm`, `@semantic-release/github`.
[semantic-release.gitbook.io/usage/plugins](https://semantic-release.gitbook.io/semantic-release/usage/plugins)
**`@semantic-release/npm` is in the default set and will attempt `npm publish` out of the box.** To avoid
that for a never-published package you must either (a) set `"private": true` in package.json so the npm
plugin self-detects and skips publish, or (b) explicitly override the plugins array and either drop
`@semantic-release/npm` or keep it with `npmPublish: false`. Once you override the plugins array at all, **you
must re-list every plugin you still want**, since the override replaces rather than extends the defaults.
[@semantic-release/npm README](https://github.com/semantic-release/npm/blob/master/README.md);
corroborating discussion: [darraghoriordan.com — "Semantic versioning javascript projects but skipping NPM publish"](https://www.darraghoriordan.com/2021/10/11/semantic-versioning-no-npm-publish),
[semantic-release/semantic-release Discussion #2392](https://github.com/semantic-release/semantic-release/discussions/2392).
Note also: even with `npmPublish: false`, the npm plugin still writes the bumped version into `package.json`
(useful here), but you're carrying a plugin literally named "npm" for a project that will never touch npm —
a legibility smell more than a functional problem.

**Dependencies.** `semantic-release` itself and every plugin (`@semantic-release/npm`,
`@semantic-release/github`, `@semantic-release/commit-analyzer`, `@semantic-release/release-notes-generator`,
optionally `@semantic-release/changelog`, `@semantic-release/git`, etc.) are installed as **devDependencies**
— never runtime `dependencies` — so the hard zero-deps constraint is not technically violated. But the
devDependency footprint is large: the Camunda migration issue above quantifies **5 direct devDependencies and
~170 transitive packages** for their semantic-release setup, contrasted against release-please's "zero local
dependencies" Action-only footprint. [camunda/orchestration-cluster-api-js#84](https://github.com/camunda/orchestration-cluster-api-js/issues/84)
For a project whose entire founding constraint is "keep the dependency surface minimal," pulling in ~170
transitive dev packages to run a release pipeline is directionally opposed to the project's stated values,
even though it's technically devDependency-only and doesn't ship in the `.vsix`.

**Changelog.** Optional (`@semantic-release/changelog` plugin, not in the default four) — without it,
semantic-release's "changelog" only exists as the GitHub Release notes body, not a committed `CHANGELOG.md`.
Same commit-message-quality dependency as release-please for whether the output reads as useful curation vs.
noise.

**Artifact-only release behavior.** Same shape as changesets: `@semantic-release/github` (a default plugin)
does support attaching build artifacts to the GitHub Release via its `assets` option, so once `npmPublish` is
neutralized, semantic-release can absolutely do "compute version → build .vsix → attach to GitHub Release" as
its entire job. Functionally comparable to release-please for this specific need, but arrived at by *disabling*
a default rather than release-please's *design* of never publishing anything by default.

**Real failure modes / why teams move off it.**
- **Dependency and maintenance overhead** — the leading concrete example is Camunda's move to release-please,
  citing dependency count as a named reason. [issue #84](https://github.com/camunda/orchestration-cluster-api-js/issues/84)
- **No human checkpoint.** Releases happen automatically on every qualifying push with no review gate —
  a miscategorized commit (`fix:` when it should've been non-releasing, or vice versa) ships a real,
  irreversible tag and GitHub Release before anyone looks at a diff. This is the structural opposite of
  release-please/changesets' PR-gated model.
- **Confusing retry/idempotency behavior.** [semantic-release/semantic-release#3178](https://github.com/semantic-release/semantic-release/issues/3178):
  if a release run fails after the tag is already pushed, re-running the same CI job appears to succeed
  (green build) but silently performs no release steps, because semantic-release sees the tag already exists
  — a "phantom success" failure mode people have been burned by.
- **Configuration fragility.** Malformed or outdated `.releaserc`/plugin config causes hard failures with
  opaque errors; users report needing to re-list the *entire* plugin array whenever they customize anything
  ([discussions/2392](https://github.com/semantic-release/semantic-release/discussions/2392)).
- **Conventional Commits itself is contested as a foundation.** A widely-discussed critique
  ([Lobsters: "Conventional Commits considered harmful"](https://lobste.rs/s/szoe3m/conventional_commits_considered))
  argues commit-type prefixes are a poor proxy for changelog-worthy user impact: "The line between a 'fix'
  and a 'feat' is in the eye of the beholder... Commit messages and changelogs serve different purposes."
  Since semantic-release (and release-please) both derive *everything* — version number, changelog content,
  whether a release happens at all — from that single ambiguous signal, this is a foundational risk shared by
  both automated-commit-driven tools, more acutely felt by semantic-release since it has no PR review gate to
  catch a misclassification before it ships.

---

## 4. Plain `npm version` + a tag-triggered workflow

**What it is.** No new tool. The maintainer runs `npm version patch|minor|major` locally (or in a workflow
dispatched by hand), which bumps `package.json`'s `version` field, commits that bump, and creates a local git
tag `vX.Y.Z` in one command (this is npm's built-in behavior, not a separate package). Pushing that tag
(`git push --follow-tags`) triggers a `on: push: tags: ['v*']` GitHub Actions workflow that checks out the
tagged commit, builds (`vsce package`), and creates a GitHub Release with the `.vsix` attached
(`softprops/action-gh-release` or `gh release create ... $ARTIFACT`).
[Go Make Things — automated npm-package release walkthrough](https://gomakethings.com/articles/how-to-automatically-create-a-new-release-and-publish-to-npm-whenever-package.json-is-updated-using-a-github-action/);
general pattern corroborated across [Michael Zanggl's CI/CD write-up](https://michaelzanggl.com/articles/github-actions-cd-setup/)
and multiple VS Code-extension-specific walkthroughs (e.g. [jpearson.blog on VS Code extension pre-releases](https://jpearson.blog/2022/05/02/pre-releases-github-actions-for-visual-studio-code-extensions/)).

**What does it automate that hand-rolled YAML does not?** Nothing beyond what `npm version` already gives for
free (atomic version bump + matching git tag in one command, which is stdlib npm, not a "tool" to adopt).
Everything past that — building, attaching to a Release — is exactly the hand-rolled YAML this task is
judging against. This option **is** the current approach, just naming the specific `npm version` primitive
that triggers it.

**Requirements.** No commit convention, no bot PR, no config file beyond the workflow YAML itself, **zero
dependencies of any kind** — not even a devDependency, since `npm version` ships with npm itself.

**Changelog.** None, unless the maintainer writes one by hand. For a single-maintainer project shipping to a
handful of users via a GitHub Release page (not a package registry with an audience expecting semver-mapped
changelogs), a short human-written paragraph in the GitHub Release description arguably serves readers better
than a mechanically-generated bullet list derived from commit prefixes — release-note *audience* here is
"whoever downloads the vsix off GitHub," not "npm consumers deciding whether to bump a dependency."

**Failure modes.** The only ones are the ones already inherent to hand-rolled YAML: version bump is a manual
judgment call (no enforcement of semver correctness), nothing stops forgetting to bump before tagging, and
there's no changelog unless someone writes it. These are exactly the gaps the other three tools are sold as
solving — the question is whether solving them is worth what each one costs *this* repo.

---

## Recommendation

**Adopt release-please (Action-only, `node` release type). Do not adopt changesets or semantic-release.**

**Reasoning.**

1. **The zero-dependency constraint is about to become the tie-breaker, and release-please is the only one of
   the three "tool" options that doesn't ask you to add anything to the repo's npm dependency graph at all** —
   not `dependencies`, not even `devDependencies`. It's consumed as a pinned third-party Action
   (`googleapis/release-please-action@v4`) plus two small JSON config files. changesets needs `@changesets/cli`
   as a devDependency; semantic-release needs 4+ devDependencies pulling in ~170 transitive packages (a number
   a real team cited as their reason to leave it for release-please). Given that this project's defining
   constraint is dependency minimalism, and devDependencies are explicitly capped at "typescript and @types
   only" today, introducing a devDependency tree for release tooling cuts against the project's own stated
   values even though it wouldn't violate the letter of "runtime `dependencies` stays empty."

2. **release-please's `node` strategy does exactly the two things this repo actually needs and nothing more**:
   bump `package.json`'s version (which `vsce package` reads) and maintain `CHANGELOG.md` — via a PR the
   single maintainer reviews and merges themselves, at their own pace. That PR-gated model is a meaningful
   safety property semantic-release structurally lacks (semantic-release ships the moment a qualifying commit
   lands on the release branch, with no review step) — for a project with one maintainer and no CI-driven
   registry publish to undo, an unreviewed auto-tag is a needless risk with no offsetting benefit.

3. **changesets solves a problem this repo doesn't have.** Its entire mechanical distinctiveness — intent
   files capturing *other contributors'* version-bump decisions for the maintainer to reconcile — assumes
   multiple contributors submitting PRs. With one maintainer, writing a `.changeset/*.md` file is strictly
   more steps than either (a) writing a Conventional Commit message release-please can read directly, or
   (b) just hand-editing CHANGELOG.md. Its own maintainers confirm it "works" solo but its value proposition
   is explicitly monorepo/multi-contributor.

4. **The honest counter-case for "none of them, keep the hand-rolled YAML" is real and should be named:** the
   thing release-please buys you — a correct semver bump and a changelog — has a cost (unwavering Conventional
   Commit discipline on every commit, forever, since that discipline is the *only* input to both the version
   number and the changelog text). The Lobsters critique cited above is not a fringe complaint: "fix vs feat"
   is genuinely ambiguous, and a solo maintainer moving fast has every incentive to write "wip" or "fix stuff"
   commits that release-please will either silently ignore (no release triggered when one was warranted) or
   miscategorize. If the maintainer doesn't already write Conventional Commits as a habit, adopting
   release-please means adopting that habit *first*, and the tool provides negative value until the habit is
   solid. Given the project is pre-1.0 with no releases yet, this is a reasonable moment to start the habit —
   but the honest framing is "release-please is a bet that commit-message discipline will hold," not "a
   guaranteed free upgrade over hand-rolled YAML." A maintainer who knows they won't maintain that discipline
   should stick with plain `npm version` + tag-triggered YAML rather than adopt a tool whose entire benefit is
   contingent on an input they won't reliably produce.

**What migration concretely looks like** (if adopted): keep the existing build/package/attach-vsix job as-is;
add `.github/workflows/release-please.yml` running `googleapis/release-please-action@v4` with
`release-type: node` (or manifest mode with `release-please-config.json` set to `"release-type": "node"`) on
push to the default branch; gate the existing build job on `${{ steps.release.outputs.release_created }}` and
have it `gh release upload ${{ steps.release.outputs.tag_name }} ./out.vsix` instead of (or in addition to)
however the tag currently gets created. The only new artifacts committed to the repo are the two small
release-please config/manifest JSON files — no `package.json` changes, no new dependency of either kind.

---

## Sources

- [googleapis/release-please README](https://github.com/googleapis/release-please/blob/main/README.md)
- [release-please-action — GitHub Marketplace](https://github.com/marketplace/actions/release-please-action)
- [release-please manifest-releaser.md](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [release-please Issue #2546 — historical tag naming blocks releases](https://github.com/googleapis/release-please/issues/2546)
- [camunda/orchestration-cluster-api-js Issue #84 — migration from semantic-release to release-please](https://github.com/camunda/orchestration-cluster-api-js/issues/84)
- [changesets/changesets README](https://github.com/changesets/changesets)
- [changesets intro-to-using-changesets.md](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)
- [changesets/changesets Discussion #892 — single-package usage](https://github.com/changesets/changesets/discussions/892)
- [changesets/action README](https://github.com/changesets/action)
- [Mitchell Hashimoto — "Reorient GitHub Pull Requests Around Changesets"](https://mitchellh.com/writing/github-changesets)
- [semantic-release/semantic-release README](https://github.com/semantic-release/semantic-release/blob/master/README.md)
- [semantic-release.gitbook.io — usage/plugins (default plugin set)](https://semantic-release.gitbook.io/semantic-release/usage/plugins)
- [semantic-release/npm README — npmPublish option](https://github.com/semantic-release/npm/blob/master/README.md)
- [semantic-release Discussion #2392 — skipping npm release, tags only](https://github.com/semantic-release/semantic-release/discussions/2392)
- [darraghoriordan.com — semantic-versioning JS projects but skipping npm publish](https://www.darraghoriordan.com/2021/10/11/semantic-versioning-no-npm-publish)
- [semantic-release/semantic-release Issue #3178 — silent no-op on retry after tag exists](https://github.com/semantic-release/semantic-release/issues/3178)
- [Lobsters — "Conventional Commits considered harmful" discussion](https://lobste.rs/s/szoe3m/conventional_commits_considered)
- [Go Make Things — npm version + tag-triggered GitHub Actions release walkthrough](https://gomakethings.com/articles/how-to-automatically-create-a-new-release-and-publish-to-npm-whenever-package.json-is-updated-using-a-github-action/)
- [Michael Zanggl — Publish to NPM automatically with GitHub Actions](https://michaelzanggl.com/articles/github-actions-cd-setup/)
- [James Pearson — Pre-Releases & GitHub Actions for VS Code Extensions](https://jpearson.blog/2022/05/02/pre-releases-github-actions-for-visual-studio-code-extensions/)
