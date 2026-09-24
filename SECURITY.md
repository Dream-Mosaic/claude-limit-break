# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
**[Report a vulnerability](https://github.com/Dream-Mosaic/claude-limit-break/security/advisories/new)**
(the repository's Security tab → "Report a vulnerability").

Please do not open a public issue for a vulnerability. You can expect an acknowledgement within a week.

## Scope

The extension launches the Claude Code CLI on your machine and reads Claude Code's transcripts and settings under `~/.claude` and `~/.claude.json`. Reports of particular interest:
- anything that could make it launch a command other than `claude --resume <session-id>`, or pass it attacker-controlled arguments;
- anything that could make it write to Claude Code's configuration, or answer Claude Code's folder-trust prompt on your behalf; it is designed never to do either.

## Supported versions

Only the latest release receives fixes.
