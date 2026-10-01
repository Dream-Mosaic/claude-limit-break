import { resolveSession } from './sessionResolver';
import { checkBudget, type UsageRecord } from './budget';
import type { Settings } from './config';
import type { PendingJob } from './scheduler';

export type Plan =
  | { kind: 'schedule'; job: PendingJob; estimate: number }
  // The session is named so a dismissed refusal can be recorded against it
  // (the gave-up state, gaveUp.ts, is per session).
  | { kind: 'refuse'; reason: string; sessionId: string; cwd?: string }
  | { kind: 'ignore'; reason: string };

export function planResume(
  hit: { detection: { resumeAt?: Date; text: string; rateLimitType?: string }; cwd?: string; file: string; entryTimestampMs?: number },
  reason: 'limit' | 'overload',
  settings: Settings,
  statBytes: (p: string) => number,
  now: Date,
  jitter: (min: number, max: number) => number,
  /**
   * The newest usage record in the transcript, when one can be read. It says
   * what the live context actually is; the byte count only says how much has
   * ever been written to the file. See estimateResumeTokens.
   */
  readUsage?: (transcript: string) => UsageRecord | undefined,
  /**
   * Extra wait for an overload retry, on top of the usual random delay
   * (final fix wave A, A6 - the user's decision; see overloadBackoff.ts). It
   * goes into the un-jittered deadline itself, so everything keyed on that
   * deadline - the cross-window claim's hold (A5) above all - covers it.
   * Ignored for a limit, which neither counts nor backs off.
   */
  overloadBackoffMs = 0,
): Plan {
  if (!settings.enabled) {
    return { kind: 'ignore', reason: 'Extension disabled.' };
  }
  const session = resolveSession(hit.file, hit.cwd, statBytes);
  if (!session) {
    // No fallback to "the newest transcript somewhere". Resuming a session we
    // cannot name is how one project's prompt lands in another project.
    return { kind: 'ignore', reason: `Not a session transcript: ${hit.file}` };
  }
  const verdict = checkBudget(session.bytes, settings.maxResumeTokens, readUsage?.(session.transcript));
  if (!verdict.allowed) {
    return {
      kind: 'refuse',
      reason: verdict.reason ?? 'Over the token budget.',
      sessionId: session.sessionId,
      cwd: session.cwd,
    };
  }
  // An overload has no stated reset time, so the jitter *is* the backoff -
  // plus, for a session that keeps failing, the A6 step backoff.
  const backoffMs = reason === 'overload' && overloadBackoffMs > 0 ? overloadBackoffMs : 0;
  const base = (hit.detection.resumeAt?.getTime() ?? now.getTime()) + backoffMs;
  const jitterMs = jitter(settings.randomDelayMinMinutes, settings.randomDelayMaxMinutes);
  return {
    kind: 'schedule',
    estimate: verdict.estimate,
    job: {
      sessionId: session.sessionId,
      transcript: session.transcript,
      cwd: session.cwd,
      prompt: settings.resumePrompt,
      baseResumeAtMs: base,
      resumeAtMs: base + jitterMs,
      jitterMs,
      reason,
      // Recorded so the log and a reader of the persisted job can tell a
      // backed-off retry from an ordinary one; already inside baseResumeAtMs.
      ...(backoffMs > 0 ? { backoffMs } : {}),
      // Only set when the watcher had one: an absent key, not `undefined`,
      // keeps the persisted job (globalState) exactly as it was for a hit
      // without it.
      ...(hit.entryTimestampMs !== undefined ? { entryTimestampMs: hit.entryTimestampMs } : {}),
      // Which usage limit stopped the session, when the detection could tell
      // (Task 4c, R4): decideOnFire stands down for Claude Code's native
      // auto-continue only when it is the five-hour one. Left off, like the
      // others, when absent.
      ...(hit.detection.rateLimitType !== undefined ? { rateLimitType: hit.detection.rateLimitType } : {}),
      // The native auto-continue check's baseline (final review, Important
      // 6). resolveSession reports 0 for a size it could not read; that is
      // "unknown", not a baseline every transcript has grown past.
      ...(session.bytes > 0 ? { transcriptBytesAtDetection: session.bytes } : {}),
    },
  };
}
