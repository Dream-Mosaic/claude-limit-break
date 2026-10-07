/**
 * Which other processes are live on a session right now. A resume into a session still open in a panel tab forks the transcript, and the abandoned branch is the one holding the resumed turn.
 *
 * The source is `claude agents --json`, not `~/.claude/sessions/<pid>.json`: those files are keyed by pid, outlive their process and prove nothing about liveness. The CLI's listing already does the staleness work, including a procStart comparison that guards against pid reuse. It requires --json when stdout is not a TTY.
 *
 * The listing lacks `entrypoint` (which separates a panel from a terminal), so that field is read per pid from the store, only for a pid the listing has vouched for. Liveness from the listing, label from the file.
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
  /** How `claude agents --json` names the session. Absent when not reported; the coordination prompt (holderPolicy.ts's buildResumePrompt) falls back to the pid then. */
  name?: string;
}

/** The entrypoint a Claude Code panel writes into its own session record. */
const PANEL_ENTRYPOINT = 'claude-vscode';

/**
 * Parse `claude agents --json`. Anything unexpected is "no information", never an error: this runs right after a resume. Rows without a numeric pid are dropped (background agent records have an id instead).
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
    const { pid, kind, sessionId, cwd, status, name } = row as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof sessionId !== 'string') {
      continue;
    }
    const parsedRow: AgentRow = { pid, kind: typeof kind === 'string' ? kind : '', sessionId };
    // Only added when present and a string; an explicit `undefined` key would change the row's shape.
    if (typeof cwd === 'string') {
      parsedRow.cwd = cwd;
    }
    if (typeof status === 'string') {
      parsedRow.status = status;
    }
    if (typeof name === 'string') {
      parsedRow.name = name;
    }
    rows.push(parsedRow);
  }
  return rows;
}

/**
 * Live interactive processes on `sessionId` other than `ourPid`, the resume this extension just launched. Optional because VS Code resolves Terminal.processId asynchronously; `undefined` excludes nothing.
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
 * Whether a panel tab somewhere is holding this session open. `entrypointOf` reads one vouched pid's record; undefined (no record) cannot be called a panel. A second *terminal* is deliberately not a panel: it has no tab to reopen.
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
 * Compose the two reads into: is a panel tab holding this session open, other than the resume we just started?
 *
 * `runAgents` returns the raw stdout of `claude agents --json`; `readRecord` reads one pid's file. Both are injected so tests need no `claude` on PATH and never read the real ~/.claude/sessions.
 *
 * A failure to run the listing is "no", not an error. The record must name the same session the listing did, which catches a record left behind by an earlier process with the same pid.
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
  | { kind: 'panel'; pid: number; bridged: boolean; status: string | undefined }
  | { kind: 'terminal'; pid: number; status: string | undefined };

/**
 * Who else is holding this session open right now, if anyone: the pure decision `scheduler.onFire` asks before it spawns. Liveness comes from `rows` (`parseAgentRows`), the panel/terminal label from `readRecord`, the same split `livePanelDetector` uses.
 *
 * A panel wins over a terminal when both are present, so the whole list is scanned rather than stopping at the first. Only the last terminal pid is kept; every consumer treats any terminal the same way.
 *
 * A live pid whose record cannot be read, or names a different session (pid reuse), contributes nothing.
 *
 * `status` is carried on both results. `readRecord` vouches for the entrypoint but not the status, so status is read from the matching row in `rows`.
 */
export function classifyHolder(
  rows: readonly AgentRow[],
  sessionId: string,
  ourPid: number | undefined,
  readRecord: (pid: number) => HolderRecord | undefined,
): SessionHolder {
  let terminalPid: number | undefined;
  let terminalStatus: string | undefined;
  for (const pid of otherLivePids(rows, sessionId, ourPid)) {
    const record = readRecord(pid);
    if (!record || record.sessionId !== sessionId) {
      continue;
    }
    // One row per live pid, so this lookup is exact.
    const status = rows.find((r) => r.pid === pid)?.status;
    if (record.entrypoint === PANEL_ENTRYPOINT) {
      return { kind: 'panel', pid, bridged: Boolean(record.bridgeSessionId), status };
    }
    terminalPid = pid;
    terminalStatus = status;
  }
  return terminalPid !== undefined ? { kind: 'terminal', pid: terminalPid, status: terminalStatus } : { kind: 'none' };
}

/**
 * Every DIFFERENT session already busy or waiting in the same folder as `cwd`: nobody else is on this session, but unrelated sessions in the folder are working. Every match is returned, since the coordination sentence in holderPolicy.ts's buildResumePrompt names all of them.
 *
 * Folders are compared with `normalizeProjectPath` (as trust.ts does), so a Windows drive-letter or slash-direction difference does not hide a collision. An idle session is not a peer to coordinate with.
 */
export function busyFolderPeers(
  rows: readonly AgentRow[],
  sessionId: string,
  cwd: string,
  platform: NodeJS.Platform,
): AgentRow[] {
  const target = normalizeProjectPath(cwd, platform);
  return rows.filter(
    (r) =>
      r.sessionId !== sessionId &&
      (r.status === 'busy' || r.status === 'waiting') &&
      r.cwd !== undefined &&
      normalizeProjectPath(r.cwd, platform) === target,
  );
}

/**
 * `claude agents --json`, run and parsed - or `'unknown'` when the listing itself could not be run.
 *
 * The single impure step behind both `scheduler.onFire` (holder classification and busy-folder peers, off one snapshot) and a manual resume's live-holder check.
 *
 * `'unknown'`, not an empty list: callers still resume on it but log a listing failure. Failing closed would stop every resume on a machine where `claude agents` misbehaves.
 */
export function agentRowsDetector(runAgents: () => string): () => AgentRow[] | 'unknown' {
  return () => {
    let stdout: string;
    try {
      stdout = runAgents();
    } catch {
      return 'unknown';
    }
    return parseAgentRows(stdout);
  };
}
