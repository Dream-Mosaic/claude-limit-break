/**
 * The "gave up" state (plan Task 4, synthesis A8/A9).
 *
 * Some resume failures are final as far as this extension is concerned: it
 * will not try again on its own. Before this module each of them logged (and
 * sometimes notified) once and then the status bar went back to its idle eye,
 * which reads exactly like "nothing ever happened" - the silent failure the
 * whole extension exists to end. So each one is recorded here, per session,
 * and the status bar renders the records until something clears them.
 *
 * The four causes are the ones the code can actually observe today, and no
 * others (the brief forbids inventing detection, e.g. of auth failures):
 *
 * - `stall`    the stall watch fired: a launched resume's transcript did not
 *              grow within the grace period (stallWatch.ts).
 * - `launcher` no claude executable could be resolved, so nothing launched.
 * - `cwd`      the session's recorded folder is gone (or is a file), so
 *              nothing launched.
 * - `budget`   the budget refusal was dismissed without "Resume anyway".
 *
 * Pure: no VS Code, no filesystem, no clock (callers pass `atMs`). One record
 * per session, because the status bar lists sessions, and Task 5b folds these
 * records into the same one-line-per-session tooltip list as pending jobs.
 */

export type GaveUpCause = 'stall' | 'launcher' | 'cwd' | 'budget';

export interface GaveUpRecord {
  sessionId: string;
  /** The session's folder, as recorded in its transcript. Undefined when none was. */
  cwd?: string;
  cause: GaveUpCause;
  /** When it gave up (epoch ms). Refreshed by a repeat of the same failure. */
  atMs: number;
}

/**
 * Status-bar icon for "a session gave up, and nothing is counting down".
 *
 * circle-slash, not warning or error. `$(error)` reads as this extension
 * itself having crashed, which it has not. `$(warning)` reads as a caution
 * about something still in progress - and the countdown already turns the
 * item's background to the warning colour in its last minute, so a warning
 * glyph would blur into that. circle-slash is "stopped, not trying", which is
 * exactly the state: the extension is healthy and has deliberately stopped
 * retrying this session until something clears it. Pinned in gaveUp.test.ts.
 */
export const GAVE_UP_ICON = '$(circle-slash)';

const short = (sessionId: string) => sessionId.slice(0, 8);

export class GaveUpState {
  private readonly records = new Map<string, GaveUpRecord>();
  /**
   * `${sessionId}\n${cause}` pairs already warned about (controller ruling 1:
   * warn once per session per cause). Kept apart from `records` on purpose: a
   * launched resume clears the record but NOT this, so a resume that stalls
   * again after a manual retry is shown in the status bar again without
   * popping the same notification a second time. Only a new detection (or
   * Cancel) forgets it.
   */
  private readonly warned = new Set<string>();

  /**
   * Record a failure. Returns whether the caller should notify: true the
   * first time this cause is seen for this session since its last detection,
   * and always when `manual` - the failure is the answer to something the
   * user just clicked, and a click with no visible answer is the "looks idle"
   * failure this state exists to remove (controller ruling on 4b concern 1).
   * Warn-once is for AUTOMATIC repeats only. Either way the pair is marked
   * warned, and a repeat replaces the record, so the tooltip shows the latest
   * time.
   */
  record(entry: GaveUpRecord, manual = false): boolean {
    this.records.set(entry.sessionId, { ...entry });
    const key = `${entry.sessionId}\n${entry.cause}`;
    if (this.warned.has(key) && !manual) {
      return false;
    }
    this.warned.add(key);
    return true;
  }

  /**
   * A new limit/overload detection for this session (any kind): it is live
   * again, so its record goes, and so does its warn-once memory - the next
   * failure is about a new attempt and is news. Returns whether a record was
   * removed, i.e. whether the status bar needs re-rendering.
   */
  detected(sessionId: string): boolean {
    for (const key of [...this.warned]) {
      if (key.startsWith(`${sessionId}\n`)) {
        this.warned.delete(key);
      }
    }
    return this.records.delete(sessionId);
  }

  /** A resume actually launched for this session: its record goes (see `warned` for what stays). */
  launched(sessionId: string): boolean {
    return this.records.delete(sessionId);
  }

  /**
   * The session finished a turn: it is working again, so its record goes.
   * Not a new detection, so its warn-once memory stays (fix round 1, ruling
   * 2a). Returns whether a record was removed.
   */
  turnEnded(sessionId: string): boolean {
    return this.records.delete(sessionId);
  }

