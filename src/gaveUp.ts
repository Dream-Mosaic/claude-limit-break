import { MAX_OVERLOAD_RESUMES } from './overloadBackoff';

/**
 * The "gave up" state: resume failures this extension will not retry on its own. Each is recorded per session so the status bar shows it instead of returning to the idle eye, which reads like "nothing happened".
 *
 * Causes:
 * - `stall`     a launched resume's transcript did not grow within the grace period (stallWatch.ts).
 * - `launcher`  no claude executable could be resolved.
 * - `cwd`       the session's recorded folder is gone (or is a file).
 * - `budget`    the budget refusal was dismissed without "Resume anyway".
 * - `overloads` a 6th consecutive overload retry would have been scheduled (overloadBackoff.ts).
 *
 * Pure: no VS Code, filesystem or clock (callers pass `atMs`). One record per session, matching the status bar's one-line-per-session list.
 */

export type GaveUpCause = 'stall' | 'launcher' | 'cwd' | 'budget' | 'overloads';

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
 * circle-slash, not `$(error)` (reads as the extension crashing) or `$(warning)` (blurs into the countdown's warning background): the extension is healthy and has deliberately stopped retrying.
 */
export const GAVE_UP_ICON = '$(circle-slash)';

const short = (sessionId: string) => sessionId.slice(0, 8);

export class GaveUpState {
  private readonly records = new Map<string, GaveUpRecord>();
  /**
   * `${sessionId}\n${cause}` pairs already warned about: warn once per session per cause. Kept apart from `records` because a launched resume clears the record but not this, so a repeat stall shows in the status bar without a second notification. Only a new detection (or Cancel) forgets it.
   */
  private readonly warned = new Set<string>();

  /**
   * Record a failure. Returns whether the caller should notify: true the first time this cause is seen for this session since its last detection, and always when `manual` (the answer to a click must be visible). A repeat replaces the record so the tooltip shows the latest time.
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
   * A new limit/overload detection: the session is live again, so its record and warn-once memory go. Returns whether a record was removed.
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
   * The session finished a turn, so its record goes; its warn-once memory stays. Returns whether a record was removed.
   */
  turnEnded(sessionId: string): boolean {
    return this.records.delete(sessionId);
  }

  /**
   * "Dismiss gave-up notices": every record goes; no job is touched and warn-once memory stays. Returns whether anything was recorded.
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
 * Short per-cause reason for a tooltip line, exported for the unified session list in statusBar.ts, which already shows the id and folder.
 */
export const REASON: Record<GaveUpCause, string> = {
  stall: 'resume stalled: its transcript did not grow after launch',
  launcher: 'could not find the claude executable',
  cwd: 'its folder no longer exists',
  budget: 'over the token budget, and the refusal was dismissed',
  overloads: `kept stopping on server errors (${MAX_OVERLOAD_RESUMES} resumes in a row)`,
};

/**
 * One tooltip line (Markdown) for a gave-up session: short id, folder, cause and time. The folder is user-controlled text.
 */
export function describeGaveUp(r: GaveUpRecord): string {
  const where = r.cwd ? ` in \`${r.cwd}\`` : ' (no folder recorded)';
  return `\`${short(r.sessionId)}\`${where}: ${REASON[r.cause]} (${new Date(r.atMs).toLocaleTimeString()})`;
}

/**
 * The notification for a failure that has just made a session give up, with distinct text per cause. The budget cause has none here: its notification is the refusal itself (budgetRefusalNotice), and a second one would be a nag.
 */
export function gaveUpNotice(
  n:
    | { cause: 'stall'; sessionId: string; cwd?: string; folderTrusted?: boolean }
    | { cause: 'launcher' | 'cwd' | 'overloads'; sessionId: string; cwd?: string },
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
    case 'overloads':
      return (
        `Limit Break: session ${s} kept stopping on server errors (${MAX_OVERLOAD_RESUMES} resumes in a row); ` +
        'giving up until it finishes a turn.'
      );
  }
}

/**
 * The budget refusal: the one notice for the `budget` cause. It offers "Resume anyway", plus the session it is about and the lasting fix.
 */
export function budgetRefusalNotice(sessionId: string, reason: string): string {
  return (
    `Limit Break: not resuming session ${short(sessionId)}. ${reason} ` +
    'Choose "Resume anyway" to go ahead this once, or raise claudeLimitBreak.maxResumeTokens.'
  );
}
