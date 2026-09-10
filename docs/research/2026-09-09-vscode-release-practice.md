# VS Code extension versioning/release research — for Dream-Mosaic/claude-limit-buster

Context: `claude-limit-buster` is TypeScript, zero runtime deps, single maintainer, public repo,
**deliberately never published to the Marketplace**, distributed as a `.vsix` on GitHub Releases.
Currently `0.1.0`, no releases cut yet. This file is raw research to inform a release-workflow
decision — not a plan.

---

## 1. Microsoft's official guidance

### 1a. The odd/even pre-release versioning convention

Source: [Publishing Extensions — "Pre-release Extensions"](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions) (code.visualstudio.com)

Exact wording: recommends extensions use `major.EVEN_NUMBER.patch` for release versions and
`major.ODD_NUMBER.patch` for pre-release versions, e.g. `0.2.*` release / `0.3.*` pre-release.

The mechanism this exists for, per the same page:

> "VS Code will automatically update extensions to the highest version available, so even if a
> user opted-into a pre-release version and there is an extension release with a higher version,
> the user will be updated to the released version."

So the parity convention is a workaround for one specific problem: the Marketplace client picks
"highest version number" as "latest," full stop — it has no separate concept of a pre-release
track with its own ordering. If pre-release used `1.3.0` and the next stable release was `1.3.0`
too (or lower), a pre-release user could get *downgraded* to what looks like an older stable, or
a stable user could get bumped into a numerically-higher pre-release. Reserving all odd minors for
pre-release and all even minors for stable keeps every stable release numerically higher than the
pre-release that preceded it and numerically lower than the next pre-release, so both channels
sort correctly under plain numeric comparison.

**This is entirely a Marketplace-gallery mechanism.** It only matters when:
- the extension is installed "from a gallery" (Marketplace or Open VSX via `vsce`/`ovsx`), and
- VS Code's own update engine is deciding what to silently install next for that identifier.

A `.vsix` installed via "Install from VSIX" is not tracked against any gallery at all (see §3/§4
below) — VS Code has no "latest version for this identifier" to compare against, so there is no
downgrade/leapfrog hazard for the convention to prevent. **The convention's problem does not exist
for a Marketplace-less extension.**

### 1b. `vsce package --pre-release` — what it actually does, verified from source

Read `microsoft/vscode-vsce` source directly (`src/package.ts` on the `main` branch, fetched via
`raw.githubusercontent.com`, retrieved 2026-09-08):

