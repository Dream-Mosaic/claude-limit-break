/**
 * Recognises "you are out of usage, come back later" messages from Claude Code
 * and works out the wall-clock instant at which work can resume.
 *
 * The wording of these messages has changed over time and differs between the
 * CLI, the API error body and the TUI banner, so detection is deliberately
 * forgiving: a message must first look like a limit notice at all, and then the
 * first rule that yields a *future* instant wins.
 */

export interface LimitDetection {
  resumeAt: Date;
  rule: string;
  text: string;
  /**
   * Which usage limit this is, in Claude Code's vocabulary (`five_hour`, `seven_day`, ...),
   * when it can be told: from `quotaLimits.rateLimitType`, or the label in "You've hit your
   * <label> limit". The key is left off when unknown. Native auto-continue covers only the
   * five-hour limit (see holderPolicy.ts).
   */
  rateLimitType?: string;
  /**
   * The reset lies beyond maxWaitHours but within {@link MAX_RESET_DAYS}: scheduled but never
   * resumed automatically; Resume Now is offered at the reset. Absent (not false) otherwise.
   */
  offerOnly?: true;
}

/** A rule that recognised its shape but could not turn it into an instant, with the reason. */
interface Unparseable {
  unparseable: string;
}

interface Rule {
  id: string;
  re: RegExp;
  resolve(m: RegExpExecArray, now: Date, zone?: string): Date | Unparseable | undefined;
}

/**
 * Why a detected limit is not scheduled: `past` (reset older than {@link RESET_GRACE_MS},
 * e.g. a fork's copy), `absurd` (further than {@link MAX_RESET_DAYS}, a misread), or
 * `unparseable` (with a `detail` when known). `at` is the instant read, for past and absurd.
 */
export interface LimitRejection {
  kind: 'rejected';
  reason: 'past' | 'absurd' | 'unparseable';
  detail?: string;
  at?: Date;
}

/**
 * Outcome for an already-absolute reset instant: `auto` within maxWaitHours, `offerOnly`
 * beyond it but within the bound (the larger of {@link MAX_RESET_DAYS} and maxWaitHours), otherwise rejected.
 */
export type ResetVerdict = { kind: 'auto'; at: Date } | { kind: 'offerOnly'; at: Date } | LimitRejection;

/** What a limit notice's text means: a detection (offer-only or not), or why it is not one. */
export type LimitVerdict = { kind: 'detected'; detection: LimitDetection } | LimitRejection;

