import * as nodeFs from 'node:fs';

/**
 * Has a session moved on since its stop was detected? (Final fix wave A, A3:
 * final review I1, M5 and M7.)
 *
 * A resume is only ever for a live, still-unhandled stop. The job carries the
 * transcript's size at detection (`transcriptBytesAtDetection`), so whatever
 * was appended after that is what happened to the session since. A new
 * `user` or `assistant` entry there means somebody - the user at a panel or a
 * terminal, Claude Code's own auto-continue, another window's resume - has
 * already continued it, and a resume on top of that forks the conversation:
 * the idle-panel race of final review I1, where the user comes back at 2:12,
 * types, the turn ends, and a fire padded to 2:25 finds an idle panel and
 * resumes anyway.
 *
 * What does NOT count as moving on:
 * - Claude Code's own synthetic error entries: `isApiErrorMessage: true` (a
 *   second limit notice from a hand retry, an overload), or
 *   `message.model === '<synthetic>'` (the unflagged "No response
 *   requested." entries the Task 4c scan found). They report the stop; they
 *   are not the session continuing.
 * - Any other entry type (`system`, `summary`, hook and snapshot records):
 *   a trailing hook entry is not a turn (final review M7).
 * - Unparseable or partial lines: the tail may still be mid-write.
 *
 * Fails OPEN - false - when it cannot tell: no baseline (a job persisted by an
 * older build), an unreadable transcript, or one now shorter than its
 * baseline (replaced). Goal 2 is to resume unattended; not knowing is not a
 * reason to strand a session, and this was the behaviour before the check.
 */
export function continuedSince(
  transcriptPath: string,
  baselineBytes: number | undefined,
  fs: ContinuedFs = nodeFs,
): boolean {
  if (baselineBytes === undefined || !Number.isFinite(baselineBytes) || baselineBytes < 0) {
    return false;
  }
  let text: string;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= baselineBytes) {
      return false;
    }
    // Bounded: a continuation shows itself in the first entry or two after
    // the stop, and a resumed session can append megabytes before this runs.
    const length = Math.min(size - baselineBytes, MAX_CONTINUED_READ_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, baselineBytes);
    } finally {
      fs.closeSync(fd);
    }
    text = buffer.toString('utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isContinuation(entry)) {
      return true;
    }
  }
  return false;
}

/** How much of what was appended since detection is read. */
export const MAX_CONTINUED_READ_BYTES = 2_000_000;

/** The subset of node:fs {@link continuedSince} reads with. */
export interface ContinuedFs {
  statSync(p: string): { size: number };
  openSync(p: string, flags: string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

/** A user or assistant entry that is not one of Claude Code's own synthetic error entries. */
function isContinuation(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  const e = entry as Record<string, unknown>;
  if (e.type !== 'user' && e.type !== 'assistant') {
    return false;
  }
  if (e.isApiErrorMessage === true) {
    return false;
  }
  const message = e.message;
  if (message && typeof message === 'object' && (message as Record<string, unknown>).model === '<synthetic>') {
    return false;
  }
  return true;
}
