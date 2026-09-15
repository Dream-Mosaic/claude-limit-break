# Next steps

State as of 2026-09-15, after the pre-release audit. Read
[design](design/2026-09-01-design.md) and [UPSTREAM.md](UPSTREAM.md) first.

## Settled

- **Copyright holder:** Dream Mosaic LLC.
- **Attribution:** root `LICENSE` for this project, `THIRDPARTY.md` for
  upstream's verbatim notice. No per-file headers.
- **Packaging gate:** both files must ship inside the `.vsix`, not merely in
  the repo — keep them out of `.vscodeignore`. `scripts/check-vsix.sh` asserts
  it in CI, along with `CHANGELOG.md` shipping and `.superpowers` not. This is
  the one attribution detail that can silently break at release time.
- **Public repo, no Marketplace listing**, `.vsix` attached to releases.

## Known limitations

**Two open windows can resume the same session twice.** Every VS Code window
runs its own `TranscriptWatcher`, and that watcher's root is the global
`~/.claude/projects` rather than the workspace, so both windows see the same
limit notice. Each window also runs its own `ResumeScheduler`, which reads
`globalState` once when it is constructed and then keeps the pending job in
memory. Nothing coordinates them: both schedule the cooldown, both fire it, and
one limit can launch two concurrent `claude --resume` runs against the same
session ID. The cost is a doubled resume — two terminals, two cold prompt
caches, roughly twice the tokens the budget check estimated for one.

This is not fixed in code, deliberately. Both candidate fixes turn on how VS
Code propagates a `Memento` write between windows, and that cannot be
established without a running Extension Development Host — the same thing
blocking the manual verification below. Shipping an unverifiable concurrency fix
is worse than stating the limitation. The candidates, for whoever can run one:

- **Re-read and stand down.** Have `tick()` read `globalState` again before
  firing, and abandon the job when the stored value is gone or no longer
  matches — so the window that did not clear the key does not also resume.
- **Claim the fire.** Write a claim (a window id and a timestamp) with a
  compare-and-set against the stored job, and resume only from the window whose
  claim stuck.

Either way the mechanism has to be measured first: whether a `Memento.update`
in one window is visible in another at all, and how soon.

## Verified

**Does the panel render a CLI-advanced session on reload? Yes — on a fresh
reopen.** Confirmed 2026-09-09 in an Extension Development Host. A panel-created
session was advanced by an interactive CLI resume; the new turn did not appear in
the tab that was open at the time, and did appear as soon as that tab was closed
and reopened from Session history.

The mechanism explains both halves. The extension opens a session by spawning the
CLI with `--resume=<id>` (visible in `extension.js` of Claude Code 2.1.267), so
the panel is not a separate store — it reads the same transcript from disk. An
already-open tab is a live process holding its own state and does not re-read;
a reopen starts a new `--resume`, which replays the file.

Two flags in the same argv builder, `--resume-session-at` and
`--resume-drops-turn`, were not investigated. Their defaults could in principle
affect what a reopen replays.

**What this means for the design.** The panel and this extension resume through
the identical code path, so there is nothing panel-specific to replicate. The
follow-up is a notification after a resume — "this session advanced in a
terminal; reopen the tab to see it" — not a reload mechanism. There is no
supported way to push that reload: Claude Code 2.1.267 contributes 26 commands,
none of which take a session id and none of which refresh a panel. See
`claude-vscode.reopenClosedSession` for the closest thing, and
https://github.com/anthropics/claude-code/issues/55959 for the upstream request.

A first attempt at this test used `--fork-session` to protect the live
transcript, which guaranteed failure: forks lack the `bridge-session` entries the
panel's session list keys on, so the fork was never listed. The valid test needs
an **in-place** resume of a **panel-created** session, and a **reopen** rather
than a look at the tab that is already open.

### Manual smoke test — run 2026-09-09

Run in a real Extension Development Host (`F5`; `.vscode/launch.json` compiles
and opens the second window with the extension loaded from `out/`). Nothing is
installed; closing the window is the cleanup. All five steps pass. It found four
bugs, filed as issues.

