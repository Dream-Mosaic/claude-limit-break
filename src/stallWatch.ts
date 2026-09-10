/**
 * Did a resume actually resume?
 *
 * `vscode.window.createTerminal` returning a terminal proves only that VS Code
 * accepted the options - not that `claude` ran, and certainly not that it did
 * any work. Two failures observed in the smoke test both leave a terminal
 * sitting there looking healthy:
 *
 * - The folder is not trusted, so `claude` stops at its own trust prompt and
 *   waits for a keypress that nobody is there to give (#5).
 * - The launch itself fails inside the terminal process, asynchronously, well
 *   after the extension has already logged success (#4).
 *
 * A resumed session that is genuinely working appends to its transcript. So
 * the transcript growing is the one piece of evidence worth having, and this
 * module decides what the byte counts mean. It is pure: no filesystem, no
 * clock, no VS Code.
 */

/**
 * How long the caller should wait before asking.
 *
 * A limit wait guarantees a cold prompt cache, so a resumed session reprocesses
 * its whole history before it writes a single new line - the design notes
 * measured 1.6 MB of transcript costing ~288k cache-creation tokens. Checking
 * sooner would call every healthy resume of a large session a stall.
 *
 * Deliberately not a setting. It is a detail of how Claude Code behaves, not a
 * preference anyone holds, and a knob here would only ever be turned to silence
 * a warning that was right.
 *
 * This is scheduling advice, and nothing else: `stallVerdict` deliberately does
 * not re-check it. Guarding the same interval in both places lets the two drift
 * apart - a shortened timer with the constant unchanged made every healthy
 * resume report "too soon", which the caller could not tell from a stall.
 */
export const GRACE_MS = 60_000;

export type StallVerdict = 'grew' | 'stalled';

export interface StallCheck {
  /** Transcript size when the terminal was created. */
  bytesAtLaunch: number;
  /** Transcript size now, or undefined when it could not be read at all. */
  bytesNow: number | undefined;
}

/**
 * `stalled` covers every case that is not positive evidence of growth -
 * including a transcript that has become unreadable, or has somehow shrunk.
 * The claim being made is "this resume produced work", and that claim needs
 * proving rather than assuming; the cost of being wrong in the cautious
 * direction is one warning the user can ignore, while the cost in the other
 * direction is the silent failure this module exists to end.
 */
export function stallVerdict({ bytesAtLaunch, bytesNow }: StallCheck): StallVerdict {
  if (bytesNow === undefined) {
    return 'stalled';
  }
  return bytesNow > bytesAtLaunch ? 'grew' : 'stalled';
}
