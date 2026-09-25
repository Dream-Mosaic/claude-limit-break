### Task 1: Replayed limits, the grace window, and `quotaLimits.resetsAt`

Make the seven red tests at the end of `test/transcriptWatcher.test.ts` pass without breaking any other test. They encode the requirements and are the spec. Read them first.

Requirements:
- Resolve a limit notice against the ENTRY's own `timestamp` (ISO string), not the time of reading. A missing or unparseable timestamp falls back to now, as before. Forked transcripts copy lines with their original timestamps, which is how last night's "resets 1am" re-armed an 18-hour timer.
- Grace window: if the resolved reset time is in the past by at most `RESET_GRACE_MS` (export it; 15 minutes), the limit is still an event and is due NOW (`resumeAt <= now`), never rolled forward to tomorrow. If it passed longer ago than that, it is history: return no limit.
- `quotaLimits.resetsAt` (epoch SECONDS, a top-level field of the transcript entry) is the primary reset time when present, and it wins over whatever the text says. It still counts when the text cannot be parsed at all. It is trusted ONLY on an entry Claude Code flagged (`isApiErrorMessage === true` or `error === 'rate_limit'`); on any other entry it is ignored. The same grace and history rules apply to it.
- Overloads have no reset time, so staleness is age: an overload entry whose timestamp is older than `MAX_OVERLOAD_AGE_MS` (export it; 10 minutes) triggers nothing.
- The hook point is `TranscriptWatcher.inspectLine` in `src/transcriptWatcher.ts`, where `const now = new Date()` is passed to `detectLimit` (around line 399). The text parser's rollover lives in `src/parsers/limitParser.ts` (around lines 210–224). Change it only as far as the grace rule needs.
- Keep `maxWait` semantics: a structured reset further out than `maxWait` is handled the same way a parsed one is today.

Also add tests for:
- the boundary on both sides of `RESET_GRACE_MS`;
- the boundary on both sides of `MAX_OVERLOAD_AGE_MS`;
- a flagged entry whose `quotaLimits` has no numeric `resetsAt`, which falls back to the text.

