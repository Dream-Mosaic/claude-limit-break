import type { AgentRow, SessionHolder } from './liveSessions';
import { RATE_LIMIT_LABELS } from './parsers/limitParser';

export interface OnFireDecision {
  /** Whether `resume(job)` should be called. */
  resume: boolean;
  /** Whether the job should go to `rememberReady` so "Resume Now" can still start it. */
  remember: boolean;
  /** Present whenever there is something worth writing to the output channel. */
  logMessage?: string;
  /** Defaults to 'info' when omitted; 'warn' marks a listing failure. */
  logLevel?: 'info' | 'warn';
  /** Present only when the user should be told, with exactly one button. */
  notice?: { message: string; button: string };
  /**
   * True only when this stood down for Claude Code's own auto-continue: an idle terminal at a five-hour usage limit (or one of unknown type) with the setting on. Native auto-continue arms only for `status === "rejected"` and `rateLimitType === "five_hour"`, so other limits are offered instead. The feature may not exist for every account, so the caller checks back after the stall-watch grace and offers the job if the transcript never grew; that check also keeps an unknown limit type safe.
   */
  awaitNativeContinue?: true;
}

const RESUME_IN_TERMINAL_BUTTON = 'Resume in Terminal Anyway';

/** Appended to every notice carrying {@link RESUME_IN_TERMINAL_BUTTON}: the button opens a NEW terminal on a conversation the existing one still holds. */
const SECOND_TERMINAL = ' Resuming here opens a second terminal on the same conversation.';

/**
 * Whether a holder's status counts as idle. An unknown or missing status counts as idle (fail open): resuming unattended is the goal, and a failed listing already resumes. Only 'busy' and 'waiting' are not idle.
 */
function isIdleStatus(status: string | undefined): boolean {
  return status !== 'busy' && status !== 'waiting';
}

/**
 * Decide what `scheduler.onFire` does with a fired job, given who (if anyone) already holds the session. Resuming into a session a panel or terminal still holds forks the conversation.
 *
 * `status` ("idle" | "busy" | "waiting") decides the outcome:
 *   - an IDLE panel resumes as normal (someone left a panel idle at a limit and walked away); stale-tab handling runs after the resume.
 *   - a busy or waiting panel or terminal means the session is already being continued (by the person, or by Remote Control's auto-continue on a bridged panel), so the job is silently dropped: no spawn, no rememberReady, no notification, just a log line.
 *   - an idle terminal defers to autoContinueOn for a FIVE-HOUR usage LIMIT, or one of unknown type (treated as five-hour: the follow-up native-continue check offers the job back if nothing grew). When it is OFF the job is remembered and "Resume in Terminal Anyway" is offered. Any OTHER limit type, and any OVERLOAD (`reason`), is never continued natively, so it gets the offer whatever the setting says. Neither case auto-spawns: an idle terminal is a live second writer.
 *
 * `resume: true` is reserved for 'none', a listing failure ('unknown', which must still resume rather than fail closed and stop every resume where `claude agents` misbehaves), and an idle panel (see {@link isIdleStatus}).
 *
 * A DIFFERENT busy session in the same folder does not block: see {@link buildResumePrompt}.
 */
export function decideOnFire(
  holder: SessionHolder | 'unknown',
  autoContinueOn: boolean,
  shortId: string,
  reason: 'limit' | 'overload',
  /** The limit type the detection named (LimitDetection.rateLimitType), when it could tell. Read for `reason === 'limit'` only. */
  rateLimitType?: string,
): OnFireDecision {
  if (holder === 'unknown') {
    return {
      resume: true,
      remember: false,
      logMessage: `Could not list live Claude sessions; resuming ${shortId} as usual.`,
      logLevel: 'warn',
    };
  }
  if (holder.kind === 'none') {
    return { resume: true, remember: false };
  }
  if (holder.kind === 'panel' && isIdleStatus(holder.status)) {
    return {
      resume: true,
      remember: false,
      logMessage: `Session ${shortId} is open in an idle Claude panel (pid ${holder.pid}); resuming anyway.`,
    };
  }
  if (holder.kind === 'panel') {
    const bridgeNote = holder.bridged ? ' Remote Control may have continued it.' : '';
    return {
      resume: false,
      remember: false,
      logMessage:
        `Session ${shortId} is open in a Claude panel (pid ${holder.pid}) and is already ` +
        `${holder.status ?? 'active'}; not starting a second writer.${bridgeNote}`,
    };
  }
  // terminal, explicitly busy or waiting: the session is already being worked, so this drops silently. An unreported status falls through to the idle handling below.
  if (!isIdleStatus(holder.status)) {
    return {
      resume: false,
      remember: false,
      logMessage:
        `Session ${shortId} is open in a terminal (pid ${holder.pid}) and is already ` +
        `${holder.status ?? 'active'}; not starting a second writer.`,
    };
  }
  // terminal, idle. Native auto-continue (`autoContinueAtUsageLimit`) covers a usage limit reset only, not the overload family (529, transient 429, interrupted stream), so for an overload job the setting is irrelevant and the offer is made as if it were off.
  if (reason === 'overload') {
    return {
      resume: false,
      remember: true,
      logMessage:
        `Session ${shortId} is open in a terminal (pid ${holder.pid}) and hit a server error, which ` +
        `Claude Code's own auto-continue does not cover; not starting a second writer.`,
      notice: {
        message:
          `Limit Break: session ${shortId} was stopped by a server error, and it is open in a terminal. ` +
          `Continue it there.${SECOND_TERMINAL}`,
        button: RESUME_IN_TERMINAL_BUTTON,
      },
    };
  }
  // A limit type other than five_hour: native auto-continue will not run, so standing down would strand the session. Same shape as the overload offer above. The label is Claude Code's own (limitParser.ts RATE_LIMIT_LABELS); an unknown type is named by its raw key.
  if (rateLimitType !== undefined && rateLimitType !== 'five_hour') {
    // Own keys only: an inherited member ('constructor', '__proto__') is not a label.
    const label = Object.hasOwn(RATE_LIMIT_LABELS, rateLimitType)
      ? RATE_LIMIT_LABELS[rateLimitType]
      : rateLimitType.replace(/_/g, ' ');
    return {
      resume: false,
      remember: true,
      logMessage:
        `Session ${shortId} is open in a terminal (pid ${holder.pid}) and hit a ${label} limit, which ` +
        `Claude Code's own auto-continue does not cover; not starting a second writer.`,
      notice: {
        message:
          `Limit Break: the limit has reset for session ${shortId}, and it is open in a terminal. ` +
          `Continue it there.${SECOND_TERMINAL}`,
        button: RESUME_IN_TERMINAL_BUTTON,
      },
    };
  }
  if (autoContinueOn) {
    return {
      resume: false,
      remember: false,
      logMessage:
        `Session ${shortId} is open in a terminal (pid ${holder.pid}); ` +
        `Claude Code's own auto-continue should pick it back up, so nothing was started here. ` +
        `Checking that it did.`,
      awaitNativeContinue: true,
    };
  }
  return {
    resume: false,
    remember: true,
    logMessage:
      `Session ${shortId} is open in a terminal (pid ${holder.pid}) and auto-continue is off; ` +
      `not starting a second writer.`,
    notice: {
      message:
        `Limit Break: the limit has reset for session ${shortId}, and it is open in a terminal. ` +
        `Continue it there.${SECOND_TERMINAL}`,
      button: RESUME_IN_TERMINAL_BUTTON,
    },
  };
}

