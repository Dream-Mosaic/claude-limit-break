import { readAppendedWindow, ContinuedFs } from './continuedSince';
import * as nodeFs from 'node:fs';

/**
 * Claude Code's native auto-continue writes its state into the transcript as
 * `system` / `informational` entries (wave C; research-autocontinue-
 * compaction.md). Derived from the 2.1.285 binary, except the armed line and
 * the process_exit cancel line, which are byte-exact from a real transcript
 * (fd493448 lines 29 and 31, v2.1.278):
 *
 *   armed:     "Usage limit reached · continuing automatically at 11:10am · esc or type to cancel"
 *              ("Usage limit reached again · continuing automatically ..." after a takeover).
 *              The tail varies by version (2.1.285 ends "· esc to cancel") and
 *              by a remote flag, so only the prefix is matched.
 *   cancelled: "Automatic continue cancelled · <reason>"
 *   fired:     "Usage limit reset · continuing automatically"
 *   other:     the early-fire, stale, turned-off, stopped and did-not-run lines,
 *              logged and otherwise ignored.
 *
 * One cancel reason is NOT a system entry: "Don't continue automatically" in
 * /rate-limit-options is the command's own output, a `user` entry whose
 * content is `<local-command-stdout>Automatic continue cancelled. Your session
 * will wait for you instead; ...</local-command-stdout>` (derived from code;
 * no real sample on this machine).
 *
 * Recognition is by type, subtype and prefix only, and the text is never
 * parsed for a time: Claude Code writes these itself, so a `system` entry is
 * trustworthy provenance, but the wording is not a contract.
 */

export type NativeStatusKind = 'armed' | 'cancelled' | 'fired' | 'other';

export interface NativeStatus {
  kind: NativeStatusKind;
  /** The entry's whole content string, for the log. */
  text: string;
}

// U+00B7 MIDDLE DOT ("·") is the separator Claude Code writes. One named
// constant, so every pattern below is built from the same character.
const DOT = '·';
const ARMED_RE = new RegExp(`^Usage limit reached(?: again)? ${DOT} continuing automatically`);
const FIRED_RE = new RegExp(`^Usage limit reset ${DOT} continuing automatically`);
const CANCELLED_PREFIX = 'Automatic continue cancelled';
/** The remaining system/informational lines Claude Code writes about the feature; logged only. */
const OTHER_RE = new RegExp(
  `^(?:Usage limit available again ${DOT} continuing now|Usage limit has reset ${DOT} press enter to continue|` +
    'Automatic continue (?:was turned off|stopped|did not run))',
);
const LOCAL_STDOUT_OPEN = '<local-command-stdout>';
const LOCAL_STDOUT_CLOSE = '</local-command-stdout>';

/** What an entry says about Claude Code's own auto-continue, if anything. */
export function classifyNativeStatus(entry: unknown): NativeStatus | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined;
  }
  const e = entry as Record<string, unknown>;
  if (e.type === 'user') {
    return classifyMenuCancel(e);
  }
  if (e.type !== 'system' || e.subtype !== 'informational' || typeof e.content !== 'string') {
    return undefined;
  }
  const text = e.content;
  if (ARMED_RE.test(text)) {
    return { kind: 'armed', text };
  }
  if (text.startsWith(CANCELLED_PREFIX)) {
    return { kind: 'cancelled', text };
  }
  if (FIRED_RE.test(text)) {
    return { kind: 'fired', text };
  }
  if (OTHER_RE.test(text)) {
    return { kind: 'other', text };
  }
  return undefined;
}

/**
 * The /rate-limit-options "Don't continue automatically" answer: a `user`
 * entry (a local command's stdout), not a system line. Only a message that
 * STARTS with the stdout tag and the cancel prefix counts; the tags are
 * stripped from the returned text so the reason table sees the bare sentence.
 */
