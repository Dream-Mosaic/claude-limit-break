import { buildEnvelope, buildPayload, inboxLines } from './inbox';
import { modUsable, continuedJob, buildControlBody, controlFileText, type ModStatus } from './modStatus';

/**
 * Continue a live, idle session in place (spec: "Continuing in place"), instead of launching a second `claude --resume`:
 * 1. Choose a transport: the mod when the holder runs it (modStatus.ts modUsable), otherwise the socket.
 * 2. Send through the session's inbox (inbox.ts): a control message the mod consumes, or the enveloped resume prompt.
 * 3. Confirm within CONFIRM_WINDOW_MS: the mod lists the job as continued, or the payload's msg_id is in the transcript.
 * 4. Last look before giving up: the msg_id, or any new turn since the send, means it landed late, and nothing may launch (a launch then would be the fork 1.1 exists to prevent).
 * Anything else is `fallback`, and the caller launches as 1.0 did.
 */

/** No documented delivery time; the spikes' slowest ceiling was 11.5 s. A long window only delays; a short one risks a fork. */
export const CONFIRM_WINDOW_MS = 60_000;
export const CONFIRM_POLL_MS = 1_000;
/** D11: the web client's head start on a bridged panel, from the un-jittered reset. The two continues seen came about 90 s after it. */
export const BRIDGED_GRACE_MS = 5 * 60_000;

export type Transport = 'mod' | 'socket';

export type ContinueOutcome =
  | { kind: 'continued'; transport: Transport; elapsedMs: number }
  | { kind: 'landed-late'; transport: Transport }
  | { kind: 'fallback'; reason: string };

export interface ContinueJob {
  sessionId: string;
  transcript: string;
  prompt: string;
  /** The job's claim key: the control entry's and the mod's job id. */
  jobId: string;
}

export interface ContinueDeps {
  platform: NodeJS.Platform;
  now(): number;
  sleep(ms: number): Promise<void>;
  newId(): string;
  readHolderRecord(pid: number): { sessionId: string; startedAtMs?: number; messagingSocketPath?: string } | undefined;
  readModStatus(sessionId: string): ModStatus | undefined;
  peerToken(pid: number): string | undefined;
  writeControlFile(sessionId: string, text: string): void;
  send(socketPath: string, lines: readonly string[]): Promise<void>;
  transcriptBytes(transcript: string): number | undefined;
  transcriptContains(transcript: string, needle: string, fromBytes: number): boolean;
  continuedSince(transcript: string, bytes: number | undefined): boolean;
}

export async function continueInPlace(job: ContinueJob, holderPid: number, deps: ContinueDeps): Promise<ContinueOutcome> {
  const record = deps.readHolderRecord(holderPid);
  if (!record || record.sessionId !== job.sessionId) {
    return { kind: 'fallback', reason: 'no session record for the holder' };
  }
  if (!record.messagingSocketPath) {
    return { kind: 'fallback', reason: 'the holder has no inbox' };
  }
  const token = deps.peerToken(holderPid);
  if (token === undefined && deps.platform === 'win32') {
    return { kind: 'fallback', reason: 'no inbox token for the holder' };
  }
  const transport: Transport = modUsable(deps.readModStatus(job.sessionId), job.sessionId, record.startedAtMs) ? 'mod' : 'socket';
  const bytesAtSend = deps.transcriptBytes(job.transcript);
  let body = job.prompt;
  if (transport === 'mod') {
    const nonce = deps.newId();
    try {
      deps.writeControlFile(job.sessionId, controlFileText(job.jobId, nonce, deps.now(), job.prompt));
    } catch (err) {
      return { kind: 'fallback', reason: `could not write the control file: ${(err as Error).message}` };
    }
    body = buildControlBody(job.jobId, nonce);
  }
  const msgId = deps.newId();
  const payload = buildPayload(job.sessionId, buildEnvelope(body), msgId);
  const sentAt = deps.now();
  try {
    await deps.send(record.messagingSocketPath, inboxLines(payload, token));
  } catch (err) {
    // Only "nothing listening" proves nothing was written. Any other rejection (deadline, close before the
    // write callback) may have delivered the message, so it is confirmed like a sent one.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      return { kind: 'fallback', reason: `send failed: ${(err as Error).message}` };
    }
  }
  // A throwing check counts as "not seen", so it never rejects the whole continue.
  const seen = (check: () => boolean): boolean => {
    try {
      return check();
    } catch {
      return false;
    }
  };
  const confirmed = () =>
    seen(() => transport === 'mod'
      ? continuedJob(deps.readModStatus(job.sessionId), job.jobId)
      : deps.transcriptContains(job.transcript, msgId, bytesAtSend ?? 0));
  let elapsed: number | undefined;
  try {
    while (deps.now() - sentAt < CONFIRM_WINDOW_MS) {
      if (confirmed()) {
        elapsed = deps.now() - sentAt;
        break;
      }
      await deps.sleep(CONFIRM_POLL_MS);
    }
  } catch {
    // now() or sleep() threw: stop polling and take the last look.
  }
  if (elapsed !== undefined) {
    return { kind: 'continued', transport, elapsedMs: elapsed };
  }
  if (
    confirmed() ||
    seen(() => deps.transcriptContains(job.transcript, msgId, bytesAtSend ?? 0)) ||
    seen(() => deps.continuedSince(job.transcript, bytesAtSend))
  ) {
    return { kind: 'landed-late', transport };
  }
  return { kind: 'fallback', reason: `not confirmed within ${CONFIRM_WINDOW_MS / 1000} s` };
}

/** Whether `needle` occurs in `file` at or after byte `fromBytes`. Unreadable is false. */
export function transcriptContains(
  file: string,
  needle: string,
  fromBytes: number,
  fs: {
    statSync(p: string): { size: number };
    openSync(p: string, flags: string): number;
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
    closeSync(fd: number): void;
  },
): boolean {
  try {
    const size = fs.statSync(file).size;
    // A file smaller than the offset was rewritten or truncated: scan it whole (a fresh msg_id can't false-positive).
    const from = size < fromBytes ? 0 : fromBytes;
    const length = size - from;
    if (length <= 0) {
      return false;
    }
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, from);
      return buffer.toString('utf8').includes(needle);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}