/**
 * What "Resume in Terminal Anyway" says instead of resuming when the holder, re-read at click time, is busy or waiting; undefined means go ahead.
 *
 * The notification does not auto-dismiss, so by the click the user may be back at that terminal and a second `claude --resume` would fork it. An idle holder (fail open per {@link isIdleStatus}), no holder and a failed listing all go ahead. Worded by where the holder is; a busy panel is stopped too.
 */
export function busyAtClickNotice(holder: SessionHolder | 'unknown', shortId: string): string | undefined {
  if (holder === 'unknown' || holder.kind === 'none' || isIdleStatus(holder.status)) {
    return undefined;
  }
  const where = holder.kind === 'panel' ? 'a Claude panel' : 'a terminal';
  return `Limit Break: session ${shortId} is now busy in ${where}; not starting a second writer.`;
}

/**
 * The modal warning a MANUAL resume (the resumeNow command, or the off-autoResume "Resume Now" notification's button) shows before launching into a session someone already holds.
 *
 * An IDLE panel (per {@link isIdleStatus}) needs no modal: that is the ordinary "come back and continue" case. Every other live holder still warns: a busy or waiting holder of either kind, or a terminal of any status (someone might type into it, and unlike an idle panel it has no auto-resync).
 *
 * 'none' and 'unknown' return undefined: not knowing is not a reason to block a resume asked for by hand.
 */
export function manualResumeWarning(
  holder: SessionHolder | 'unknown',
  shortId: string,
): { message: string; button: string } | undefined {
  if (holder === 'unknown' || holder.kind === 'none') {
    return undefined;
  }
  if (holder.kind === 'panel' && isIdleStatus(holder.status)) {
    return undefined;
  }
  const where = holder.kind === 'panel' ? 'a Claude panel' : 'a terminal';
  return {
    message:
      `Limit Break: session ${shortId} is already open in ${where}. ` +
      `Resuming here will fork the conversation.`,
    button: 'Resume Anyway',
  };
}

/** The one field {@link buildResumePrompt} needs from a busy peer's `claude agents --json` row. */
export type BusyPeer = Pick<AgentRow, 'pid' | 'name'>;

/** Longest a peer name may run in a prompt or notice; `claude agents` names are free text. */
const MAX_PEER_NAME = 64;

/**
 * How a busy peer is named in the resume prompt and notice. The name comes from `claude agents --json`, text this extension does not control, landing in a session's opening prompt, so it is folded onto one line (CR/LF become a space), any double quote becomes a single one, it is capped at MAX_PEER_NAME characters, and it is quoted. The pid fallback is our own number and stays bare.
 */
export function peerLabel(peer: BusyPeer): string {
  if (peer.name === undefined) {
    return String(peer.pid);
  }
  const oneLine = peer.name.replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
  return `"${oneLine.slice(0, MAX_PEER_NAME)}"`;
}

/**
 * Append a coordination sentence to the user's resume prompt when one or more DIFFERENT Claude sessions are busy or waiting in the same folder (see liveSessions.ts's `busyFolderPeers`).
 *
 * The extension never writes into a session it did not create, so it tells the RESUMED model to coordinate: it names the peer(s) in the opening prompt and asks it to use SendMessage before editing anything. The prompt travels as a single argv element (resumer.ts's buildResumeArgs), so nothing here needs shell escaping, but the names are untrusted text, so each is quoted, kept to one line and capped (see {@link peerLabel}).
 *
 * Exactly the user's prompt, unchanged, when there are no peers.
 */
export function buildResumePrompt(userPrompt: string, busyPeers: readonly BusyPeer[]): string {
  if (busyPeers.length === 0) {
    return userPrompt;
  }
  const names = busyPeers.map(peerLabel).join(', ');
  return (
    `${userPrompt} Another Claude session is working in this folder: ${names}. ` +
    `Before editing anything, message it with SendMessage to coordinate who does what.`
  );
}
