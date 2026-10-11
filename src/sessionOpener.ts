/**
 * The D9 notice's "Open Session" button: bring the session that is waiting into view, in this window only.
 * - A panel: the Claude Code extension's private `claude-vscode.editor.open`, which takes a session id first (read from the 2.1.295 extension's minified source; not smoke-tested). Checked for at run time, like reopenOffer.ts's command.
 * - A terminal: a VS Code terminal whose shell is the claude process or one of its three nearest ancestors.
 * `openSession` never rejects: a failing dependency (including the other extension's private command) means false, "couldn't open".
 */

export const PANEL_OPEN_COMMAND = 'claude-vscode.editor.open';
const MAX_ANCESTORS = 3;

export interface OpenerDeps {
  commands(): Promise<string[]>;
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
  terminals(): { processId: Thenable<number | undefined>; show(): void }[];
  parentPid(pid: number): Promise<number | undefined>;
}

export async function openSession(
  target: { kind: 'panel' | 'terminal'; pid: number; sessionId: string },
  deps: OpenerDeps,
): Promise<boolean> {
  if (target.kind === 'panel') {
    try {
      if (!(await deps.commands()).includes(PANEL_OPEN_COMMAND)) {
        return false;
      }
      await deps.executeCommand(PANEL_OPEN_COMMAND, target.sessionId);
      return true;
    } catch {
      return false;
    }
  }
  const lineage = [target.pid];
  try {
    for (let i = 0; i < MAX_ANCESTORS; i += 1) {
      const parent = await deps.parentPid(lineage[lineage.length - 1]!);
      if (parent === undefined || !Number.isSafeInteger(parent) || parent <= 0 || lineage.includes(parent)) {
        break;
      }
      lineage.push(parent);
    }
  } catch {
    // keep the lineage found so far
  }
  try {
    for (const terminal of deps.terminals()) {
      const pid = await Promise.resolve(terminal.processId).catch(() => undefined);
      if (pid !== undefined && lineage.includes(pid)) {
        terminal.show();
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** The command that prints `pid`'s parent pid; undefined for anything but a positive integer, so nothing else reaches a command line. */
export function parentPidCommand(pid: number, platform: NodeJS.Platform): { file: string; args: string[] } | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (platform === 'win32') {
    return {
      file: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
    };
  }
  return { file: 'ps', args: ['-o', 'ppid=', '-p', String(pid)] };
}
