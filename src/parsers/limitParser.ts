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
 * A DST fall-back repeats one wall-clock hour twice, an hour apart in real
 * time (issue A7). The 2-pass loop above always converges on whichever
 * offset applies to the *naively guessed* instant - which is always the
 * EARLIER of the two real instants that share that wall-clock reading,
 * confirmed by direct execution against the unmodified algorithm. Detect
 * that by checking whether stepping the candidate forward one hour still
 * reads the same wall clock: if so, the candidate is the ambiguous hour's
 * first pass, and the later occurrence - one hour on - is what
 * nextZonedOccurrence's callers want. Resolving to the later instant is
 * deliberate: waking an hour late finds a still-live limit safe to
 * re-check; waking an hour early risks resuming into a session that has
 * not actually reset yet.
 *
 * A DST spring-forward SKIPS one wall-clock hour outright (Task 4a, A7's
 * other half): the reading asked for may not exist at all (e.g.
 * America/Chicago's clock jumps from 01:59:59 straight to 03:00:00, so
 * "02:30" never happens). The 2-pass loop still converges on some instant,
 * but it does so by re-resolving the offset a second time at its own
 * first-pass candidate - which by then sits on the far side of the jump - so
 * it lands on the offset that took effect *after* the jump and reads back an
 * hour EARLIER than what was asked for (confirmed by direct execution:
 * "02:30" on that gap resolves to an instant reading 01:30, not 02:30). That
 * is the unsafe direction by the same reasoning as the fall-back case above,
 * so it is detected the same way a missed target is always detected here -
 * the resolved candidate's own wall-clock reading no longer matches what was
 * asked for - and corrected by stepping forward one hour onto the safe side
 * of the gap instead.
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
    // Spring-forward gap: the resolved instant does not read back the hour
    // and minute that were actually asked for, proof the requested wall
    // clock fell inside a skipped hour. Step forward one hour - the only
    // gap size any zone Claude Code's own banners have been seen in uses -
    // onto the safe, later side of the jump.
    const requested = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (renderedWallClock(timeZone, candidate)?.slice(-5) !== requested) {
        return oneHourLater;
    }
    return candidate;
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
 * The soonest instant, starting from `today` and walking forward up to two
 * calendar days, at which the named zone's wall clock reads `h:minute` and
 * the result is still in the future relative to `now`, or - within
 * {@link RESET_GRACE_MS} - has only just passed.
 *
 * That last clause matters for a notice read moments after its own clock
 * time struck: without it, "resets 1am" read at 1:03am would skip today's
 * occurrence for being three minutes stale and roll all the way to tomorrow,
 * arming a needless ~24h wait for a limit that had just lifted. The final
 * accept/reject call on how stale is still acceptable belongs to
 * detectLimit's own grace check against the real current time; this only
 * has to stop rolling forward past a candidate that check might still want.
 *
 * Re-derives the wall clock for each date instead of adding a flat 24h, so a
 * DST change during the walk does not shift the result by an hour (issue
 * #10: a flat-milliseconds roll-forward resumed the fall-back case an hour
 * early, into a session that was still limited).
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
            // No zone named in the notice: read the given zone - an explicit
            // override so a test can pin a fixed zone, since `TZ` is not
            // reliably honoured by Node on Windows (issue #10) - or the
            // process's own resolved zone otherwise, so production behaviour
            // is unchanged when no override is given. Walk forward and
            // re-derive the wall clock exactly as the named-zone branch
            // above does, rather than adding a flat DAY_MS once the "today"
            // reading turns out to be in the past.
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
 * How far in the past a resolved reset time may lie and still count as an
 * event due right now, rather than history. Exists because a notice is
 * resolved against when it was *written*, not when this pass happens to read
 * it (see the `now` parameter below) - and a session left alone past its own
 * reset time is a real, current situation: it needs resuming now, not
 * skipped as stale, and it certainly does not need to wait for the same
 * clock time tomorrow. Longer ago than this is instead treated as history:
 * a limit that lifted last night is not a reason to act this morning.
 *
 * 15 minutes: comfortably past the couple of minutes a fork's own write and
 * this watcher's poll interval could add, without being so wide that a
 * genuinely stale notice from hours ago slips through as "current".
 */
export const RESET_GRACE_MS = 15 * 60_000;

/**
 * Scan a chunk of text for a usage-limit notice.
 *
 * `now` is the instant the notice is resolved *against* - the entry's own
 * timestamp when the caller has one, so "try again in 5 hours" means 5 hours
 * from when Claude Code wrote that line, not from whenever this pass happens
 * to read it. `opts.readAt` is the actual current time, used only to decide
 * whether a reset that has already passed is still within {@link
 * RESET_GRACE_MS} of now (a live event) or further back than that (history).
 * It defaults to `now` itself, which is exactly right when a caller has only
 * one instant to give - every existing caller, before `readAt` existed.
 *
 * `maxWaitHours` rejects absurd results (a stray year in the text, a misread
 * timezone) rather than arming a timer that would never sensibly fire.
 */
