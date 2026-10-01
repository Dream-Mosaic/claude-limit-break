import * as nodeFs from 'node:fs';

/**
 * Is a session PAST the stop it was detected at? (Final fix wave A, A3:
 * final review I1, M5 and M7; refined by wave A fix round 1, review C1.)
 *
 * A resume is only ever for a live, still-unhandled stop. The job carries the
 * transcript's size at detection (`transcriptBytesAtDetection`), so whatever
 * was appended after that is what happened to the session since. A real
 * `user` or `assistant` entry there means somebody - the user at a panel or a
 * terminal, Claude Code's own auto-continue, another window's resume - took
 * the session on, and a resume on top of a session that is still going forks
 * the conversation: the idle-panel race of final review I1, where the user
 * comes back at 2:12, types, the turn ends, and a fire padded to 2:25 finds an
 * idle panel and resumes anyway.
 *
 * But taking it on is not the same as getting past it (review C1). The
 * commonest reaction to a limit is "try again", and a retry - by hand, from
 * Remote Control, or a background task's `<task-notification>` turn - that
 * runs into the same limit writes a real prompt and then another flagged
 * error entry. The review found 43 of those on this machine, 38 with an
 * identical `quotaLimits.resetsAt`. That session is stopped, at a live stop,
 * and must still be resumed. So the appended `user` and `assistant` entries
 * are walked in order: a real one sets "continued", a flagged
 * (`isApiErrorMessage: true`) one clears it again, and the LAST of them
 * decides.
 *
 * What neither sets nor clears it:
 * - The unflagged `<synthetic>` assistant entries ("No response requested.",
 *   the Task 4c scan): they are Claude Code talking, not the session moving.
 * - Local slash commands (review I1): `/usage`, `/status`, `/model` write
 *   `user` entries starting `<local-command-caveat>`, `<command-name>` or
 *   `<local-command-stdout>`, and make no API call - checking when a limit
 *   resets is not getting past it. Other `isMeta` entries still count: the
 *   native auto-continue's own "Continue from where you left off." is one.
 * - Any other entry type (`system`, `summary`, hook and snapshot records):
 *   a trailing hook entry is not a turn (final review M7).
 * - Unparseable or partial lines: the tail may still be mid-write, and a tail
 *   read can start mid-line.
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
  let from = baselineBytes;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= baselineBytes) {
      return false;
    }
    // The TAIL, bounded: the last entry decides, and a resumed session can
    // append megabytes before this runs. Never earlier than the baseline -
    // history before the stop is not news. A start inside a line just makes
    // that first fragment unparseable, and it is skipped.
    from = Math.max(baselineBytes, size - MAX_CONTINUED_READ_BYTES);
    const length = size - from;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, from);
    } finally {
      fs.closeSync(fd);
    }
    text = buffer.toString('utf8');
  } catch {
    return false;
  }
  let continued = false;
  let parsedAny = false;
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
    parsedAny = true;
    const verdict = readEntry(entry);
    if (verdict !== undefined) {
      continued = verdict;
    }
  }
  // Wave B, B8 (wave A re-review, m-new-1). The window started past the
  // baseline, so more than MAX_CONTINUED_READ_BYTES was appended, and not one
  // line in it parsed: the last line alone is longer than the window. A
  // synthetic error entry is a few hundred bytes, never megabytes, so a line
  // that long is a real prompt (pasted images, say) and the session moved on.
  // When the window starts AT the baseline, an unparseable tail is only a
  // partial write, which is not news.
  if (from > baselineBytes && !parsedAny) {
    return true;
  }
  return continued;
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

/** Where a `user` entry carrying a local slash command's output starts (review I1). */
const LOCAL_COMMAND_RE = /^\s*<(?:command-name|local-command-stdout|local-command-caveat)>/;

/**
 * What one appended entry says about the stop: true for the session moving
 * on (a real user or assistant entry), false for it stopping again (a flagged
 * user or assistant entry), undefined for neither.
 */
function readEntry(entry: unknown): boolean | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined;
  }
  const e = entry as Record<string, unknown>;
  if (e.type !== 'user' && e.type !== 'assistant') {
    return undefined;
  }
  if (e.isApiErrorMessage === true) {
    return false;
  }
  const message = e.message;
  if (message && typeof message === 'object') {
    const m = message as Record<string, unknown>;
    if (m.model === '<synthetic>') {
      return undefined;
    }
    if (e.type === 'user' && LOCAL_COMMAND_RE.test(leadingText(m.content))) {
      return undefined;
    }
  }
  return true;
}

/** A message's string content, or its first text block's text; '' otherwise. */
function leadingText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const first = content[0] as Record<string, unknown> | undefined;
    if (first && typeof first === 'object' && typeof first.text === 'string') {
      return first.text;
    }
  }
  return '';
}
