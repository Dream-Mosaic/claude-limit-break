/**
 * Recognises the moment Claude Code stops working and waits on you.
 *
 * Two different things count as "your turn", and they surface in different
 * places:
 *
 *  - A **permission prompt** ("Do you want to proceed?") is drawn by the TUI
 *    and never reaches the transcript until after it is answered, so it can
 *    only be caught in terminal output.
 *  - A **finished turn** — Claude has said its piece and is sitting at the
 *    input box — is not a distinct banner at all, but the transcript records it
 *    exactly, as an assistant entry with `stop_reason: "end_turn"`.
 *
 * Detection only has to be good enough to ring a bell, so the cost of being
 * wrong is one unwanted noise rather than an unwanted automated action. Even
 * so, patterns are kept to wording the CLI actually prints, because a bell that
 * cries wolf is a bell people turn off.
 */

import { normalize, stripAnsi, MAX_NOTICE_LENGTH } from './limitParser';

export interface InputDetection {
    rule: string;
    kind: 'prompt' | 'turnEnd';
    text: string;
}

interface InputRule {
    id: string;
    re: RegExp;
}

const RULES: InputRule[] = [
    {
        // The escape hatch every Claude Code permission prompt offers. Nothing else
        // prints this sentence, which makes it the single most reliable marker.
        id: 'permission-choice',
        re: /\bno,?\s*and tell claude what to do differently\b/i,
    },
    {
        // "Do you want to proceed?", "Do you want to make this edit to x.ts?",
        // "Do you want to create foo.md?"
        id: 'do-you-want',
        re: /\bdo you want to (?:proceed|continue|make this edit|create|overwrite|run|apply)\b/i,
    },
    {
        // Plan mode's wording: "Would you like to proceed?"
        id: 'would-you-like',
        re: /\bwould you like to proceed\b/i,
    },
    {
        id: 'awaiting-input',
        re: /\b(?:waiting for|awaiting) (?:your )?(?:input|response|confirmation|approval)\b/i,
    },
];

/**
 * Whether a line is the *user's own* text being echoed back.
 *
 * Claude Code repaints the input box with whatever has been typed into it, so
 * a question the user is in the middle of asking would otherwise ring the bell
 * for the user's own keystrokes.
 */
function isEchoedInput(line: string): boolean {
    const trimmed = line.trim();
    // The same marker points at the selected option inside a permission box, so
    // a numbered choice is exempt — that is the prompt, not the user's typing.
    if (/^[>❯]\s*\d+\.\s/.test(trimmed)) {
        return false;
    }
    return /^[>❯]\s/.test(trimmed);
}

/** Scan one short line for a prompt that is waiting on the user. */
export function detectInputNeeded(rawText: string): InputDetection | undefined {
    const text = normalize(rawText);
    if (!text || text.length > MAX_NOTICE_LENGTH) {
        return undefined;
    }
    for (const rule of RULES) {
        if (rule.re.test(text)) {
            return { rule: rule.id, kind: 'prompt', text };
        }
    }
    return undefined;
}

/**
 * Line-oriented variant for terminal buffers, matching the other parsers: one
 * short line at a time, with the box-drawing characters the TUI frames its
 * prompts in stripped off first.
 */
export function detectInputNeededInLines(text: string): InputDetection | undefined {
    const lines = stripAnsi(text).split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        // Prompts are drawn inside a box, so the payload arrives wrapped in │ … │.
        const line = (lines[i] ?? '').replace(/[│┃|]/g, ' ').trim();
        if (!line || line.length > MAX_NOTICE_LENGTH || isEchoedInput(line)) {
            continue;
        }
        const hit = detectInputNeeded(line);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}

/**
 * Whether a transcript entry is Claude handing the conversation back.
 *
 * `stop_reason: "end_turn"` is the API saying the assistant finished without
 * asking for a tool, which is precisely "over to you". A turn that stopped at
 * `tool_use` is still working and must stay silent.
 */
export function isTurnEndEntry(entry: Record<string, unknown>): boolean {
    if (entry.type !== 'assistant') {
        return false;
    }
    const message = entry.message;
    if (!message || typeof message !== 'object') {
        return false;
    }
    if ((message as Record<string, unknown>).stop_reason !== 'end_turn') {
        return false;
    }
    // Sub-agent transcripts carry the same shape; their turns end constantly
    // while the main session is still busy, so they must not ring the bell.
    return entry.isSidechain !== true;
}

/** Human-readable summary for logs and notifications. */
export function describeInput(detection: InputDetection): string {
    return detection.kind === 'turnEnd' ? 'Claude finished its turn' : detection.text;
}
