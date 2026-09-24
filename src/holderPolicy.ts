import type { AgentRow, SessionHolder } from './liveSessions';

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

const RESUME_IN_TERMINAL_BUTTON = 'Resume in Terminal Anyway';

/**
 * Decide what `scheduler.onFire` does with a fired job, given who (if anyone)
 * already holds the session.
 *
 * This exists because of the 2026-09-23 field incident this task is named
 * for: a scheduled resume spawned a second `claude --resume` terminal while a
 * panel tab was still open on the same session, forking the conversation
 * (docs/research/2026-09-20-panel-fork-experiment.md, #6).
 *
 * The controller corrected this policy mid-implementation (see
 * task-2-report.md): `status` ("idle" | "busy" | "waiting", carried on
 * `holder` by classifyHolder) now decides the outcome, not just which KIND of
 * process holds the session -
 *   - an IDLE panel resumes as normal. This is the product's main use case:
 *     someone leaves a panel idle at a limit and walks away. The existing #7
 *     stale-tab handling (handleStalePanel / onStale) runs after the resume
 *     exactly as it already does; nothing here needs to notify instead of
 *     spawning.
 *   - a panel or terminal that is busy or waiting means the session is
 *     already being continued - by the person, or by Remote Control's own
 *     auto-continue on a bridged panel - so this silently drops the job:
 *     no spawn, no rememberReady, no notification, just a log line (naming
 *     Remote Control when the panel is bridged).
 *   - an idle terminal defers to autoContinueOn: Claude Code's own
 *     auto-continue already covers it when that setting is on (see
 *     autoContinue.ts), so this stays silent there too; only when it is OFF
 *     does this remember the job and offer "Resume in Terminal Anyway".
 *
 * `resume: true` is reserved for 'none' (nobody found), a listing failure
 * ('unknown', which must still resume rather than fail closed and silently
 * stop every future resume on a machine where `claude agents` misbehaves),
 * and now an idle panel.
 *
 * Any status other than the exact string 'idle' - including 'busy',
 * 'waiting', or an absent/unreported status - is treated as NOT idle: Task 2
 * exists to avoid a second writer, so an unknown status errs toward the
 * cautious reading rather than assuming it is safe to spawn.
 *
 * A DIFFERENT session busy or waiting in the same folder is no longer this
 * function's concern - a second controller ruling replaced "block and
 * notify" with "resume anyway, and tell the resumed model to coordinate";
 * see {@link buildResumePrompt} and `scheduler.onFire` in extension.ts, which
 * calls it directly off the same listing, independently of this decision.
 */
export function decideOnFire(holder: SessionHolder | 'unknown', autoContinueOn: boolean, shortId: string): OnFireDecision {
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
  if (holder.kind === 'panel' && holder.status === 'idle') {
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
  // terminal, busy or waiting (or an unreported status, treated the same
  // way): the session is already being worked, so this drops silently.
  if (holder.status !== 'idle') {
    return {
      resume: false,
      remember: false,
      logMessage:
        `Session ${shortId} is open in a terminal (pid ${holder.pid}) and is already ` +
        `${holder.status ?? 'active'}; not starting a second writer.`,
    };
  }
  // terminal, idle.
  if (autoContinueOn) {
    return {
      resume: false,
      remember: false,
      logMessage:
        `Session ${shortId} is open in a terminal (pid ${holder.pid}); ` +
        `Claude Code's own auto-continue will pick it back up, so nothing was started here.`,
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
        `Claude Limit Buster: the limit has reset for session ${shortId}, and it is open in a terminal. ` +
        `Continue it there.`,
      button: RESUME_IN_TERMINAL_BUTTON,
    },
  };
}

/**
 * The modal warning a MANUAL resume (the resumeNow command, or the
 * off-autoResume "Resume Now" notification's own button) shows before
 * launching into a session someone already holds.
 *
 * Per the same controller correction {@link decideOnFire} documents: an IDLE
 * panel needs no modal - that is the ordinary "come back and continue in the
 * panel, or resume by hand instead" case, not a live conflict. Every other
 * live holder still warns: a busy or waiting holder of either kind, or a
 * terminal of any status (an idle terminal still has someone who might type
 * into it, and unlike an idle panel there is no #7 auto-resync for it).
 *
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
  if (holder.kind === 'panel' && holder.status === 'idle') {
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

/** The one field {@link buildResumePrompt} needs from a busy peer's `claude agents --json` row. */
export type BusyPeer = Pick<AgentRow, 'pid' | 'name'>;

/**
 * Append a coordination sentence to the user's resume prompt when one or
 * more DIFFERENT Claude sessions are busy or waiting in the same folder
 * (see liveSessions.ts's `busyFolderPeers`).
 *
 * A second controller ruling replaced Task 2's original "block and notify"
 * treatment of this case: the extension cannot message another session
 * itself (global constraint #3 - never write into a session this extension
 * did not create), so instead it tells the RESUMED model to, by naming the
 * peer(s) in its own opening prompt and asking it to use SendMessage before
 * editing anything. `resume(job)` still launches the same way either way;
 * the prompt travels as a single argv element to `claude --resume` (see
 * resumer.ts's buildResumeArgs), never shell-quoted by hand, so nothing here
 * needs to escape the names it inserts.
 *
 * Exactly the user's own prompt, unchanged, when there are no peers - this
 * must never add stray text to the common case, which is every resume with
 * nobody else in the folder.
 */
export function buildResumePrompt(userPrompt: string, busyPeers: readonly BusyPeer[]): string {
  if (busyPeers.length === 0) {
    return userPrompt;
  }
  const names = busyPeers.map((p) => p.name ?? String(p.pid)).join(', ');
  return (
    `${userPrompt} Another Claude session is working in this folder: ${names}. ` +
    `Before editing anything, message it with SendMessage to coordinate who does what.`
  );
}
