import * as path from 'node:path';

import { claudeHome } from './claudeHome';

/**
 * One field lookup in `~/.claude/sessions/<pid>.json`, the file Claude Code writes per live process.
 *
 * Deliberately small: this store is keyed by pid and survives the process's death, so it cannot say whether a process is alive. `claude agents --json` does (liveSessions.ts); this file is read only for a pid that listing has vouched for, to get `entrypoint`, which separates a panel from a terminal.
 *
 * `readFile` is injected so tests hand it fabricated records instead of depending on real Claude Code processes.
 */

export interface SessionRecord {
  sessionId: string;
  /** Absent in records written by a version that did not record it. */
  entrypoint: string | undefined;
  /** Present only when Remote Control has bridged this session, i.e. Claude Code web can drive it too. Omitted, not `undefined`, when absent. */
  bridgeSessionId?: string;
}

export function sessionRegistryDir(): string {
  return path.join(claudeHome(), 'sessions');
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