/** Strip ANSI SGR/CSI/OSC sequences that terminal output is full of. */
export function stripAnsi(input: string): string {
    return input
        // OSC ... terminated by BEL or ST
        .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
        // CSI and other escape sequences
        .replace(/\x1b[[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g, '')
        // stray control characters, keeping \n and \t
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
/** Normalise punctuation/whitespace so one set of patterns covers all sources. */
export function normalize(input: string): string {
    return stripAnsi(input)
        .replace(/[   ]/g, ' ') // non-breaking spaces
        .replace(/[‘’]/g, "'") // curly quotes
        .replace(/[“”]/g, '"')
        .replace(/[‐-―−]/g, '-') // dashes
        .replace(/[•∙·‧●]/g, ' ') // bullets used as separators
        .replace(/\\n/g, ' ') // JSON-escaped newlines
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * A message must match one of these before any time is extracted. Without this
 * gate, phrases like "resets at 3pm" in ordinary prose would arm a timer.
 */
const LIMIT_HINTS = [
    /usage limit reached/i,
    /\blimit reached\b/i,
    /\b(?:session|usage|weekly|daily|opus|sonnet) limit\b/i,
    /\byour limit\b/i,            // <-- added: documented format, previously missed
    /\brate[- ]limit(?:ed|s)?\b/i,
    /\brate limit exceeded\b/i,
    /you(?:'ve| have)\s+(?:hit|reached|used(?: up)?)\s+(?:your|the)\s+(?:\w+\s+){0,3}limit/i,
    /\bout of (?:tokens|credits|usage|quota)\b/i,
    /\b\d+\s*-?\s*hour limit\b/i,
    /\bquota (?:exceeded|reached|exhausted)\b/i,
    /\bupgrade to (?:claude )?max\b/i,
    /\berror\b[^.]{0,40}\b429\b/i,
    /\b429\b[^.]{0,40}\btoo many requests\b/i,
];
export function looksLikeLimitMessage(text: string): boolean {
    const t = normalize(text);
    return LIMIT_HINTS.some((re) => re.test(t));
}
const HOUR_MS = 3_600_000;

/**
 * The label Claude Code puts in "You've hit your <label> limit" per limit type, keyed by
 * `rateLimitType`. Lower-cased; text is matched case-insensitively. Read by detectLimit and
 * by holderPolicy, which names the label in its log line.
 */
export const RATE_LIMIT_LABELS: Readonly<Record<string, string>> = {
    five_hour: 'session',
    seven_day: 'weekly',
    seven_day_opus: 'Opus',
    seven_day_sonnet: 'Sonnet',
    seven_day_overage_included: 'Fable',
    overage: 'usage credit',
};

/**
 * The limit type a notice names, or undefined. Only the exact "You've hit your <label> limit"
 * form counts: other wordings do not say which window tripped, and guessing would stand the
 * extension down for a limit Claude Code never continues.
 */
export function rateLimitTypeFromText(text: string): string | undefined {
    const m = /\byou'?ve hit your (session|weekly|opus|sonnet|fable|usage credit) limit\b/i.exec(text);
    if (!m) {
        return undefined;
    }
    const label = (m[1] ?? '').toLowerCase();
    return Object.entries(RATE_LIMIT_LABELS).find(([, name]) => name.toLowerCase() === label)?.[0];
}

const COMPACTION_STDERR_OPEN = '<local-command-stderr>';
const COMPACTION_STDERR_CLOSE = '</local-command-stderr>';
const COMPACTION_PREFIX = 'Error during compaction:';

/**
 * The usage-limit text of a failed `/compact`, or undefined when the entry is not exactly that.
 *
 * A compaction that hits a limit is written UNFLAGGED, as a `system`/`local_command` entry.
 * Admitted only when `type` is `system`, `subtype` is `local_command`, and `content` is a string
 * that STARTS with the stderr tag and the compaction prefix and then names a usage limit.
 * Model prose, tool results and user pastes can never be one, so the flagged gate stays
 * closed. Returns the text with tag and prefix stripped, to be read as trusted text.
 */
export function compactionLimitText(entry: Record<string, unknown>): string | undefined {
    if (entry.type !== 'system' || entry.subtype !== 'local_command') {
        return undefined;
    }
    const content = entry.content;
    if (typeof content !== 'string' || !content.startsWith(COMPACTION_STDERR_OPEN + COMPACTION_PREFIX)) {
        return undefined;
    }
    let text = content.slice(COMPACTION_STDERR_OPEN.length + COMPACTION_PREFIX.length);
    if (text.endsWith(COMPACTION_STDERR_CLOSE)) {
        text = text.slice(0, -COMPACTION_STDERR_CLOSE.length);
    }
    text = text.trim();
    return looksLikeLimitMessage(text) ? text : undefined;
}
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The furthest out a reset is believed. The longest limits are seven-day, so a weekly reset
 * is at most 7 days out; a day of slack covers zone or rounding differences. Later is a
 * misread and rejected, unless the user set maxWaitHours higher, which then is the bound.
 */
export const MAX_RESET_DAYS = 8;

/**
 * Sort a resolved reset instant into policy outcomes. `basis` is what the horizons are
 * measured from (the entry's timestamp for text, the real time for a structured value);
 * `readAt` is what staleness is judged against. Past is checked first. Both bounds are inclusive.
 */
function classifyReset(at: Date, basis: Date, readAt: Date, maxWaitHours: number): ResetVerdict {
    if (at.getTime() < readAt.getTime() - RESET_GRACE_MS) {
        return { kind: 'rejected', reason: 'past', at };
    }
    if (at.getTime() > basis.getTime() + Math.max(MAX_RESET_DAYS * DAY_MS, maxWaitHours * HOUR_MS)) {
        return { kind: 'rejected', reason: 'absurd', at };
    }
    if (at.getTime() > basis.getTime() + maxWaitHours * HOUR_MS) {
        return { kind: 'offerOnly', at };
    }
    return { kind: 'auto', at };
}
/** Keywords that legitimately introduce a "come back at/in ..." clause. */
const LEAD_IN = '(?:try again|check back|come back|retry|reset(?:s|ting)?|wait|available(?: again)?|continue|resume|back)';
/**
 * Milliseconds a named zone is ahead of UTC at a given instant, or undefined if
 * the runtime does not know the zone.
 */
function zoneOffsetMs(timeZone: string, at: Date): number | undefined {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).formatToParts(at);
        const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
        const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
        return Number.isNaN(wallAsUtc) ? undefined : wallAsUtc - at.getTime();
    }
    catch {
        return undefined;
    }
}
/** The calendar date currently showing in a named zone. */
function zoneToday(timeZone: string, at: Date): { y: number; m: number; d: number } | undefined {
    const offset = zoneOffsetMs(timeZone, at);
    if (offset === undefined) {
        return undefined;
    }
    const shifted = new Date(at.getTime() + offset);
    return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}
/**
 * The wall-clock date and time a named zone reads at a given instant, as a
 * sortable string - used only to compare two instants for "same local
 * reading", never parsed back into a Date.
 */
function renderedWallClock(timeZone: string, at: Date): string | undefined {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).formatToParts(at);
        const get = (type: string) => parts.find((p) => p.type === type)?.value;
        return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
    }
    catch {
        return undefined;
    }
}

/**
 * The instant at which a named zone's wall clock reads the given date and time.
 * Iterates twice so a reading that lands on a DST transition still converges.
 *
 * Fall-back repeats a wall-clock hour and the loop lands on the earlier instant; it steps
 * forward an hour to prefer the later one: waking late finds a live limit safe to re-check,
 * waking early risks resuming into a session that has not reset.
 *
 * Spring-forward skips an hour, and a reading inside the gap lands an hour early (the same
 * unsafe direction). It is corrected by taking the requested time with the offset in force
 * BEFORE the jump; a flat extra hour is wrong east of UTC.
 */
function zonedWallClockToInstant(
    timeZone: string,
    y: number,
    m: number,
    d: number,
    hour: number,
    minute: number
): Date | undefined {
    const target = Date.UTC(y, m, d, hour, minute, 0, 0);
    let instant = target;
    for (let i = 0; i < 2; i++) {
        const offset = zoneOffsetMs(timeZone, new Date(instant));
        if (offset === undefined) {
            return undefined;
        }
        instant = target - offset;
    }
    const candidate = new Date(instant);
    const oneHourLater = new Date(instant + HOUR_MS);
    if (renderedWallClock(timeZone, candidate) === renderedWallClock(timeZone, oneHourLater)) {
        return oneHourLater;
    }
    // Spring-forward gap: the result does not read back the requested hour and minute. Use the
    // pre-jump offset, which lands on the safe, later side.
    const requested = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (renderedWallClock(timeZone, candidate)?.slice(-5) !== requested) {
        const dayBefore = zoneOffsetMs(timeZone, new Date(target - DAY_MS));
        const dayAfter = zoneOffsetMs(timeZone, new Date(target + DAY_MS));
        if (dayBefore === undefined || dayAfter === undefined) {
            return oneHourLater;
        }
        return new Date(target - Math.min(dayBefore, dayAfter));
    }
    return candidate;
}
const RULES: Rule[] = [
    {
        // Epoch seconds or millis.
        id: 'epoch',
        re: /limit reached\s*[|:]\s*(\d{9,13})\b/i,
        resolve(m) {
            const n = Number(m[1] ?? '');
            if (!Number.isFinite(n) || n <= 0) {
                return undefined;
            }
            // <1e12 is unambiguously seconds; anything larger is already millis.
            return new Date(n < 1e12 ? n * 1000 : n);
        },
    },
    {
        // ISO timestamp. The lead-in must sit within a few characters of it with no quote between,
        // or the rule would read a transcript line's own "timestamp" field.
        id: 'iso',
        re: /(?:reset(?:s|ting)?|try again|available|come back|until)\b[^"\n]{0,30}?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
        resolve(m) {
            const d = new Date((m[1] ?? '').replace(' ', 'T'));
            return Number.isNaN(d.getTime()) ? undefined : d;
        },
    },
    {
        // Relative duration.
        id: 'duration-hours',
        re: new RegExp(`${LEAD_IN}\\s*(?:in|after|for)?\\s*(?:about|approximately|roughly|~)?\\s*` +
            // Longest alternative first, so "hours" is never chopped down to "hour"
            // and left with a stray "s" that breaks the minutes group.
            `(\\d{1,2})\\s*(?:hours|hour|hrs|hr|h)\\b` +
            `(?:\\s*(?:and\\s*)?(\\d{1,2})\\s*(?:minutes|minute|mins|min|m)\\b)?`, 'i'),
        resolve(m, now) {
            const hours = Number(m[1] ?? '');
            const minutes = m[2] ? Number(m[2]) : 0;
            if (hours === 0 && minutes === 0) {
                return undefined;
            }
            return new Date(now.getTime() + hours * HOUR_MS + minutes * MINUTE_MS);
        },
    },
    {
        // Relative minutes only.
        id: 'duration-minutes',
        re: new RegExp(`${LEAD_IN}\\s*(?:in|after|for)?\\s*(?:about|approximately|roughly|~)?\\s*` +
            `(\\d{1,3})\\s*(?:minutes|minute|mins|min|m)\\b`, 'i'),
        resolve(m, now) {
            const minutes = Number(m[1] ?? '');
            return minutes > 0 ? new Date(now.getTime() + minutes * MINUTE_MS) : undefined;
        },
    },
    {
        // Dated form: short month, day, then a comma or " at", an hour and am/pm. The zone is
        // optional in the pattern only so a notice without one is recognised and rejected with a reason.
        id: 'dated-reset',
        re: /reset(?:s|ting)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:,|\s+at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(\s*([^()\s]+)\s*\))?/i,
        resolve(m, now) {
            return resolveDatedReset(m, now);
        },
    },
    {
        // Weekday form; read only with a zone in parentheses, like the dated form.
        id: 'weekday-reset',
        re: /reset(?:s|ting)?\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(\s*([^()\s]+)\s*\))?/i,
        resolve(m, now) {
            return resolveWeekdayReset(m, now);
        },
    },
    {
        // Clock reset. The hour may not run on into more digits, or an ISO date's year would be
        // read as an hour.
        id: 'clock-reset',
        re: /reset(?:s|ting)?(?:\s+(?:at|around))?\s+(\d{1,2})(?!\d)(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*(?:(utc|gmt|z)\s*([+-]\d{1,2})?(?::?(\d{2}))?|([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+))?\s*\)?/i,
        resolve(m, now, zone) {
            return resolveClockTime(m, now, zone);
        },
    },
    {
        // "try again at" form; same hour restriction as clock-reset above.
        id: 'clock-retry',
        re: /(?:try again|available(?: again)?|come back|check back|back)\s+(?:at|after)\s+(\d{1,2})(?!\d)(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*(?:(utc|gmt|z)\s*([+-]\d{1,2})?(?::?(\d{2}))?|([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+))?\s*\)?/i,
        resolve(m, now, zone) {
            return resolveClockTime(m, now, zone);
        },
    },
];
/**
 * The soonest instant, from `today` forward up to two calendar days, at which the named zone
 * reads `h:minute` and is still in the future relative to `now`, or within {@link
 * RESET_GRACE_MS} past it. The grace keeps a notice read just after its own time from rolling
 * to tomorrow. Re-derives the wall clock per date rather than adding a flat 24h, so a DST
 * change does not shift the result an hour early.
 */
function nextZonedOccurrence(
    zone: string,
    today: { y: number; m: number; d: number },
    h: number,
    minute: number,
    now: Date
): Date | undefined {
    for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
        const attempt = zonedWallClockToInstant(zone, today.y, today.m, today.d + dayOffset, h, minute);
        if (attempt && attempt.getTime() >= now.getTime() - RESET_GRACE_MS) {
            return attempt;
        }
    }
    return undefined;
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The 24-hour hour for a 1-12 reading and its meridiem, or undefined when the
 * reading is not a real time ("13pm", "0am", ":75").
 */
function meridiemHour(hourText: string | undefined, minuteText: string | undefined, meridiem: string | undefined): number | undefined {
    const hour = Number(hourText ?? '');
    const minute = minuteText ? Number(minuteText) : 0;
    if (!Number.isInteger(hour) || hour < 1 || hour > 12 || minute > 59) {
        return undefined;
    }
    return (hour % 12) + (meridiem?.toLowerCase() === 'pm' ? 12 : 0);
}

/**
 * The zone a dated or weekday notice names, checked against the runtime's zone data, or why
 * it cannot be used. Required: this machine's zone is only a guess at Claude Code's.
 */
function noticeZone(zone: string | undefined, now: Date): { zone: string; today: { y: number; m: number; d: number } } | Unparseable {
    if (!zone) {
        return { unparseable: 'a dated reset with no time zone' };
    }
    const today = zoneToday(zone, now);
    return today ? { zone, today } : { unparseable: `an unknown time zone (${zone})` };
}

/**
 * "Aug 4, 1am (America/Chicago)": that reading in the first year whose occurrence is on or
 * after `now` less {@link RESET_GRACE_MS}. The year starts from the zone's own calendar, not
 * UTC's. A day the month lacks is rejected, not rolled over as Date.UTC would.
 */
function resolveDatedReset(m: RegExpExecArray, now: Date): Date | Unparseable {
    const month = MONTHS.indexOf((m[1] ?? '').toLowerCase());
    const day = Number(m[2] ?? '');
    const hour = meridiemHour(m[3], m[4], m[5]);
    const minute = m[4] ? Number(m[4]) : 0;
    const zoned = noticeZone(m[6], now);
    if ('unparseable' in zoned) {
        return zoned;
    }
    if (hour === undefined) {
        return { unparseable: 'not a real time' };
    }
    let latest: Date | undefined;
    for (const year of [zoned.today.y, zoned.today.y + 1]) {
        if (day < 1 || new Date(Date.UTC(year, month, day)).getUTCMonth() !== month) {
            continue;
        }
        const at = zonedWallClockToInstant(zoned.zone, year, month, day, hour, minute);
        if (!at) {
            return { unparseable: `an unknown time zone (${zoned.zone})` };
        }
        latest = at;
        if (at.getTime() >= now.getTime() - RESET_GRACE_MS) {
            return at;
        }
    }
    return latest ?? { unparseable: 'not a real date' };
}

/**
 * "Mon 12:00am (America/Chicago)": the first such weekday, from the zone's own today, on or
 * after `now` less {@link RESET_GRACE_MS}. Eight days are walked so today's weekday, if
 * passed, rolls to next week.
 */
function resolveWeekdayReset(m: RegExpExecArray, now: Date): Date | Unparseable {
    const weekday = WEEKDAYS.indexOf((m[1] ?? '').toLowerCase());
    const hour = meridiemHour(m[2], m[3], m[4]);
    const minute = m[3] ? Number(m[3]) : 0;
    const zoned = noticeZone(m[5], now);
    if ('unparseable' in zoned) {
        return zoned;
    }
    if (hour === undefined) {
        return { unparseable: 'not a real time' };
    }
    const { y, m: month, d } = zoned.today;
    for (let offset = 0; offset <= 7; offset++) {
        if (new Date(Date.UTC(y, month, d + offset)).getUTCDay() !== weekday) {
            continue;
        }
        const at = zonedWallClockToInstant(zoned.zone, y, month, d + offset, hour, minute);
        if (at && at.getTime() >= now.getTime() - RESET_GRACE_MS) {
            return at;
        }
    }
    return { unparseable: `an unknown time zone (${zoned.zone})` };
}

/**
 * Turn a bare clock reading into the next future instant.
 *
 * Without a meridiem a 1-12 reading is ambiguous ("resets 3" could be 3am or
 * 3pm), so both readings are considered and the soonest future one wins - a
 * limit notice always refers to the *next* occurrence.
 */
function resolveClockTime(m: RegExpExecArray, now: Date, zone?: string): Date | undefined {
    const hour = Number(m[1] ?? '');
    const minute = m[2] ? Number(m[2]) : 0;
    const meridiem = m[3]?.toLowerCase();
    const tzName = m[4]?.toLowerCase();
    const rawOffset = m[5] ?? '';
    const tzOffsetHours = rawOffset ? Number(rawOffset) : 0;
    const tzOffsetMinutes = m[6] ? Number(m[6]) : 0;
    // An IANA zone name, as Claude Code's own banner uses: "(Asia/Jerusalem)".
    const ianaZone = m[7];
    if (!Number.isFinite(hour) || hour > 23 || minute > 59) {
        return undefined;
    }
    const candidateHours = [];
    if (meridiem) {
        candidateHours.push((hour % 12) + (meridiem === 'pm' ? 12 : 0));
    }
    else if (hour >= 1 && hour <= 12) {
        candidateHours.push(hour, (hour % 12) + 12);
    }
    else {
        candidateHours.push(hour);
    }
    const utcBased = Boolean(tzName);
    // The sign on the hours part governs the whole offset: UTC-5:30 is -5h30m.
    const offsetSign = rawOffset.startsWith('-') ? -1 : 1;
    const signedOffsetMs = utcBased
        ? offsetSign * (Math.abs(tzOffsetHours) * HOUR_MS + tzOffsetMinutes * MINUTE_MS)
        : 0;
    // Resolve against the named zone's own calendar day, so a reading like
    // "1:40am (Asia/Jerusalem)" is correct regardless of where this machine is.
    const zoneDay = ianaZone ? zoneToday(ianaZone, now) : undefined;
    if (ianaZone && !zoneDay) {
        return undefined;
    }
    let best;
    for (const h of candidateHours) {
        let candidate;
        if (zoneDay && ianaZone) {
            candidate = nextZonedOccurrence(ianaZone, zoneDay, h, minute, now);
            if (!candidate) {
                continue;
            }
        }
        else if (utcBased) {
            // Interpret h:mm as a reading in UTC+offset, then convert to a real instant.
            candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, minute, 0, 0) -
                signedOffsetMs);
            // A numeric UTC offset carries no DST rules of its own, so a flat day is exact.
            while (candidate.getTime() <= now.getTime()) {
                candidate = new Date(candidate.getTime() + DAY_MS);
            }
        }
        else {
            // No zone named: use the given zone (an override, since `TZ` is not reliably honoured by
            // Node on Windows) or the process zone. Walk forward as the named-zone branch does.
            const localZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
            const today = zoneToday(localZone, now);
            candidate = today ? nextZonedOccurrence(localZone, today, h, minute, now) : undefined;
            if (!candidate) {
                continue;
            }
        }
        if (!best || candidate.getTime() < best.getTime()) {
            best = candidate;
        }
    }
    return best;
}
/**
 * How far in the past a resolved reset may lie and still count as due now rather than
 * history: a session left alone past its reset needs resuming now. Covers a fork's write
 * and the poll interval.
 */