- `--pre-release` (added in vsce 2.5, [commit dc4cf1b](https://github.com/microsoft/vscode-vsce/commit/dc4cf1b0c5fda2a7a8bc2d1ed4038a3a27b4baec)) does exactly one thing to the package: it writes
  ```xml
  <Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />
  ```
  into the `.vsixmanifest` XML inside the `.vsix` (`package.ts` line ~1555).
- It also requires `engines.vscode >= 1.63` (`package.ts` lines ~494–524) — pre-release support
  was added to VS Code in 1.63.
- That's it. No other file, no different bundling, no different code path.

That `PreRelease` XML property is read by exactly two consumers: the Marketplace's own gallery
service (to show the "Switch to Pre-Release Version" toggle on the extension's Marketplace page)
and VS Code's gallery-aware update client (to decide whether a user who opted into pre-releases
should get this version automatically). **A sideloaded `.vsix` is never evaluated by either of
those systems** — installing via "Install from VSIX" bypasses the gallery client entirely. So for
a GitHub-Releases-only `.vsix`, `--pre-release` sets a metadata bit nothing will ever read. It is
inert, not harmful, just meaningless in this distribution model.

Repo: [microsoft/vscode-vsce](https://github.com/microsoft/vscode-vsce)
File read: [`src/package.ts`](https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts) (lines ~160, 213, 405, 494–524, 562, 1555 inspected directly)

### 1c. Version string constraints — and a real gap between "package" and "publish"

Official doc text ([publishing-extension](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)):

> "We only support `major.minor.patch` for extension versions, `semver` pre-release tags are not
> supported."

This reads like a hard constraint of the tool. **It isn't — verified directly in vsce's source,
and the enforcement point matters:**

- `src/validation.ts`, `validateVersion()` (lines 35–45): validates `package.json`'s `version`
  with plain `semver.valid(version)` — this **accepts** full semver, prerelease tags included
  (e.g. `1.2.3-beta.1` passes). This check runs on every `vsce package`.
- `src/publish.ts` (lines 378–379) — this is where the real rejection lives, and it only runs
  during `vsce publish` (i.e., only when actually talking to the Marketplace API):
  ```js
  if (semver.prerelease(manifest.version)) {
    throw new Error(`The VS Marketplace doesn't support prerelease versions: '${manifest.version}'. ...`);
  }
  ```

**Consequence for this repo:** since claude-limit-buster will only ever run `vsce package`
(never `vsce publish`), the "no semver prerelease tags" rule literally never executes against it.
`vsce package` will happily build a `.vsix` for a version like `0.2.0-beta.1`. The restriction
Microsoft documents is a Marketplace API rule, not a `vsce`/`.vsix` format rule — and it doesn't
apply here.

On `0.x`: no special-cased handling found anywhere in `validation.ts` or `publish.ts` beyond the
generic semver validity check; `0.x.y` is treated like any other three-part version. (Standard
semver.org semantics — "anything may change" pre-1.0 — apply by convention only, not by tooling
enforcement.)

Source files fetched and grepped directly: [`src/validation.ts`](https://github.com/microsoft/vscode-vsce/blob/main/src/validation.ts), [`src/publish.ts`](https://github.com/microsoft/vscode-vsce/blob/main/src/publish.ts), [`src/package.ts`](https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts)

### 1d. CHANGELOG.md packaging — confirmed at the source level

`src/package.ts` defines a `ChangelogProcessor` (line ~1035) that:
- looks for `CHANGELOG.md` (or a configured `changelogPath`) at the extension root,
- copies it into the `.vsix` at `extension/changelog.md`,
- tags it with vsix-manifest asset type `Microsoft.VisualStudio.Services.Content.Changelog`.

This runs on **every** `vsce package` call — not gated on `vsce publish`, not gated on Marketplace
presence. See §4 for why this matters even for a sideloaded extension.

---

## 2. What real extensions actually do — 6 repos, read directly

| Repo | Profile | Trigger | Version decided by | Changelog | Tooling |
|---|---|---|---|---|---|
| [gitkraken/vscode-gitlens](https://github.com/gitkraken/vscode-gitlens) | Large/corporate (GitKraken) | git tag push (`v*.*.*` or `releases/ext/v*.*.*`) for stable; daily cron + manual dispatch for pre-release | Hand-edited `package.json`, verified against the tag in CI | `CHANGELOG.md` is the source of truth — injected into the GitHub Release body via `mindsers/changelog-reader-action` | Hand-rolled YAML |
| [prettier/prettier-vscode](https://github.com/prettier/prettier-vscode) | Mid-size, multi-maintainer (Prettier org) | git tag push (`v*`) | Tag itself; prerelease-ness detected from tag *suffix* (`-preview\|-beta\|-alpha\|-rc`), not from minor parity | `gh release create --generate-notes` (auto from commits/PRs) + a manual link appended to `CHANGELOG.md` | Hand-rolled YAML |
| [microsoft/vscode-eslint](https://github.com/microsoft/vscode-eslint) | Microsoft official | Push to `main` (stable) / manual dispatch (pre-release) | Centralized shared pipeline template (`microsoft/vscode-engineering`), not per-repo logic | Not visible in the pipeline YAML itself (handled by the shared template) | **Azure Pipelines**, not GitHub Actions — extends a shared corporate template repo, separate tag prefixes `release/` vs `pre-release/` |
| [coder/vscode-coder](https://github.com/coder/vscode-coder) | Corporate (Coder) — note: *is* on the Marketplace, included for contrast | git tag push, distinguished by **suffix**: `v1.2.3` (stable) vs `v1.2.3-pre` (pre-release) | Tag must exactly match `package.json` version (CI hard-fails otherwise); **same numeric version used on both channels** — no odd/even parity at all | Not shown in these workflows | Hand-rolled YAML; `--pre-release` flag added only for the `-pre`-tagged build |
| [usernamehw/vscode-error-lens](https://github.com/usernamehw/vscode-error-lens) | **Single maintainer** | None — confirmed via GitHub API that the repo has **no `.github/` directory at all** (404 on `contents/.github`) | Maintainer bumps `package.json` and runs `vsce publish` locally, by hand | Maintained by hand in `CHANGELOG.md` | **No CI/CD.** Fully manual. |
| [Gruntfuggly/todo-tree](https://github.com/Gruntfuggly/todo-tree) | **Single maintainer** | Same — confirmed **no `.github/` directory** via GitHub API (404) | Manual | Manual `CHANGELOG.md` | **No CI/CD.** Fully manual. |

Also checked: [continuedev/continue](https://github.com/continuedev/continue) (VC-funded, monorepo,
now archived/read-only) — per its [CONTRIBUTING.md](https://github.com/continuedev/continue/blob/main/CONTRIBUTING.md),
pushing a tag like `v1.3.x-vscode` triggers a `preview.yaml` workflow (pre-release build), and
`v1.2.x-vscode` triggers `main.yaml` (stable) — odd minor happens to map to preview here, but the
channel selection is driven by the tag/workflow split, not by any programmatic parity check.

**None of the six real, currently-relevant repos I could read enforce the odd/even-minor rule
programmatically.** Every one of them separates channels via git-tag namespace, tag suffix, or a
separate branch/cron schedule, then applies `vsce package --pre-release` (or not) based on that —
the parity convention is treated as optional decoration on top of an explicit channel signal, not
load-bearing. GitLens's own `package.json` version and Coder's explicitly reuse the *same* base
number across channels, which is the literal opposite of parity.

**None used release-please, changesets, or semantic-release.** The two multi-person / corporate
repos (GitLens, prettier-vscode) hand-roll GitHub Actions YAML with manual version bumps validated
against the pushed tag. Microsoft's own extension uses a shared internal Azure Pipelines template
(`microsoft/vscode-engineering`) rather than either GitHub Actions or a generic release tool. The
single-maintainer extensions (Error Lens, Todo Tree) run **no CI at all** — versioning and
publishing is a manual local `vsce publish` by the author.

A generic tool does exist — [felipecrs/semantic-release-vsce](https://github.com/felipecrs/semantic-release-vsce)
(a `semantic-release` plugin that packages/publishes via `vsce`) — but it has only 41 GitHub stars
at time of writing, i.e. real-world adoption for this niche is low; conventional-commit-driven
automatic versioning is not how the extensions people actually use get released.

---

## 3. The `.vsix`-on-GitHub-Releases pattern specifically

**There is no established, widely-followed convention here — it's genuinely ad hoc.** Evidence:

- Even inside Microsoft, extensions disagree: [microsoft/vscode-python#19256](https://github.com/microsoft/vscode-python/issues/19256)
  is a user asking the Python extension to attach `.vsix` files to GitHub Releases (closed
  **"not planned"**), while other Microsoft extensions do attach them. There is no house style.
- [GitLab's own VS Code extension](https://gitlab.com/gitlab-org/gitlab-vscode-extension/-/issues/1251)
  had an open issue asking to publish the `.vsix` as a release asset — i.e., a company shipping a
  real product extension didn't have this wired up either and had to be asked for it.
- [LeetCode-OpenSource/vscode-leetcode#769](https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/769):
  a concrete example of an extension kept off the Marketplace for a *reason* (Microsoft's
  Marketplace Terms of Service block non-Microsoft VS Code distributions — VSCodium, code-server —
  from accessing it), with Open VSX proposed as the fallback rather than GitHub Releases alone.
- A small cottage industry of third-party tools exists purely to fill the gap left by "no
  Marketplace = no discovery, no update channel":
  - [zokugun/vscode-vsix-manager](https://github.com/zokugun/vscode-vsix-manager) — lets a user
    declare `github:<owner>/<repo>` as an extension source in their own settings and pulls
    `.vsix` releases from GitHub/Forgejo. Confirms there's no built-in naming convention for the
    `.vsix` asset — the tool just grabs "the vsix" from the release, optionally by `@version`.
  - [SanderRonde/vscode-auto-update](https://github.com/SanderRonde/vscode-auto-update) — a
    library explicitly billed as "for a self-updating extension **that is not in the store**."
  - [jan-dolejsi/vscode-extension-updater](https://github.com/jan-dolejsi/vscode-extension-updater) —
    "custom extension updater for private extension marketplaces."
  - [z-juln/update-vscode-extension](https://github.com/z-juln/update-vscode-extension) and
    [ryu1kn/vscode-extension-update-reporter](https://github.com/ryu1kn/vscode-extension-update-reporter) — same problem, different small libraries.

  The existence of ~4 independent, small, low-adoption libraries all solving "notify the user an
  update exists for my non-Marketplace extension" is itself the finding: **VS Code has zero
  built-in mechanism for this, and no single library has become the standard answer.**

**Install instructions**: universally hand-written prose in the README — "go to Releases, download
the `.vsix` from Assets, open the Extensions view → `...` menu → Install from VSIX." This is
consistent across every source found (see e.g. the general guidance summarized at
[SAS's install-extensions-offline walkthrough](https://blogs.sas.com/content/sgf/2025/03/07/install-vs-code-extensions-offline/) and the same steps described independently by multiple other sources). No repo I found does anything fancier (no install script, no `curl | vsix-install` convention).

---

## 4. CHANGELOG.md still matters for a manually-installed `.vsix`

Confirmed two independent ways:

1. **Packaging-level, from vsce source** (§1d above): `vsce package` bundles `CHANGELOG.md` into
   the `.vsix` on every run, unconditionally — this is not a Marketplace-only step.
2. **Client-level, from official docs**: [Extension Marketplace docs](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)
   describe VS Code's Extension Editor as having a **Changelog** tab whose content is "the
   extension repository CHANGELOG if available." This is a client-side view of files inside the
   *installed* extension — it works for any installed extension regardless of install source,
   because VS Code is just rendering a file that shipped inside the `.vsix`, not fetching
   anything from a gallery.

So: skipping `CHANGELOG.md` doesn't just lose you Marketplace polish (which doesn't apply here
anyway) — it removes the one piece of in-editor "what changed" surface a user gets for a
manually-installed extension with no other update signal (see §3). Worth keeping even at minimal
effort (one bullet list per version) precisely because there's no Marketplace page to compensate.

---

## 5. The auto-update trap — the one thing a generic Node/npm release setup would completely miss

This is VS Code-specific and easy to get backwards if you reason from "GitHub Releases + a tag"
experience with ordinary CLI tools or libraries:

- Official docs, confirmed via direct fetch of [code.visualstudio.com/docs/configure/extensions/extension-marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace):
  > "When you install an extension via VSIX, auto update for that extension is disabled by
  > default."
- This was previously buggy in the other direction — see [microsoft/vscode#156693](https://github.com/microsoft/vscode/issues/156693)
  ("Extensions installed from `--install-extension` with a pinned version or `.vsix` file auto
  update") and [microsoft/vscode#219932](https://github.com/microsoft/vscode/issues/219932) ("Do
  not enable auto update when installing an extension via VSIX") — VS Code itself had to fix this
  because sideloaded/pinned installs were unexpectedly being silently overwritten. Current
  behavior (documented, and per the issue thread, effective from VS Code 1.92) is: **no
  auto-update for VSIX-installed extensions, period.**
- More fundamentally for this repo: VS Code's update engine only ever asks the **gallery service**
  (Marketplace, or Open VSX if configured) "what's the latest version of `publisher.name`?" A
  `.vsix` sideloaded from a repo that has never published anything to any gallery has **no
  identifier for VS Code to even check** — there is nothing to compare against, so "Show Outdated
  Extensions" / `@updates` / "Update All Extensions" will never surface this extension, ever, no
  matter what `extensions.autoUpdate` is set to.

**The trap**: a maintainer coming from ordinary software-release habits (tag → build → GitHub
Release → users `npm update`/`brew upgrade`/download-and-overwrite) will assume "user downloads
newer `.vsix`, installs it, done" behaves like a normal upgrade. It does — installing a newer
`.vsix` over an older sideloaded one does update the extension — but **nothing tells the user a
newer one exists.** There's no push, no badge, no `@updates` entry, nothing. This is the single
biggest structural gap a Marketplace listing would have silently closed (the Marketplace update
engine and the "Show Outdated Extensions" UI) and it has to be replaced by hand: a README note to
watch/star the repo, a GitHub "Watch → Releases only" callout, an in-app version-check against the
GitHub Releases API (per §3's small-library ecosystem), or simply accepting that updates are
opt-in-only and documenting that explicitly.

---

## Answers to the four things asked for

**1. Should the odd-minor pre-release convention be adopted here?**
No. It solves exactly one problem — the Marketplace/gallery update engine picking "numerically
highest" as "latest" across two channels it doesn't otherwise distinguish — and that problem is
structurally absent when there's no Marketplace listing and no gallery-mediated auto-update at
all (§1a, §5). Every real repo surveyed that does run a genuine pre-release channel (GitLens,
Coder, Continue) separates channels via git-tag namespace/suffix or branch, not via numeric
parity, and two of them (Coder, GitLens) reuse the *same* version number across the pre-release
and stable build of a given release rather than shifting the minor. Standard semver (`major.minor.patch`,
optionally with prerelease/build metadata, which `vsce package` — as opposed to `vsce publish` —
does not reject; §1c) is the better fit: it's what git tags, GitHub Releases, and any future
tooling (changesets, semantic-release, or just `git describe`) already expect, and nothing here
needs the parity hack's specific guarantee.

**2. What does the modal single-maintainer setup look like?**
Two real single-maintainer extensions read directly (Error Lens, Todo Tree) run **zero CI/CD** —
no `.github/workflows` directory exists in either repo (confirmed via GitHub API, not just a
missing search hit). The maintainer bumps `package.json` by hand, edits `CHANGELOG.md` by hand,
runs `vsce package`/`vsce publish` locally, and (for Marketplace extensions) that's the whole
pipeline. For a repo that also wants a GitHub Release artifact, the smallest step up from that
baseline — seen in every corporate example too, just wrapped in more YAML — is: push a tag
matching `package.json`'s version → one CI job builds with `vsce package` → attaches the `.vsix`
to a `gh release create`/`softprops/action-gh-release` step, with the tag-vs-manifest version
match enforced as a hard CI failure (both GitLens's and Coder's workflows do this exact check
explicitly, e.g. [cd-stable.yml](https://github.com/gitkraken/vscode-gitlens/blob/main/.github/workflows/cd-stable.yml), [release.yaml](https://github.com/coder/vscode-coder/blob/main/.github/workflows/release.yaml)). No corporate or hobby repo I read reaches for changesets/release-please/semantic-release for the actual version decision.

**3. What does the maintainer have to do by hand that a Marketplace listing would otherwise do?**
- Update notification: entirely absent by default (§5) — no equivalent of "Show Outdated
  Extensions," no auto-update, no badge. This is the standout gap; several tiny third-party
  libraries exist purely to patch it (§3), none dominant.
- Discovery/install instructions: hand-written README prose is the universal norm (§3) — there is
  no tooling convention to lean on, just "go to Releases → Assets → download → Install from VSIX."
- The in-editor Changelog tab still works from a bundled `CHANGELOG.md` (§4) — that one *is*
  free, since `vsce package` bundles it regardless of publish target; skipping the file is a
  choice, not a forced simplification.
- Version-authenticity signal: with no Marketplace page, the git tag + GitHub Release + attached
  `.vsix` *is* the only version-of-record; every real workflow read enforces tag-equals-manifest-version
  in CI specifically because that's now the sole source of truth (no Marketplace validation layer
  to catch a mismatch after the fact).

**4. Any VS Code-specific trap a generic Node release setup would miss?**
Yes, exactly the auto-update trap in §5: assuming "publish new version → users get it" the way an
npm package or a self-updating CLI would. VS Code's entire update mechanism is gallery-mediated;
a `.vsix` with no gallery presence gets none of it, silently, forever — and this is very easy not
to notice while testing locally, since a manual "Install from VSIX" of a newer file works fine and
gives no sense that automatic delivery is categorically absent for anyone who doesn't repeat that
manual step themselves.

---

## Sources index (every URL fetched/grepped during this research)

Official docs:
- https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions
- https://code.visualstudio.com/api/references/extension-manifest
- https://code.visualstudio.com/docs/configure/extensions/extension-marketplace

vsce source (microsoft/vscode-vsce, `main` branch, fetched raw + grepped):
- https://github.com/microsoft/vscode-vsce
- https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts
- https://github.com/microsoft/vscode-vsce/blob/main/src/validation.ts
- https://github.com/microsoft/vscode-vsce/blob/main/src/publish.ts
- https://github.com/microsoft/vscode-vsce/commit/dc4cf1b0c5fda2a7a8bc2d1ed4038a3a27b4baec

Real extension workflows read directly:
- https://github.com/gitkraken/vscode-gitlens/blob/main/.github/workflows/cd-pre.yml
- https://github.com/gitkraken/vscode-gitlens/blob/main/.github/workflows/cd-stable.yml
- https://github.com/gitkraken/vscode-gitlens/blob/main/.github/workflows/cd-core.yml
- https://github.com/prettier/prettier-vscode/blob/main/.github/workflows/main.yaml
- https://github.com/prettier/prettier-vscode/blob/main/.github/workflows/publish-legacy.yaml
- https://github.com/microsoft/vscode-eslint/blob/main/build/azure-pipelines/release.yml
- https://github.com/microsoft/vscode-eslint/blob/main/build/azure-pipelines/pre-release.yml
- https://github.com/coder/vscode-coder/blob/main/.github/workflows/release.yaml
- https://github.com/coder/vscode-coder/blob/main/.github/workflows/pre-release.yaml
- https://github.com/usernamehw/vscode-error-lens (confirmed no `.github/workflows` via GitHub API)
- https://github.com/Gruntfuggly/todo-tree (confirmed no `.github/workflows` via GitHub API)
- https://github.com/continuedev/continue/blob/main/CONTRIBUTING.md

Generic release tooling for VS Code extensions:
- https://github.com/felipecrs/semantic-release-vsce

The `.vsix`-on-GitHub-Releases pattern / update-notification gap:
- https://github.com/zokugun/vscode-vsix-manager
- https://github.com/SanderRonde/vscode-auto-update
- https://github.com/jan-dolejsi/vscode-extension-updater
- https://github.com/z-juln/update-vscode-extension
- https://github.com/ryu1kn/vscode-extension-update-reporter
- https://github.com/microsoft/vscode-python/issues/19256
- https://gitlab.com/gitlab-org/gitlab-vscode-extension/-/issues/1251
- https://github.com/LeetCode-OpenSource/vscode-leetcode/issues/769
- https://blogs.sas.com/content/sgf/2025/03/07/install-vs-code-extensions-offline/

Auto-update behavior for sideloaded extensions:
- https://github.com/microsoft/vscode/issues/156693
- https://github.com/microsoft/vscode/issues/219932
