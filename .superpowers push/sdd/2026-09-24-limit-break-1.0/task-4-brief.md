### Task 4: Overload and failure states (synthesis A5, A6, A7, A8, A9)

- Ignore Claude Code's own in-flight retry lines ("Retrying in Ns · attempt k/n" and close variants): it is already retrying, so we must not also schedule one.
- Route "Server is temporarily limiting requests (not your usage limit)" to the overload path. Today it falls through both parsers.
- Treat "Your computer went to sleep mid-response" (and close variants) as an overload-class interruption to retry.
- DST (A7): when a wall-clock reset time falls in the repeated hour at a fall-back transition, resolve it to the LATER instant. The #10 code is `nextZonedOccurrence` in `src/parsers/limitParser.ts`.
- A distinct "gave up" state (A8/A9). When a resume fails in a way we stop retrying on, the status bar shows a distinct icon and a tooltip saying why, instead of looking idle. Those failures are: stall watch fired, launcher missing, cwd missing, or the budget refusal dismissed. Warn once per session per failure, then stay quiet. It clears on the next successful detection or resume for that session, or on Cancel from the menu. Failure notifications name their cause distinctly.

