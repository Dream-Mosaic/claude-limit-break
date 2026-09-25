# Task 3 report: stop untrusted text from arming timers (synthesis A3)

Branch `fix/1.0-field-reports`, worktree `C:/Users/thegr/Dream-Mosaic/Projects/claude-limit-buster-lead`.
Commits: `3688d55`, `1ce287f`, `2925f81` (HEAD).

## What was built

Four new vetoes, all applied only on the untrusted path (flagged entries -
`isApiErrorMessage`/`error:'rate_limit'` - are unaffected by every one of
them, per the brief):

1. **Percentage-usage status lines** (`src/parsers/limitParser.ts`,
   `looksLikePercentageUsage`): `/\bused\s+\d{1,3}%/i`, matching the brief's
   regex exactly. Joins the existing `looksLikeCode` check inside
   `detectLimit`.
2. **Visibly quoted text** (`looksLikeQuotedNotice`): a new guard, also
   inside `detectLimit`, that rejects a candidate when any physical line of
   the *raw* text (checked before `normalize()` collapses newlines to
   spaces) starts with a backtick anywhere on the line, a `>` blockquote
   marker, or a tight grep-style `path:line:` / `path:line-` citation
   (`/^[^\s:]+:\d+[:-]/` - a bare token with no whitespace or colon in it,
   immediately followed by digits and `:` or `-`). Verified this does not
   collide with real banner wording such as "resets 12:40pm" (the digits
   there are followed by `pm`, not `:`/`-`).
3. **Subagent files never arm limits** (`src/transcriptWatcher.ts`,
   `isSubagentFile`): a new guard on the path
   (`/[\\/]subagents[\\/]/i`), gating the *entire* limit-detection block
   (both the `quotaLimits.resetsAt` fast path and the text loop). Turn-end
   and overload detection are untouched - confirmed by a dedicated test
   showing both still fire for a subagent-file entry. **Which resolved
   ambiguity applies:** subagent files are scanned for more than limits
   today (overload, turn-end), so the fix skips limit detection only; it
   does not skip the file wholesale.
