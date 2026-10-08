import * as nodeFs from 'node:fs';

/**
 * Is a session PAST the stop it was detected at?
 *
 * A resume is only for a live, still-unhandled stop. The job carries the transcript's size at
 * detection (`transcriptBytesAtDetection`); a real `user` or `assistant` entry appended after
 * that means somebody (the user, Claude Code's auto-continue, another window's resume) took
 * the session on, and resuming a session that is still going forks the conversation.
 *
 * But taking it on is not getting past it: a retry that runs into the same limit writes a real
 * prompt and then another flagged error entry, and that session is still stopped. So the
 * appended entries are walked in order: a real one sets "continued", a flagged
 * (`isApiErrorMessage: true`) one clears it, and the LAST of them decides.
 *
 * What neither sets nor clears it:
 * - Unflagged `<synthetic>` assistant entries ("No response requested."): Claude Code talking,
 *   not the session moving.
 * - Local slash commands (`/usage`, `/status`, `/model`): `user` entries starting
 *   `<local-command-caveat>`, `<command-name>` or `<local-command-stdout>`. Checking when a
 *   limit resets is not getting past it. Other `isMeta` entries still count: native
 *   auto-continue's "Continue from where you left off." is one.
 * - Any other entry type (`system`, `summary`, hook and snapshot records).
 * - Unparseable or partial lines: the tail may be mid-write, and a tail read can start mid-line.
 *
 * Fails OPEN (false) when it cannot tell: no baseline, an unreadable transcript, or one now
 * shorter than its baseline. Not knowing is not a reason to strand a session.
 */
export function continuedSince(
  transcriptPath: string,
  baselineBytes: number | undefined,
  fs: ContinuedFs = nodeFs,
): boolean {
  const window = readAppendedWindow(transcriptPath, baselineBytes, fs);
  if (!window) {
    return false;
  }
  const { text, from } = window;
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
  // The window started past the baseline and not one line parsed: the last line alone is longer
  // than the window. A synthetic error entry is never that large, so it is a real prompt and the
  // session moved on. When the window starts AT the baseline, an unparseable tail is only a
  // partial write.
  if (from > (baselineBytes ?? 0) && !parsedAny) {
    return true;
  }
  return continued;
}

/**
 * What was appended to a transcript since `baselineBytes`, bounded to the last
 * {@link MAX_CONTINUED_READ_BYTES} and never before the baseline. Shared with the native
 * auto-continue cancel scan so both read the same bytes. `from` is where the text starts (past
 * the baseline when the cap bit, so its first line may be a fragment). Undefined when
 * unreadable: no or invalid baseline, an unreadable transcript, or one no longer than its baseline.
 */
export function readAppendedWindow(
  transcriptPath: string,
  baselineBytes: number | undefined,
  fs: ContinuedFs = nodeFs,
): { text: string; from: number } | undefined {
  if (baselineBytes === undefined || !Number.isFinite(baselineBytes) || baselineBytes < 0) {
    return undefined;
  }
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= baselineBytes) {
      return undefined;
    }
    // The TAIL, bounded: the last entry decides. Never earlier than the baseline. A start inside
    // a line leaves an unparseable first fragment, which is skipped.
    const from = Math.max(baselineBytes, size - MAX_CONTINUED_READ_BYTES);
    const length = size - from;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, from);
    } finally {
      fs.closeSync(fd);
    }
    return { text: buffer.toString('utf8'), from };
  } catch {
    return undefined;
  }
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

/**
 * Where a `user` entry carrying a local slash command's output starts. stderr counts too: a
 * failing command is no more the session moving on than stdout is.
 */
const LOCAL_COMMAND_RE = /^\s*<(?:command-name|local-command-stdout|local-command-stderr|local-command-caveat)>/;

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
