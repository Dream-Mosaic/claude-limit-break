# Next steps

State as of the initial commits. Read
[design](design/2026-09-01-design.md) and [UPSTREAM.md](UPSTREAM.md) first.

## Settled

- **Copyright holder:** Dream Mosaic LLC.
- **Attribution:** root `LICENSE` for this project, `THIRDPARTY.md` for
  upstream's verbatim notice. No per-file headers.
- **Packaging gate:** both files must ship inside the `.vsix`, not merely in
  the repo — keep them out of `.vscodeignore` and assert it in CI with
  `unzip -l *.vsix | grep -E "LICENSE|THIRDPARTY"`. This is the one
  attribution detail that can silently break at release time.
- **Public repo, no Marketplace listing**, `.vsix` attached to releases.

## Verification still outstanding

**Does the panel render a CLI-advanced session on reload?** The docs say the
extension and CLI share conversation history, and a CLI resume of a panel session
was verified to carry full context. What is *not* verified is whether the panel
displays that turn after reload.

A first attempt used `--fork-session` to protect the live transcript, which
guaranteed failure: forks lack the `bridge-session` entries the panel's session
list keys on, so the fork was never listed. The valid test needs an **in-place**
resume of a **panel-created** session:

1. Open a new Claude Code tab, send a prompt with a marker word.
2. Find its transcript (newest `.jsonl` containing `"type":"bridge-session"`).
3. From a terminal: `claude -p --resume <id> "what was the marker word?"`
4. Reopen that tab from Session history; check whether the CLI turn appears.

If it doesn't render, the design needs a "reload the panel after resume" step.

### Outstanding manual verification

Task 14 (resume policy and extension wiring) is committed, but the extension
has never been activated in a real Extension Development Host — `npm test`
cannot exercise `activate()`, and driving a GUI window is outside what an
automated session can do. Nobody has confirmed it actually runs. The task
brief's Step 6 is preserved here verbatim so whoever runs it does not have to
reconstruct it:

1. Press `F5`. Confirm the Output panel shows `Claude Limit Buster active.`
2. Run `Claude Limit Buster: Show Log` from the command palette.
3. In a terminal in that host window, append a synthetic limit line to a real
   transcript and confirm a notification and a status-bar countdown appear:
   ```bash
   ID=$(basename "$(ls -t ~/.claude/projects/*/*.jsonl | head -1)" .jsonl)
   printf '%s\n' '{"type":"assistant","isApiErrorMessage":true,"cwd":"'"$PWD"'","message":{"content":"Claude AI usage limit reached. Try again in 5 minutes"}}' \
     >> ~/.claude/projects/*/"$ID".jsonl
   ```
4. Run `Claude Limit Buster: Resume Now`. A **new** terminal must open,
   running `claude`, with no text typed into any existing terminal.
5. **This is the same "Does the panel render a CLI-advanced session on
   reload?" question above.** If the session in step 3 was created in the
   Claude Code panel, reopen it from Session history and check whether the
   resumed turn is rendered. Record the answer in the section above. If it
   does not render, this task gains a follow-up: prompt the user to reload
   the panel after a resume.

## Spike results worth not re-deriving

Verified during design. Commands assume `CLAUDE_CODE_*` env vars are cleared —
a nested `claude` inherits `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, and IPC socket
vars that will skew results:

```bash
UNSET=$(env | grep -o '^CLAUDE[^=]*' | sed 's/^/-u /' | tr '\n' ' ')
env $UNSET claude -p --resume <id> "prompt" --output-format json
```

| Question | Answer |
|---|---|
| Session ID discoverable? | **Yes** — transcript filename *is* the `sessionId` |
| Headless resume carries context? | **Yes** — verified across a panel-created session |
| Does resume fork? | **No** — same ID, appends to the same `.jsonl` |
| Does headless inherit permission mode? | **No** — an `acceptEdits` session resumed with `-p` was denied `Write` |
| Does `--permission-mode acceptEdits` work? | **Yes** |
| Does interactive terminal resume do tool work? | **Yes** — at the user's normal autonomy, no flag needed |
| Does headless hang on denial? | **No** — clean exit, structured `permission_denials` |

Cost of a cold resume: **1,618,394 bytes → 288,574 cache-creation tokens**
(~$2.89 list equivalent). This is the basis for the `bytes / 5.6` estimate and
needs more data points.

## Spike sessions left on disk

Not cleaned up. Delete when done:

- `8dd2b36d-cc84-4b0b-9a77-15955eef9698` — headless baseline
- `a9c386a5-3d6e-4728-a5a3-f4f3f92b98a8` — permission-inheritance test
- `bed357a1-5197-4e8b-9866-85f31ecf6340` — fork of the design conversation

First two under
`~/.claude/projects/<temp-scratch-project>/`,
the third under the design conversation's project directory.

## Then

Execute [the implementation plan](superpowers/plans/2026-09-02-claude-limit-buster.md):
15 tasks, TypeScript reconstruction first, the three parser fixes with the
corpus as the gate, then `sessionResolver` / `budget` / `resumer`.

Task 14 (steps 1-5, 7) is done. Its step 6 — the manual smoke test that would
also answer the outstanding panel-rendering question above — is still open;
see "Outstanding manual verification" under Verification still outstanding.
