import { resolveSession } from './sessionResolver';
import { checkBudget, type UsageRecord } from './budget';
import type { Settings } from './config';
import type { PendingJob } from './scheduler';

export type Plan =
  | { kind: 'schedule'; job: PendingJob; estimate?: number; budgetUnmeasured?: true }
  // The session is named so a dismissed refusal can be recorded against it (gaveUp.ts).
  | { kind: 'refuse'; reason: string; sessionId: string; cwd?: string }
  | { kind: 'ignore'; reason: string };

export function planResume(
  hit: {
    detection: { resumeAt?: Date; text: string; rateLimitType?: string; offerOnly?: true };
    cwd?: string;
    file: string;
    entryTimestampMs?: number;
  },
  reason: 'limit' | 'overload',
  settings: Settings,
  statBytes: (p: string) => number,
  now: Date,
  jitter: (min: number, max: number) => number,
  /**
   * The newest usage record in the transcript, when one can be read. It says
   * what the live context actually is. None means unmeasured, which the budget
   * allows. See estimateResumeTokens.
   */
  readUsage?: (transcript: string) => UsageRecord | undefined,
  /**
   * Extra wait for an overload retry, on top of the usual random delay (overloadBackoff.ts). It goes into the un-jittered deadline itself, so the cross-window claim's hold covers it. Ignored for a limit.
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
  const verdict = checkBudget(settings.maxResumeTokens, readUsage?.(session.transcript));
  if (!verdict.allowed) {
    return {
      kind: 'refuse',
      reason: verdict.reason ?? 'Over the token budget.',
      sessionId: session.sessionId,
      cwd: session.cwd,
    };
  }
  // An overload has no stated reset time, so the jitter *is* the backoff, plus the step backoff for a session that keeps failing.
  const backoffMs = reason === 'overload' && overloadBackoffMs > 0 ? overloadBackoffMs : 0;
  const base = (hit.detection.resumeAt?.getTime() ?? now.getTime()) + backoffMs;
  const jitterMs = jitter(settings.randomDelayMinMinutes, settings.randomDelayMaxMinutes);
  return {
    kind: 'schedule',
    ...(verdict.estimate !== undefined ? { estimate: verdict.estimate } : {}),
    // Only worth a log line when a cap was in force and could not be applied.
    ...(verdict.estimate === undefined && settings.maxResumeTokens > 0 ? { budgetUnmeasured: true as const } : {}),
    job: {
      sessionId: session.sessionId,
      transcript: session.transcript,
      cwd: session.cwd,
      prompt: settings.resumePrompt,
      baseResumeAtMs: base,
      resumeAtMs: base + jitterMs,
      jitterMs,
      reason,
      // Recorded so the log and the persisted job show a backed-off retry; already inside baseResumeAtMs.
      ...(backoffMs > 0 ? { backoffMs } : {}),
      // Only set when the watcher had one: an absent key, not `undefined`, keeps the persisted job's shape.
      ...(hit.entryTimestampMs !== undefined ? { entryTimestampMs: hit.entryTimestampMs } : {}),
      // Which usage limit stopped the session, when known: decideOnFire stands down for native auto-continue only for the five-hour one.
      ...(hit.detection.rateLimitType !== undefined ? { rateLimitType: hit.detection.rateLimitType } : {}),
      // The native auto-continue check's baseline. resolveSession reports 0 for an unreadable size; that is "unknown", not a baseline every transcript has grown past.
      ...(session.bytes > 0 ? { transcriptBytesAtDetection: session.bytes } : {}),
      // A reset beyond maxWaitHours is scheduled like any other but only offered at fire. Absent, not false, otherwise.
      ...(hit.detection.offerOnly === true ? { offerOnly: true as const } : {}),
    },
  };
}
