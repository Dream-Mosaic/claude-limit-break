import * as vscode from 'vscode';
import type { Logger } from './log';
import { isSessionId } from './sessionResolver';
import { RESET_GRACE_MS } from './parsers/limitParser';

const STATE_KEY = 'claudeLimitBreak.pending';
const TICK_MS = 1000;

export interface PendingJob {
  sessionId: string;
  transcript: string;
  cwd?: string;
  prompt: string;
  /** Deadline including jitter. What the scheduler fires on. */
  resumeAtMs: number;
  /** Deadline the notice actually stated, before jitter. The dedupe in schedule() compares resumeAtMs, the deadline actually being waited on. */
  baseResumeAtMs: number;
  jitterMs: number;
  reason: 'limit' | 'overload';
  /** Whether `cwd` was trusted for CLI use at schedule time (trust.ts). Checked here rather than at fire time, when the user has already walked away. Undefined for a job with no cwd or one persisted before this field. */
  folderTrusted?: boolean;
  /** The `timestamp` of the transcript entry this job was detected from, in ms (overload hits only). Identifies an overload across windows for the claim (claims.ts claimKeyFor). Absent falls back to the 10-minute bucket. */
  entryTimestampMs?: number;
  /** The transcript's size when the job was planned, when readable: the baseline for the native auto-continue check. A fire is padded past the reset, so Claude Code's auto-continue has usually written its turn by then; growth is measured from before the reset. */
  transcriptBytesAtDetection?: number;
  /** Which usage limit stopped the session (`five_hour`, `seven_day`, ...; LimitDetection.rateLimitType). decideOnFire reads it: native auto-continue covers the five-hour limit only, so every other type is offered. Undefined for an overload, a limit whose text named no type, or an older persisted job. */
  rateLimitType?: string;
  /** The overload backoff this job was planned with (overloadBackoff.ts). Already included in `baseResumeAtMs`; kept for the log. Absent for a limit and for a first overload retry. */
  backoffMs?: number;
  /** The limit resets beyond maxWaitHours, so this job is never resumed automatically: scheduled like any other (claim, status bar, persistence) but its fire offers Resume Now instead of launching. Absent, never false, otherwise; restoreJob drops a stored job with any other value, since losing the flag would turn an offer into an automatic resume. */
  offerOnly?: true;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** What `restoreJob` makes of one stored entry: the job to keep, or why it was dropped. */
export type RestoreResult = { job: PendingJob } | { dropped: string };

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate one entry read back from globalState.
 *
 * The pending and ready lists are where a job reaches `claude --resume` without having been parsed from a transcript this run, and globalState is a JSON file anyone can edit. So nothing is trusted: the session id must pass `isSessionId` (`--resume` only ever receives a UUID), strings must be strings, times finite, and `reason` one of the two values the code branches on. A job failing any of that is dropped and the caller logs it.
 *
 * Two things are tolerated. A job saved before the random delay existed lacks `baseResumeAtMs` and `jitterMs`; they are filled in (its deadline is treated as the unpadded one). A `rateLimitType` that is not a non-empty string is only a hint, so the field is deleted and the job kept.
 *
 * Returns the very same object when nothing needed changing, so a caller holding the stored array keeps its references.
 */
export function restoreJob(raw: unknown): RestoreResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { dropped: 'it is not an object' };
  }
  const j = raw as Record<string, unknown>;
  if (typeof j.sessionId !== 'string' || !isSessionId(j.sessionId)) {
    return { dropped: 'its session id is not a UUID' };
  }
  if (typeof j.transcript !== 'string') {
    return { dropped: 'its transcript is not a string' };
  }
  if (typeof j.prompt !== 'string') {
    return { dropped: 'its prompt is not a string' };
  }
  // Required, unlike baseResumeAtMs: the tick compares against it, and a job with no usable deadline would never fire.
  if (!isFiniteNumber(j.resumeAtMs)) {
    return { dropped: 'its resume time is not a finite number' };
  }
  if (j.reason !== 'limit' && j.reason !== 'overload') {
    return { dropped: 'its reason is neither "limit" nor "overload"' };
  }
  for (const key of ['baseResumeAtMs', 'jitterMs', 'entryTimestampMs', 'transcriptBytesAtDetection', 'backoffMs']) {
    if (j[key] !== undefined && !isFiniteNumber(j[key])) {
      return { dropped: `its ${key} is not a finite number` };
    }
  }
  if (j.cwd !== undefined && typeof j.cwd !== 'string') {
    return { dropped: 'its cwd is not a string' };
  }
  if (j.folderTrusted !== undefined && typeof j.folderTrusted !== 'boolean') {
    return { dropped: 'its folderTrusted is not a boolean' };
  }
  // Dropped, never repaired: deleting a bad offerOnly would turn a promised offer into an automatic resume.
  if (j.offerOnly !== undefined && j.offerOnly !== true) {
    return { dropped: 'its offerOnly is not true' };
  }
  const badType = j.rateLimitType !== undefined && (typeof j.rateLimitType !== 'string' || j.rateLimitType === '');
  if (j.baseResumeAtMs !== undefined && j.jitterMs !== undefined && !badType) {
    return { job: j as unknown as PendingJob };
  }
  const job = {
    ...j,
    baseResumeAtMs: j.baseResumeAtMs ?? j.resumeAtMs,
    jitterMs: j.jitterMs ?? 0,
  } as unknown as PendingJob;
  if (badType) {
    delete job.rateLimitType;
  }
  return { job };
}