export const RESET_GRACE_MS = 15 * 60_000;

/**
 * Scan text for a usage-limit notice. Returns the detection (offer-only or not), or undefined
 * for both "not a notice" and "a notice that cannot be scheduled"; use {@link classifyLimit}
 * to tell those apart.
 *
 * `now` is what the notice is resolved against (the entry's own timestamp when known).
 * `opts.readAt` is the real current time, used only to judge whether a passed reset is within
 * {@link RESET_GRACE_MS}; it defaults to `now`.
 *
 * `maxWaitHours` decides automatic versus offer-only; a reset beyond the larger of
 * {@link MAX_RESET_DAYS} and maxWaitHours is rejected as a misread.
 */
export function detectLimit(
    rawText: string,
    now: Date = new Date(),
    maxWaitHours: number = 24,
    opts: { trusted?: boolean; zone?: string; readAt?: Date } = {}
): LimitDetection | undefined {
    const verdict = classifyLimit(rawText, now, maxWaitHours, opts);
    return verdict?.kind === 'detected' ? verdict.detection : undefined;
}

/**
 * {@link detectLimit}, telling its outcomes apart. Undefined when the text is not a limit
 * notice at all (no limit wording, too long, or untrusted text that looks like code or a
 * quotation); otherwise `detected` (`offerOnly` when beyond maxWaitHours) or `rejected` with
 * the reason.
 *
 * The first automatic rule wins; failing that the first offer-only; failing that the first
 * rule's rejection reason (unparseable if none matched).
 */
