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

import { normalize, stripAnsi, looksLikeLimitMessage, looksLikeCode, MAX_NOTICE_LENGTH } from './limitParser';

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

export function looksLikeOverloadMessage(text: string): boolean {
    const t = normalize(text);
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

/**
 * Line-oriented variant for terminal buffers, matching the limit parser's
 * approach: one short line at a time, so a marker in one place cannot pair up
 * with unrelated text somewhere else on screen.
 */
export function detectOverloadInLines(text: string): OverloadDetection | undefined {
    const lines = stripAnsi(text).split(/\r?\n/);
    // Newest first: when a redrawn TUI screen holds several errors, the freshest
    // one is the one being reacted to.
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = (lines[i] ?? '').trim();
        if (line && line.length <= MAX_NOTICE_LENGTH) {
            const hit = detectOverload(line);
            if (hit) {
                return hit;
            }
        }
    }
    return undefined;
}

/** Human-readable summary for logs and notifications. */
export function describeOverload(detection: OverloadDetection): string {
    return detection.status ? `HTTP ${detection.status}` : detection.rule.replace(/-/g, ' ');
}
