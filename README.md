# Claude Limit Buster

A VS Code extension that waits out Claude Code usage limits and resumes your
session — without typing into your terminal.

## What it does

When a Claude Code session stops — a usage limit, a `529`, a server error — it
notices, waits out the clock, and picks the session back up where it left off.

Detection reads Claude Code's own session transcripts rather than watching a
terminal, so it works whether Claude is running in the VS Code panel or in a
terminal, and whether or not the session was started from VS Code at all.

It also chimes when a Claude turn finishes in a folder open in this window, so
you can walk away from a long run and hear when it is your turn again.

## How it resumes

Recovery targets a session **by ID** and hands the prompt to a fresh terminal as
an argument:

```
claude --resume <session-id> "<prompt>"
```

Three consequences worth knowing:

- **Nothing is typed into an existing terminal.** No prompt text is ever sent to
  a shell that might be sitting at a command line.
- **The right session, every time.** The transcript filename *is* the session
  ID, and detection already knows which transcript the limit came from — so
  there is no "most recent session" guessing.
- **No autonomy is granted.** Resume runs at whatever permission level you
  already use. An unattended headless mode exists, but it is opt-in and
  machine-scoped so a workspace cannot enable it for you.

## Token budget

Recovery competes with the quota it is recovering. A usage-limit wait guarantees
a cold prompt cache, so resuming a large session reprocesses its whole history —
a measured resume of a 1.6 MB session cost 288,574 cache-creation tokens.

Spend is therefore estimated before resuming and capped, rather than retrying a
fixed number of times with no idea what each attempt costs.

## Install

There is no Marketplace listing and there is not intended to be one. Every
release attaches a built `.vsix`, so the quickest route is to download one from
the [Releases page](../../releases) and install it from the Extensions view —
the `...` menu, **Install from VSIX...**.

To build it yourself instead:

```bash
npm install
npx --yes @vscode/vsce package
```

That writes `claude-limit-buster-<version>.vsix` beside the manifest. Install it
from the Extensions view — the `...` menu, **Install from VSIX...** — or from a
terminal:

```bash
code --install-extension claude-limit-buster-<version>.vsix
```

## Versioning and releases

`package.json` holds the version and nothing derives it. Tags are `v<version>`
and only the release workflow creates them.

Merging to `main` runs that workflow. It compares the version against the
existing tags: if the tag already exists it does nothing, and if it does not it
runs the tests, packages, verifies the archive, and publishes a GitHub release
with the `.vsix` attached. Anything below `1.0.0` is marked pre-release. It
never publishes to the Marketplace.

So a release is one line in a pull request — the version bump — and it can be
its own pull request, after the changes it releases have already merged.

Nothing blocks a pull request for not bumping the version. Instead, when a merge
to `main` finds the version already tagged, the release workflow compares `src/`
against that tag and warns if it has moved on. That asks the question that
actually matters — has `main` drifted from the last release — rather than asking
each pull request to guess its own version bump before review has decided
whether it is a patch or a minor.

## Staying up to date

VS Code disables automatic updates for an extension installed from a `.vsix`,
and its update check only ever queries a marketplace — an extension that has
never been listed on one has no identity to check against, so **Show Outdated
Extensions** will never mention it. Nothing will tell you a new version exists.

Watch this repository for releases to find out: **Watch → Custom → Releases**.

## Development

```bash
npm install
npm test
```

The parser suites in [test/parsers](test/parsers), together with the
entry-level cases in
[test/transcriptWatcher.test.ts](test/transcriptWatcher.test.ts), are the
regression gate for detection. See [docs/UPSTREAM.md](docs/UPSTREAM.md) for how
detection is built and [docs/NEXT.md](docs/NEXT.md) for current state.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

This project incorporates MIT-licensed code from
[Claude Timeout Resume](https://marketplace.visualstudio.com/items?itemName=BarPopko.claude-timeout-resume)
by BarPopko. Its notice is in [THIRDPARTY.md](THIRDPARTY.md).