/** Restore a stored job list or bare single-slot job into the jobs worth keeping, logging each one dropped. */
export function restoreJobs(stored: unknown, log: Logger, what: string): PendingJob[] {
  // A list; or a bare object from a version that kept a single slot, carried over rather than lost.
  const list: unknown[] = Array.isArray(stored) ? stored : stored === undefined || stored === null ? [] : [stored];
  const kept: PendingJob[] = [];
  for (const entry of list) {
    const result = restoreJob(entry);
    if ('job' in result) {
      kept.push(result.job);
    } else {
      log.warn(`Dropped a stored ${what} resume: ${result.dropped}.`);
    }
  }
  return kept;
}

/**
 * Owns the pending resumes - one per session - and the countdown that drives them. A usage limit belongs to the account, so every session working when it lands hits it at once; a single slot would drop all but one.
 *
 * The countdown is a repeating one-second tick comparing `Date.now()` against each deadline, not one long `setTimeout`, so suspending or hibernating mid-cooldown cannot skew the timer.
 */
export class ResumeScheduler {
  private timer?: NodeJS.Timeout;
  private readonly pending = new Map<string, PendingJob>();
  private firing = false;

  private readonly onFireEmitter = new vscode.EventEmitter<PendingJob>();
  private readonly onChangeEmitter = new vscode.EventEmitter<PendingJob | undefined>();
  private readonly onUpgradeEmitter = new vscode.EventEmitter<PendingJob>();

  /** Fires once for each job whose cooldown elapses. */
  readonly onFire = this.onFireEmitter.event;
  /** Fires with the soonest pending job whenever any job is set, cleared or ticks down. */
  readonly onChange = this.onChangeEmitter.event;
  /** Fires with an offer-only job that a same-reset automatic re-detection has just made automatic, so the user can be told. */
  readonly onUpgrade = this.onUpgradeEmitter.event;

  constructor(
    private readonly memento: MementoLike,
    private readonly log: Logger,
  ) {
    for (const job of restoreJobs(memento.get<unknown>(STATE_KEY), log, 'pending')) {
      this.pending.set(job.sessionId, job);
    }
  }

  /** Every pending job, soonest first. */
  get jobs(): PendingJob[] {
    return [...this.pending.values()].sort((a, b) => a.resumeAtMs - b.resumeAtMs);
  }

  /** The soonest pending job: the one the countdown shows and "Resume Now" means. */
  get current(): PendingJob | undefined {
    return this.jobs[0];
  }

  get msRemaining(): number {
    const soonest = this.current;
    return soonest ? soonest.resumeAtMs - Date.now() : 0;
  }

