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
}

interface Rule {
  id: string;
  re: RegExp;
  resolve(m: RegExpExecArray, now: Date, zone?: string): Date | undefined;
}

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
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
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
 * The instant at which a named zone's wall clock reads the given date and time.
 * Iterates twice so a reading that lands on a DST transition still converges.
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
    return new Date(instant);
}
const RULES: Rule[] = [
    {
        // "Claude AI usage limit reached|1754035200"  (epoch seconds or millis)
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
        // "...resets at 2026-08-03T18:00:00Z"
        //
        // The lead-in must sit within a few characters of the timestamp, and no
        // quote may intervene. Transcript lines carry their own "timestamp" field,
        // and without this the rule would happily read that instead.
        id: 'iso',
        re: /(?:reset(?:s|ting)?|try again|available|come back|until)\b[^"\n]{0,30}?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
        resolve(m) {
            const d = new Date((m[1] ?? '').replace(' ', 'T'));
            return Number.isNaN(d.getTime()) ? undefined : d;
        },
    },
    {
        // "wait 5 hours", "try again in about 4h 32m", "resets in 2 hours and 5 minutes"
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
        // "try again in 45 minutes"
        id: 'duration-minutes',
        re: new RegExp(`${LEAD_IN}\\s*(?:in|after|for)?\\s*(?:about|approximately|roughly|~)?\\s*` +
            `(\\d{1,3})\\s*(?:minutes|minute|mins|min|m)\\b`, 'i'),
        resolve(m, now) {
            const minutes = Number(m[1] ?? '');
            return minutes > 0 ? new Date(now.getTime() + minutes * MINUTE_MS) : undefined;
        },
    },
    {
        // "resets 3pm", "reset at 10:30 (UTC)", "resets 1:40am (Asia/Jerusalem)"
        id: 'clock-reset',
        re: /reset(?:s|ting)?(?:\s+(?:at|around))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*(?:(utc|gmt|z)\s*([+-]\d{1,2})?(?::?(\d{2}))?|([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+))?\s*\)?/i,
        resolve(m, now, zone) {
            return resolveClockTime(m, now, zone);
        },
    },
    {
        // "try again at 3:15pm", "available again at 18:00 UTC"
        id: 'clock-retry',
        re: /(?:try again|available(?: again)?|come back|check back|back)\s+(?:at|after)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?\s*(?:(utc|gmt|z)\s*([+-]\d{1,2})?(?::?(\d{2}))?|([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+))?\s*\)?/i,
        resolve(m, now, zone) {
            return resolveClockTime(m, now, zone);
        },
    },
];
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
            // Walk forward day by day until the reading lands in the future.
            for (let dayOffset = 0; dayOffset <= 2 && !candidate; dayOffset++) {
                const attempt = zonedWallClockToInstant(ianaZone, zoneDay.y, zoneDay.m, zoneDay.d + dayOffset, h, minute);
                if (attempt && attempt.getTime() > now.getTime()) {
                    candidate = attempt;
                }
            }
            if (!candidate) {
                continue;
            }
        }
        else if (utcBased) {
            // Interpret h:mm as a reading in UTC+offset, then convert to a real instant.
            candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, minute, 0, 0) -
                signedOffsetMs);
        }
        else {
            // No zone named in the notice: read the given zone - an explicit
            // override so a test can pin a fixed zone, since `TZ` is not
            // reliably honoured by Node on Windows (issue #10) - or the
            // process's own resolved zone otherwise, so production behaviour
            // is unchanged when no override is given.
            const localZone = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
            const today = zoneToday(localZone, now);
            candidate = today ? zonedWallClockToInstant(localZone, today.y, today.m, today.d, h, minute) : undefined;
            if (!candidate) {
                continue;
            }
        }
        // Roll forward a day at a time until it lands in the future. (The named-zone
        // branch above already guarantees this, so the loop is a no-op there.)
        while (candidate.getTime() <= now.getTime()) {
            candidate = new Date(candidate.getTime() + DAY_MS);
        }
        if (!best || candidate.getTime() < best.getTime()) {
            best = candidate;
        }
    }
    return best;
}
/**
 * Scan a chunk of text for a usage-limit notice.
 *
 * `maxWaitHours` rejects absurd results (a stray year in the text, a misread
 * timezone) rather than arming a timer that would never sensibly fire.
 */
export function detectLimit(
    rawText: string,
    now: Date = new Date(),
    maxWaitHours: number = 24,
    opts: { trusted?: boolean; zone?: string } = {}
): LimitDetection | undefined {
    const text = normalize(rawText);
    if (!text || text.length > MAX_NOTICE_LENGTH) {
        return undefined;
    }
    if (!looksLikeLimitMessage(text)) {
        return undefined;
    }
    // Source code and conversation *about* limits - which is exactly what a
    // transcript of working on this extension looks like - must not arm a timer.
    // Mirrors detectOverload, which has always guarded internally. Entries Claude
    // Code itself tagged as a rate-limit event are trusted past this.
    if (!opts.trusted && looksLikeCode(text)) {
        return undefined;
    }
    const horizon = now.getTime() + maxWaitHours * HOUR_MS;
    for (const rule of RULES) {
        const m = rule.re.exec(text);
        if (!m) {
            continue;
        }
        const at = rule.resolve(m, now, opts.zone);
        if (!at || Number.isNaN(at.getTime())) {
            continue;
        }
        if (at.getTime() <= now.getTime() || at.getTime() > horizon) {
            continue;
        }
        return { resumeAt: at, rule: rule.id, text };
    }
    return undefined;
}
/**
 * A genuine limit banner is a short line. Anything longer is prose or source
 * code that merely talks about limits.
 */
export const MAX_NOTICE_LENGTH = 400;
/**
 * Cheap guard against text that quotes a banner inside source code rather than
 * being one. A real notice is a plain sentence with none of this punctuation.
 *
 * Shared with the overload parser, which needs the same protection: a
 * transcript of working on this very extension is full of strings that read
 * exactly like the errors it hunts for.
 */
export function looksLikeCode(text: string): boolean {
    return /[{};]|=>|\b(?:const|let|var|function|return|assert|import|export|test|describe)\b|\/\/|\/\*|`/.test(text);
}
/** "4h 32m", "59m 12s", "42s" - compact countdown rendering. */
export function formatDuration(ms: number): string {
    if (ms <= 0) {
        return '0s';
    }
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
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
