/**
 * Recognises "the server is having a moment" errors from Claude Code.
 *
 * These are a different animal from usage limits. A usage limit has a reset
 * time hours away and the right move is to wait it out; an overload is a
 * transient server-side failure where the right move is to retry in seconds,
 * and — if the session keeps failing — to abandon it and start a fresh one,
 * which is what people end up doing by hand.
 *
 * Detection is deliberately narrower than the limit parser's: an overload
 * triggers an automatic retry within a minute or two, so a false positive is
 * more annoying than a missed one.
 */

import { normalize, looksLikeLimitMessage, looksLikeCode, MAX_NOTICE_LENGTH } from './limitParser';

export interface OverloadDetection {
    rule: string;
    status?: number;
    text: string;
}

interface OverloadRule {
    id: string;
    re: RegExp;
    statusGroup?: number;
}

/**
 * A line must read like an error report before any pattern is applied, so
 * prose that merely contains the word "overloaded" is left alone.
 */
const ERROR_MARKERS = [
    /\berror\b/i,
    /\bfailed\b/i,
    /\bunavailable\b/i,
    /\boverloaded_error\b/i,
    // A bare "Overloaded" is the API's own one-word message, but the same word in
    // the middle of a sentence is someone talking about a queue.
    /^overloaded\b/i,
    /\btimed out\b/i,
    /\bsocket hang up\b/i,   // <-- added: Node prints this bare, with no "Error:" prefix
    /\b5\d{2}\b/,
];

/**
 * Claude Code's own in-flight retry status line: "API Error (529 {...}) ·
 * Retrying in 5s · attempt 3/10". This is Claude Code already retrying, not a
 * failure to react to - scheduling a resume on top of it would interrupt its
 * own backoff. The colon form ("API Error: 529 ...") never carries this
 * suffix and stays terminal/actionable (synthesis A5; prior-art
 * 1-autoretry-detection.md "Three gaps" #1, overload.test.js:83-85: "Acting
 * on it would interrupt Claude's own backoff"). Matched on the "Retrying
 * in Ns .. attempt k/n" pair alone, not on the parens or the status code, so
 * it covers every code, second count and attempt ratio Claude Code might
 * render without needing a rule per variant.
 */
const IN_FLIGHT_RETRY_RE = /\bretrying in\s*\d+s\b[^\n]{0,60}\battempt\s*\d{1,2}\/\d{1,2}\b/i;

/**
 * The transient-429 render Claude Code writes when the server is throttling
 * requests but the account's own usage limit has not been hit - its own text
 * disclaims being a usage limit ("not your usage limit"). This must win over
 * looksLikeOverloadMessage's ordinary "a 429 belongs to the limit parser"
 * carve-out just below, or the message is silently dropped by both parsers
 * (synthesis A6; prior-art 1-autoretry-detection.md "Three gaps" #3: their
 * own OVERLOAD_ANCHOR/pattern set treats this exact render as overload, not a
 * usage limit, "mirrored almost word-for-word" in the carve-out's own
 * comment). Anchored on the "API Error:" head, as every other rule here is.
 */
const TRANSIENT_429_RE = /\bapi error:\s*server is temporarily limiting requests\b[^\n]{0,40}\bnot your usage limit\b/i;

/**
 * The stream-interruption family: a turn Claude Code's own byte-watchdog
 * finalized after a suspend/sleep, a dropped connection, or a stalled
 * stream - real content was already yielded, so Claude Code's built-in
 * auto-retry (which only covers thinking-only truncation) never resumes it,
 * and the session sits on a half-finished answer indefinitely without this
 * rule (synthesis A6; prior-art 5-history-issues.md bug entry #3). Every
 * variant is anchored on the literal "API Error:" head, as the brief
 * requires, so prose that merely mentions sleep or a dropped connection never
 * matches - the alternation only starts matching after that head is seen.
 * The seven variants themselves are exactly the ones the prior-art evidence
 * names (1-autoretry-detection.md:80-81, 2-autoretry-resume.md:296-297); no
 * additional phrasing has been invented beyond what that evidence shows.
 */
const STREAM_INTERRUPTED_RE =
    /\bapi error:\s*(?:your computer went to sleep (?:mid-response|before a response was produced)|the response stopped arriving|connection lost (?:mid-response|before a response was produced)|server error mid-response|the response stalled before a response was produced)\b/i;

