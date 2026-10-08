/**
 * Back-to-back overload resumes: a five-step backoff, then give up, to bound token spend.
 *
 * An overload resume guesses the server has recovered. A headless (`-p`) resume exits and a closed terminal is gone, so without a cap every flagged overload would auto-resume again, and a mid-response failure spends tokens.
 * - The 1st consecutive automatic overload resume of a session keeps the usual random delay (randomDelayMin/MaxMinutes).
 * - The 2nd to 5th add +15, +30, +60 and +120 minutes on top of that delay.
 * - A 6th is never scheduled: the session gives up until it finishes a turn.
 * - A finished turn resets the count. Limit jobs neither count nor get a backoff.
 *
 * Pure: no VS Code, no clock, no filesystem.
 */

/** Extra minutes for consecutive automatic overload resume 1, 2, 3, 4 and 5. */
export const OVERLOAD_BACKOFF_MINUTES: readonly number[] = [0, 15, 30, 60, 120];

/** How many consecutive automatic overload resumes a session gets before it gives up. */
export const MAX_OVERLOAD_RESUMES = OVERLOAD_BACKOFF_MINUTES.length;

/**
 * The backoff for the next overload resume of a session that has already
 * had `consecutive` of them since its last finished turn, in ms - or
 * undefined once the cap is reached, which means give up.
 */
export function overloadBackoffMs(consecutive: number): number | undefined {
  const minutes = OVERLOAD_BACKOFF_MINUTES[consecutive];
  return minutes === undefined ? undefined : minutes * 60_000;
}

/**
 * Per-session count of consecutive overload resumes planned since the session's last finished turn.
 *
 * Counted when a job is SCHEDULED, not launched: every window watching the machine sees the same entries in the same order so their counts agree, whereas a count of launches would differ per window (a window that lost every claim would plan the next retry with no backoff).
 *
 * In memory only: a reload starts every session from zero.
 */
export class OverloadStreaks {
  private readonly counts = new Map<string, number>();

  /** Consecutive overload resumes planned for this session since its last finished turn. */
  count(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }

  /** An overload resume was scheduled for this session. */
  planned(sessionId: string): void {
    this.counts.set(sessionId, this.count(sessionId) + 1);
  }

  /** The session finished a turn: it works again, so its count starts over. Returns whether it had one. */
  turnEnded(sessionId: string): boolean {
    return this.counts.delete(sessionId);
  }
}