4. **Text inside a tool result never arms a limit** (`collectStrings`):
   `collectStrings` now returns `{text, toolResult}` tuples instead of bare
   strings, threading an `inToolResult` flag down through recursion that
   turns on inside a `type: "tool_result"` content block or anywhere under a
   top-level `toolUseResult` field (confirmed against a real transcript on
   this machine - `toolUseResult` is a genuine sibling field Claude Code
   writes). The limit-detection loop in `inspectLine` skips
   `candidate.toolResult` text unless `flagged`; the overload loop is
   unaffected (out of this task's scope).

## TDD evidence

**RED, limitParser (unit level):** added `looksLikePercentageUsage` and
`looksLikeQuotedNotice` to the import list before they existed -
`npm run compile` failed with `TS2305: has no exported member`. Then wrote
9 tests (percentage, `>`, grep-prefix, bare `path:line-`, positive control,
plus 4 direct tests of the two new functions) before implementing.

**RED, transcriptWatcher (integration level):** added 10 tests up front,
covering the three real false positives plus isolation/positive cases. After
implementing only the `limitParser.ts` change (commit 1) and before touching
`transcriptWatcher.ts`, `node --test out/test/transcriptWatcher.test.js`
showed 2 of 44 red:
```
✖ a subagent file never arms a limit timer, even quoting a real banner verbatim (real false positive)
✖ plain banner wording inside a tool_result block does not arm a timer, even with no quoting marks
```
(The percentage/grep/quoted-notice transcriptWatcher-level tests already
passed at that point, since `detectLimit`'s new guards already covered
them - expected, and left in as replay-check/integration confirmation
rather than re-litigated RED tests.)

**GREEN:** after the `transcriptWatcher.ts` fix, all 44 (then 45) tests
passed. Full suite: 460 -> 477 unit tests, all green
(`npm test > "$TEMP/t.log" 2>&1; echo "exit=$?"` -> `exit=0`, `477 pass, 0
fail`). Integration: `npm run test:integration` -> `exit=0`, `9 passing`.

**Replay check (resolved ambiguity):** all three real strings from the brief
are used verbatim in `test/transcriptWatcher.test.ts`:
- `"\u2026You have used up your monthly limit. Try again in 3 hours"` (subagent
  file test) - the brief's exact text, ellipsis U+2026 preserved.
- `"You've used 91% of your session limit \u00b7 resets 12:40pm"` (middot
  U+00B7 preserved) - used twice: once untrusted (must not arm) and once
  flagged (positive control, must still arm).
- The grep case has no exact text in the brief ("a `grep` result quoting a
  banner" - no literal string given), so it is reconstructed realistically:
  a `tool_result` content block whose `content` is
  `'docs/PRIOR-ART.md:277:Claude AI usage limit reached. Try again in 5
  hours'`.
- A flagged real banner (`"You've hit your session limit \u00b7 resets
  12:40am (America/Chicago)"`, one of the actually-captured banners already
  pinned in `test/parsers/limitParser.test.ts`) is used as the required
  positive case.

## Mutation table

All mutants run in the foreground with `mutate_fast.py` against the focused
compiled test file (`npm run compile` once per mutant, then
`node --test out/test/<file>.test.js`); every mutant was caught, file
restored after each run, `git status --short` clean afterward.

**`out/test/parsers/limitParser.test.js`** (7 mutants, all `src/parsers/limitParser.ts`):

| Mutation | Result |
|---|---|
| Drop `looksLikePercentageUsage(text)` from the OR guard | CAUGHT (1) |
| Drop `looksLikeQuotedNotice(rawText)` from the OR guard | CAUGHT (3) |
| Percentage regex changed to never match | CAUGHT (2) |
| Quoted-notice: backtick check removed | CAUGHT (1) |
| Quoted-notice: `>` blockquote check removed | CAUGHT (2) |
| Quoted-notice: grep-prefix check removed | CAUGHT (4) |
| Quoted-notice: per-line split replaced with whole-text check | CAUGHT (1) |

**`out/test/transcriptWatcher.test.js`** (5 mutants, all `src/transcriptWatcher.ts`):

| Mutation | Result |
|---|---|
| `!isSubagentFile(file) &&` dropped from the limit-block condition | CAUGHT (1) |
| `isSubagentFile` regex replaced with `return false` | CAUGHT (1) |
| `if (!flagged && candidate.toolResult)` replaced with `if (false)` | CAUGHT (2) |
| `obj.type === 'tool_result'` tagging dropped | CAUGHT (1) |
| `key === 'toolUseResult'` tagging dropped | **SURVIVED first pass** - added a dedicated test (`plain banner wording under a top-level toolUseResult field does not arm a timer`, commit `2925f81`), then re-ran: CAUGHT (1) |

The `toolUseResult` survivor is worth flagging explicitly: the first pass of
tests exercised the `type: "tool_result"` content-block path but nothing
exercised a banner living directly under the top-level `toolUseResult`
field (which real transcripts on this machine confirmed exists as a
genuine sibling field). Caught by mutation testing as intended, fixed by
adding the missing test before moving on.

## Files changed

- `src/parsers/limitParser.ts` - `looksLikePercentageUsage`,
  `looksLikeQuotedNotice`, and the extended guard inside `detectLimit`.
- `src/transcriptWatcher.ts` - `isSubagentFile`, the `Candidate` type,
  `collectStrings`'s new `inToolResult` threading, and the two call sites
  (limit-detection loop gated on subagent-file + tool-result; overload loop
  updated for the new `Candidate` shape, behavior otherwise unchanged).
- `test/parsers/limitParser.test.ts` - 9 new tests.
- `test/transcriptWatcher.test.ts` - 11 new tests (10 initial + 1 mutation
  follow-up).

## Concerns

- **Grep-case text is reconstructed, not verbatim.** The brief gives exact
  text for two of the three false positives but only a description ("a
  `grep` result quoting a banner") for the third. I built a representative
  `tool_result` block using a real banner format and a real path from this
  repo's own docs. If the lead has the actual captured line, it would be
  worth swapping in for full fidelity, though the current test already
  exercises both the structural (`tool_result`) and textual (grep-prefix)
  vetoes that would catch it either way.
- **Grep-prefix regex tightness.** `/^[^\s:]+:\d+[:-]/` requires the banner
  line to *start* with a bare-token, digit, colon/hyphen citation. I checked
  it against every real banner format in `test/parsers/limitParser.test.ts`
  (all begin with words like "Claude", "You've", "Your", "Error", "API",
  none matching the pattern) plus the two positive-control tests added here.
  A banner that somehow began with something like `3:15-...` at the very
  start of the string (not as part of "resets at 3:15-4:00" type prose,
  since those don't front-load the digits) could theoretically false-veto,
  but no such format exists in the current rule set or documented banners.
- **`looksLikeQuotedNotice`'s backtick check duplicates part of
  `looksLikeCode`.** `looksLikeCode` already vetoes any text containing a
  backtick, so in practice the backtick branch of the new function is
  currently redundant with the existing guard. Kept it in per the brief's
  explicit wording ("inside backticks" is one of the three quoted-text
  shapes to veto) and because the two guards are conceptually distinct
  (code punctuation vs. quotation) even though today's regex means one
  would already catch what the other does; a mutation test on that specific
  branch still passed (caught by the dedicated `looksLikeQuotedNotice`
  function test), so it is pinned as its own contract regardless.
- Did not touch `overloadParser.ts` or the overload-detection loop's
  candidate handling beyond the mechanical `.text` field access forced by
  `collectStrings`'s new return shape - out of this task's scope per the
  brief and the A3 table (`transcriptWatcher.ts`, `limitParser.ts` only).

## Verification run (final, before this report)

```
npm test > "$TEMP/t.log" 2>&1; echo "exit=$?"
-> exit=0, tests 477, pass 477, fail 0

npm run test:integration
-> exit=0, 9 passing
```

## Fix round 1

Commit `ca4f2ae` (HEAD). Two issues from the coordinator's review of the
initial three commits.

**1. CRITICAL - flagged entries were not exempt from the subagent-file
veto.** `src/transcriptWatcher.ts:441` read
`if (!isSubagentFile(file) && (flagged || apiError || entry.type !==
'user'))` - `isSubagentFile` was checked *before* `flagged`, so a genuine
rate-limit hit landing in a `subagents/` file (a flagged banner, or a
flagged `quotaLimits.resetsAt` entry) was silently dropped instead of
arming, the opposite of every other veto in this task, all of which exempt
flagged entries. Fixed to
`if (flagged || (!isSubagentFile(file) && (apiError || entry.type !==
'user')))`, exactly as specified. A duplicate detection between a subagent
file and its parent transcript is accepted as harmless per the
coordinator's note (Task 10's scheduler keeps the first job for a given
`baseResumeAtMs`) and not otherwise guarded against here.

RED (before the fix, `node --test out/test/transcriptWatcher.test.js`):
```
✖ a flagged banner in a subagents/ file still arms a timer
✖ a flagged quotaLimits.resetsAt entry in a subagents/ file still arms a timer
```
GREEN after the one-line reorder.

**2. IMPORTANT - `looksLikeQuotedNotice`'s grep-prefix regex missed a
Windows drive-letter path.** `/^[^\s:]+:\d+[:-]/` matched only up to the
first colon: for `C:\Users\x\y.ts:12: ...` the leading token is just `C`
before the first `:`, which has no digits after it, so the pattern never
reached the real `:12:` further in. Added an optional
`(?:[A-Za-z]:)?` prefix:
`/^(?:[A-Za-z]:)?[^\s:]+:\d+[:-]/`. Checked against every real banner
format already pinned in `test/parsers/limitParser.test.ts`, plus the
adversarial case "12:40pm" (not itself a drive letter + path, since "1" is
a digit, not `[A-Za-z]`), to confirm the wider pattern opens no new
false-veto hole.

RED (before the fix): both a `detectLimit`-level test and a direct
`looksLikeQuotedNotice` unit test failed to veto the drive-letter form.
GREEN after the regex change.

### Mutation table, fix round 1

Run with `mutate_fast.py` against both focused compiled test files
together (`out/test/parsers/limitParser.test.js,out/test/transcriptWatcher.test.js`):

| Mutation | Result |
|---|---|
| Revert the subagent-file condition to the old (buggy) ordering | CAUGHT (2) |
| Drop the `flagged \|\|` clause entirely from the OR | CAUGHT (2) |
| Drop the optional drive-letter group from the grep-prefix regex | CAUGHT (2) |

Working tree confirmed clean (`git status --short`) after each mutation
run, before the final commit.

### Gate (fix round 1)

```
npm test > "$TEMP/t_final.log" 2>&1; echo "exit=$?"
-> exit=0, tests 482, pass 482, fail 0

npm run test:integration
-> exit=0, 9 passing
```

### Files changed, fix round 1

- `src/transcriptWatcher.ts` - the subagent-file veto condition reorder.
- `src/parsers/limitParser.ts` - the grep-prefix regex's optional
  drive-letter group.
- `test/transcriptWatcher.test.ts` - 2 new tests (flagged banner and
  flagged `quotaLimits.resetsAt`, both in a `subagents/` file).
- `test/parsers/limitParser.test.ts` - 3 new tests (drive-letter grep
  prefix at the `detectLimit` level, the same at the `looksLikeQuotedNotice`
  unit level, and a positive-control sweep over every real banner format).
