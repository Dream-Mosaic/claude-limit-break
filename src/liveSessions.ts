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

export interface AgentRow {
  pid: number;
  kind: string;
  sessionId: string;
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
    const { pid, kind, sessionId } = row as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof sessionId !== 'string') {
      continue;
    }
    rows.push({ pid, kind: typeof kind === 'string' ? kind : '', sessionId });
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