function classifyMenuCancel(e: Record<string, unknown>): NativeStatus | undefined {
  const message = e.message;
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const content = (message as Record<string, unknown>).content;
  let raw: string | undefined;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    const first = content[0] as Record<string, unknown> | undefined;
    raw =
      first && typeof first === 'object' && first.type === 'text' && typeof first.text === 'string'
        ? first.text
        : undefined;
  }
  if (raw === undefined || !raw.startsWith(LOCAL_STDOUT_OPEN + CANCELLED_PREFIX)) {
    return undefined;
  }
  let text = raw.slice(LOCAL_STDOUT_OPEN.length);
  if (text.endsWith(LOCAL_STDOUT_CLOSE)) {
    text = text.slice(0, -LOCAL_STDOUT_CLOSE.length);
  }
  return { kind: 'cancelled', text };
}

/**
 * The cancel reasons that mean "somebody else has this session" or "the user
 * declined", so a resume here would be a second writer or against their wish.
 * Every other reason (for example "Claude Code exited during the wait") is not
 * listed, and the fire proceeds as it always has.
 */
export type StandDownReason = 'desktop' | 'cloud' | 'background' | 'user';

/** How the stand-down notice names each reason. */
export const STAND_DOWN_LABEL: Readonly<Record<StandDownReason, string>> = {
  desktop: 'moved to Claude Desktop',
  cloud: 'moved to the cloud',
  background: 'moved to the background',
  user: 'set to wait by you',
};

const CANCELLED = `${CANCELLED_PREFIX} ${DOT} `;

/**
 * Cancel-line wordings, matched as prefixes of the content (all pinned from
 * the 2.1.285 binary; research-autocontinue-compaction.md sections B to D).
 * Each carries more after the reason ("... , so the task will not resume on
 * its own when the usage limit resets (continue it there)") that is
 * deliberately not matched, so a wording tweak past the reason does not break
 * the stand-down.
 *
 * - desktop: /desktop handed the session to Claude Desktop.
 * - cloud: the session is being sent to the cloud.
 * - background: the task continues in another (background) session, so a
 *   resume here is a second writer.
 * - user: Esc or Ctrl+C at an empty prompt (a system line), or "Don't continue
 *   automatically" in /rate-limit-options (a user entry; see
 *   classifyNativeStatus).
 *
 * Not listed on purpose, so today's behaviour holds: `process_exit` ("Claude
 * Code exited during the wait") and `relaunch` ("Claude Code relaunched
 * during the wait"). A mismatch only falls back to resuming as before.
 */
const STAND_DOWN_PATTERNS: readonly { reason: StandDownReason; re: RegExp }[] = [
  { reason: 'desktop', re: new RegExp(`^${CANCELLED}this session moved to Claude Desktop`) },
  { reason: 'cloud', re: new RegExp(`^${CANCELLED}sending this session to the cloud`) },
  { reason: 'background', re: new RegExp(`^${CANCELLED}this session moved to the background`) },
  { reason: 'user', re: new RegExp(`^${CANCELLED}/rate-limit-options to re-arm`) },
  { reason: 'user', re: /^Automatic continue cancelled\. Your session will wait for you instead/ },
];

/** Which stand-down reason a cancel line's content carries, or undefined for any other. */
export function standDownReason(cancelText: string): StandDownReason | undefined {
  return STAND_DOWN_PATTERNS.find((p) => p.re.test(cancelText))?.reason;
}

/**
 * The content of the LAST auto-continue cancel line appended to a transcript
 * since `baselineBytes`, or undefined when there is none or the window cannot
 * be read. The same window continuedSince judges (readAppendedWindow), so the
 * two never disagree about what "since the stop" means. Unparseable and
 * partial lines are skipped.
 */
export function lastNativeCancel(
  transcriptPath: string,
  baselineBytes: number | undefined,
  fs: ContinuedFs = nodeFs,
): string | undefined {
  const window = readAppendedWindow(transcriptPath, baselineBytes, fs);
  if (!window) {
    return undefined;
  }
  let last: string | undefined;
  for (const line of window.text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const status = classifyNativeStatus(entry);
    if (status?.kind === 'cancelled') {
      last = status.text;
    }
  }
  return last;
}
