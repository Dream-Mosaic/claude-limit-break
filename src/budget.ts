/**
 * Bytes of transcript per cache-creation token, calibrated from one measured
 * resume: 1,618,394 bytes -> 288,574 tokens. One data point, so this is an
 * order-of-magnitude guard rather than an accounting figure. Recalibrate as
 * real numbers accumulate.
 */
export const BYTES_PER_TOKEN = 5.6;

/**
 * What one assistant turn recorded about the context it ran on.
 *
 * Claude Code writes a `usage` block on every assistant entry. Together these
 * three numbers are the size of the live context at that moment, which is the
 * thing a cold resume has to build again - and unlike the file's byte count,
 * it is measured rather than inferred.
 */
export interface UsageRecord {
  input: number;
  cacheRead: number;
  cacheCreate: number;
}

export function contextTokens(usage: UsageRecord): number {
  return usage.input + usage.cacheRead + usage.cacheCreate;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The newest usage record in a chunk read off the end of a transcript.
 *
 * Scanned backwards, because the last one is the only one that describes the
 * context as it stands now. Lines that do not parse are skipped rather than
 * thrown on: a fixed-size read off the end of a multi-megabyte file lands
 * mid-line, and that fragment is not a record.
 */
export function parseLastUsage(tail: string): UsageRecord | undefined {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    let parsed: { message?: { usage?: Record<string, unknown> } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    const usage = parsed.message?.usage;
    if (!usage) {
      continue;
    }
    return {
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
    };
  }
  return undefined;
}

/**
 * What resuming this session should cost.
 *
 * The byte count is the fallback, not the measure. A transcript accumulates
 * everything ever written to it: turns already summarised away by compaction,
 * whole segments a reload replayed verbatim, and bookkeeping lines that never
 * reach a prompt. On this project's own 11.2 MB session that read 2,007,179
 * tokens, while the session's records showed the largest cache creation it had
 * ever actually paid was 407,570 - so the guard refused a resume costing a
 * quarter of what it claimed, which is exactly the session someone most wants
 * back.
 *
 * A usage record says what the context really is, so it wins whenever one can
 * be read. Bytes remain for a session with no assistant turn yet, where there
 * is nothing else to go on.
 */
export function estimateResumeTokens(bytes: number, usage?: UsageRecord): number {
  if (usage) {
    return contextTokens(usage);
  }
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
export function checkBudget(bytes: number, maxResumeTokens: number, usage?: UsageRecord): BudgetVerdict {
  const estimate = estimateResumeTokens(bytes, usage);
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
