/**
 * How long to linger past a cooldown before resuming.
 *
 * Resuming on the very second a window opens is both conspicuous and a poor
 * bet — everyone else's cooldown ends on the same round minute — so the wait
 * is padded by a random amount inside a configured band.
 *
 * Kept free of `vscode` imports so it can be unit-tested on its own.
 */

/**
 * Milliseconds of random padding to add to a resume deadline, uniform on
 * `[minMinutes, maxMinutes]`. Returns 0 when the window is degenerate.
 */
export function randomJitterMs(minMinutes: number, maxMinutes: number): number {
  // An inverted band is read as the range it describes rather than rejected;
  // someone who typed 30 and 10 meant "between ten and thirty minutes".
  const lo = Math.max(0, Math.min(minMinutes, maxMinutes));
  const hi = Math.max(0, Math.max(minMinutes, maxMinutes));
  if (hi <= 0) {
    return 0;
  }
  return Math.floor((lo + Math.random() * (hi - lo)) * 60_000);
}
