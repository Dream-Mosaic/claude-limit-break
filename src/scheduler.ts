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
  /** Deadline the notice actually stated, before jitter. Used for dedupe. */
  baseResumeAtMs: number;
  jitterMs: number;
  reason: 'limit' | 'overload';
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

/**
 * Owns the single pending resume and the countdown that drives it.
 *
 * The countdown is a repeating one-second tick that compares `Date.now()`
 * against the deadline rather than one long `setTimeout`, so suspending or
 * hibernating the machine mid-cooldown cannot skew or swallow the timer.
 */
export class ResumeScheduler {
  private timer?: NodeJS.Timeout;
  private pending?: PendingJob;
  private firing = false;

  private readonly onFireEmitter = new vscode.EventEmitter<PendingJob>();
  private readonly onChangeEmitter = new vscode.EventEmitter<PendingJob | undefined>();

  /** Fires when the cooldown elapses. */
  readonly onFire = this.onFireEmitter.event;
  /** Fires whenever the pending job is set, cleared or ticks down. */
  readonly onChange = this.onChangeEmitter.event;

  constructor(
    private readonly memento: MementoLike,
    private readonly log: Logger,
  ) {
    const stored = memento.get<StoredJob>(STATE_KEY);
    if (stored) {
      // A job saved by a version that predates the random delay has neither
      // field; treating its deadline as the unpadded one keeps dedupe working.
      this.pending = {
        ...stored,
        baseResumeAtMs: stored.baseResumeAtMs ?? stored.resumeAtMs,
        jitterMs: stored.jitterMs ?? 0,
      };
    }
  }

  get current(): PendingJob | undefined {
    return this.pending;
  }

  get msRemaining(): number {
    return this.pending ? this.pending.resumeAtMs - Date.now() : 0;
  }

  /**
   * Arm a resume. A later deadline never replaces an earlier one still counting
   * down: repeated limit notices for the same cooldown would otherwise keep
   * pushing the resume further out.
   */
  schedule(job: PendingJob): boolean {
    const existing = this.pending;
    if (existing && existing.resumeAtMs >= Date.now() && job.resumeAtMs > existing.resumeAtMs) {
      this.log.info(
        `Ignoring later deadline ${new Date(job.resumeAtMs).toISOString()}; ` +
          `already waiting until ${new Date(existing.resumeAtMs).toISOString()}`,
      );
      return false;
    }
    this.pending = job;
    void this.memento.update(STATE_KEY, job);
    const jitter = job.jitterMs > 0 ? `, +${Math.round(job.jitterMs / 60_000)}m random delay` : '';
    this.log.info(
      `Resume scheduled for ${new Date(job.resumeAtMs).toLocaleString()} ` +
        `(reason=${job.reason}, sessionId=${job.sessionId}${jitter}, cwd=${job.cwd ?? 'n/a'})`,
    );
    this.startTicking();
    this.onChangeEmitter.fire(job);
    return true;
  }

  cancel(): void {
    if (!this.pending) {
      return;
    }
    this.log.info('Pending resume cancelled.');
    this.pending = undefined;
    void this.memento.update(STATE_KEY, undefined);
    this.stopTicking();
    this.onChangeEmitter.fire(undefined);
  }

  /**
   * Re-arm the countdown after a window reload or restart. A deadline that
   * already passed while VS Code was closed is not treated specially: the
   * next tick sees it is due and fires it there, exactly as it would for any
   * deadline reached mid-countdown.
   */
  start(): void {
    if (!this.pending) {
      return;
    }
    this.startTicking();
    this.onChangeEmitter.fire(this.pending);
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
    const job = this.pending;
    if (!job) {
      this.stopTicking();
      return;
    }
    if (Date.now() >= job.resumeAtMs) {
      this.consume(job);
      return;
    }
    this.onChangeEmitter.fire(job);
  }

  /** Clear state first, then fire, so a failing handler cannot re-trigger. */
  private consume(job: PendingJob): void {
    if (this.firing) {
      return;
    }
    this.firing = true;
    try {
      this.pending = undefined;
      void this.memento.update(STATE_KEY, undefined);
      this.stopTicking();
      this.onChangeEmitter.fire(undefined);
      this.onFireEmitter.fire(job);
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
