import * as net from 'node:net';
import * as path from 'node:path';

/**
 * Posting into a live session's cross-session inbox (`messagingSocketPath` in `~/.claude/sessions/<pid>.json`): a Unix socket, or a named pipe on Windows. Documented by Anthropic (cross-session messaging); the payload's shape and the auth line were confirmed by spike S1 on Windows 2.1.293 (docs/research/2026-10-08-socket-and-mod-spikes.md).
 *
 * The inbox never replies. Delivery is confirmed elsewhere (continueInPlace.ts): by the payload's msg_id in the transcript, or by the mod's status file.
 */

/** The sender name the envelope carries; the panel shows "Message from @limit-break". */
export const SENDER = 'limit-break';

/** The wrapper a `SendMessage` from another session arrives in. Undocumented, read from claude.exe; only the panel's sender row depends on it, not delivery. */
export function buildEnvelope(body: string): string {
  return `<cross-session-message from="uds:${SENDER}" from-name="${SENDER}">\n${body}\n</cross-session-message>`;
}

export interface PeerPayload {
  msgV: 1;
  msg_id: string;
  type: 'user';
  message: { role: 'user'; content: string };
  priority: 'next';
  session_id: string;
}

export function buildPayload(sessionId: string, content: string, msgId: string): PeerPayload {
  return { msgV: 1, msg_id: msgId, type: 'user', message: { role: 'user', content }, priority: 'next', session_id: sessionId };
}

/** What goes down the socket: the auth line first when there is a token (required on Windows), then the payload; each line newline-terminated. */
export function inboxLines(payload: PeerPayload, token: string | undefined): string[] {
  const lines = [JSON.stringify(payload) + '\n'];
  return token === undefined ? lines : [JSON.stringify({ type: 'auth', token }) + '\n', ...lines];
}

/**
 * The session's `peerToken`, from `<dir>/<pid>.<hash>.key` (JSON: peerToken, procStartFt, pidDomain). Only the user's account can read it. Undefined when there is no such file, it is unreadable, or it holds no non-empty peerToken. Never logged.
 */
export function findPeerToken(
  dir: string,
  pid: number,
  listDir: (d: string) => string[],
  readFile: (p: string) => string,
): string | undefined {
  let names: string[];
  try {
    names = listDir(dir);
  } catch {
    return undefined;
  }
  const prefix = `${pid}.`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.key') || name.split('.').length !== 3) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFile(path.join(dir, name))) as { peerToken?: unknown };
      if (typeof parsed.peerToken === 'string' && parsed.peerToken.length > 0) {
        return parsed.peerToken;
      }
    } catch {
      // An unreadable key file is no token.
    }
  }
  return undefined;
}

/**
 * Connect, write `lines`, and close `closeAfterMs` later (spike S1 closed after 2 s, which is what was tested). Always settles: resolves once written; rejects if the connection fails (no such pipe: the process is gone), the write fails, the socket closes before the write, or `timeoutMs` passes first (the socket is then destroyed).
 */
export function sendToInbox(
  socketPath: string,
  lines: readonly string[],
  closeAfterMs = 2_000,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let endTimer: NodeJS.Timeout | undefined;
    const socket = net.createConnection({ path: socketPath });
    const settle = (err?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve();
      }
    };
    const deadline = setTimeout(() => settle(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.on('error', (err) => settle(err));
    socket.on('close', () => {
      clearTimeout(endTimer);
      settle(new Error('closed before the write completed'));
    });
    socket.on('connect', () => {
      socket.write(lines.join(''), (err) => {
        if (err) {
          settle(err);
          return;
        }
        settle();
        endTimer = setTimeout(() => {
          socket.end();
          socket.destroy();
        }, closeAfterMs);
        endTimer.unref?.();
      });
    });
  });
}