export function detectLimit(
    rawText: string,
    now: Date = new Date(),
    maxWaitHours: number = 24,
    opts: { trusted?: boolean; zone?: string; readAt?: Date } = {}
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
    //
    // Two more shapes join the same guard (synthesis A3, 2026-09-23 false
    // positives): a percentage-usage status line ("You've used 91% of your
    // session limit"), which is Claude Code's own readout, not a "you're
    // blocked" notice, and text someone else is visibly quoting - a subagent
    // recap, a `grep` hit, a reply - rather than a notice Claude Code is
    // delivering right now. All three are skipped outright on a flagged
    // entry, exactly like looksLikeCode.
    if (!opts.trusted && (looksLikeCode(text) || looksLikePercentageUsage(text) || looksLikeQuotedNotice(rawText))) {
        return undefined;
    }
    const readAt = opts.readAt ?? now;
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
        if (at.getTime() > horizon) {
            continue;
        }
        // History, not an event: further in the past (relative to the real
        // current time) than the grace window allows. A reset still inside
        // the window is returned as-is, resumeAt at or before readAt, which
        // is exactly the "due now" signal the scheduler already treats a
        // past deadline as (see planResume/ResumeScheduler.tick).
        if (at.getTime() < readAt.getTime() - RESET_GRACE_MS) {
            continue;
        }
        return { resumeAt: at, rule: rule.id, text };
    }
    return undefined;
}

/**
 * Resolve an already-absolute reset time - `quotaLimits.resetsAt`, epoch
 * seconds Claude Code writes on a flagged rate-limit entry - against the same
 * grace and horizon rules a parsed notice gets. There is no text to
 * misread here (no zone, no DST, no calendar rollover), which is exactly why
 * this field wins over the text when both are present: it is simply trusted,
 * checked only for staleness (too far in the past) and absurdity (too far in
 * the future).
 *
 * Unlike {@link detectLimit}, there is only one time reference: the value is
 * already absolute, so nothing needs a separate "when this was written"
 * basis to resolve a relative expression against. `now` here is the real
 * current time, used for both the horizon and the grace check.
 */
export function resolveStructuredReset(
    resetsAtSeconds: number,
    now: Date,
    maxWaitHours: number
): Date | undefined {
    if (!Number.isFinite(resetsAtSeconds)) {
        return undefined;
    }
    const at = new Date(resetsAtSeconds * 1000);
    const horizon = now.getTime() + maxWaitHours * HOUR_MS;
    if (at.getTime() > horizon) {
        return undefined;
    }
    if (at.getTime() < now.getTime() - RESET_GRACE_MS) {
        return undefined;
    }
    return at;
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
/**
 * Whether the text is a usage-percentage readout ("You've used 91% of your
 * session limit") rather than a "you're blocked" notice. Claude Code writes
 * these as ordinary status lines while a session is still usable; a real
 * false positive on 2026-09-23 armed a timer from one read on the untrusted
 * path.
 */
export function looksLikePercentageUsage(text: string): boolean {
    return /\bused\s+\d{1,3}%/i.test(text);
}
/**
 * Whether the text is visibly quoted rather than a live banner: fenced in
 * backticks, blockquoted with a leading `>`, or carrying a `grep`-style
 * "path:line:" / "path:line-" citation. (Any backtick already trips
 * looksLikeCode above; this checks independently too, since a plain-worded
 * quote inside backticks has none of that function's other punctuation.)
 * Each shape is exactly how a real banner turns up as someone else's
 * evidence - a subagent's recap, a `grep` hit on a doc, a reply quoting an
 * earlier message - rather than a notice Claude Code is delivering now.
 *
 * Checked per physical line of the *raw* text, before normalize() collapses
 * every run of whitespace (newlines included) to a single space: a prefix
 * only has to sit at the start of its own line, not the whole candidate.
 * The grep pattern is deliberately narrow - an optional single-letter drive
 * ("C:"), then a bare token with no whitespace or colon in it, immediately
 * followed by ":<digits>:" or ":<digits>-" - so an ordinary banner ("resets
 * 12:40pm") never matches: "12" is followed by ":40pm", not a run of digits
 * followed by ':' or '-'. The drive letter is optional (fix round 1: an
 * absolute Windows path like "C:\Users\x\y.ts:12:" was missed without it -
 * "C" alone has no trailing digits, so the un-prefixed pattern never got
 * past the drive letter to the real path).
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
