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
 * Claude Code's own in-flight retry status line: "API Error (529 {...}) ·
 * Retrying in 5s · attempt 3/10". This is Claude Code already retrying, not a
 * failure to react to - scheduling a resume on top of it would interrupt its
 * own backoff. The colon form ("API Error: 529 ...") never carries this
 * suffix and stays terminal/actionable (synthesis A5; prior-art
 * 1-autoretry-detection.md "Three gaps" #1, overload.test.js:83-85: "Acting
 * on it would interrupt Claude's own backoff").
 *
 * Matched on "Retrying in <number>" alone (Task 4c, R2): every countdown line
 * means Claude Code is still retrying, whatever else it carries. The attempt
 * counter is optional ("· Retrying in 12s" has none) and the unit is spelled
 * two ways ("5s", and "1 seconds…" in the older parens render, GitHub #1166),
 * so neither is part of the pattern - nor are the parens or the status code,
 * which keeps it covering every code, count and ratio without a rule per
 * variant. The 2.1.282 binary builds this line only inside its terminal UI
 * component (research-api-errors-binary.md Q3) and never writes it to a
 * transcript, so ignoring it cannot lose a real stop.
 */
const IN_FLIGHT_RETRY_RE = /\bretrying in\s*\d/i;

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
 * The other 429 render that is an overload, not a limit (Task 4c, R1): "API
 * Error: Request rejected (429) · this may be a temporary capacity issue. If
 * it persists, check https://status.claude.com." (code.claude.com/docs/en/
 * errors.md, "Rate Limiting"). Anchored on the "temporary capacity issue"
 * tail, not on the head alone: the head is what the binary writes ahead of
 * ANY raw 429 message the API sent (INn: `Request rejected (429) · ${we||Pe}`),
 * and one real transcript on this machine (Claude Code 2.1.267) reads "API
 * Error: Request rejected (429) · Claude AI usage limit reached|1789071998" -
 * a usage limit with a reset time, which the limit parser owns. Only the
 * fallback text Claude Code itself substitutes when the API sent none says
 * "this may be a temporary capacity issue". Like TRANSIENT_429_RE it has to be
 * claimed before looksLikeOverloadMessage's "a 429 belongs to the limit
 * parser" carve-out, or both parsers drop it.
 */
const REJECTED_429_RE = /\bapi error:\s*request rejected \(429\)[^\n]{0,10}\bthis may be a temporary capacity issue\b/i;

/**
 * "API Error: No response from API (waited 3m, then 10m on the retry). If a
 * proxy or gateway on your network holds responses until they complete, raise
 * API_TIMEOUT_MS or CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS to wait longer."
 * (errors.md, "Connection and Timeout Errors"). The wait times vary, so the
 * pattern stops at the fixed head.
 */
const NO_RESPONSE_RE = /\bapi error:\s*no response from api\b/i;

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
 *
 * The set is the docs page's own list now (Task 4c): code.claude.com/docs/en/
 * errors.md, "Mid-Response Failures", names six renders, each ending "The
 * response above may be incomplete." - server error, connection lost, sleep,
 * "the response stopped arriving", "part of the response never arrived" and
 * "the response stream was malformed" (the last two are new here). The
 * "before a response was produced" forms and "the response stalled" are not on
 * that page; they stay because the prior-art evidence names them
 * (1-autoretry-detection.md:80-81, 2-autoretry-resume.md:296-297) and a
 * render Claude Code has ever written is worth keeping. Nothing beyond those
 * two sources is invented.
 */
const STREAM_INTERRUPTED_RE =
    /\bapi error:\s*(?:your computer went to sleep (?:mid-response|before a response was produced)|the response stopped arriving|part of the response never arrived|the response stream was malformed|connection lost (?:mid-response|before a response was produced)|server error mid-response|the response stalled before a response was produced)\b/i;

/**
 * The head every genuine "API Error" banner line starts with - optionally
 * behind the single message glyph Claude Code's own renders show ("⏺ API
 * Error: ..." / "● API Error: ..."), with nothing but leading whitespace in
 * front of it. Both the colon form ("API Error: 529 ...") and the parens form
 * ("API Error (500 {...})") count (final review, Important 4): the parens
 * form is a real terminal render too, and its in-flight variant ("... ·
 * Retrying in 5s · attempt 3/10") must still get as far as the
 * IN_FLIGHT_RETRY_RE exclusion rather than be silently lost to the anchor.
 */
const LINE_HEAD_RE = /^\s*(?:[⏺●]\s*)?api error\s*[:(]/i;

/**
 * The match of `innerRe` on the first physical line of `rawText` whose own
 * visible content genuinely BEGINS with "API Error" - not one where the
 * phrase merely turns up mid-sentence in a longer line of prose, or inside a
 * quoted shell argument (Task 4a fix round 1, review finding #2: model notes
 * like "Added a rule so API Error: Your computer went to sleep mid-response.
 * …" and a Bash tool_use argument `echo "API Error: ..."` both fired the
 * transient-429/stream-interrupted rules on the untrusted path before this).
 *
 * Checked per physical line of the RAW text, before normalize() collapses
 * every real newline into a single space and destroys the position a
 * line-start anchor would need to see - the same reason looksLikeQuotedNotice
 * (limitParser.ts) is checked this way rather than against the normalized
 * whole-text string. `innerRe` is then run against that one line's own
 * normalized text, so it keeps matching through normalize()'s usual
 * quote/dash/whitespace cleanup.
 *
 * Used for the rules marked `lineAnchored`: the ones whose wording is ordinary
 * English that turns up in prose and in a quoted shell argument, so the "API
 * Error:" head is the only thing that makes it a banner. (Overload detection
 * only ever reads an entry Claude Code itself flagged as an API error -
 * inspectLine, Task 4c R3 - so unflagged prose never reaches these rules; the
 * anchor is the second line of defence, for a flagged entry whose text quotes
 * a render mid-sentence.)
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
    // The transient-429 render names "rate limit" vocabulary in its own text
    // while explicitly disclaiming being a usage limit - it must be claimed as
    // an overload before the carve-out below hands anything "rate limit"-shaped
    // to the limit parser, or it is dropped by both (see TRANSIENT_429_RE).
    // The "Request rejected (429) ... temporary capacity issue" render is the
    // same case: its "(429)" would otherwise trip the limit hint (see
    // REJECTED_429_RE).
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
        // "API Error: Connection error.", "fetch failed", "socket hang up", and
        // the documented "API Error: Connection to the API was lost (ECONNRESET)"
        // - whose OS error code varies (INn interpolates it), so the phrase is
        // matched, not just the one code.
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
 * The general code guard cannot be used on these, because the error Claude Code
 * prints embeds the API's JSON body — `API Error (529 {"type":"error",...})` —
 * and braces alone would throw the real thing away. Only the markers that no
 * error message ever carries are grounds for rejection here.
 *
 * A URL is taken out first (Task 4c): "//" is one of those markers, and it is
 * also the second and third character of every link. Claude Code's renders now
 * end "If it persists, check https://status.claude.com.", so before this, five
 * of the six documented server-error renders were rejected as quoted source
 * code - the identical sentence with the scheme removed was detected. A real
 * comment marker beside a link still trips the check.
 */
function quotesSourceCode(text: string): boolean {
    const withoutUrls = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ');
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
 * The caller decides whether the chunk is Claude Code's own error to begin
 * with: this only reads text, and inspectLine hands it nothing from an entry
 * Claude Code did not mark as an API error (Task 4c, R3 - every error message
 * the binary writes is built with `isApiErrorMessage: true`, so an unmarked
 * entry is the model or the user talking ABOUT an error). There used to be an
 * `anchored` mode here for the unmarked path; with that path gone it is too.
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
