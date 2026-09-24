import type { SessionHolder } from './liveSessions';

/**
 * What `scheduler.onFire` classifies before ever calling `resume()`: the
 * outcome of `classifyHolder`, extended with the one case it cannot see by
 * itself - a DIFFERENT session already busy in the same folder - and with
 * 'unknown' for a listing that could not be run at all. See liveSessions.ts
 * for classifyHolder and busyFolderHolder, the two pure reads this is built
 * from; composing them is wiring, done in extension.ts, once per fire, off a
 * single `claude agents --json` snapshot.
 */
export type FireHolder = SessionHolder | { kind: 'busy-elsewhere' } | 'unknown';

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
}

const RESUME_ANYWAY_BUTTON = 'Resume in Terminal Anyway';

/**
 * Decide what `scheduler.onFire` does with a fired job, given who (if anyone)
 * already holds the session or its folder.
 *
 * This exists because of the 2026-09-23 field incident this task is named
 * for: a scheduled resume spawned a second `claude --resume` terminal while a
 * panel tab was still open on the same session, forking the conversation
 * (docs/research/2026-09-20-panel-fork-experiment.md, #6). Every branch here
 * that leaves a live holder alone answers that directly; `resume: true` is
 * reserved for the two cases where nothing has been found holding the
 * session - 'none', and a listing failure, which must still resume rather
 * than fail closed and silently stop every future resume on a machine where
 * `claude agents` misbehaves.
 *
 * `panel`, `terminal` with auto-continue off, and `busy-elsewhere` all get
 * the same treatment - remembered for manual resume, and a notice with the
 * one button that claims the job (`forgetReady`, exactly like the existing
 * "Resume Now" notification) and then calls `resume(job)` anyway. Only the
 * wording differs, so the field named is enough to tell the caller which.
 * `terminal` with auto-continue on is the one case that is neither
 * remembered nor spawned: Claude Code's own terminal UI is already going to
 * pick the session back up (see autoContinue.ts), so there is nothing this
 * extension needs to do or offer.
 */
export function decideOnFire(holder: FireHolder, autoContinueOn: boolean, shortId: string): OnFireDecision {
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
  if (holder.kind === 'terminal' && autoContinueOn) {
    return {
      resume: false,
      remember: false,
      logMessage:
        `Session ${shortId} is open in a terminal (pid ${holder.pid}); ` +
        `Claude Code's own auto-continue will pick it back up, so nothing was started here.`,
    };
  }
  if (holder.kind === 'panel') {
    const bridgeNote = holder.bridged
      ? ' Remote Control is connected to it too, and may continue it on its own.'
      : '';
    return {
      resume: false,
      remember: true,
      logMessage: `Session ${shortId} is open in a Claude panel (pid ${holder.pid}); not starting a second writer.`,
      notice: {
        message:
          `Claude Limit Buster: the limit has reset for session ${shortId}, and it is open in a Claude panel. ` +
          `Continue it there.${bridgeNote}`,
        button: RESUME_ANYWAY_BUTTON,
      },
    };
  }
  if (holder.kind === 'terminal') {
    return {
      resume: false,
      remember: true,
      logMessage:
        `Session ${shortId} is open in a terminal (pid ${holder.pid}) and auto-continue is off; ` +
        `not starting a second writer.`,
      notice: {
        message:
          `Claude Limit Buster: the limit has reset for session ${shortId}, and it is open in a terminal. ` +
          `Continue it there.`,
        button: RESUME_ANYWAY_BUTTON,
      },
    };
  }
  // busy-elsewhere: nobody else is on THIS session, but a different one is
  // actively working in the same folder - just as much a second writer.
  return {
    resume: false,
    remember: true,
    logMessage: `Another Claude session is busy in this folder; not starting a second writer for ${shortId}.`,
    notice: {
      message:
        `Claude Limit Buster: the limit has reset for session ${shortId}, but this folder already has ` +
        `another active Claude session. Continue there.`,
      button: RESUME_ANYWAY_BUTTON,
    },
  };
}

/**
 * The modal warning a MANUAL resume (the resumeNow command, or the
 * off-autoResume "Resume Now" notification's own button) shows before
 * launching into a session someone already holds.
 *
 * Unlike {@link decideOnFire}, there is no folder-wide busy check here: the
 * brief scopes the manual-resume warning to "a live holder" of THIS session,
 * and a user clicking Resume Now already knows which session they mean.
 * 'none' and 'unknown' both return undefined - nothing to warn about, and (for
 * 'unknown') not knowing is not a reason to block a resume asked for by hand.
 */
export function manualResumeWarning(
  holder: SessionHolder | 'unknown',
  shortId: string,
): { message: string; button: string } | undefined {
  if (holder === 'unknown' || holder.kind === 'none') {
    return undefined;
  }
  const where = holder.kind === 'panel' ? 'a Claude panel' : 'a terminal';
  return {
    message:
      `Claude Limit Buster: session ${shortId} is already open in ${where}. ` +
      `Resuming here will fork the conversation.`,
    button: 'Resume Anyway',
  };
}