export function looksLikeOverloadMessage(text: string): boolean {
    const t = normalize(text);
    // The transient-429 render names "rate limit" vocabulary in its own text
    // while explicitly disclaiming being a usage limit - it must be claimed as
    // an overload before the carve-out below hands anything "rate limit"-shaped
    // to the limit parser, or it is dropped by both (see TRANSIENT_429_RE).
    if (TRANSIENT_429_RE.test(t)) {
        return true;
    }
    // A 429 is a rate limit, not an overload: it belongs to the limit parser,
    // which knows how to read the reset time out of it. Retrying a 429 every
    // thirty seconds would only dig the hole deeper.
    if (looksLikeLimitMessage(t)) {
        return false;
    }
    return ERROR_MARKERS.some((re) => re.test(t));
}

const RULES: OverloadRule[] = [
    {
        // "API Error: 529 Overloaded", "API Error (500 {...})", "API Error: 503"
        id: 'api-error-status',
        re: /\bapi error:?\s*\(?\s*(5\d{2})\b/i,
        statusGroup: 1,
    },
    {
        // Anthropic's own wording: {"type":"overloaded_error"} / "Overloaded"
        id: 'overloaded',
        re: /\boverloaded(?:_error)?\b/i,
    },
    {
        // "503 Service Unavailable", "Internal server error", "502 Bad Gateway"
        id: 'server-error',
        re: /\b(?:internal server error|service unavailable|bad gateway|gateway timeout|upstream connect error)\b/i,
    },
    {
        // "API Error: Connection error.", "fetch failed", "socket hang up"
        id: 'connection-error',
        re: /\b(?:api error:?\s*connection error|connection error\b[^\n]{0,30}\bretr|fetch failed|socket hang up|econnreset|econnrefused|etimedout|enotfound|network error)\b/i,
    },
    {
        // "Request timed out", "API Error: Request timeout"
        id: 'timeout',
        re: /\b(?:request timed out|request timeout|read timed out|stream timed out)\b/i,
    },
    {
        // "Server is temporarily limiting requests (not your usage limit)"
        id: 'transient-429',
        re: TRANSIENT_429_RE,
    },
    {
        // "Your computer went to sleep mid-response", dropped connection, stalled stream.
        id: 'stream-interrupted',
        re: STREAM_INTERRUPTED_RE,
    },
];

/**
 * Whether an "API Error:" line is really a quotation of one.
 *
 * The general code guard cannot be used on these, because the error Claude Code
 * prints embeds the API's JSON body — `API Error (529 {"type":"error",...})` —
 * and braces alone would throw the real thing away. Only the markers that no
 * error message ever carries are grounds for rejection here.
 */
function quotesSourceCode(text: string): boolean {
    return /=>|\/\/|\/\*|`|\b(?:const|let|var|function|return|assert|expect|describe|import|export)\b/.test(text);
}

/** Pull a bare 5xx status out of a line when the matching rule did not. */
function sniffStatus(text: string): number | undefined {
    const m = /\b(5\d{2})\b/.exec(text);
    if (!m) {
        return undefined;
    }
    const n = Number(m[1] ?? '');
    return n >= 500 && n <= 599 ? n : undefined;
}

/** Scan one short chunk of text for a transient server failure. */
export function detectOverload(rawText: string): OverloadDetection | undefined {
    const text = normalize(rawText);
    if (!text || text.length > MAX_NOTICE_LENGTH) {
        return undefined;
    }
    if (!looksLikeOverloadMessage(text)) {
        return undefined;
    }
    // Claude Code is already retrying this one itself (ruling: applies on
    // every path, flagged or not - it is retrying either way, so nothing here
    // may schedule a second one on top of its own backoff). Checked ahead of
    // the RULES loop so it wins even over a matching status-code rule.
    if (IN_FLIGHT_RETRY_RE.test(text)) {
        return undefined;
    }
    // Source code and conversation *about* these errors — which is exactly what a
    // transcript of working on this extension looks like — must not arm a retry.
    // An explicit "API Error:" prefix is trusted further, since the CLI's own
    // wording of it carries a JSON body that the general guard cannot tell from
    // code.
    const isBanner = /\bapi error\b/i.test(text);
    if (isBanner ? quotesSourceCode(text) : looksLikeCode(text)) {
        return undefined;
    }
    for (const rule of RULES) {
        const m = rule.re.exec(text);
        if (!m) {
            continue;
        }
        const status = rule.statusGroup ? Number(m[rule.statusGroup] ?? '') : sniffStatus(text);
        return { rule: rule.id, status, text };
    }
    return undefined;
}
