# Changelog

VS Code renders this file in the extension's Changelog tab, including for an
extension installed from a `.vsix`. Since there is no Marketplace listing here,
this is the only in-editor account of what changed.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing has been released yet. `v0.1.0` is tagged to reserve the version, not to
mark a release — the extension has not yet been run in a real Extension
Development Host. Everything below ships in the first published version.

### Added

- Watches Claude Code transcripts for usage-limit notices and server errors,
  waits out the cooldown, and resumes the session by id.
- Resumes into a new terminal whose shell process is `claude` itself, with the
  prompt passed as an argument. No shell parses it, and no existing terminal is
  ever written to.
- Resolves the session from the transcript that produced the detection, so a
  resume can never pair one project's session with another project's prompt.
- Estimates the token cost of a resume before scheduling it and refuses when it
  exceeds `claudeLimitBuster.maxResumeTokens`. A limit wait guarantees a cold
  cache, so a resume reprocesses the whole session.
- Counts down against wall-clock on a one-second tick, so a cooldown survives
  sleep and a window reload, and pads the deadline with random jitter.
- Status-bar countdown, an optional chime when a turn in this workspace ends,
  and `Resume Now` / `Cancel Pending Resume` / `Show Log` commands.
- Settings under `claudeLimitBuster.*`. Everything that influences what gets
  executed is machine-scoped, so a workspace cannot set it.

### Development

- Integration tests run the extension inside a real VS Code
  (`npm run test:integration`), alongside the fast unit suite (`npm test`).

### Known limitations

- Two VS Code windows each run their own watcher and scheduler, so one limit can
  start two concurrent resumes of the same session. See `docs/NEXT.md`.
- Headless resume is declared in settings but not routed; it currently falls
  through to the interactive path and says so in the log.
- Nothing notifies you that a newer version exists ([#1]). VS Code disables
  auto-update for a `.vsix` install and its update check only queries a gallery.

[#1]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/1
