# Parser corpus

These run against the **incorporated parsers as originally compiled**, to
establish the baseline our detection must not regress. They are the evidence
behind [../../docs/UPSTREAM.md](../../docs/UPSTREAM.md).

They are throwaway-quality harnesses promoted into the repo because the data in
them is the valuable part. Rewrite them properly once we have our own TypeScript
source; keep every case.

## Running

They need upstream's extracted `out/` directory:

```bash
UPSTREAM_OUT=/path/to/BarPopko.claude-timeout-resume_0.3.0/extension/out/ node test/corpus/parser-corpus.js
```

Without `UPSTREAM_OUT` they look in `./upstream/extension/out/`, so extracting
the `.vsix` to `upstream/` at the repo root also works. `upstream/` is
gitignored — the extension is not redistributed here.

See [../../docs/UPSTREAM.md](../../docs/UPSTREAM.md) for how to obtain it.

## The three harnesses

### `parser-corpus.js` — 63 cases, the main suite

Positives are drawn from upstream's own `DOCS.md` claimed coverage. Negatives
are the important half: source code discussing limits, prose, pasted errors,
ANSI repaints, and a `429` that must **not** trip the overload parser.

**Expected on upstream v0.3.0: 56 pass, 7 fail.** The failures are the baseline,
and each is a known finding:

| Failure | Meaning |
|---|---|
| `Your limit will reset at 14:00 (UTC)` misses | `LIMIT_HINTS` gap — documented format, broken |
| `socket hang up` misses | `ERROR_MARKERS` gap — documented format, broken |
| 3 × raw-level negatives trip | **Not defects.** These are caught by the guard chain at the level that actually runs; the raw parser is deliberately permissive |
| user-question trips *through the guard chain* | **The real one.** Finding #6 |
| pasted-529 trips raw parser | Not a defect — the watcher's entry-type gate catches it |

Once our fixes land, the two documented-format misses and the user-question
false positive should turn into passes. The raw-level ones may legitimately
keep failing.

### `diagnose-failures.js` — why each failure happens

Isolates the cause of each miss (gate rejection vs rule failure) and sizes the
false-positive class: **6 of 10 ordinary user questions arm a resume timer.**

### `watcher-e2e.js` — the real code path

Loads the actual `TranscriptWatcher` with a stubbed `vscode` module and feeds it
genuine Claude Code entry JSON, so the false-positive finding is measured
through `inspectLine()` rather than a hand-rolled approximation. It also proves
two guards that *do* hold: the sibling `timestamp` field is not misread as a
reset time, and the terminal path has no code guard.

The vscode stub (a `Module._load` hook plus a minimal `EventEmitter`) is worth
keeping — it's how you test watcher code without a VS Code host.

## Known gap

**Every fixture is synthetic**, written from upstream's documentation. No real
captured limit entry exists in this corpus. Capture one the first time a real
usage limit is hit and add it — that is the highest-value single addition here.
