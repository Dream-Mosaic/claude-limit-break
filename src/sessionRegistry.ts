import * as os from 'node:os';
import * as path from 'node:path';

/**
 * One field lookup in `~/.claude/sessions/<pid>.json`, the file Claude Code
 * writes per live process.
 *
 * Deliberately small. Issue #6 established that this store cannot answer
 * "is that process alive?" - it is keyed by pid, survives the process's
 * death, and nothing checks it. `claude agents --json` answers that (see
 * liveSessions.ts), and this file is read only for a pid that listing has
 * already vouched for, to get the one field the listing does not carry:
 * `entrypoint`, which separates a panel from a terminal.
 *
 * `readFile` is injected rather than imported, the same shape
 * resolveClaudeLauncher uses for `which`/`readShim` in resumer.ts: this reads
 * something the extension does not own, so a test hands it fabricated records
 * instead of depending on whichever Claude Code processes happen to be
 * running on the machine at the time.
 */

export interface SessionRecord {
  sessionId: string;
  /** Absent in records written by a version that did not record it. */
  entrypoint: string | undefined;
  /**
   * Present only when Remote Control has bridged this session, i.e. Claude
   * Code web can drive it too. The key is omitted rather than set to
   * `undefined` when absent, so a record with no bridge looks exactly like it
   * did before this field existed.
   */
  bridgeSessionId?: string;
}

export function sessionRegistryDir(): string {
  return path.join(os.homedir(), '.claude', 'sessions');
}

export function readSessionRecord(
  dir: string,
  pid: number,
  readFile: (p: string) => string,
): SessionRecord | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFile(path.join(dir, `${pid}.json`))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  // The filename is the only thing tying a record to a process, so a record
  // that names a different pid is not describing the process asked about.
  if (parsed.pid !== pid || typeof parsed.sessionId !== 'string') {
    return undefined;
  }
  const record: SessionRecord = {
    sessionId: parsed.sessionId,
    entrypoint: typeof parsed.entrypoint === 'string' ? parsed.entrypoint : undefined,
  };
  if (typeof parsed.bridgeSessionId === 'string' && parsed.bridgeSessionId.length > 0) {
    record.bridgeSessionId = parsed.bridgeSessionId;
  }
  return record;
}