  /**
   * Arm a resume for the job's session. A later deadline never replaces an earlier one still counting down for the same session, or repeated notices for one cooldown would keep pushing the resume out. Other sessions' deadlines are never compared.
   *
   * `baseResumeAtMs` (the un-jittered reset) is compared too, not just `resumeAtMs`: planResume re-rolls jitter on every detection, so a repeat notice for the identical reset can have an EARLIER `resumeAtMs` and would replace the job. The same base means the same reset, so it is dropped either way, keeping the first schedule.
   *
   * For an offer-only job the latest detection decides. A re-detection of the same reset (bases within RESET_GRACE_MS, since a second read can differ by a second) is handled before any jitter comparison:
   * - automatic (the session hit the limit again within maxWaitHours of the reset): the scheduled job is made automatic in place, keeping its fire time and base so its claim key and hold deadline do not move. `onUpgrade` fires so the user is told; the return is false, as for any re-detection that did not schedule anew.
   * - offer-only again: nothing changes.
   * An automatic job is never made offer-only for the same reset; a real detection cannot do that (the time left only shrinks), so it is refused and logged as unexpected.
   */
  schedule(job: PendingJob): boolean {
    const existing = this.pending.get(job.sessionId);
    if (existing && existing.resumeAtMs >= Date.now()) {
      const sameLimitReset =
        existing.reason === 'limit' &&
        job.reason === 'limit' &&
        Math.abs(existing.baseResumeAtMs - job.baseResumeAtMs) <= RESET_GRACE_MS;
      // Each of the three offer-only branches below returns, so each first takes the newer evidence the re-detection carries, as the plain same-reset drop further down does. Only there: two automatic jobs keep that drop's exact-base rule, which tells a different reset minutes apart from a re-read.
      const touchesOffer = sameLimitReset && (existing.offerOnly === true || job.offerOnly === true);
      if (touchesOffer) {
        this.adoptReDetection(existing, job);
      }
      if (sameLimitReset && existing.offerOnly && !job.offerOnly) {
        delete existing.offerOnly;
        this.persist();
        this.log.info(
          `Re-detection of the same reset for ${job.sessionId} falls within maxWaitHours; ` +
            `its offer-only resume is now automatic, still at ${new Date(existing.resumeAtMs).toISOString()}.`,
        );
        this.onChangeEmitter.fire(this.current);
        this.onUpgradeEmitter.fire(existing);
        return false;
      }
      if (sameLimitReset && existing.offerOnly && job.offerOnly) {
        this.log.info(`Ignoring an offer-only re-detection of the same reset for ${job.sessionId}; already waiting to offer it.`);
        return false;
      }
      if (sameLimitReset && !existing.offerOnly && job.offerOnly) {
        this.log.warn(
          `Unexpected: an offer-only re-detection of a reset ${job.sessionId} already resumes automatically; ` +
            'keeping the automatic resume.',
        );
        return false;
      }
      const sameReset = existing.baseResumeAtMs === job.baseResumeAtMs;
      if (job.resumeAtMs > existing.resumeAtMs || (sameReset && job.resumeAtMs < existing.resumeAtMs)) {
        if (sameReset) {
          this.adoptReDetection(existing, job);
        }
        this.log.info(
          sameReset
            ? `Ignoring re-detection of the same reset for ${job.sessionId} (base ` +
                `${new Date(job.baseResumeAtMs).toISOString()}); keeping the resume already scheduled for ` +
                `${new Date(existing.resumeAtMs).toISOString()}.`
            : `Ignoring later deadline ${new Date(job.resumeAtMs).toISOString()} for ${job.sessionId}; ` +
                `already waiting until ${new Date(existing.resumeAtMs).toISOString()}`,
        );
        return false;
      }
    }
    this.pending.set(job.sessionId, job);
    this.persist();
    const jitter =
      (job.backoffMs ? `, +${Math.round(job.backoffMs / 60_000)}m overload backoff` : '') +
      (job.jitterMs > 0 ? `, +${Math.round(job.jitterMs / 60_000)}m random delay` : '');
    this.log.info(
      `Resume scheduled for ${new Date(job.resumeAtMs).toLocaleString()} ` +
        `(reason=${job.reason}, sessionId=${job.sessionId}${jitter}, cwd=${job.cwd ?? 'n/a'})`,
    );
    this.startTicking();
    this.onChangeEmitter.fire(this.current);
    return true;
  }

