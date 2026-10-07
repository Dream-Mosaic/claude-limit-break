/**
 * Did a resume actually resume?
 *
 * `vscode.window.createTerminal` returning proves only that VS Code accepted the options, not that `claude` ran or did any work. Two failures leave a healthy-looking terminal: the folder is not trusted so `claude` waits at its trust prompt, or the launch fails asynchronously inside the terminal process after success was logged.
 *
 * A working resumed session appends to its transcript, so growth is the one piece of evidence worth having; this module decides what the byte counts mean. Pure: no filesystem, clock or VS Code.
 */

/**
 * How long the caller should wait before asking.
 *
 * A limit wait guarantees a cold prompt cache, so a resumed session reprocesses its whole history before writing a new line; checking sooner would call every healthy resume of a large session a stall.
 *
 * Deliberately not a setting: it is a detail of Claude Code's behaviour, and a knob would only be turned to silence a warning that was right.
 *
 * Scheduling advice only: `stallVerdict` does not re-check it, because guarding the same interval in both places lets the two drift apart (a shortened timer made every healthy resume report "too soon").
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
 * `stalled` covers every case that is not positive evidence of growth, including an unreadable or shrunken transcript. "This resume produced work" needs proving, not assuming: the cost of a wrong cautious answer is one ignorable warning, versus the silent failure this module exists to end.
 */
export function stallVerdict({ bytesAtLaunch, bytesNow }: StallCheck): StallVerdict {
  if (bytesNow === undefined) {
    return 'stalled';
  }
  return bytesNow > bytesAtLaunch ? 'grew' : 'stalled';
}
