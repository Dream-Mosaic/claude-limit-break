/**
 * Recognises the moment Claude Code stops working and waits on you.
 *
 * A **finished turn** — Claude has said its piece and is sitting at the input
 * box — is not a distinct banner at all, but the transcript records it exactly,
 * as an assistant entry with `stop_reason: "end_turn"`. That entry is the whole
 * of this module.
 *
 * A **permission prompt** ("Do you want to proceed?") deliberately is not
 * covered. The TUI draws it and does not write it to the transcript until after
 * it has been answered, so a transcript reader cannot see one while it is still
 * waiting — and a transcript is all this extension reads.
 */

export interface InputDetection {
    rule: string;
    kind: 'prompt' | 'turnEnd';
    text: string;
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
