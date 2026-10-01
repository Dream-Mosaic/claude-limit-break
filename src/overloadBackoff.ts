/**
 * Back-to-back overload resumes (final fix wave A, A6; final review M8,
 * design Goal 4 - bound token spend).
 *
 * An overload resume is a guess that the server has recovered. In
 * interactive mode a second failure lands on our own idle terminal and
 * becomes an offer, so the loop bounds itself; but a headless (`-p`) resume
 * exits, and a terminal the user closed is gone, so every flagged overload
 * after that would auto-resume again, with no cap - and a mid-response
 * failure does spend tokens.
 *
 * The user's decision (2026-09-30, relayed by the lead): a five-step backoff,
 * then give up.
 * - The 1st consecutive automatic overload resume of a session keeps the
 *   usual random delay (randomDelayMin/MaxMinutes).
 * - The 2nd, 3rd, 4th and 5th add +15, +30, +60 and +120 minutes on top of
 *   that usual random delay.
 * - A 6th is never scheduled: the session gives up until it finishes a turn.
 * - A finished turn resets the count. Limit jobs neither count nor get a
 *   backoff.
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
 * Per-session count of consecutive overload resumes planned since the
 * session's last finished turn.
 *
 * Counted when an overload job is SCHEDULED, not when a resume launches.
 * Every window watching the machine (watchScope machine, the default) sees
 * the same overload entries and the same turn ends in the same order, so
 * every window's count agrees; only one window launches each resume (the
 * cross-window claim), so a count of launches would differ per window - a
 * window that lost every claim would still plan the next retry with no
 * backoff, fire first and win it, and each window would have its own five.
 *
 * In memory only, like the gave-up records it feeds (gaveUp.ts): a reload
 * starts every session from zero.
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
