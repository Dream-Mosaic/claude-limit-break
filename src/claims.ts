import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from './log';

/**
 * A machine-wide, filesystem-based claim so only one VS Code window launches a resume for a given usage-limit reset.
 *
 * With `watchScope: machine` every window watches every transcript, so two can detect the same limit within milliseconds and each schedule a resume. holderPolicy.ts only catches a second fire minutes later, once the first child shows in `claude agents`.
 *
 * `fs.openSync(path, 'wx')` fails atomically when the file exists, which is all a "first one wins" claim needs. Claims are never released on success; they age out (STALE_MS, then cleanupStaleClaims), so a crashed window cannot wedge future attempts.
 */

export type ClaimResult = 'claimed' | 'taken';

/** The subset of node:fs this module needs, injected so tests use a real temp directory instead of the machine-wide one, and can fake an unexpected error. */
export interface ClaimFs {
  mkdirSync(p: string, options: { recursive: true }): string | undefined;
  openSync(p: string, flags: string): number;
  writeSync(fd: number, data: string): number;
  closeSync(fd: number): void;
  statSync(p: string): { mtimeMs: number };
  unlinkSync(p: string): void;
  readdirSync(p: string): string[];
}

/** A claim younger than this is still good; older counts as abandoned by a window that never released it (crash, force-quit). */
const STALE_MS = 60 * 60 * 1000;

/** How long a claim file is kept around at all, swept up on activation. Generous next to STALE_MS - this is disk-space hygiene, not a correctness boundary. */
const CLEANUP_MS = 24 * 60 * 60 * 1000;

const CLAIM_SUFFIX = '.claim';

const noopLog: Logger = { info() {}, warn() {}, error() {} };

/** Where claim files live: machine-wide, shared by every window and profile of the same OS user - deliberately outside any per-window or per-workspace store. */
export function claimsDir(): string {
  return path.join(os.tmpdir(), 'claude-limit-break', 'claims');
}

/**
 * The key naming the reset a job belongs to - identical across every window watching the same account, so their claim attempts collide on purpose.
 *
 * A limit job uses its un-jittered deadline (`baseResumeAtMs`): every window parses the same notice into the same instant before adding its own jitter.
 *
 * An overload job has no stated reset time, so it uses `entryTimestampMs`, the reporting transcript entry's own timestamp: the same in every window, and distinct for separate overloads. (A time bucket would collide with this window's own earlier claim, still fresh, and drop a genuine second overload.)
 *
 * With no entry timestamp it falls back to a 10-minute bucket of `baseResumeAtMs`; the padded `resumeAtMs` would put different windows' copies in different buckets.
 */
export function claimKeyFor(job: {
  sessionId: string;
  baseResumeAtMs: number;
  resumeAtMs: number;
  reason: 'limit' | 'overload';
  entryTimestampMs?: number;
}): string {
  if (job.reason === 'overload') {
    if (job.entryTimestampMs !== undefined && Number.isFinite(job.entryTimestampMs)) {
      return `${job.sessionId}-overload-${job.entryTimestampMs}`;
    }
    return `${job.sessionId}-overload-${Math.floor(job.baseResumeAtMs / 600_000)}`;
  }
  return `${job.sessionId}-${job.baseResumeAtMs}`;
}

function claimPath(dir: string, key: string): string {
  return path.join(dir, `${key}${CLAIM_SUFFIX}`);
}

/**
 * One attempt at `fs.openSync(file, 'wx')`.
 *
 * - Succeeds: the claim is ours. 'claimed'.
 * - Fails with EEXIST and the existing file is fresh: someone else holds it. 'taken'.
 * - Fails with EEXIST and the existing file is stale: it is unlinked so the caller can retry. 'retry'.
 * - Fails any other way (permissions, full disk, bad path): fails open, logged. 'claimed'.
 */
function attempt(
  file: string,
  key: string,
  nowMs: number,
  fs: ClaimFs,
  log: Logger,
  owner: string | undefined,
): ClaimResult | 'retry' {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      log.warn(`Claim ${key} could not be created (${String(err)}); resuming as if it were ours.`);
      return 'claimed';
    }
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (statErr) {
      log.warn(`Claim ${key} exists but could not be inspected (${String(statErr)}); resuming as if it were ours.`);
      return 'claimed';
    }
    if (nowMs - mtimeMs < STALE_MS) {
      return 'taken';
    }
    try {
      fs.unlinkSync(file);
    } catch (unlinkErr) {
      log.warn(`Stale claim ${key} could not be removed (${String(unlinkErr)}); resuming as if it were ours.`);
      return 'claimed';
    }
    return 'retry';
  }
  try {
    // "<pid> <ms> <window>": the window identity (vscode.env.sessionId) lets claimOwner tell this window's claim from another's. Last, so an older two-field file reads as ownerless.
    fs.writeSync(fd, owner ? `${process.pid} ${nowMs} ${owner}` : `${process.pid} ${nowMs}`);
  } finally {
    fs.closeSync(fd);
  }
  return 'claimed';
}

