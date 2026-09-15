import * as vscode from 'vscode';
import type { Logger } from './log';

const STATE_KEY = 'claudeLimitBuster.pending';
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
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * The shape a job may have as read back from the memento. A job saved by a
 * version that predates the random delay has neither `baseResumeAtMs` nor
 * `jitterMs`; the constructor migrates it into a full `PendingJob`.
 */
type StoredJob = Omit<PendingJob, 'baseResumeAtMs' | 'jitterMs'> &
  Partial<Pick<PendingJob, 'baseResumeAtMs' | 'jitterMs'>>;

/** Fill in the fields a job saved before the random delay existed does not have. */
function migrate(stored: StoredJob): PendingJob {
  // Treating its deadline as the unpadded one keeps dedupe working.
  return {
    ...stored,
    baseResumeAtMs: stored.baseResumeAtMs ?? stored.resumeAtMs,
    jitterMs: stored.jitterMs ?? 0,
  };
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

  /** Fires once for each job whose cooldown elapses. */
  readonly onFire = this.onFireEmitter.event;
  /** Fires with the soonest pending job whenever any job is set, cleared or ticks down. */
  readonly onChange = this.onChangeEmitter.event;

  constructor(
    private readonly memento: MementoLike,
    private readonly log: Logger,
  ) {
    // A list since jobs became per-session; a bare object from a version that
    // kept a single slot, which is carried over rather than lost on upgrade.
    const stored = memento.get<StoredJob | StoredJob[]>(STATE_KEY);
    const list = Array.isArray(stored) ? stored : stored ? [stored] : [];
    for (const job of list) {
      this.pending.set(job.sessionId, migrate(job));
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
   */
  schedule(job: PendingJob): boolean {
    const existing = this.pending.get(job.sessionId);
    if (existing && existing.resumeAtMs >= Date.now() && job.resumeAtMs > existing.resumeAtMs) {
      this.log.info(
        `Ignoring later deadline ${new Date(job.resumeAtMs).toISOString()} for ${job.sessionId}; ` +
          `already waiting until ${new Date(existing.resumeAtMs).toISOString()}`,
      );
      return false;
    }
    this.pending.set(job.sessionId, job);
    this.persist();
    const jitter = job.jitterMs > 0 ? `, +${Math.round(job.jitterMs / 60_000)}m random delay` : '';
    this.log.info(
      `Resume scheduled for ${new Date(job.resumeAtMs).toLocaleString()} ` +
        `(reason=${job.reason}, sessionId=${job.sessionId}${jitter}, cwd=${job.cwd ?? 'n/a'})`,
    );
    this.startTicking();
    this.onChangeEmitter.fire(this.current);
    return true;
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
  }
}