  /**
   * "Dismiss gave-up notices" from the menu: every record goes, and nothing
   * else - no job is touched (the caller never passes it one), and the
   * warn-once memory stays, since dismissing is "I have seen these", not a
   * new attempt (fix round 1, ruling 2b). Returns whether anything was
   * recorded.
   */
  dismissRecords(): boolean {
    const had = this.records.size > 0;
    this.records.clear();
    return had;
  }

  /** Cancel from the menu or the command: everything goes. Returns whether anything was recorded. */
  clearAll(): boolean {
    const had = this.records.size > 0;
    this.records.clear();
    this.warned.clear();
    return had;
  }

  /** Every gave-up session, oldest first, as copies. */
  list(): GaveUpRecord[] {
    return [...this.records.values()].sort((a, b) => a.atMs - b.atMs).map((r) => ({ ...r }));
  }
}

/**
 * Short, per-cause reason for a tooltip line. Each cause reads differently.
 * Exported for Task 5b's unified session-list tooltip (statusBar.ts), which
 * annotates a pending/ready line with just the reason - describeGaveUp below
 * builds a whole standalone line, which is redundant once the id and folder
 * are already on that line from the pending/ready side.
 */
export const REASON: Record<GaveUpCause, string> = {
  stall: 'resume stalled: its transcript did not grow after launch',
  launcher: 'could not find the claude executable',
  cwd: 'its folder no longer exists',
  budget: 'over the token budget, and the refusal was dismissed',
};

/**
 * One tooltip line (Markdown) for a gave-up session: short id, folder, cause
 * and time. Task 5b folds this into its single list; it will need to escape
 * the folder, which is user-controlled text, when it does.
 */
export function describeGaveUp(r: GaveUpRecord): string {
  const where = r.cwd ? ` in \`${r.cwd}\`` : ' (no folder recorded)';
  return `\`${short(r.sessionId)}\`${where}: ${REASON[r.cause]} (${new Date(r.atMs).toLocaleTimeString()})`;
}

/**
 * The notification for a failure that has just made a session give up.
 *
 * Distinct text per cause (synthesis A9), each naming the cause and what the
 * user can do about it. The budget cause is not here: its notification is
 * the refusal itself (budgetRefusalNotice), shown before the user dismisses
 * it - popping a second one right after they closed the first would be the
 * nag this state exists to avoid.
 */
export function gaveUpNotice(
  n:
    | { cause: 'stall'; sessionId: string; cwd?: string; folderTrusted?: boolean }
    | { cause: 'launcher' | 'cwd'; sessionId: string; cwd?: string },
): string {
  const s = short(n.sessionId);
  switch (n.cause) {
    case 'stall':
      // The trust prompt is only blamed when the schedule-time trust check
      // already said so; otherwise the honest answer is "we don't know".
      return (
        `Limit Break: the resume of session ${s} stalled - its transcript has not grown since launch, ` +
        'so it will not be retried automatically.' +
        (n.folderTrusted === false
          ? ' This folder is not trusted by the Claude CLI, which is the most likely reason: Claude is waiting at ' +
            'its trust prompt. Answer it in the resume\'s terminal.'
          : ' Claude may be waiting at a prompt, or may have exited; check the resume\'s terminal.')
      );
    case 'launcher':
      return (
        `Limit Break: could not resume session ${s}: the claude executable was not found. ` +
        'Set claudeLimitBreak.claudeCommand to its full path, then use "Resume Now".'
      );
    case 'cwd':
      return (
        `Limit Break: the folder for session ${s} no longer exists: ${n.cwd}. ` +
        'The resume was not started. Use "Resume Now" again once the folder is back, or check the transcript.'
      );
  }
}

/**
 * The budget refusal: the one notice for the `budget` cause. It already
 * offers the way through ("Resume anyway"); this adds the session it is about
 * and the lasting fix, so a dismissed refusal has told the user everything
 * the gave-up tooltip will later remind them of.
 */
export function budgetRefusalNotice(sessionId: string, reason: string): string {
  return (
    `Limit Break: not resuming session ${short(sessionId)}. ${reason} ` +
    'Choose "Resume anyway" to go ahead this once, or raise claudeLimitBreak.maxResumeTokens.'
  );
}