export function classifyLimit(
    rawText: string,
    now: Date = new Date(),
    maxWaitHours: number = 24,
    opts: { trusted?: boolean; zone?: string; readAt?: Date } = {}
): LimitVerdict | undefined {
    const text = normalize(rawText);
    if (!text || text.length > MAX_NOTICE_LENGTH) {
        return undefined;
    }
    if (!looksLikeLimitMessage(text)) {
        return undefined;
    }
    // Source code, a percentage-usage readout and visibly quoted text are not notices. Skipped
    // for a trusted (flagged) entry.
    if (!opts.trusted && (looksLikeCode(text) || looksLikePercentageUsage(text) || looksLikeQuotedNotice(rawText))) {
        return undefined;
    }
    const readAt = opts.readAt ?? now;
    const rateLimitType = rateLimitTypeFromText(text);
    const detection = (at: Date, rule: string, offerOnly: boolean): LimitDetection => ({
        resumeAt: at,
        rule,
        text,
        ...(rateLimitType !== undefined ? { rateLimitType } : {}),
        ...(offerOnly ? { offerOnly: true as const } : {}),
    });
    let offer: LimitDetection | undefined;
    let rejection: LimitRejection | undefined;
    for (const rule of RULES) {
        const m = rule.re.exec(text);
        if (!m) {
            continue;
        }
        const at = rule.resolve(m, now, opts.zone);
        if (at && !(at instanceof Date)) {
            rejection ??= { kind: 'rejected', reason: 'unparseable', detail: at.unparseable };
            continue;
        }
        if (!at || Number.isNaN(at.getTime())) {
            continue;
        }
        // A reset inside the grace window is returned as-is (resumeAt at or before readAt): the
        // "due now" signal the scheduler already understands.
        const verdict = classifyReset(at, now, readAt, maxWaitHours);
        if (verdict.kind === 'auto') {
            return { kind: 'detected', detection: detection(at, rule.id, false) };
        }
        if (verdict.kind === 'offerOnly') {
            offer ??= detection(at, rule.id, true);
            continue;
        }
        rejection ??= verdict;
    }
    if (offer) {
        return { kind: 'detected', detection: offer };
    }
    return rejection ?? { kind: 'rejected', reason: 'unparseable' };
}

