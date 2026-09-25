### Task 3: Stop untrusted text from arming timers (synthesis A3)

The watcher scans assistant, system and subagent entries with `trusted: false`. Real false positives from 2026-09-23 include:
- a subagent note quoting "…You have used up your monthly limit. Try again in 3 hours";
- "You've used 91% of your session limit · resets 12:40pm";
- a `grep` result quoting a banner.

- Do not scan files under a `subagents/` directory for LIMITS at all. A subagent that hits the limit stops its parent, whose own transcript records it.
- On the untrusted path, veto:
  - percentage-usage warnings (`/\bused\s+\d{1,3}%/i`);
  - text inside tool results;
  - text that is clearly quoted: inside backticks, or on a line prefixed with `>` or a `file:line:` grep prefix.
- Flagged entries (`isApiErrorMessage`/`error: 'rate_limit'`) are unaffected.
- Replay check: the tests must include each of the three real strings above as a negative case, and a flagged real banner as a positive case.