| Step | Result |
|---|---|
| 1. Output shows `Claude Limit Buster active.` | Pass. Watcher started on 177 transcripts |
| 2. `Claude Limit Buster: Show Log` | Pass |
| 3. Synthetic limit line → notification + countdown | Pass. Correct session, folder and reason in the tooltip |
| 4. `Resume Now` opens a **new** terminal running `claude` | Pass. Nothing typed into any existing terminal |
| 5. Panel renders the CLI-advanced turn | Pass **on reopen** — see "Verified" above |

Found while running it:

- [#2] the watcher root is the whole `~/.claude/projects` tree, not the workspace.
- [#3] clicking the status bar cancels the pending resume with no confirmation.
- [#4] a resume into a missing `cwd` fails silently, logs success, and loses the
  job. The log is unambiguous — `Pending resume cancelled.` at 01:54:38.393,
  `Resumed <id> in a new terminal.` at 01:54:38.431, for a terminal that never
  launched.
- [#5] an untrusted folder stops `claude` at its trust prompt, so an unattended
  resume stalls. On this machine 14 of 20 tracked projects were untrusted,
  including this repo — panel-created sessions do not appear to set the flag,
  and those are exactly the sessions this extension resumes.

To re-run step 3, append a synthetic limit line to a transcript. Use a
**panel-created** session other than the one you are working in, and take the
`cwd` from the file rather than typing it — a Windows path typed through a shell
loses its backslashes, and `	` becomes a tab:

```powershell
$t = Get-ChildItem "$env:USERPROFILE\.claude\projects\*\*.jsonl" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 20 |
  Where-Object { Select-String -Path $_.FullName -Pattern '"type":"bridge-session"' -Quiet } |
  Select-Object -First 1
$cwd = (Get-Content $t.FullName | ForEach-Object { try { (ConvertFrom-Json $_).cwd } catch {} } |
        Where-Object { $_ } | Select-Object -First 1)
$line = @{ type='assistant'; isApiErrorMessage=$true; cwd=$cwd
           message=@{ content='Claude AI usage limit reached. Try again in 5 minutes' } } |
        ConvertTo-Json -Compress -Depth 5
[System.IO.File]::AppendAllText($t.FullName, $line + "`n")
```

```bash
# bash equivalent
f=$(ls -t ~/.claude/projects/*/*.jsonl | head -20 | xargs grep -l '"type":"bridge-session"' | head -1)
node -e 'const fs=require("fs"),f=process.argv[1];
  const cwd=fs.readFileSync(f,"utf8").split("
").filter(Boolean)
    .map(l=>{try{return JSON.parse(l).cwd}catch{}}).find(Boolean);
  fs.appendFileSync(f,JSON.stringify({type:"assistant",isApiErrorMessage:true,cwd,
    message:{content:"Claude AI usage limit reached. Try again in 5 minutes"}})+"
")' "$f"
```

[#2]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/2
[#3]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/3
[#4]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/4
[#5]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/5

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
| Does a sequential resume fork? | **No** — same ID, appends to the same `.jsonl`. Two *live* processes can: see [#6] |
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

The implementation plan is done, the smoke test passes, and a pre-release audit
(2026-09-13) has been worked through. Fixed as a result: [#4] (a resume into a
missing folder), [#5] (the trust prompt), [#9] (an inherited session identity),
and a scheduler that held one pending resume for the whole machine, so that
when several sessions hit the account's limit together only one was resumed.

Open, roughly in priority order:

- [#6] a resume while the session is still live in a panel. The issue describes
  the one experiment that settles it; it needs someone at the keyboard. It
  gates [#7], whose branch also needs a rebase before merging.
- [#8] four small findings from reviewing the #4 and #5 fixes.
- [#11] a job waiting for Resume Now is lost on reload.
- [#10] a reset time with no zone resolves an hour off across a DST change.
- [#12] test gaps found by mutation testing, mostly in the limit parser.
- [#2], [#3], [#13], [#1].

[#6]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/6
[#7]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/7
[#8]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/8
[#9]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/9
[#10]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/10
[#11]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/11
[#12]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/12
[#13]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/13
[#1]: https://github.com/Dream-Mosaic/claude-limit-buster/issues/1
