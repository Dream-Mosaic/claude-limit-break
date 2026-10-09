# Field observations, September 2026

These observations come from running Claude Limit Buster 0.1.x and Limit Break
during their own development. Each one bears on how the extension behaves. They
were recorded at the time in session notes, and are kept here so the reasoning
lives in the repo.

## Who else continues a session at a reset

**Claude Code's terminal UI continues by itself, from v2.1.234.**
- The setting is `autoContinueAtUsageLimit`, on by default, shown in `/config`
  as "Continue automatically at usage limit". It was confirmed on for this
  account on 2026-09-30.
- It re-arms at most twice, and ends if you type, exit or `/resume`.
- It isn't offered for `-p` runs, background sessions, API keys, or resets more
  than 24 h away.
- Desktop has its own checkbox, "Auto-continue when limits reset".
- So for `entrypoint: cli` sessions, including Limit Break's own resume
  terminals, a Limit Break resume would be a second writer.
  `src/autoContinue.ts` holds the stand-down.

**The VS Code panel does not, as of extension 2.1.281** (checked 2026-09-23).
The panel runs the bundled binary in stream-json SDK mode. The auto-continue
logic lives in the terminal UI host, and the webview has no auto-continue code.
No panel observed that day continued on its own. To recheck after an extension
update, grep the extension's `webview/index.js` for `autoContinue`.

**Remote Control is a third continuer.** When a panel session is driven from
Claude Code web through Remote Control, the web client sends this into the panel
at the reset:

> I hit my usage limit while you were working, but it has reset now. Please
> continue from where you left off.

It was seen twice, both confirmed by the user as the web client:
- 2026-09-24T02:11Z;
- 2026-09-30T23:01:32Z, 90 s after a 6 pm session-limit reset.

Both entries carry `entrypoint: claude-vscode` and `promptSource: sdk`. In the
second, the panel's `~/.claude/sessions/<pid>.json` had a `bridgeSessionId`.

Those fields can't tell a Remote Control continue from a prompt typed into the
panel, because both run through the panel's SDK mode. Only the timing, the
wording, or the user's word separate them. Whether the web client always does
this, or only while its tab is open, is undetermined.

## Why the default resume prompt is neutral

The 1.0 default, chosen on 2026-09-30 (9ff6ca0), is:

> [Limit Break] Your session was interrupted and has been resumed automatically.
> Please continue from where you left off.

It's the same text for limits and for overloads. It replaced
`[Limit Break] I hit my usage limit while you were working, but it has reset now. …`,
for three reasons:
- **The old text is false for an overload.**
- **It nearly matches the Remote Control text above,** so it couldn't identify a
  Limit Break resume.
- **The model can't check the reason.** A resumed model never sees Claude Code's
  error entry, so the prompt is its only clue, and a wrong reason plants a false
  premise.

The user also judged that elapsed time and a reason sentence don't reliably
change what the agent does. "Resumed automatically" says what happened.

## Incidents and what they taught

**Four writers on one repo (2026-09-23).** This repo had two VS Code panel
processes, plus two terminals that 0.1.2 itself had launched at a reset, each
running `claude.exe --resume <id> "Continue where you left off."` under
`Code.exe`. Both sessions were still open in panels, which is the [#6]
situation. The resume terminals worked unattended for 34 and 28 turns,
including edits. One panel session was working from a picture of the repo hours
out of date. A resumed session has no way to know that another process has
moved the same conversation or working tree forward.

**Idle is not inert (2026-09-24).**
1. A resume in another project found port 3001 busy and killed the listener.
2. That listener was the idle panel's own background dev server.
3. The server's task failure arrived in the panel as a task notification, which
   started a new turn.
4. The panel then ran builds and e2e suites against the same worktree and
   database as the resume.

A session listed as idle can wake whenever one of its background jobs ends.

**Uninstalling doesn't stop a running extension (2026-09-30).** 0.1.2 fired
twice after `code --uninstall-extension`, from windows that were never
reloaded. After an uninstall, reload every VS Code window.

**A background agent dies with the terminal that started it (2026-09-30).** A
resume terminal launched an implementer subagent, and closing that terminal
killed the agent mid-task. A resume session shouldn't launch background agents.
That's for the panel that owns the conversation.

[#6]: https://github.com/Dream-Mosaic/claude-limit-break/issues/6
