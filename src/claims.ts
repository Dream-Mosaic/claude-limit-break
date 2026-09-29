import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from './log';

/**
 * A machine-wide, filesystem-based claim so that only one VS Code window
 * launches a resume for a given usage-limit reset.
 *
 * Root cause (2026-09-24): every VS Code window runs its own copy of the
 * extension, and with `watchScope: machine` every copy watches every
 * transcript. Two windows can detect the same limit within milliseconds of
 * each other and each schedule their own resume with their own jitter -
 * Task 2's holder check (holderPolicy.ts) catches a second fire MINUTES
 * later, once the first child shows up in `claude agents`, but it cannot
 * catch two windows firing a second or two apart, before that.
 *
 * A plain file, not a locking library: `fs.openSync(path, 'wx')` fails
 * atomically when the file already exists, which is all a "first one wins"
 * claim needs. No process needs to be told when it is done with the claim
 * either - a claim just ages out (see the 1h staleness check here, and the
 * 24h sweep in cleanupStaleClaims), so a window that crashes mid-resume
 * cannot wedge every future attempt shut.
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
 * The key naming the reset a job belongs to - identical across every window
 * watching the same account, so their independent claim attempts collide on
 * purpose.
 *
 * A limit job's key is its un-jittered deadline (`baseResumeAtMs`): every
 * window parses the same "Try again in 5 hours" notice into the same
 * instant, before each window's own random padding is added, so this is
 * stable no matter how differently each window's jitter rolled.
 *
 * An overload job has no stated reset time at all - "the jitter *is* the
 * backoff" (policy.ts) - so its key is the identity of the transcript entry
 * that reported it: `entryTimestampMs`, the entry's own `timestamp`
 * (final review, Important 3). Every window reads the same line, so every
 * window gets the same value, and two separate overloads are two separate
 * entries with two separate timestamps.
 *
 * That replaced a 10-minute bucket of the detection instant
 * (`baseResumeAtMs`, the moment planResume read `now`). The bucket collided
 * across windows as intended, but also with THIS window's own earlier claim:
 * a successful automatic resume leaves its claim fresh for an hour
 * (STALE_MS), so a genuine second overload in the same bucket found the key
 * 'taken' by itself and was dropped. The bucket survives only as the
 * fallback for a job with no entry timestamp (an entry that carried none, or
 * a job persisted by an older build).
 *
 * Fix round 1 history, still true of that fallback: bucketing `resumeAtMs`
 * - the padded fire time, with each window's own independently-rolled
 * jitter in it - put two windows' copies of the same overload in different
 * buckets far more often than not; `baseResumeAtMs` does not have that
 * problem.
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
 * - Fails with EEXIST and the existing file is fresh (under 1h old, per
 *   STALE_MS): someone else already holds it. 'taken'.
 * - Fails with EEXIST and the existing file is stale: it is unlinked here so
 *   the caller can retry the open. 'retry'.
 * - Fails any other way (permissions, a full disk, a bad path): fail open
 *   (Goal 2 - never block a resume nobody is coming back to answer for),
 *   logged so the failure is not silent. 'claimed'.
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
    // "<pid> <ms> <window>": the window identity (vscode.env.sessionId) is
    // what lets claimOwner tell this window's own earlier claim apart from
    // another window's (final review, Important 3). Last, so an older
    // build's two-field file simply reads as having no owner.
    fs.writeSync(fd, owner ? `${process.pid} ${nowMs} ${owner}` : `${process.pid} ${nowMs}`);
  } finally {
    fs.closeSync(fd);
  }
  return 'claimed';
}

/**
 * Claim `key` for this process. See the module doc for why this exists and
 * why a plain file is enough.
 *
 * `dir` and `fs` are both parameters rather than fixed to `claimsDir()` and
 * real `node:fs` - dir so tests use a throwaway temp directory instead of the
 * real machine-wide one, `fs` so a test can simulate the "any other
 * filesystem error" branch without actually breaking the filesystem.
 *
 * Retries at most once, on a stale takeover: if the retry itself hits
 * another 'retry' (another process recreated the file between the unlink and
 * the second open - vanishingly unlikely, but not impossible), this fails
 * open rather than looping.
 */
export function claimResume(
  dir: string,
  key: string,
  nowMs: number,
  fs: ClaimFs,
  log: Logger = noopLog,
  owner?: string,
): ClaimResult {
  fs.mkdirSync(dir, { recursive: true });
  const file = claimPath(dir, key);
  const first = attempt(file, key, nowMs, fs, log, owner);
  if (first !== 'retry') {
    return first;
  }
  const second = attempt(file, key, nowMs, fs, log, owner);
  return second === 'retry' ? 'claimed' : second;
}

/**
 * The window identity recorded in `key`'s claim file by claimResume's
 * `owner`, or undefined when there is no such file, it cannot be read, or it
 * was written without one (an older build). Only ever used to word a log
 * line - "already claimed by this window" rather than "by another window"
 * (final review, Important 3) - never to decide anything: a claim is a claim,
 * whoever holds it.
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
 * Give up a claim this process took out. Called only when a launch off it
 * failed to start, so a later attempt (another window, or a manual retry) is
 * not blocked by a claim nothing is going to act on. A successful launch
 * never calls this, and neither does the Task 2 holder decision declining
 * (final review, Important 2: this window has handled that reset, and
 * releasing let every other window re-offer it); those claims age out on
 * their own (STALE_MS, then cleanupStaleClaims).
 *
 * Missing file is not an error - the claim may already have expired, or
 * never existed (a manual resume that bypassed the claim check entirely).
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
 * Delete claim files older than 24h. Run once on activation - disk hygiene
 * for a machine-wide directory nothing else ever cleans, not a correctness
 * mechanism (STALE_MS, an order of magnitude shorter, is what keeps a claim
 * from blocking anything for long).
 *
 * A missing directory (nothing has ever claimed anything on this machine) is
 * not an error. Only `*.claim` files are touched - anything else in the
 * directory is left alone, though nothing else is expected to be there.
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