/**
 * Resolve an already-absolute reset time (`quotaLimits.resetsAt`, epoch seconds) against the
 * same grace and horizon rules a parsed notice gets. It wins over the text because nothing
 * can be misread; it is checked only for staleness and absurdity (beyond the larger of {@link MAX_RESET_DAYS} and maxWaitHours).
 *
 * The result says which outcome it is: automatic, offer-only, or rejected with a reason.
 * `now` is the real time, used for both horizons and the grace check.
 */
export function resolveStructuredReset(
    resetsAtSeconds: number,
    now: Date,
    maxWaitHours: number
): ResetVerdict {
    if (!Number.isFinite(resetsAtSeconds)) {
        return { kind: 'rejected', reason: 'unparseable' };
    }
    return classifyReset(new Date(resetsAtSeconds * 1000), now, now, maxWaitHours);
}
/**
 * A genuine limit banner is a short line. Anything longer is prose or source
 * code that merely talks about limits.
 */
export const MAX_NOTICE_LENGTH = 400;
/**
 * Cheap guard against text that quotes a banner inside source code rather than being one.
 * Shared with the overload parser.
 */
export function looksLikeCode(text: string): boolean {
    return /[{};]|=>|\b(?:const|let|var|function|return|assert|import|export|test|describe)\b|\/\/|\/\*|`/.test(text);
}
/**
 * Whether the text is a usage-percentage readout ("You've used 91% of your session limit"),
 * an ordinary status line rather than a "you're blocked" notice.
 */
export function looksLikePercentageUsage(text: string): boolean {
    return /\bused\s+\d{1,3}%/i.test(text);
}
/**
 * Whether the text is visibly quoted rather than a live banner: fenced in backticks,
 * blockquoted with `>`, or carrying a `grep`-style "path:line:" citation.
 *
 * Checked per physical line of the *raw* text, before normalize() collapses newlines. The
 * grep pattern is deliberately narrow (a bare token, then ":<digits>:" or ":<digits>-") so a
 * banner like "resets 12:40pm" never matches; the optional drive letter lets an absolute
 * Windows path match.
 */
export function looksLikeQuotedNotice(rawText: string): boolean {
    return rawText.split(/\r?\n/).some((line) => {
        const t = line.trim();
        if (!t) {
            return false;
        }
        return /`/.test(t) || /^>/.test(t) || /^(?:[A-Za-z]:)?[^\s:]+:\d+[:-]/.test(t);
    });
}
/** "6d 23h", "4h 32m", "42s": compact countdown rendering; days from 24 hours up. */
export function formatDuration(ms: number): string {
    if (ms <= 0) {
        return '0s';
    }
    const totalSeconds = Math.round(ms / 1000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor(totalSeconds / 3600);
    if (days > 0) {
        return `${days}d ${hours % 24}h`;
    }
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}
