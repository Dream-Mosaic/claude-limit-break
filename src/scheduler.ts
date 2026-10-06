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
  /**
   * Deadline the notice actually stated, before jitter was added. Recorded so a
   * padded resume time can be traced back to what Claude said; the dedupe in
   * schedule() compares resumeAtMs, the deadline actually being waited on.
   */
  baseResumeAtMs: number;
  jitterMs: number;
  reason: 'limit' | 'overload';
  /**
   * Whether `cwd` was trusted for CLI use at schedule time (see trust.ts).
   * Checked once here rather than at fire time, because fire time is when the
   * user has already walked away - too late to do anything about a stall at
   * Claude's trust prompt (#5). Undefined for a job with no cwd to check, or
   * one persisted by a version that predates this field.
   */
  folderTrusted?: boolean;
  /**
   * The `timestamp` of the transcript entry this job was detected from, in
   * ms, when it had one (overload hits only, today). Identifies an overload
   * event across windows for the cross-window claim (claims.ts claimKeyFor;
   * final review, Important 3). Absent on a job persisted by an older build,
   * which falls back to the old 10-minute bucket.
   */
  entryTimestampMs?: number;
  /**
   * The transcript's size when the job was planned (at detection), when it
   * could be read. The baseline for the native auto-continue check (final
   * review, Important 6): a fire is padded 5-30 minutes past the reset, so
   * Claude Code's own auto-continue has usually written - and often finished
   * - its turn before this window fires, and growth has to be measured from
   * before the reset, not from the fire.
   */
  transcriptBytesAtDetection?: number;
  /**
   * Which usage limit stopped the session (`five_hour`, `seven_day`, ...; see
   * LimitDetection.rateLimitType), for a limit job whose detection could tell.
   * decideOnFire reads it: Claude Code's native auto-continue covers the
   * five-hour limit only, so every other type is offered rather than stood
   * down for. Undefined for an overload, for a limit whose text named no
   * type, and for a job persisted before this field existed.
   */
  rateLimitType?: string;
  /**
   * The A6 overload backoff this job was planned with (final fix wave A; the
   * user's decision: +15/+30/+60/+120 minutes for a session's 2nd-5th
   * consecutive overload resume). Already included in `baseResumeAtMs`;
   * kept for the log. Absent for a limit and for a first overload retry.
   */
  backoffMs?: number;
  /**
   * Wave D, D3 (policy B, the user's decision): the limit resets beyond
   * maxWaitHours, so this job is never resumed automatically. It is scheduled
   * like any other - the claim, the status bar and persistence all come with
   * that - but its fire offers Resume Now (the autoResume-off path) instead
   * of launching. Absent, never false, on every other job; restoreJob drops a
   * stored job whose value is anything but `true`, since losing the flag
   * would turn an offer into an automatic resume.
   */
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
 * Validate one entry read back from globalState (final review M2, wave B).
 *
 * The pending and ready lists are the one place a job reaches `claude
 * --resume` without having been parsed from a transcript this run, and
 * globalState is a JSON file anyone can edit, or an older build can have
 * written badly. So nothing is trusted: the session id must pass
 * `isSessionId` (constraint 4: `--resume` only ever receives a UUID), the
 * strings must be strings, the times finite, and `reason` one of the two
 * values the code branches on. A job that fails any of that is dropped, and
 * the caller logs one line for it.
 *
 * Two things are tolerated rather than dropped. A job saved before the random
 * delay existed has neither `baseResumeAtMs` nor `jitterMs`; they are filled
 * in (treating its deadline as the unpadded one keeps the dedupe working). A
 * `rateLimitType` that is not a non-empty string is only a hint to
 * decideOnFire, so the field is deleted and the job kept: dropping a live
 * resume over a label would cost the user more than the label is worth.
 *
 * Returns the very same object when nothing needed changing, so a caller
 * holding the stored array keeps its references.
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
  // Required, unlike baseResumeAtMs: the tick compares against it, and a job
  // with no usable deadline would sit in the list forever without firing.
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
  // Wave D, D3: dropped, never repaired. Deleting a bad offerOnly (the way a
  // bad rateLimitType is repaired below) would turn a resume the user was
  // told would only be offered into an automatic one.
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
  // A list since jobs became per-session; a bare object from a version that
  // kept a single slot, which is carried over rather than lost on upgrade.
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
 * Owns the pending resumes - one per session - and the countdown that drives
 * them.
 *
 * One per session, not one in total. A usage limit belongs to the account, so
 * every session working when it lands hits it at once: on the machine this was
 * written on, 16 of 61 real limit episodes had two or three sessions reporting
 * the same reset within minutes. A single slot kept one of them and dropped
 * the rest without a word.
 *
 * The countdown is a repeating one-second tick that compares `Date.now()`
 * against each deadline rather than one long `setTimeout`, so suspending or
 * hibernating the machine mid-cooldown cannot skew or swallow the timer.
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
  /**
   * Fires with an offer-only job that a same-reset automatic re-detection
   * has just made automatic (wave D fix round 1), so the user can be told.
   */
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
   * Arm a resume for the job's session. A later deadline never replaces an
   * earlier one still counting down for the same session: repeated limit
   * notices for one cooldown would otherwise keep pushing that resume further
   * out. Deadlines belonging to other sessions are never compared at all.
   *
   * Task 10 fix (2026-09-24): `baseResumeAtMs` - the un-jittered reset - is
   * also compared, not just `resumeAtMs`. planResume rolls a fresh random
   * jitter on every detection, so a REPEAT notice for the identical reset
   * produces a different `resumeAtMs` each time; a re-detection that happened
   * to re-roll a SMALLER jitter has an earlier `resumeAtMs` than the job
   * already scheduled, which slipped past the check above (only a strictly
   * LATER resumeAtMs was ever blocked) and replaced it - on 2026-09-24 this
   * moved a window's resume from 2:27:19 to 2:20:11 on a re-detection. Same
   * `baseResumeAtMs` means the same reset no matter which way the new jitter
   * roll moved it, so it is dropped either way, keeping the first schedule.
   *
   * Wave D fix round 1 (Important 1; the user's decision, 2026-10-02): for
   * an offer-only job, the latest detection decides, deterministically. A
   * re-detection of the same reset - bases within RESET_GRACE_MS, since a
   * second read of the same reset can differ by a second - is handled here,
   * before any jitter comparison, which used to let a zero or earlier
   * jitter roll replace the job and silently drop the flag:
   * - automatic (the session hit the limit again within maxWaitHours of the
   *   reset): the job already scheduled is made automatic in place. Its fire
   *   time and base are kept, so its claim key and hold deadline do not move.
   *   `onUpgrade` fires so the user is told; the return is false, as for any
   *   re-detection that did not schedule anew.
   * - offer-only again: nothing changes.
   * And an automatic job is never made offer-only for the same reset. That
   * cannot happen from a real detection (the time left to a reset only
   * shrinks), so it is refused and logged as unexpected.
   */
  schedule(job: PendingJob): boolean {
    const existing = this.pending.get(job.sessionId);
    if (existing && existing.resumeAtMs >= Date.now()) {
      const sameLimitReset =
        existing.reason === 'limit' &&
        job.reason === 'limit' &&
        Math.abs(existing.baseResumeAtMs - job.baseResumeAtMs) <= RESET_GRACE_MS;
      // Wave D fix round 2 (N1): each of the three offer-only branches below
      // returns, so each first takes the newer evidence the re-detection
      // carries, as the plain same-reset drop further down always has. Only
      // there: two automatic jobs keep that drop's own exact-base rule, which
      // is what tells a different reset minutes apart from a re-read.
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
   * What a dropped re-detection of the same reset still contributes to the
   * job already pending, never its schedule or deadline. Called by every
   * same-reset branch of schedule() (wave D fix round 2, N1).
   *
   * - Final fix wave A, A9: it may know which limit this is when the first
   *   detection did not (a text-only notice, then the flagged entry's
   *   quotaLimits). decideOnFire reads the type, so the job adopts it - only
   *   onto a job with none.
   * - Wave A fix round 1 (review C1): where the stop is. A retry that ran
   *   into the same reset again is newer evidence of the live stop, and the
   *   continued-since check (continuedSince.ts) must measure from it, not
   *   from the first detection. Logged like A9's adoption (wave B, B8,
   *   re-review m-new-2): a later "has continued since it stopped" skip is
   *   measured from here.
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

  /**
   * Re-arm the countdown after a window reload or restart. A deadline that
   * already passed while VS Code was closed is not treated specially: the
   * next tick sees it is due and fires it there, exactly as it would for any
   * deadline reached mid-countdown.
   */
  start(): void {
    if (this.pending.size === 0) {
      return;
    }
    this.startTicking();
    this.onChangeEmitter.fire(this.current);
  }

  /**
   * Undefined rather than an empty list when nothing is pending, so an idle
   * store looks exactly as it did before jobs became per-session.
   */
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
