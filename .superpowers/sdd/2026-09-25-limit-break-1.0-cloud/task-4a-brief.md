### Task 4a: Overload detection gaps and the DST commit (synthesis A5, A6, A7)

Plan Task 4, split: this is its detection half. 4b is the "gave up" state. The plan text for these bullets,
verbatim:

- Ignore Claude Code's own in-flight retry lines ("Retrying in Ns · attempt k/n" and close variants): it is already retrying, so we must not also schedule one.
- Route "Server is temporarily limiting requests (not your usage limit)" to the overload path. Today it falls through both parsers.
- Treat "Your computer went to sleep mid-response" (and close variants) as an overload-class interruption to retry.
- DST (A7): when a wall-clock reset time falls in the repeated hour at a fall-back transition, resolve it to the LATER instant. The #10 code is `nextZonedOccurrence` in `src/parsers/limitParser.ts`.

State of the DST bullet: the Windows lane committed it as `bbff534` (fix/1.0-field-reports), and this
lane merges that commit in before dispatch. It was never reviewed. Your job for that bullet: read the commit,
check its test pins the America/Chicago 2026-11-01 01:30 case to the LATER instant (07:30Z, CST), add a
spring-forward case (a wall-clock time that does not exist, e.g. America/Chicago 2026-03-08 02:30) if none
exists and pin whatever the code does there with a comment saying why that answer is safe (late is safe, early
is not), and mutation-check its new guard. Change the implementation only if a test shows it is wrong.

Exact strings (from Claude Code's own renders, via the prior-art slices in
`.superpowers/sdd/2026-09-25-limit-break-1.0-cloud/ref/prior-art/`; `1-autoretry-detection.md` "Three gaps",
the fixture table near line 230, and `5-history-issues.md` bug entry #3):
- in-flight retry, must NOT schedule anything: `API Error (529 {"type":"error"}) · Retrying in 5s · attempt 3/10`.
  The PARENS form with a `Retrying in` / `attempt k/n` suffix is Claude Code's own retry still in flight; the COLON
  form (`API Error: 529 ...`) with no retry suffix is terminal and stays actionable. Cover close variants (other
  codes, other second counts, `attempt 10/10`, with and without the JSON body).
- transient 429, must route to OVERLOAD (not the limit path, not dropped):
  `API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited`.
  Today `overloadParser.ts` hands any "rate limit" vocabulary to the limit parser (around its lines 46-55); this
  message disclaims being a usage limit in its own text. It must not arm a usage-limit timer.
- sleep/stream interruption, must route to OVERLOAD (retry):
  `API Error: Your computer went to sleep mid-response. The response above may be incomplete.`
  Close variants: `went to sleep before a response was produced`; the other stream-interruption renders listed
  in `5-history-issues.md` (a dropped connection, a stalled stream) if they carry the same `API Error:` head.
  Anchor on the `API Error:` head, as the existing rules do, so prose that merely mentions sleep never matches.

Constraints specific to this task:
- The untrusted-text rules from Task 3 (quoted text, tool results, subagent files, percentage warnings) and the
  flagged-entry exemption must keep working for the new overload rules: a quoted or tool-result copy of any
  of these strings on the untrusted path must not schedule anything. Add at least one negative test for that.
- Overload staleness is age (`MAX_OVERLOAD_AGE_MS`, Task 1): the new overload renders obey it too.
- Every new rule gets positive and negative tests and a mutation check.
