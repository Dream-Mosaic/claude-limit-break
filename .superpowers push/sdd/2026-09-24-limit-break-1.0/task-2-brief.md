### Task 2: Never start a second writer on a live session

When a job fires, first find out who holds the session. Spawn a terminal only if nobody does.

- Extend `src/liveSessions.ts` with a pure classifier. From the `claude agents --json` rows (liveness) plus each vouched pid's record `~/.claude/sessions/<pid>.json` (for `entrypoint`, and `sessionId` must match), return one of:
  - `{ kind: 'none' }`
  - `{ kind: 'panel', pid }` (entrypoint `claude-vscode`)
  - `{ kind: 'terminal', pid }` (any other entrypoint, including `cli`)
  
  A panel wins over a terminal when both are present. Reuse `parseAgentRows` and `otherLivePids`. Keep the existing `livePanelDetector` behaviour for `handleStalePanel` working.
- Native auto-continue. Add `src/autoContinue.ts` with `autoContinueEnabled(cwd, platform, readFile)`. Claude Code's terminal UI continues by itself at a reset unless `autoContinueAtUsageLimit` is `false`; its default is ON when the key is absent (read from claude.exe 2.1.281: `setting ?? (autoContinueKeyPresence === "absent")`). Read these layers in precedence order, highest first:
  1. managed settings (win32 `C:\Program Files\ClaudeCode\managed-settings.json`; darwin `/Library/Application Support/ClaudeCode/managed-settings.json`; linux `/etc/claude-code/managed-settings.json`);
  2. `<cwd>/.claude/settings.local.json`;
  3. `<cwd>/.claude/settings.json`;
  4. `<CLAUDE_CONFIG_DIR || ~/.claude>/settings.json`.
  
  The first layer that sets the key as a boolean decides. Unreadable or malformed files are skipped. Inject the reader so tests never touch real files.
- In `src/extension.ts` `scheduler.onFire`, with `autoResume` on, before `resume(job)`, classify the holder:
  - `panel`: do NOT spawn. `rememberReady(job)`. Log it. Show an information message saying the limit has reset and the session is open in a Claude panel, so continue it there, with one button, `Resume in Terminal Anyway`. That button claims the job with `forgetReady` exactly as the existing Resume Now notification does, then calls `resume(job)`.
  - `terminal` and `autoContinueEnabled(job.cwd)`: do NOT spawn and do NOT remember it. Log that Claude Code will continue the session by itself.
  - `terminal` and auto-continue off: same as `panel`, but the message says a terminal.
  - `none`: also check whether a DIFFERENT live session (by `claude agents --json` row `sessionId`) is `status: "busy"` in the same folder (normalize with `normalizeProjectPath` from `src/trust.ts`). If so, same treatment as `panel`, with a message naming that the folder has another active Claude session. Otherwise resume as today.
- Manual Resume Now (the command and the notification button) with a live holder: ask with a modal warning that names the holder and says a resume here forks the conversation, with a `Resume Anyway` button. No holder: unchanged.
- The listing call is `execFileSync` with a 10 s timeout (reuse the `detectLivePanel` runner). A listing failure means "unknown", and it resumes as today and logs that, because failing closed would silently stop every resume on a machine where `claude agents` misbehaves.
- `AgentRow` must also carry `cwd` and `status` (optional strings) for the busy-folder check.


Addendum (controller ruling, 2026-09-24): Claude Code web, via Remote Control, auto-continues a bridged panel session at the reset. A bridged session is one whose `~/.claude/sessions/<pid>.json` has a non-empty `bridgeSessionId`. The classifier's `panel` result should carry `bridged: boolean`. For a bridged panel, the notification adds that Remote Control may continue the session on its own. Behaviour is otherwise unchanged: never spawn.

## CORRECTION (controller, 2026-09-24, from the user). Supersedes the panel rules above.
The holder's `status` decides:
- none: resume.
- idle panel: RESUME. The existing onStale (notify|reopen) path runs after the resume.
- busy or waiting panel: no spawn; log it and drop the job (someone is already continuing it, by hand or through Remote Control).
- busy or waiting terminal: no spawn; log it and drop the job.
- idle terminal with auto-continue ON: no spawn; log it and drop the job.
- idle terminal with auto-continue OFF: notify with "Resume in Terminal Anyway" and rememberReady.
- A different session busy in the same folder: notify with "Resume Anyway".
- Manual Resume Now shows the modal warning only for a busy or waiting holder, or a terminal holder.
- (User ruling, 2026-09-24) A different session busy or waiting in the same folder: RESUME, and append a coordination sentence to the resume prompt naming the busy session(s) by `name` (pid as fallback): "Another Claude session is working in this folder: <names>. Before editing anything, message it with SendMessage to coordinate who does what." Also log it and show a non-blocking info message. Implement it as a pure buildResumePrompt(userPrompt, busyPeers); with no peers the prompt is unchanged.
