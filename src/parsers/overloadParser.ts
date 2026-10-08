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
    // Require `re` to match on a physical line of the RAW text whose own
    // visible content genuinely begins with "API Error:" - not merely
    // contains it somewhere. See matchesApiErrorLine below.
    lineAnchored?: boolean;
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
 * Claude Code's own in-flight retry status line ("... · Retrying in 5s · attempt 3/10"). It is
 * already retrying, so scheduling a resume on top would interrupt its backoff. The colon form
 * ("API Error: 529 ...") never carries this suffix and stays actionable.
 *
 * Matched on "Retrying in <number>" alone: the attempt counter and unit spelling vary, so
 * neither (nor the parens or status code) is part of the pattern. This line is only drawn in
 * the terminal UI, never written to a transcript, so ignoring it cannot lose a real stop.
 */
const IN_FLIGHT_RETRY_RE = /\bretrying in\s*\d/i;

/**
 /**
  * The transient-429 render: the server is throttling but the account's usage limit is not hit
  * (its text disclaims "not your usage limit"). It must win over looksLikeOverloadMessage's
  * "a 429 belongs to the limit parser" carve-out, or both parsers drop it. Anchored on the
  * "API Error:" head like every other rule here.
  */
const TRANSIENT_429_RE = /\bapi error:\s*server is temporarily limiting requests\b[^\n]{0,40}\bnot your usage limit\b/i;

/**
 /**
  * The other 429 render that is an overload: "Request rejected (429) · this may be a temporary
  * capacity issue". Anchored on the "temporary capacity issue" tail, not the head: the head
  * prefixes ANY raw 429 message, including a usage limit with a reset time that the limit
  * parser owns. Like TRANSIENT_429_RE it must be claimed before the 429 carve-out.
  */
const REJECTED_429_RE = /\bapi error:\s*request rejected \(429\)[^\n]{0,10}\bthis may be a temporary capacity issue\b/i;

/**
 /**
  * "API Error: No response from API (waited ...)". The wait times vary, so the pattern stops at
  * the fixed head.
  */
const NO_RESPONSE_RE = /\bapi error:\s*no response from api\b/i;

/**
 /**
  * The stream-interruption family: a turn the byte-watchdog finalized after a suspend, a
  * dropped connection or a stalled stream. Content was already yielded, so Claude Code's
  * built-in auto-retry never resumes it and the session would sit on a half-finished answer.
  * Every variant is anchored on the literal "API Error:" head so prose that mentions sleep or
  * a dropped connection never matches.
  */
const STREAM_INTERRUPTED_RE =
    /\bapi error:\s*(?:your computer went to sleep (?:mid-response|before a response was produced)|the response stopped arriving|part of the response never arrived|the response stream was malformed|connection lost (?:mid-response|before a response was produced)|server error mid-response|the response stalled before a response was produced)\b/i;

/**
 /**
  * The head every genuine "API Error" banner line starts with, optionally behind the single
  * message glyph Claude Code's renders show, with only leading whitespace before it. Both the
  * colon form and the parens form count: the in-flight parens variant must still reach the
  * IN_FLIGHT_RETRY_RE exclusion rather than be lost to the anchor.
  */
const LINE_HEAD_RE = /^\s*(?:[⏺●]\s*)?api error\s*[:(]/i;

/**
 /**
  * The match of `innerRe` on the first physical line of `rawText` whose own visible content
  * BEGINS with "API Error", not one where the phrase turns up mid-sentence or inside a quoted
  * shell argument.
  *
  * Checked per physical line of the RAW text, before normalize() collapses newlines and
  * destroys the line-start position. `innerRe` runs against that one line's normalized text.
  *
  * Used for `lineAnchored` rules, whose wording is ordinary English: the "API Error:" head is
  * the only thing that makes it a banner. Only entries Claude Code flagged reach these, so the
  * anchor is the second line of defence for a flagged entry that quotes a render mid-sentence.
  */
function matchApiErrorLine(rawText: string, innerRe: RegExp): RegExpExecArray | undefined {
    for (const line of rawText.split(/\r?\n/)) {
        if (!LINE_HEAD_RE.test(line)) {
            continue;
        }
        const m = innerRe.exec(normalize(line));
        if (m) {
            return m;
        }
    }
    return undefined;
}

export function looksLikeOverloadMessage(text: string): boolean {
    const t = normalize(text);
    // The transient-429 render uses "rate limit" vocabulary while disclaiming being a usage limit;
    // claim it as an overload before the carve-out below hands it to the limit parser (see
    // TRANSIENT_429_RE). The "Request rejected (429)" render is the same case (see REJECTED_429_RE).
    if (TRANSIENT_429_RE.test(t) || REJECTED_429_RE.test(t)) {
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
        // Connection errors, including the documented "Connection to the API was lost", whose OS error
        // code varies, so the phrase is matched, not one code.
        id: 'connection-error',
        re: /\b(?:api error:?\s*connection (?:error|to the api was lost)|connection error\b[^\n]{0,30}\bretr|fetch failed|socket hang up|econnreset|econnrefused|etimedout|enotfound|network error)\b/i,
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
        lineAnchored: true,
    },
    {
        // "Request rejected (429) · this may be a temporary capacity issue."
        id: 'rejected-429',
        re: REJECTED_429_RE,
        lineAnchored: true,
    },
    {
        // "No response from API (waited 3m, then 10m on the retry)."
        id: 'no-response',
        re: NO_RESPONSE_RE,
        lineAnchored: true,
    },
    {
        // "Your computer went to sleep mid-response", dropped connection, stalled stream.
        id: 'stream-interrupted',
        re: STREAM_INTERRUPTED_RE,
        lineAnchored: true,
    },
];

/**
 * Whether an "API Error:" line is really a quotation of one.
 *
 * The general code guard cannot be used: the real error embeds the API's JSON body and braces
 * alone would reject it. Only markers no error message ever carries are grounds for rejection.
 *
 * A URL is taken out first: "//" is one of those markers and is also in every link, and real
 * renders end with a link. A real comment marker beside a link still trips the check.
 */
function quotesSourceCode(text: string): boolean {
    // The link stops at whitespace, at the characters that end a link in source
    // code (a quote, backtick, semicolon, paren or angle bracket) and at a
    // comment marker of its own, so "https://a.com";//x and https://a.com/*x*/
    // still trip the check below instead of being swallowed with the link.
    const withoutUrls = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/(?:(?!\/\*|\/\/)[^\s"'`;)<>])*/gi, ' ');
    return /=>|\/\/|\/\*|`|\b(?:const|let|var|function|return|assert|expect|describe|import|export)\b/.test(withoutUrls);
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

/**
 * Scan one short chunk of text for a transient server failure.
 *
 * The caller decides whether the chunk is Claude Code's own error: this only reads text, and
 * inspectLine hands it nothing from an entry not marked as an API error.
 */
export function detectOverload(rawText: string): OverloadDetection | undefined {
    const text = normalize(rawText);
    if (!text || text.length > MAX_NOTICE_LENGTH) {
        return undefined;
    }
    if (!looksLikeOverloadMessage(text)) {
        return undefined;
    }
    // Claude Code is already retrying this one itself, so nothing here may
    // schedule a second one on top of its own backoff. Checked ahead of the
    // RULES loop so it wins even over a matching status-code rule.
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
        const m = rule.lineAnchored ? matchApiErrorLine(rawText, rule.re) : rule.re.exec(text);
        if (!m) {
            continue;
        }
        const status = rule.statusGroup ? Number(m[rule.statusGroup] ?? '') : sniffStatus(text);
        return { rule: rule.id, status, text };
    }
    return undefined;
}
