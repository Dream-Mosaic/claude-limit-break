import { resolveSession } from './sessionResolver';
import { checkBudget } from './budget';
import type { Settings } from './config';
import type { PendingJob } from './scheduler';

export type Plan =
  | { kind: 'schedule'; job: PendingJob; estimate: number }
  | { kind: 'refuse'; reason: string }
  | { kind: 'ignore'; reason: string };

export function planResume(
  hit: { detection: { resumeAt?: Date; text: string }; cwd?: string; file: string },
  reason: 'limit' | 'overload',
  settings: Settings,
  statBytes: (p: string) => number,
  now: Date,
  jitter: (min: number, max: number) => number,
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
  const verdict = checkBudget(session.bytes, settings.maxResumeTokens);
  if (!verdict.allowed) {
    return { kind: 'refuse', reason: verdict.reason ?? 'Over the token budget.' };
  }
  // An overload has no stated reset time, so the jitter *is* the backoff.
  const base = hit.detection.resumeAt?.getTime() ?? now.getTime();
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
    },
  };
}
