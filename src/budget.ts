/**
 * Bytes of transcript per cache-creation token, calibrated from one measured
 * resume: 1,618,394 bytes -> 288,574 tokens. One data point, so this is an
 * order-of-magnitude guard rather than an accounting figure. Recalibrate as
 * real numbers accumulate.
 */
export const BYTES_PER_TOKEN = 5.6;

export function estimateResumeTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  return Math.round(bytes / BYTES_PER_TOKEN);
}

export interface BudgetVerdict {
  allowed: boolean;
  estimate: number;
  limit: number;
  reason?: string;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * Pre-flight check. A usage-limit wait guarantees a cold prompt cache, so a
 * resume reprocesses the whole session history - recovery competes with the
 * quota it is recovering.
 */
export function checkBudget(bytes: number, maxResumeTokens: number): BudgetVerdict {
  const estimate = estimateResumeTokens(bytes);
  if (maxResumeTokens <= 0) {
    return { allowed: true, estimate, limit: maxResumeTokens };
  }
  if (estimate > maxResumeTokens) {
    return {
      allowed: false,
      estimate,
      limit: maxResumeTokens,
      reason:
        `Resuming this session is estimated at ~${fmt(estimate)} tokens, ` +
        `over the ${fmt(maxResumeTokens)} limit.`,
    };
  }
  return { allowed: true, estimate, limit: maxResumeTokens };
}

/**
 * Post-flight accounting across one incident. Only headless mode can feed this:
 * `--output-format json` returns a `usage` block, while the default interactive
 * mode returns nothing to read. Enforcement in interactive mode is therefore
 * estimate-only, which the settings description states plainly.
 */
export class IncidentBudget {
  private spent = 0;

  add(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.spent += tokens;
    }
  }

  get total(): number {
    return this.spent;
  }

  exceeded(cap: number): boolean {
    return cap > 0 && this.spent > cap;
  }

  reset(): void {
    this.spent = 0;
  }
}
