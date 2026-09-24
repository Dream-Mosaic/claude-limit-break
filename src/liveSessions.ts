/**
 * Which other processes are live on a session right now.
 *
 * This exists because of the experiment in
 * docs/research/2026-09-20-panel-fork-experiment.md: a resume into a session
 * still open in a panel tab forks the transcript, and the branch that gets
 * abandoned is the one holding the resumed turn. Knowing a panel is live is
 * what lets the extension say so before the user types into that tab.
 *
 * The source is `claude agents --json`, not `~/.claude/sessions/<pid>.json`
 * directly. Issue #6 established why: those files are keyed by pid, outlive
 * the process that wrote them, and nothing in them proves the pid is alive.
 * `claude agents --json` is the CLI's own consumer of that store and already
 * does the staleness work, including a procStart comparison that guards
 * against pid reuse. It requires --json when stdout is not a TTY.
 *
 * The listing does not carry `entrypoint`, which is the field that separates
 * a panel from a terminal, so that one field is read per pid from the store -
 * but only for a pid the listing has already vouched for. Liveness from the
 * oracle, label from the file.
 */

import { normalizeProjectPath } from './trust';

export interface AgentRow {
  pid: number;
  kind: string;
  sessionId: string;
  /** Absent when the listing did not report it. Needed for the busy-folder check. */
  cwd?: string;
  /** "busy" | "idle" | "waiting" as `claude agents --json` prints it. Absent when not reported. */
  status?: string;
}

/** The entrypoint a Claude Code panel writes into its own session record. */
const PANEL_ENTRYPOINT = 'claude-vscode';

/**
 * Parse `claude agents --json`.
 *
 * Anything unexpected is treated as "no information", never as an error: this
 * runs right after a resume, and a listing that cannot be read is not a reason
 * to interrupt the user. Rows without a numeric pid are dropped - background
 * agent records have an id instead, and #6 found an orphaned one of those that
 * no command could remove.
 */
export function parseAgentRows(stdout: string): AgentRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const rows: AgentRow[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const { pid, kind, sessionId, cwd, status } = row as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof sessionId !== 'string') {
      continue;
    }
    const parsedRow: AgentRow = { pid, kind: typeof kind === 'string' ? kind : '', sessionId };
    // Added only when present and a string: an explicit `undefined` key would
    // fail the exact-shape deepEqual assertions every existing caller uses.
    if (typeof cwd === 'string') {
      parsedRow.cwd = cwd;
    }
    if (typeof status === 'string') {
      parsedRow.status = status;
    }
    rows.push(parsedRow);
  }
  return rows;
}

/**
 * Live interactive processes on `sessionId` other than `ourPid`.
 *
 * `ourPid` is the resume this extension just launched, which is itself a live
 * process on that session - without excluding it every resume would report a
 * second process against itself. It is optional because VS Code resolves
 * Terminal.processId asynchronously and may not have it yet; `undefined`
 * excludes nothing rather than matching something.
 */
export function otherLivePids(
  rows: readonly AgentRow[],
  sessionId: string,
  ourPid: number | undefined,
): number[] {
  return rows
    .filter((r) => r.sessionId === sessionId && r.kind === 'interactive' && r.pid !== ourPid)
    .map((r) => r.pid);
}

/**
 * Whether a panel tab somewhere is holding this session open.
 *
 * `entrypointOf` reads one vouched pid's record; it returns undefined when
 * there is no record to read, which cannot be called a panel. A second
 * *terminal* on the session is deliberately not a panel: it has no tab to
 * reopen, and the offer this feeds is specifically about a stale tab.
 */
export function hasLivePanel(
  rows: readonly AgentRow[],
  sessionId: string,
  ourPid: number | undefined,
  entrypointOf: (pid: number) => string | undefined,
): boolean {
  return otherLivePids(rows, sessionId, ourPid).some((pid) => entrypointOf(pid) === PANEL_ENTRYPOINT);
}

/**
 * Compose the two reads into the question the extension actually asks: is a
 * panel tab holding this session open, other than the resume we just started?
 *
 * `runAgents` returns the raw stdout of `claude agents --json`; `readRecord`
 * reads one pid's file. Both are injected so this can be tested without a
 * `claude` on PATH and without reading the developer's own ~/.claude/sessions,
 * which would make a test depend on whatever happens to be running at the time.
 *
 * A failure to run the listing is "no", not an error: this fires right after a
 * resume, and not knowing is not a reason to interrupt someone.
 *
 * The record must name the same session the listing did. The listing already
 * guards against pid reuse; this catches the other direction, a record left
 * behind by some earlier process that happened to hold the same pid.
 */
