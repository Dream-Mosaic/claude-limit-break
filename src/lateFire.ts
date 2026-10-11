/**
 * How late past its scheduled time an automatic fire may be and still resume (D10). Later than this, nothing was running on schedule: VS Code was closed, or the machine slept through the deadline. The person who just opened VS Code or woke the machine is there, so the session is left to them.
 */
export const LATE_FIRE_MS = 10 * 60_000;

/** Whole minutes late when `nowMs` is more than LATE_FIRE_MS past `resumeAtMs`; undefined when the fire is on time. */
export function lateByMinutes(resumeAtMs: number, nowMs: number): number | undefined {
  const late = nowMs - resumeAtMs;
  return late > LATE_FIRE_MS ? Math.floor(late / 60_000) : undefined;
}
