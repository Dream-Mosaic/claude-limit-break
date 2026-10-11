import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The extension's half of the protocol with Limit Break's Claude Code mod (mod/hooks/control.mjs is the mod's half; test/modStatus.test.ts checks they agree). The mod writes `<dir>/sessions/<id>.json`; the extension writes `<dir>/control/<id>.json`, which the mod checks a control message against. `<dir>` is `~/.limit-break` (spec D7).
 */

export const MOD_PROTOCOL = 1;
export const CONTROL_MARKER = '[limit-break-control v1]';
/** How long a control entry stays valid: long enough for a busy-then-idle session to read its inbox, short enough that a stale one can't be replayed later. */
export const CONTROL_TTL_MS = 120_000;

export function limitBreakDir(home: string = os.homedir()): string {
  return path.join(home, '.limit-break');
}

export function statusFile(dir: string, sessionId: string): string {
  return path.join(dir, 'sessions', `${sessionId}.json`);
}

export function controlFile(dir: string, sessionId: string): string {
  return path.join(dir, 'control', `${sessionId}.json`);
}

export interface ModStatus {
  protocol: number;
  modVersion?: string;
  sessionId: string;
  /** When the mod loaded in its process, ms since the epoch. */
  loadedAtMs: number;
  /** The process moved to this session; this file no longer describes a live one. */
  movedTo?: string;
  continued: { jobId: string; atMs: number }[];
  /** Logged only: the notification types are unverified in the panel. */
  nativeContinue?: { type: string; atMs: number };
}

/** A status file as the mod wrote it, or undefined. `$.fs.write` isn't atomic, so a half-written file is "not yet", read again later. */
export function parseModStatus(text: string): ModStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const s = parsed as Record<string, unknown>;
  if (
    typeof s.protocol !== 'number' ||
    typeof s.sessionId !== 'string' ||
    typeof s.loadedAtMs !== 'number' ||
    !Number.isFinite(s.loadedAtMs) ||
    !Array.isArray(s.continued)
  ) {
    return undefined;
  }
  const continued = s.continued.filter(
    (c): c is { jobId: string; atMs: number } =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as { jobId?: unknown }).jobId === 'string' &&
      Number.isFinite((c as { atMs?: unknown }).atMs),
  );
  // Only a well-formed sighting: a bad `atMs` would make the native-continue check's toISOString() throw and skip its offer.
  const seen = s.nativeContinue as { type?: unknown; atMs?: unknown } | null | undefined;
  const nativeContinue =
    typeof seen === 'object' && seen !== null && typeof seen.type === 'string' && Number.isFinite(seen.atMs)
      ? { type: seen.type, atMs: seen.atMs as number }
      : undefined;
  return {
    protocol: s.protocol,
    ...(typeof s.modVersion === 'string' ? { modVersion: s.modVersion } : {}),
    sessionId: s.sessionId,
    loadedAtMs: s.loadedAtMs,
    ...(typeof s.movedTo === 'string' ? { movedTo: s.movedTo } : {}),
    continued,
    ...(nativeContinue ? { nativeContinue } : {}),
  };
}

/**
 * Whether the live holder of `sessionId` runs the mod. The mod can't report its pid, so the file must have been written by a mod that loaded at or after the holder process started: a file left by an earlier process (the mod since removed, or the session reopened without it) is older than the live one. A control message sent to a session without the mod would reach the model as a peer message, so anything uncertain is "no".
 */
export function modUsable(status: ModStatus | undefined, sessionId: string, holderStartedAtMs: number | undefined): boolean {
  return (
    status !== undefined &&
    status.protocol === MOD_PROTOCOL &&
    status.sessionId === sessionId &&
    status.movedTo === undefined &&
    holderStartedAtMs !== undefined &&
    status.loadedAtMs >= holderStartedAtMs
  );
}

export function continuedJob(status: ModStatus | undefined, jobId: string): boolean {
  return status !== undefined && status.continued.some((c) => c.jobId === jobId);
}

export function buildControlBody(jobId: string, nonce: string, prompt: string): string {
  return `${CONTROL_MARKER} ${JSON.stringify({ jobId, nonce, prompt })}`;
}

/** The whole control file for one continue: a single-use entry (the mod refuses a job it already continued) that expires CONTROL_TTL_MS from now. */
export function controlFileText(jobId: string, nonce: string, nowMs: number): string {
  return JSON.stringify({ protocol: MOD_PROTOCOL, entries: [{ jobId, nonce, expiresAtMs: nowMs + CONTROL_TTL_MS }] }, null, 2);
}
