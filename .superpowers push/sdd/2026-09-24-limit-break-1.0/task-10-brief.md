### Task 10: Cross-window claim (runs right after Task 2; "2b" in the ledger)

Root cause, 2026-09-24. Every VS Code window runs its own copy of the extension, and with `watchScope: machine` every copy watches every transcript. Two windows each detected the same limit within 10 ms, and each scheduled its own resume with its own jitter (07:19 and 07:31 UTC), so one conversation got two terminals. Task 2's holder check catches a second fire minutes later. It cannot catch two windows firing within a second or two, before the first child shows up in `claude agents`.

- New pure module `src/claims.ts`, with the filesystem injected and a temp directory in tests:
  - `claimResume(dir, key, nowMs, fs)`: returns `'claimed' | 'taken'`.
  - It creates `<dir>/<key>.claim` atomically, with `fs.openSync(path, 'wx')`, and writes the owner pid and time into it.
  - If the file exists and its mtime is under 1 h old, return `'taken'`.
  - If it is older, it's stale: unlink it and retry once.
  - Any other filesystem error returns `'claimed'` (fail open, Goal 2) and is logged.
- `key` is `<sessionId>-<baseResumeAtMs>` for a limit job; that's the un-jittered reset, identical in every window. For an overload job it's `<sessionId>-overload-<floor(fireMs / 600000)>`.
- `dir` is `path.join(os.tmpdir(), 'claude-limit-break', 'claims')`: machine-wide, shared by every window and profile of the same user. Create it recursively.
- Wiring in `scheduler.onFire`: claim immediately before the Task 2 holder decision.
  - `'taken'`: drop the job. Log "claimed by another window", with no notification and no rememberReady.
  - A resume that then fails to launch deletes its own claim, so a manual retry isn't blocked.
- Manual Resume Now ignores existing claims (the user's explicit intent) but writes one, so another window doesn't also fire.
- On activation, delete claim files older than 24 h.
- Same-reset re-detection: if a job for the same sessionId with the same `baseResumeAtMs` is already scheduled, keep it. Don't re-roll the jitter. On 2026-09-24 a re-detection moved a window's resume from 2:27:19 to 2:20:11. Check `ResumeScheduler.schedule()`'s dedupe, which compares `resumeAtMs`.
- Tests:
  - two claimers on one key: exactly one gets `'claimed'`;
  - the stale takeover;
  - the fail-open error path;
  - onFire drops a taken job;
  - a failed launch releases the claim;
  - manual Resume Now bypasses the claim;
  - the same-reset re-detection keeps the first schedule.
- Mutation-check every new guard.