export function livePanelDetector(
  runAgents: () => string,
  readRecord: (pid: number) => { sessionId: string; entrypoint: string | undefined } | undefined,
): (sessionId: string, ourPid: number | undefined) => boolean {
  return (sessionId, ourPid) => {
    let stdout: string;
    try {
      stdout = runAgents();
    } catch {
      return false;
    }
    return hasLivePanel(parseAgentRows(stdout), sessionId, ourPid, (pid) => {
      const record = readRecord(pid);
      return record && record.sessionId === sessionId ? record.entrypoint : undefined;
    });
  };
}

/** The per-pid record fields the holder classifier needs. */
export interface HolderRecord {
  sessionId: string;
  entrypoint: string | undefined;
  bridgeSessionId?: string;
}

export type SessionHolder =
  | { kind: 'none' }
  | { kind: 'panel'; pid: number; bridged: boolean }
  | { kind: 'terminal'; pid: number };

/**
 * Who else is holding this session open right now, if anyone.
 *
 * Task 2's reason for existing: resuming into a session a panel or a terminal
 * already holds forks the transcript (see the module doc above). This is the
 * pure decision `scheduler.onFire` asks before it spawns anything - liveness
 * from `rows` (already `claude agents --json`, via `parseAgentRows`), the
 * panel/terminal label from `readRecord`, exactly the same split
 * `livePanelDetector` uses and for the same reason (issue #6: the per-pid
 * file cannot answer "is it alive").
 *
 * A panel wins over a terminal when both are present: the whole list of other
 * live pids is scanned rather than stopping at the first one, so a terminal
 * seen before a panel in the listing's own order cannot pre-empt it. Only one
 * terminal pid is remembered - which one does not matter, since every branch
 * that consumes a 'terminal' result treats any terminal the same way.
 *
 * A live pid whose record cannot be read, or names a different session (pid
 * reuse, or a record left behind by an earlier process, per #6), contributes
 * nothing - it is liveness with no readable label, and cannot be called
 * either a panel or a terminal.
 *
 * Which terminal pid is reported when more than one is live does not matter -
 * every caller that consumes a 'terminal' result treats any terminal the same
 * way - so the loop simply keeps the last one seen rather than guarding for
 * "only the first", which would be a branch nothing distinguishes.
 */
export function classifyHolder(
  rows: readonly AgentRow[],
  sessionId: string,
  ourPid: number | undefined,
  readRecord: (pid: number) => HolderRecord | undefined,
): SessionHolder {
  let terminalPid: number | undefined;
  for (const pid of otherLivePids(rows, sessionId, ourPid)) {
    const record = readRecord(pid);
    if (!record || record.sessionId !== sessionId) {
      continue;
    }
    if (record.entrypoint === PANEL_ENTRYPOINT) {
      return { kind: 'panel', pid, bridged: Boolean(record.bridgeSessionId) };
    }
    terminalPid = pid;
  }
  return terminalPid !== undefined ? { kind: 'terminal', pid: terminalPid } : { kind: 'none' };
}

/**
 * A DIFFERENT session already busy in the same folder as `cwd`, if any.
 *
 * classifyHolder answers "is anyone else on THIS session"; this answers the
 * other case Task 2 asks for: nobody else is on this session, but a second,
 * unrelated Claude session in the same folder is actively working, which is
 * just as much a second writer waiting to happen. Folders are compared with
 * `normalizeProjectPath`, the same folding `trust.ts` uses for the CLI's own
 * project keys, so a Windows drive-letter or slash-direction difference does
 * not hide a real collision.
 *
 * `status: 'busy'` only - an idle or waiting session in the same folder is not
 * actively writing anything right now, so it is not the collision this exists
 * to catch.
 */
export function busyFolderHolder(
  rows: readonly AgentRow[],
  sessionId: string,
  cwd: string,
  platform: NodeJS.Platform,
): AgentRow | undefined {
  const target = normalizeProjectPath(cwd, platform);
  return rows.find(
    (r) =>
      r.sessionId !== sessionId &&
      r.status === 'busy' &&
      r.cwd !== undefined &&
      normalizeProjectPath(r.cwd, platform) === target,
  );
}

/**
 * Compose the listing and the per-pid reads into the question
 * `scheduler.onFire` actually asks: who, if anyone, holds this session?
 *
 * Mirrors {@link livePanelDetector}'s shape, but a listing failure comes back
 * as `'unknown'`, not `'none'` (false there): a plain "no holder" and "the
 * listing itself could not be trusted" call for different handling upstream -
 * `'unknown'` still resumes as usual, but is logged as a listing failure
 * rather than silently agreeing nobody is there. Failing closed here would
 * silently stop every resume on a machine where `claude agents` misbehaves.
 */
export function holderDetector(
  runAgents: () => string,
  readRecord: (pid: number) => HolderRecord | undefined,
): (sessionId: string, ourPid: number | undefined) => SessionHolder | 'unknown' {
  return (sessionId, ourPid) => {
    let stdout: string;
    try {
      stdout = runAgents();
    } catch {
      return 'unknown';
    }
    return classifyHolder(parseAgentRows(stdout), sessionId, ourPid, readRecord);
  };
}