/**
 * Claim `key` for this process; see the module doc.
 *
 * `dir` and `fs` are parameters so tests can use a temp directory and simulate filesystem errors.
 *
 * Retries at most once, on a stale takeover; a second 'retry' fails open rather than looping.
 */
export function claimResume(
  dir: string,
  key: string,
  nowMs: number,
  fs: ClaimFs,
  log: Logger = noopLog,
  owner?: string,
): ClaimResult {
  // Fails open like every other filesystem failure here: a throw out of onFire would lose the job silently (VS Code swallows listener errors). No directory means nothing can be claimed.
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.warn(`Claims directory ${dir} could not be created (${String(err)}); resuming as if the claim for ${key} were ours.`);
    return 'claimed';
  }
  const file = claimPath(dir, key);
  const first = attempt(file, key, nowMs, fs, log, owner);
  if (first !== 'retry') {
    return first;
  }
  const second = attempt(file, key, nowMs, fs, log, owner);
  return second === 'retry' ? 'claimed' : second;
}

/**
 * Claim `key` and keep it fresh until `untilMs`, not just STALE_MS from now. Used by Cancel: with watchScope machine every window holds a copy of the job, and a claim at cancel time makes the others drop it. Staleness is measured from the file's mtime, so this sets the mtime to the deadline.
 *
 * A claim someone else holds is left alone ('taken'); a failure to set the mtime is logged and ignored.
 */
export function holdClaim(
  dir: string,
  key: string,
  nowMs: number,
  untilMs: number,
  fs: ClaimFs & { utimesSync(p: string, atime: number, mtime: number): void },
  log: Logger = noopLog,
  owner?: string,
): ClaimResult {
  const result = claimResume(dir, key, nowMs, fs, log, owner);
  if (result === 'claimed' && untilMs > nowMs) {
    try {
      fs.utimesSync(claimPath(dir, key), untilMs / 1000, untilMs / 1000);
    } catch (err) {
      log.warn(`Claim ${key} could not be held until ${new Date(untilMs).toISOString()} (${String(err)}).`);
    }
  }
  return result;
}

/** Slack past the latest possible jittered fire, for a window whose tick, `claude agents` listing or launch runs late. */
export const CLAIM_MARGIN_MS = 10 * 60_000;

/**
 * The one deadline every hold of a job's claim runs to: the automatic fire, the counting Resume Now, and Cancel. Another window's copy can fire anywhere up to the reset plus the longest jitter the setting allows, so a hold to THIS window's fire time could lapse early.
 *
 * The band is read as `randomJitterMs` reads it (an inverted one is the range it describes), and the deadline is never earlier than the job's own `resumeAtMs`. Pure; holdClaim only moves an mtime forward.
 */
export function claimHoldDeadline(
  job: { baseResumeAtMs: number; resumeAtMs: number },
  randomDelayMinMinutes: number,
  randomDelayMaxMinutes: number,
): number {
  const maxJitterMs = Math.max(randomDelayMinMinutes, randomDelayMaxMinutes) * 60_000;
  return Math.max(job.resumeAtMs, job.baseResumeAtMs + maxJitterMs + CLAIM_MARGIN_MS);
}

/**
 * The window identity recorded in `key`'s claim file, or undefined when there is no file, it is unreadable, or it has no owner field.
 *
 * A fresh plan in this window releases a claim on its key only when this window owns it (a Cancel's hold), never another window's. Anything unreadable reads as not ours.
 */
export function claimOwner(
  dir: string,
  key: string,
  fs: { readFileSync(p: string, encoding: 'utf8'): string },
): string | undefined {
  let body: string;
  try {
    body = fs.readFileSync(claimPath(dir, key), 'utf8');
  } catch {
    return undefined;
  }
  const owner = body.trim().split(' ').slice(2).join(' ');
  return owner || undefined;
}

/**
 * Give up a claim this process took out. Called only when a launch off it failed to start, so a later attempt is not blocked. A successful launch never calls this, nor does a holder decision declining: this window has handled that reset, and releasing would let every other window re-offer it. Those claims age out.
 *
 * A missing file is not an error.
 */
export function releaseClaim(dir: string, key: string, fs: ClaimFs, log: Logger = noopLog): void {
  try {
    fs.unlinkSync(claimPath(dir, key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not release claim ${key} (${String(err)}).`);
    }
  }
}

/**
 * Delete claim files older than 24h, once on activation. Disk hygiene for a machine-wide directory, not a correctness mechanism (STALE_MS keeps claims from blocking). A missing directory is not an error; only `*.claim` files are touched.
 */
export function cleanupStaleClaims(dir: string, nowMs: number, fs: ClaimFs, log: Logger = noopLog): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(CLAIM_SUFFIX)) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs >= CLEANUP_MS) {
        fs.unlinkSync(file);
      }
    } catch (err) {
      log.warn(`Could not clean up claim file ${name} (${String(err)}).`);
    }
  }
}
