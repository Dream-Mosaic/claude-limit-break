export interface ResolvedSession {
  sessionId: string;
  transcript: string;
  cwd?: string;
  bytes: number;
}

/**
 * Claude Code names each transcript for its session, so the id is a v4 uuid.
 * Validated rather than trusted: this value is handed to a CLI as an argv
 * element, and a filename is attacker-influenced input on a shared machine.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

const TRANSCRIPT_EXT = '.jsonl';

/**
 * Turn the transcript that produced a detection into a resume target.
 *
 * There is deliberately no search here. Upstream fell back to the newest
 * transcript anywhere under ~/.claude/projects, which could pair one project's
 * session with another project's prompt.
 */
export function resolveSession(
  transcriptPath: string,
  cwd: string | undefined,
  statBytes: (p: string) => number,
): ResolvedSession | undefined {
  // Split on both separators rather than using path.basename: CI runs on Linux
  // as well as Windows, and POSIX basename splits only on "/", so a Windows
  // transcript path would come back as one long segment and be rejected.
  const segments = transcriptPath.split(/[\\/]/);
  const filename = segments[segments.length - 1] ?? '';
  if (!filename.toLowerCase().endsWith(TRANSCRIPT_EXT)) {
    return undefined;
  }
  const sessionId = filename.slice(0, -TRANSCRIPT_EXT.length);
  if (!isSessionId(sessionId)) {
    return undefined;
  }
  let bytes = 0;
  try {
    bytes = statBytes(transcriptPath);
  } catch {
    // A rotated or deleted transcript still has a usable id; the budget check
    // treats zero as "unknown" and falls back to asking.
  }
  return { sessionId, transcript: transcriptPath, cwd, bytes };
}