  /**
   * What a dropped re-detection of the same reset still contributes to the job already pending, never its schedule or deadline. Called by every same-reset branch of schedule().
   *
   * - The limit type: the first detection may not have known it (a text-only notice, then the flagged entry's quotaLimits). decideOnFire reads it, so the job adopts it, only onto a job with none.
   * - Where the stop is: a retry that ran into the same reset again is newer evidence of the live stop, and the continued-since check (continuedSince.ts) must measure from it. Logged, since a later "has continued since it stopped" skip is measured from here.
   */
  private adoptReDetection(existing: PendingJob, job: PendingJob): void {
    if (existing.rateLimitType === undefined && job.rateLimitType !== undefined) {
      existing.rateLimitType = job.rateLimitType;
      this.persist();
      this.log.info(`Re-detection names the limit for ${job.sessionId} as ${job.rateLimitType}; noted on the pending resume.`);
    }
    if (job.transcriptBytesAtDetection !== undefined && job.transcriptBytesAtDetection !== existing.transcriptBytesAtDetection) {
      const before = existing.transcriptBytesAtDetection;
      existing.transcriptBytesAtDetection = job.transcriptBytesAtDetection;
      this.persist();
      this.log.info(
        `Re-detection moves where the stop is for ${job.sessionId} to byte ${job.transcriptBytesAtDetection} ` +
          `(was ${before ?? 'unknown'}); the detection baseline on the pending resume is refreshed.`,
      );
    }
  }

  /** Cancel one session's pending resume, or every one when no session is named. */
  cancel(sessionId?: string): void {
    if (sessionId === undefined) {
      if (this.pending.size === 0) {
        return;
      }
      this.log.info(
        this.pending.size === 1 ? 'Pending resume cancelled.' : `${this.pending.size} pending resumes cancelled.`,
      );
      this.pending.clear();
    } else {
      if (!this.pending.delete(sessionId)) {
        return;
      }
      this.log.info(`Pending resume for ${sessionId} cancelled.`);
    }
    this.persist();
    if (this.pending.size === 0) {
      this.stopTicking();
    }
    this.onChangeEmitter.fire(this.current);
  }

  /** Re-arm the countdown after a reload or restart. A deadline that passed while VS Code was closed is not special: the next tick sees it is due and fires it. */
  start(): void {
    if (this.pending.size === 0) {
      return;
    }
    this.startTicking();
    this.onChangeEmitter.fire(this.current);
  }

  /** Undefined rather than an empty list when nothing is pending. */
  private persist(): void {
    void this.memento.update(STATE_KEY, this.pending.size > 0 ? this.jobs : undefined);
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private tick(): void {
    if (this.pending.size === 0) {
      this.stopTicking();
      return;
    }
    const now = Date.now();
    const due = this.jobs.filter((job) => now >= job.resumeAtMs);
    if (due.length === 0) {
      this.onChangeEmitter.fire(this.current);
      return;
    }
    this.consume(due);
  }

  /** Clear state first, then fire, so a failing handler cannot re-trigger. */
  private consume(due: PendingJob[]): void {
    if (this.firing) {
      return;
    }
    this.firing = true;
    try {
      for (const job of due) {
        this.pending.delete(job.sessionId);
      }
      this.persist();
      if (this.pending.size === 0) {
        this.stopTicking();
      }
      this.onChangeEmitter.fire(this.current);
      for (const job of due) {
        this.onFireEmitter.fire(job);
      }
    } finally {
      this.firing = false;
    }
  }

  dispose(): void {
    this.stopTicking();
    this.onFireEmitter.dispose();
    this.onChangeEmitter.dispose();
    this.onUpgradeEmitter.dispose();
  }
}
