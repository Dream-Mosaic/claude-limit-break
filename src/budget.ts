/**
 * What one assistant turn recorded about the context it ran on.
 *
 * Claude Code writes a `usage` block on every assistant entry. Together these
 * three numbers are the size of the live context at that moment, which is the
 * thing a cold resume has to build again - and unlike a byte count of the file,
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
 * The newest REAL usage record in a chunk read off the end of a transcript.
 *
 * Scanned backwards, because the last one is the only one that describes the context as it
 * stands now. Lines that do not parse are skipped: a fixed-size read off the end lands mid-line.
 *
 * At a usage limit or an overload the LAST line is Claude Code's synthetic error entry, whose
 * `usage` block is all zeros; reading it estimates 0 tokens and lets every resume through. So
 * an entry only counts if it is a real API turn: not flagged `isApiErrorMessage`, not model
 * `<synthetic>`, and with counted tokens summing to more than zero.
 */
export function parseLastUsage(tail: string): UsageRecord | undefined {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    let parsed: { isApiErrorMessage?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    const usage = parsed.message?.usage;
    if (!usage || parsed.isApiErrorMessage === true || parsed.message?.model === '<synthetic>') {
      continue;
    }
    const record = {
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheCreate: num(usage.cache_creation_input_tokens),
    };
    // Some compaction-boundary turns report 0 here but carry real numbers in
    // cache_creation.ephemeral_1h_input_tokens / usage.iterations[]. They are skipped, so the
    // result is the turn before: an overestimate, never a silent pass.
    if (contextTokens(record) <= 0) {
      continue;
    }
    return record;
  }
  return undefined;
}

/**
 * What resuming this session should cost: the live context of its newest real turn, or
 * `undefined` when no real turn exists.
 *
 * There is no byte-count fallback: a transcript accumulates summarised-away turns, replayed
 * segments and bookkeeping lines, and overestimates badly. A session with no real usage record
 * never completed an API turn, so it is small and unmeasured, not expensive.
 */
export function estimateResumeTokens(usage?: UsageRecord): number | undefined {
  return usage ? contextTokens(usage) : undefined;
}

export interface BudgetVerdict {
  allowed: boolean;
  /** Tokens the resume should cost; undefined when the session is unmeasured. */
  estimate?: number;
  limit: number;
  reason?: string;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * Pre-flight check. A usage-limit wait guarantees a cold prompt cache, so a
 * resume reprocesses the whole session history - recovery competes with the
 * quota it is recovering. An unmeasured session (no usage record) is allowed.
 */
export function checkBudget(maxResumeTokens: number, usage?: UsageRecord): BudgetVerdict {
  const estimate = estimateResumeTokens(usage);
  if (maxResumeTokens <= 0 || estimate === undefined) {
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
