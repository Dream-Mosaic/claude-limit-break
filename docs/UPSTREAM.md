# Upstream source and the changes to make

## Where the source is

This project incorporates code from **Claude Timeout Resume v0.3.0** by BarPopko
(MIT). It is not a fork in the git sense — upstream publishes no repository, only
a `.vsix` on the Marketplace.

The `.vsix` was downloaded from the Marketplace and extracted to:

```
<your-download-dir>\BarPopko.claude-timeout-resume_0.3.0\
```

> **This path is outside the repo and not guaranteed to persist.** Re-download
> from the Marketplace listing (Resources → Download Extension), rename `.vsix`
> to `.zip`, and extract if it is gone.

The publisher's linked repo (`github.com/BarPupko/VSExtnstion-Claude-TimeOUT`)
returns **404**, so the compiled `out/*.js` is the only available source. It is
compiled TypeScript with comments intact — readable, but no `.ts`, no
`tsconfig.json`, and no sourcemaps despite `sourceMappingURL` comments.
Reconstructing TypeScript is part of the implementation work.

Layout: `extension/out/*.js` (16 modules), `extension/package.json`,
`extension/DOCS.md` (the real reference — 15KB, more detailed than the README).

## What to carry unchanged

| Module | Why |
|---|---|
| `transcriptWatcher.js` | Offset tracking, partial-line safety, poll backstop. Sound. |
| `limitParser.js` rules + time resolution | Epoch/ISO/named-timezone/offset/duration parsing. Scored well; the hard part. |
| `overloadParser.js` rules | Negative set is perfect, including `429`-routes-to-limit-parser. |
| `inputParser.js` | 13/13. `tool_use` vs `end_turn`, sidechain suppression, echo filter. |
| `scheduler.js` | Wall-clock ticks; survives sleep and restart. |
| `randomDelay.js` | Trivial and correct. |

## What to change — with citations

All line numbers refer to `extension/out/` in the extracted v0.3.0.

### 1. Move the source-code guard inside `detectLimit`

`looksLikeCode` is defined at `limitParser.js:308`. It is applied:

- **Inside** the parser for overloads — `overloadParser.js:109`, so every caller
  of `detectOverload` inherits it.
- **Outside** the parser for limits — `transcriptWatcher.js:273`, in one caller
  only.

So `detectLimitInLines` (`limitParser.js:323`), the terminal detection path, has
**no guard at all**. Verified: `cat`-ing a doc line or a matching git commit
message arms a resume timer.

**Fix:** apply the guard inside `detectLimit`, mirroring `detectOverload`.

### 2. Gate the limit path on entry type

`transcriptWatcher.js:285` gates the *overload* scan:

```js
if (apiError || entry.type !== 'user') {
```

with the author's own comment: *"the user pasting an error into the chat — or
asking about one — must never kick off an automatic retry."*

The limit scan has no equivalent. Verified against the real `inspectLine`: 4 of 6
ordinary user questions armed a timer, e.g. *"my usage limit resets at 3pm
right?"*

**Fix:** apply the same gate to the limit path.

### 3. Populate two gate lists

Both formats are documented in upstream's `DOCS.md` and both fail, because a
cheap pre-gate rejects the string before the working rule runs.

- `LIMIT_HINTS` (`limitParser.js:47`) has no pattern for bare *"your limit"*, so
  `Your limit will reset at 14:00 (UTC)` misses. Adding `usage` makes it pass.
- `ERROR_MARKERS` (`overloadParser.js:25`) rejects bare `socket hang up`, even
  though the connection-error rule literally contains that string. Node prints
  exactly that, so the documented case is the failing one. `Error: socket hang
  up` works.

## What to drop

- **`resumer.js` entirely.** `sendText` into an existing terminal, plus
  `quoteForShell` (`resumer.js:43-49`) which leaves PowerShell subexpressions
  live — verified: `$(1+41)` evaluates to `42`.
- **`overloadRecovery.js` execution layer.** Same reasons; keep the backoff
  *policy* ideas, not the delivery.
- **`soundCommand`** — read at `config.js:61`, executed at `sound.js:56-65` via
  `powershell.exe -Command`. Undeclared in `package.json`, so workspace-settable
  with no `scope: machine`.
- **`lastPrompt.js` cross-project fallback** — `findLatestTranscript` falls back
  to the newest `.jsonl` anywhere under `~/.claude/projects/`. Session ID from
  the detection's own file replaces this entirely.

## Attribution

Handled entirely at the repository root: `LICENSE` covers this project's code,
`THIRDPARTY.md` carries upstream's verbatim notice. No per-file headers — the
notice travels with the distribution, which is what MIT requires.

The one hard constraint is that both files must ship **inside the `.vsix`**, not
just in the repo. See the packaging gate in [NEXT.md](NEXT.md).

## Also worth reading

`extension/DOCS.md` lists the recognized limit and overload formats upstream
claims to support. That list is what the test corpus was built from, and two of
its claims are false (see change 3).
