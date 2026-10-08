import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './log';
import { readSettings, type Settings } from './config';
import { TranscriptWatcher, isSubagentFile } from './transcriptWatcher';
import { ResumeScheduler, restoreJobs, type PendingJob } from './scheduler';
import { CountdownStatusBar } from './statusBar';
import { planResume } from './policy';
import { randomJitterMs } from './randomDelay';
import { playAlertSound } from './sound';
import {
  buildTerminalOptions,
  buildTrustTerminalOptions,
  buildResumeArgs,
  buildHeadlessArgs,
  resolveClaudeLauncher,
  cwdExists,
} from './resumer';
import { isFolderTrusted, trustedSpelling, readClaudeUserConfig, defaultClaudeConfigPath } from './trust';
import { GRACE_MS, stallVerdict } from './stallWatch';
import { parseLastUsage, type UsageRecord } from './budget';
import {
  decideUpdateCheck,
  fetchLatestReleaseTag,
  shouldOfferFirstRunPrompt,
  shouldEnableUpdateChecks,
  DEFAULT_CHECK_INTERVAL_MS,
  LAST_CHECKED_KEY,
  LATEST_TAG_KEY,
  DISMISSED_VERSION_KEY,
  FIRST_RUN_PROMPT_KEY,
  RELEASE_TAG_URL,
  type FirstRunPromptChoice,
} from './updateCheck';
import { isSessionId, resolveSession } from './sessionResolver';
import {
  livePanelDetector,
  agentRowsDetector,
  classifyHolder,
  busyFolderPeers,
  type HolderRecord,
} from './liveSessions';
import { decideOnFire, manualResumeWarning, buildResumePrompt, peerLabel, busyAtClickNotice } from './holderPolicy';
import { autoContinueEnabled } from './autoContinue';
import { sessionRegistryDir, readSessionRecord } from './sessionRegistry';
import { selectClaudePanelTab, type WebviewTab } from './panelTab';
import { buildReopenOffer, chooseReopenCommand } from './reopenOffer';
import { execFileSync } from 'node:child_process';
import {
  claimsDir,
  claimKeyFor,
  claimResume,
  claimOwner,
  holdClaim,
  claimHoldDeadline,
  releaseClaim,
  cleanupStaleClaims,
} from './claims';
import { GaveUpState, gaveUpNotice, budgetRefusalNotice } from './gaveUp';
import { continuedSince } from './continuedSince';
import { lastNativeCancel, standDownReason, STAND_DOWN_LABEL } from './nativeContinue';
import { OverloadStreaks, overloadBackoffMs, MAX_OVERLOAD_RESUMES } from './overloadBackoff';
import { RATE_LIMIT_LABELS } from './parsers/limitParser';

const NS = 'claudeLimitBreak';

/** Label for the trust-hotlink button on the untrusted-folder notice. */
const TRUST_BUTTON = 'Open Claude to Trust';

/**
 * Where jobs waiting for "Resume Now" are kept across a reload. Separate from
 * the scheduler's own `claudeLimitBreak.pending`: these have already fired, and
 * putting them back there would count down to a deadline that has passed.
 */
const READY_KEY = 'claudeLimitBreak.ready';

/**
 * Tail of a transcript read for its newest usage record; wide enough to reach
 * past one oversized entry (a base64 image) to the last real turn.
 */
const USAGE_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * Whether a transcript entry's cwd belongs to this window. The watcher is
 * global (every project under ~/.claude/projects), so per-turn reactions must
 * filter with this.
 *
 * Compared as resolved paths with a separator boundary (/work/app must not match
 * /work/app-old), and case-folded because a Windows path recorded by the CLI need
 * not match VS Code's casing.
 */
export function isInsideWorkspace(cwd: string | undefined, folders: readonly string[]): boolean {
  if (!cwd) {
    return false;
  }
  const key = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const target = key(cwd);
  return folders.some((folder) => {
    const root = key(folder);
    return target === root || target.startsWith(root + path.sep);
  });
}

/**
 * The label a notice names a limit by (Claude Code's own, e.g. "weekly",
 * "Opus"), or "usage" when unknown. Own property only, so a stored type of
 * `constructor` is no label.
 */
function limitLabel(job: { rateLimitType?: string }): string {
  return job.rateLimitType !== undefined && Object.hasOwn(RATE_LIMIT_LABELS, job.rateLimitType)
    ? RATE_LIMIT_LABELS[job.rateLimitType]!
    : 'usage';
}

/** "an Opus limit", "a weekly limit" - and "a usage limit", hence no "u". */
function article(label: string): string {
  return /^[aeio]/i.test(label) ? 'an' : 'a';
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Limit Break');
  const log = createLogger('limit-break', (line) => channel.appendLine(line));
  const settings = () => readSettings(vscode.workspace.getConfiguration(NS));

  // Disk hygiene: keeps the machine-wide claims directory from growing.
  // claimResume's own staleness check is what stops a stale claim blocking anything.
  cleanupStaleClaims(claimsDir(), Date.now(), fs, log);

  /**
   * Take (or, on a manual path, refresh) the cross-window claim for `key`,
   * recording this window's identity (`vscode.env.sessionId`, per window and run)
   * so a collision can be told apart from another window's.
   */
  const claim = (key: string) => claimResume(claimsDir(), key, Date.now(), fs, log, vscode.env.sessionId);

  const scheduler = new ResumeScheduler(context.globalState, log);
  const status = new CountdownStatusBar();

  /**
   * Sessions this window has stopped trying to resume, and why (gaveUp.ts).
   * In memory only: a reload starts clean.
   */
  const gaveUp = new GaveUpState();

  /**
   * Consecutive overload retries planned per session since its last finished
   * turn; picks each retry's backoff (overloadBackoff.ts). In memory only.
   */
  const overloadStreaks = new OverloadStreaks();

  /**
   * The one place the status bar is drawn from. Reads `scheduler.jobs` and
   * `readyJobs` fresh each call so every caller draws the same picture.
   */
  const render = (): void => {
    status.update(scheduler.jobs, readyJobs, settings().statusBar, gaveUp.list());
  };
  const watcher = new TranscriptWatcher(
    () => settings().maxWaitHours,
    () => settings().transcriptPollSeconds,
    log,
    // Out-of-scope entries are dropped before parsing. Read per call so a
    // setting or folder change applies without a reload.
    () => ({
      mode: settings().watchScope,
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    }),
  );

  const statBytes = (p: string) => fs.statSync(p).size;

  // Jobs whose cooldown elapsed while autoResume was off. The scheduler clears
  // its own state before firing, so without this list "Resume Now" would find
  // nothing. A list, not a slot: sessions in different projects can come ready
  // while an earlier notification is unanswered, and one slot would resume the
  // wrong session.
  const readyJobs: PendingJob[] = [];

  /**
   * Written through to globalState on every change and read back at
   * activation, so a reload does not destroy a job waiting for a manual start.
   */
  const persistReady = () => {
    void context.globalState.update(READY_KEY, readyJobs.length > 0 ? [...readyJobs] : undefined);
  };

  /**
   * Drop a remembered job; reports whether it was there. Re-renders on
   * removal because the tooltip lists ready jobs.
   */
  const forgetReady = (sessionId: string) => {
    const at = readyJobs.findIndex((j) => j.sessionId === sessionId);
    if (at < 0) {
      return false;
    }
    readyJobs.splice(at, 1);
    persistReady();
    render();
    return true;
  };

  /** Remember a job for manual resume, replacing any earlier one for the same session. */
  const rememberReady = (job: PendingJob) => {
    forgetReady(job.sessionId);
    readyJobs.push(job);
    persistReady();
    render();
  };

  // Restored before anything can add to the list: a job the previous window
  // offered and nobody answered stays claimable from "Resume Now". Validated like
  // the scheduler's list, since this is globalState too; failures are dropped
  // with a log line.
  const restoredReady = restoreJobs(context.globalState.get<unknown>(READY_KEY), log, 'ready');
  if (restoredReady.length > 0) {
    readyJobs.push(...restoredReady);
    log.info(`Restored ${restoredReady.length} resume(s) still waiting to be started by hand.`);
  }

  /**
   * The newest real usage record in a transcript, read from the tail only
   * (transcripts reach tens of MB). A limit's synthetic error entry has zero usage
   * and is skipped by parseLastUsage, hence USAGE_TAIL_BYTES. Failure, or no real
   * turn in the window, is undefined (unmeasured).
   */
  const readUsage = (transcript: string): UsageRecord | undefined => {
    try {
      const size = fs.statSync(transcript).size;
      const start = Math.max(0, size - USAGE_TAIL_BYTES);
      const length = size - start;
      if (length <= 0) {
        return undefined;
      }
      const fd = fs.openSync(transcript, 'r');
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        return parseLastUsage(buffer.toString('utf8'));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return undefined;
    }
  };

  /** Arm a planned resume: trust check, scheduler, and the notice that names both. */
  const schedule = (planned: PendingJob, s: Settings, estimate: number | undefined): void => {
    // Checked at schedule time, while the user is at the keyboard and can trust
    // the folder; by fire time an untrusted folder stalls silently at Claude's
    // trust prompt. Read only: answering that prompt is the user's call.
    const folderTrusted = planned.cwd
      ? isFolderTrusted(
          planned.cwd,
          readClaudeUserConfig(defaultClaudeConfigPath(), (p) => fs.readFileSync(p, 'utf8')),
          process.platform,
        )
      : undefined;
    const job = { ...planned, folderTrusted };
    if (!scheduler.schedule(job)) {
      return;
    }
    // Counted when a retry is scheduled, not launched: every window sees the
    // same detections so counts agree, while only one launches each resume.
    if (job.reason === 'overload') {
      overloadStreaks.planned(job.sessionId);
    }
    // Cancel holds a cancelled job's claim until its fire time. If this window
    // cancelled then re-detects the same reset, its own Cancel claim would drop
    // the fresh plan at fire, so release a claim this window owns; leave another
    // window's.
    const freshKey = claimKeyFor(job);
    if (claimOwner(claimsDir(), freshKey, fs) === vscode.env.sessionId) {
      releaseClaim(claimsDir(), freshKey, fs, log);
      log.info(`Released this window's own claim on ${freshKey} so the fresh plan can fire.`);
    }
    warnIfUntrusted(job);
    if (job.offerOnly) {
      // "resuming at" would be a lie for a job that only offers.
      announceOfferOnly(job, s);
      return;
    }
    if (s.notify) {
      const at = new Date(job.resumeAtMs).toLocaleTimeString();
      showResumeNotice(
        job,
        `Limit Break: resuming at ${at}${estimate === undefined ? '' : ` (~${estimate.toLocaleString()} tokens)`}.`,
      );
    }
  };

  /** The log line for a job whose folder the Claude CLI has not trusted. */
  const warnIfUntrusted = (job: PendingJob): void => {
    if (job.folderTrusted === false) {
      log.warn(
        `Folder ${job.cwd} is not trusted by the Claude CLI; the resume will stall at its trust prompt unless you trust it first.`,
      );
    }
  };

  /**
   * Notice about a resume that will run unattended. When the folder is not
   * trusted by the Claude CLI it offers "Open Claude to Trust" so the user can
   * answer the trust dialog now. The button only opens a terminal; it never
   * answers the dialog itself.
   */
  const showResumeNotice = (job: PendingJob, message: string): void => {
    if (job.folderTrusted !== false) {
      void vscode.window.showInformationMessage(message);
      return;
    }
    const withNote =
      `${message} This folder is not trusted by the Claude CLI yet; the resume will stall at its trust prompt ` +
      'unless you trust it first.';
    void Promise.resolve(vscode.window.showInformationMessage(withNote, TRUST_BUTTON)).then((choice) => {
      if (choice === TRUST_BUTTON) {
        void vscode.commands.executeCommand(`${NS}.openClaudeToTrust`, job.cwd);
      }
    });
  };

  /**
   * Tell the user at detection that a limit resetting beyond maxWaitHours will
   * not resume on its own. Always logged; shown once across windows via its own
   * claim (the fire's key plus a suffix, held to the same deadline). A same-reset
   * re-detection in this window never gets here: the scheduler keeps the
   * offer-only job or upgrades it in place (announceUpgrade). Honours `notify`.
   */
  const announceOfferOnly = (job: PendingJob, s: Settings): void => {
    const label = limitLabel(job);
    const message =
      `Limit Break: session ${job.sessionId.slice(0, 8)} hit ${article(label)} ${label} limit that resets ` +
      `${new Date(job.baseResumeAtMs).toLocaleString()}. That is more than ${s.maxWaitHours} hours away, ` +
      `so it won't resume automatically; Resume Now will be offered when it resets.`;
    announceOnce(job, s, 'offer-notice', message, 'offer-only');
  };

  /**
   * An offer-only job that a same-reset re-detection made automatic
   * (scheduler.onUpgrade). Told once across windows, on a claim of its own.
   */
  const announceUpgrade = (job: PendingJob, s: Settings): void => {
    const message =
      `Limit Break: session ${job.sessionId.slice(0, 8)} hit its ${limitLabel(job)} limit again. ` +
      `It resets within ${s.maxWaitHours} hours, so it will now resume automatically at ` +
      `${new Date(job.resumeAtMs).toLocaleTimeString()}.`;
    // It now resumes unattended, so call out an untrusted folder as a fresh
    // schedule does.
    warnIfUntrusted(job);
    announceOnce(job, s, 'upgrade-notice', message, 'upgrade', () => showResumeNotice(job, message));
  };

  /**
   * Log `message`, then - with `notify` on - show it unless another window
   * already has: the claim on the job's fire key plus `-<suffix>` (never the
   * fire's own claim), held to the fire claim's own deadline.
   */
  const announceOnce = (
    job: PendingJob,
    s: Settings,
    suffix: string,
    message: string,
    what: string,
    show: () => void = () => void vscode.window.showInformationMessage(message),
  ): void => {
    log.info(message);
    if (!s.notify) {
      return;
    }
    const noticeKey = `${claimKeyFor(job)}-${suffix}`;
    const until = claimHoldDeadline(job, s.randomDelayMinMinutes, s.randomDelayMaxMinutes);
    if (holdClaim(claimsDir(), noticeKey, Date.now(), until, fs, log, vscode.env.sessionId) === 'taken') {
      log.info(`The ${what} notice for ${job.sessionId.slice(0, 8)} was already shown by another window; not repeating it.`);
      return;
    }
    show();
  };

  const onDetection = (hit: Parameters<typeof planResume>[0], reason: 'limit' | 'overload') => {
    const s = settings();
    // An overload retry's backoff comes from this session's consecutive count;
    // `undefined` is the sixth, when nothing more is scheduled. Only the id is
    // wanted, so resolveSession's size is stubbed.
    const streakId = reason === 'overload' ? resolveSession(hit.file, hit.cwd, () => 0)?.sessionId : undefined;
    const backoffMs = streakId === undefined ? 0 : overloadBackoffMs(overloadStreaks.count(streakId));
    const plan = planResume(hit, reason, s, statBytes, new Date(), randomJitterMs, readUsage, backoffMs ?? 0);
    if (plan.kind === 'ignore') {
      log.info(plan.reason);
      return;
    }
    if (backoffMs === undefined) {
      // Kept stopping on server errors through repeated retries: schedule
      // nothing, show it as given up (notified once, gaveUp.ts) until it finishes a
      // turn. Before gaveUp.detected() on purpose: a further overload is the same
      // streak, so must not clear the record or re-warn.
      const sessionId = plan.kind === 'refuse' ? plan.sessionId : plan.job.sessionId;
      const cwd = plan.kind === 'refuse' ? plan.cwd : plan.job.cwd;
      log.warn(
        `Session ${sessionId} kept stopping on server errors (${MAX_OVERLOAD_RESUMES} resumes in a row); ` +
          'not scheduling another until it finishes a turn.',
      );
      const warn = gaveUp.record({ sessionId, cwd, cause: 'overloads', atMs: Date.now() });
      render();
      if (warn) {
        void vscode.window.showWarningMessage(gaveUpNotice({ cause: 'overloads', sessionId, cwd }));
      } else {
        log.info(`Already warned about this for ${sessionId}; not notifying again until its next detection.`);
      }
      return;
    }
    // Any new detection means the session is live again, so whatever it last
    // gave up on is history. 'ignore' names no session, so clears none.
    if (gaveUp.detected(plan.kind === 'refuse' ? plan.sessionId : plan.job.sessionId)) {
      render();
    }
    if (plan.kind === 'refuse') {
      log.warn(plan.reason);
      // Offered, not just announced: a cold cache makes a big resume costly, but
      // whether it is worth it is the user's call. Yes replans with the cap lifted
      // for this one incident.
      void Promise.resolve(
        vscode.window.showWarningMessage(budgetRefusalNotice(plan.sessionId, plan.reason), 'Resume anyway'),
      ).then((choice) => {
        if (choice !== 'Resume anyway') {
          // Dismissed without going ahead: give up visibly; no second popup, since
          // the refusal itself was the notice for this cause.
          log.warn(`Budget refusal for ${plan.sessionId} dismissed; not resuming it.`);
          gaveUp.record({ sessionId: plan.sessionId, cwd: plan.cwd, cause: 'budget', atMs: Date.now() });
          render();
          return;
        }
        const forced = planResume(
          hit,
          reason,
          { ...s, maxResumeTokens: 0 },
          statBytes,
          new Date(),
          randomJitterMs,
          readUsage,
          backoffMs,
        );
        if (forced.kind !== 'schedule') {
          log.warn(`Could not resume ${hit.file} even with the budget lifted: ${forced.reason}`);
          return;
        }
        log.info(`Budget overridden by hand for ${forced.job.sessionId}.`);
        schedule(forced.job, s, forced.estimate);
      });
      return;
    }
    if (plan.budgetUnmeasured) {
      log.info(`Resume budget: no usage record for session ${plan.job.sessionId.slice(0, 8)}; not checked.`);
    }
    schedule(plan.job, s, plan.estimate);
  };

  /**
   * Re-read trust for a job whose folder was untrusted when scheduled, so the
   * warning can clear once the user trusts the folder during the countdown.
   *
   * Only false -> true. Keyed on the config file's mtime so an unchanged file
   * costs a stat, not a parse; an unreadable mtime falls through to re-reading.
   */
  // Keyed by session, not per window: onChange reports only the soonest job,
  // so a second session's first check could hit an mtime another session already
  // recorded and never re-read its trust.
  const trustStamps = new Map<string, number>();
  /** Returns whether this call actually flipped `job.folderTrusted` to true. */
  const refreshTrust = (job: PendingJob | undefined): boolean => {
    if (!job || job.folderTrusted !== false || !job.cwd) {
      return false;
    }
    const configPath = defaultClaudeConfigPath();
    let stamp: number | undefined;
    try {
      stamp = fs.statSync(configPath).mtimeMs;
    } catch {
      stamp = undefined;
    }
    if (stamp !== undefined && stamp === trustStamps.get(job.sessionId)) {
      return false;
    }
    if (stamp !== undefined) {
      trustStamps.set(job.sessionId, stamp);
    }
    const trusted = isFolderTrusted(
      job.cwd,
      readClaudeUserConfig(configPath, (p) => fs.readFileSync(p, 'utf8')),
      process.platform,
    );
    if (trusted) {
      job.folderTrusted = true;
      log.info(`Folder ${job.cwd} is now trusted by the Claude CLI; the resume will not stall at its prompt.`);
      return true;
    }
    return false;
  };

  /**
   * Re-check trust for every job the tooltip can show a marker for
   * (counting down and ready). Each check is refreshTrust's cheap mtime-cached
   * stat.
   *
   * A ready job's flip is persisted: otherwise a reload would restore the stale
   * `folderTrusted: false`.
   */
  const refreshAllTrust = (): void => {
    for (const job of scheduler.jobs) {
      refreshTrust(job);
    }
    let readyChanged = false;
    for (const job of readyJobs) {
      if (refreshTrust(job)) {
        readyChanged = true;
      }
    }
    if (readyChanged) {
      persistReady();
    }
  };

  /** Transcript size, or undefined when it cannot be read at all. */
  const transcriptBytes = (p: string): number | undefined => {
    try {
      return fs.statSync(p).size;
    } catch {
      return undefined;
    }
  };

  /**
   * Outstanding stall checks, so a window that closes mid-grace does not leave
   * a timer holding the extension host open.
   */
  const stallChecks = new Set<NodeJS.Timeout>();

  const which = (cmd: string) => {
    try {
      const finder = process.platform === 'win32' ? 'where' : 'which';
      return execFileSync(finder, [cmd], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const readShim = (p: string) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  const findLauncher = (configured: string) =>
    resolveClaudeLauncher(configured, process.platform, which, readShim);

  /**
   * Sessions THIS extension has resumed (this window, this run), each against
   * its terminal's pid. onInputNeeded fires for every session on the machine; a
   * stale panel tab is this extension's doing only for sessions it put a
   * `--resume` terminal against, and the pid keeps the detector from counting
   * that resume as someone else holding the session.
   */
  const resumedSessions = new Map<string, Promise<number | undefined>>();

  /**
   * `claude agents --json`, with a timeout so a hung CLI cannot take the
   * caller with it. Shared by every listing reader so a hang or missing
   * executable is one behaviour.
   */
  const runAgentsListing = (): string => {
    const launcher = findLauncher(settings().claudeCommand);
    if (!launcher) {
      throw new Error('no claude executable');
    }
    return execFileSync(launcher.file, [...launcher.args, 'agents', '--json'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  };

  /** One pid's `~/.claude/sessions/<pid>.json` record, the label half of the liveness/label split (see liveSessions.ts). */
  const readHolderRecord = (pid: number): HolderRecord | undefined =>
    readSessionRecord(sessionRegistryDir(), pid, (f) => fs.readFileSync(f, 'utf8'));

  /**
   * Is a panel tab holding this session open, apart from our own resume?
   * Liveness comes from `claude agents --json`, the entrypoint from the per-pid
   * record (see liveSessions.ts).
   */
  const detectLivePanel = livePanelDetector(runAgentsListing, readHolderRecord);

  /**
   * `claude agents --json`, run once and parsed, or `'unknown'` when the
   * listing could not be run. Feeds classifyHolder / busyFolderPeers.
   */
  const detectAgentRows = agentRowsDetector(runAgentsListing);

  /**
   * Record that a resume of `job` failed for `cause` and notify through
   * `show` (each site keeps its own severity) the first time that cause is seen
   * for the session since its last detection, and every time when `manual`. The
   * caller logs; this only decides about the popup and status bar. Never touches
   * claims: callers release theirs after resume() returns.
   */
  const giveUp = (
    job: PendingJob,
    cause: 'stall' | 'launcher' | 'cwd',
    show: (message: string) => Thenable<unknown>,
    manual = false,
  ): void => {
    const warn = gaveUp.record({ sessionId: job.sessionId, cwd: job.cwd, cause, atMs: Date.now() }, manual);
    render();
    if (warn) {
      void show(
        cause === 'stall'
          ? gaveUpNotice({ cause, sessionId: job.sessionId, cwd: job.cwd, folderTrusted: job.folderTrusted })
          : gaveUpNotice({ cause, sessionId: job.sessionId, cwd: job.cwd }),
      );
    } else {
      log.info(`Already warned about this for ${job.sessionId}; not notifying again until its next detection.`);
    }
  };

  /**
   * Attempts to launch a resume. Returns whether a terminal launch was
   * attempted (false: no claude executable, or cwd gone), so callers know whether
   * the job is discharged or still outstanding.
   *
   * `manual` is true when the user clicked something (resumeNow, the Resume Now
   * button, "Resume in Terminal Anyway"): launch failures are then always
   * notified. Only scheduler.onFire's automatic resume leaves it false. The stall
   * check takes it too: one session can hold a ready job AND a counting-down job,
   * so two manual stalls can happen with no detection in between.
   */
  const resume = (job: PendingJob, manual = false): boolean => {
    const s = settings();
    const which = (cmd: string) => {
      try {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        return execFileSync(finder, [cmd], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim() || undefined;
      } catch {
        return undefined;
      }
    };
    const readShim = (p: string) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    };
    const launcher = resolveClaudeLauncher(s.claudeCommand, process.platform, which, readShim);
    if (!launcher) {
      // Logged every time, notified once per session.
      log.error(`Cannot resume ${job.sessionId}: no claude executable found for "${s.claudeCommand || 'claude'}".`);
      giveUp(job, 'launcher', (m) => vscode.window.showErrorMessage(m), manual);
      return false;
    }
    // createTerminal does not throw on a bad cwd; VS Code reports it
    // asynchronously, after success is logged. A stale cwd (renamed project,
    // unplugged drive) is refused here synchronously, naming the path and
    // transcript.
    //
    // statSync().isDirectory(), not existsSync, which is also true for a file;
    // try/catch because statSync throws on a missing path.
    const cwdIsDirectory = (p: string): boolean => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    };
    if (!cwdExists(job.cwd, cwdIsDirectory)) {
      log.error(`Cannot resume ${job.sessionId}: cwd "${job.cwd}" no longer exists (recorded in ${job.transcript}).`);
      giveUp(job, 'cwd', (m) => vscode.window.showErrorMessage(m), manual);
      return false;
    }
    // `claude --resume` only ever receives a UUID. Jobs are validated on restore
    // and resolve, so this should never fire; it stops a bad id at the one place it
    // could do harm.
    if (!isSessionId(job.sessionId)) {
      log.error(`Refusing to resume: "${String(job.sessionId)}" is not a session id.`);
      return false;
    }
    // Headless is opt-in and does not inherit the session's permission mode, so
    // headlessPermissionMode decides whether it can do tool work; empty means it
    // cannot, the safe default for an unattended run.
    const claudeArgs =
      s.resumeMode === 'headless'
        ? buildHeadlessArgs(job.sessionId, job.prompt, s.headlessPermissionMode)
        : buildResumeArgs(job.sessionId, job.prompt);
    // The CLI finds its trust record by exact key and one folder can hold
    // several spellings (e.g. drive-letter case). Launch from the spelling on
    // record as trusted; same directory, only the name changes.
    const onRecord = job.cwd
      ? trustedSpelling(
          job.cwd,
          readClaudeUserConfig(defaultClaudeConfigPath(), (p) => fs.readFileSync(p, 'utf8')),
          process.platform,
        )
      : undefined;
    const launchCwd = onRecord ?? job.cwd;
    if (onRecord && onRecord !== job.cwd) {
      log.info(`Resuming ${job.sessionId} from "${onRecord}", the spelling the Claude CLI has trusted, rather than "${job.cwd}".`);
    }
    const opts = buildTerminalOptions(
      { sessionId: job.sessionId, transcript: job.transcript, cwd: launchCwd, bytes: 0 },
      job.prompt,
      launcher,
      claudeArgs,
    );
    // A NEW terminal, every time. Never activeTerminal, never sendText: if
    // Claude has died, the prompt would land in whatever shell is sitting there.
    const terminal = vscode.window.createTerminal(opts);
    terminal.show();
    // Only once the terminal launched, so a session never resumed is not warned about later.
    resumedSessions.set(job.sessionId, Promise.resolve(terminal.processId).catch(() => undefined));
    log.info(`Resumed ${job.sessionId} in a new terminal.`);
    // A launched resume is no longer given up; a stall records it again.
    if (gaveUp.launched(job.sessionId)) {
      render();
    }

    // A terminal existing is not a resume happening: an untrusted folder parks
    // `claude` at its trust prompt, and a launch can fail inside the terminal
    // process after success was logged. A working session appends to its
    // transcript, so check that once, after a grace long enough for a cold cache.
    const bytesAtLaunch = transcriptBytes(job.transcript) ?? 0;
    const check = setTimeout(() => {
      stallChecks.delete(check);
      const bytesNow = transcriptBytes(job.transcript);
      const verdict = stallVerdict({ bytesAtLaunch, bytesNow });
      if (verdict === 'grew') {
        log.info(`Resume of ${job.sessionId} is producing work; its transcript has grown.`);
        return;
      }
      const trustFirst =
        job.folderTrusted === false
          ? ' This folder is not trusted by the Claude CLI, which is the most likely reason: Claude is waiting at its trust prompt.'
          : ' Claude may be waiting at a prompt, or may have exited.';
      log.warn(
        `Resume of ${job.sessionId} did not produce any work: ${job.transcript} was ${bytesAtLaunch} bytes at launch and ` +
          `${bytesNow ?? 'unreadable'} now.${trustFirst}`,
      );
      giveUp(job, 'stall', (m) => vscode.window.showWarningMessage(m), manual);
    }, GRACE_MS);
    stallChecks.add(check);
    return true;
  };

  /**
   * The session has moved on since its stop was detected: a real user or
   * assistant entry appended after the job's detection-time size
   * (continuedSince.ts). A job without that size, or an unreadable transcript,
   * reads as not continued.
   */
  const hasContinued = (job: PendingJob): boolean => continuedSince(job.transcript, job.transcriptBytesAtDetection);

  /**
   * Gate for every MANUAL path (resumeNow, the Resume Now button, the
   * native-continue offer, "Resume in Terminal Anyway"): resuming a session that
   * has moved on would put a second writer on it, so ask first (modal). Resolves
   * true when there is nothing to ask or they go ahead.
   */
  const confirmNotContinued = async (job: PendingJob): Promise<boolean> => {
    if (!hasContinued(job)) {
      return true;
    }
    const button = 'Resume Anyway';
    const pick = await Promise.resolve(
      vscode.window.showWarningMessage(
        `Limit Break: session ${job.sessionId.slice(0, 8)} has continued since it stopped. ` +
          'Resuming now will fork the conversation.',
        { modal: true },
        button,
      ),
    );
    return pick === button;
  };

  /**
   * The gate every MANUAL resume goes through before `resume()`: the
   * continued-since check, then the live-holder warning.
   *
   * Unlike scheduler.onFire's holder check, a live holder here is a warning to
   * click through, not a reason to silently redirect: the user knows which session
   * they mean. `ourPid` is undefined: nothing of ours has been resumed yet.
   */
  const confirmManualResume = async (job: PendingJob): Promise<boolean> => {
    if (!(await confirmNotContinued(job))) {
      return false;
    }
    const rows = detectAgentRows();
    const holder = rows === 'unknown' ? 'unknown' : classifyHolder(rows, job.sessionId, undefined, readHolderRecord);
    const warning = manualResumeWarning(holder, job.sessionId.slice(0, 8));
    if (!warning) {
      return true;
    }
    const pick = await Promise.resolve(
      vscode.window.showWarningMessage(warning.message, { modal: true }, warning.button),
    );
    return pick === warning.button;
  };

  /**
   * A "Resume Now" notification for one remembered job (the off-autoResume
   * cooldown, or Claude Code's own auto-continue not picking the session back up).
   * The caller has already remembered the job; the click is a manual resume of
   * exactly that job.
   */
  const offerResumeNow = (job: PendingJob, claimKey: string, message: string): void => {
    void Promise.resolve(vscode.window.showInformationMessage(message, 'Resume Now')).then(async (choice) => {
      if (choice !== 'Resume Now') {
        return;
      }
      // Same live-holder gate as the resumeNow command.
      if (!(await confirmManualResume(job))) {
        return;
      }
      // This job, closed over - not "whatever is ready now": another session can
      // come ready while this notice is up. forgetReady is also how this click takes
      // ownership: the notice outlives the job, and without it a later click would
      // launch a second `claude --resume`.
      if (!forgetReady(job.sessionId)) {
        void vscode.window.showInformationMessage(
          `Limit Break: session ${job.sessionId.slice(0, 8)} was already resumed or cancelled.`,
        );
        return;
      }
      // If the launch never started, undo that ownership (rememberReady) or the
      // job is gone. The notice can sit unanswered long enough for the fire's claim to
      // go stale and another window to take it, so bypass the answer to launch
      // (explicit user intent) but release only a claim this call won ('claimed'),
      // never one 'taken' by someone else.
      const notifyClaim = claim(claimKey);
      if (!resume(job, true)) {
        rememberReady(job);
        if (notifyClaim === 'claimed') {
          releaseClaim(claimsDir(), claimKey, fs, log);
        }
      }
    });
  };

  /**
   * Stand down when Claude Code's own auto-continue was cancelled because
   * someone else has the session (Desktop, cloud, background) or the user declined
   * (Esc / chose to wait); a resume would be a second writer or against what they
   * said.
   *
   * Takes the LAST cancel line since the baseline. Only the reasons in
   * nativeContinue.ts stand down; other reasons or no cancel line return false,
   * and a false match costs a notice, not a resume.
   *
   * On stand-down the job is remembered for Resume Now, and the fire's claim is
   * KEPT like every other declined fire (see `!decision.resume` in
   * scheduler.onFire). Reports whether it stood down.
   */
  const standDownOnNativeCancel = (job: PendingJob, claimKey: string, baseline: number | undefined): boolean => {
    const cancel = lastNativeCancel(job.transcript, baseline);
    const reason = cancel === undefined ? undefined : standDownReason(cancel);
    if (reason === undefined) {
      return false;
    }
    const id8 = job.sessionId.slice(0, 8);
    rememberReady(job);
    log.info(`Session ${id8}: Claude Code's auto-continue was cancelled (${cancel}); not resuming here.`);
    offerResumeNow(
      job,
      claimKey,
      `Limit Break: session ${id8} was ${STAND_DOWN_LABEL[reason]}, so it was not resumed here.`,
    );
    return true;
  };

  /**
   * Native auto-continue checks waiting out their grace, apart from stallChecks
   * so Cancel can drop them (a late check would offer back a discarded job).
   */
  const nativeChecks = new Set<NodeJS.Timeout>();

  /**
   * Check back on a session left to Claude Code's own auto-continue.
   * decideOnFire stands down for it (five-hour or unknown-type limits, setting on
   * or absent), but the toggle exists for some accounts only; without this check
   * such an account's limit would be dropped silently.
   *
   * Reuses the stall grace. The baseline is the transcript size at DETECTION when
   * the job carries it: randomDelay pads the fire past the reset, so a working
   * auto-continue has often finished before this runs. Older jobs fall back to
   * the size now.
   *
   * "Continued" means a real turn since the baseline (continuedSince.ts), not any
   * growth. If not continued the job is remembered and offered back; the fire's
   * claim is kept either way, and the offer's button bypasses claims like every
   * manual path.
   */
  const armNativeContinueCheck = (job: PendingJob, claimKey: string): void => {
    const baseline = job.transcriptBytesAtDetection ?? transcriptBytes(job.transcript);
    const check = setTimeout(() => {
      nativeChecks.delete(check);
      if (continuedSince(job.transcript, baseline)) {
        log.info(`Claude Code continued ${job.sessionId} on its own; a new turn follows the limit in its transcript.`);
        return;
      }
      // A cancel line written during the grace is the answer to "why did it not
      // continue", not a failure.
      if (standDownOnNativeCancel(job, claimKey, baseline)) {
        return;
      }
      const bytesNow = transcriptBytes(job.transcript);
      log.warn(
        `Claude Code did not continue ${job.sessionId} on its own: ${job.transcript} was ${baseline ?? 'unreadable'} bytes at ` +
          `detection and ${bytesNow ?? 'unreadable'} now, with no new turn. Its auto-continue may not be available on this account; ` +
          `offering the resume here instead.`,
      );
      rememberReady(job);
      offerResumeNow(
        job,
        claimKey,
        `Limit Break: Claude Code did not continue ${job.sessionId.slice(0, 8)} on its own. Resume it here?`,
      );
    }, GRACE_MS);
    nativeChecks.add(check);
  };

  /**
   * Every open webview tab in this window, reduced to what panelTab.ts can
   * work on, paired with the real Tab so a choice can become a close() call.
   */
  const webviewTabs = (): { tab: vscode.Tab; entry: WebviewTab }[] =>
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t): t is vscode.Tab & { input: vscode.TabInputWebview } => t.input instanceof vscode.TabInputWebview)
      .map((t) => ({ tab: t, entry: { viewType: t.input.viewType, label: t.label } }));

  /** The one Claude tab in this window, if it can be identified, and the command that can bring it back. */
  const resolveReopenTarget = async (): Promise<{ tab: vscode.Tab; command: string } | undefined> => {
    const tabs = webviewTabs();
    const selected = selectClaudePanelTab(tabs.map((t) => t.entry));
    const command = chooseReopenCommand(await vscode.commands.getCommands(true));
    const target = selected && tabs.find((t) => t.entry === selected)?.tab;
    return target && command ? { tab: target, command } : undefined;
  };

  const reopen = async (target: { tab: vscode.Tab; command: string }, sessionId: string): Promise<void> => {
    await vscode.window.tabGroups.close(target.tab);
    await vscode.commands.executeCommand(target.command);
    log.info(`Reopened the stale panel tab for session ${sessionId}.`);
  };

  /**
   * After a resumed session's turn ends, deal with the panel tab still open on
   * the pre-resume conversation. Not cosmetic: the next message typed there is
   * anchored to the pre-resume node, forking the transcript and stranding the
   * resumed turn, with no error. Reopening resyncs it, since a restarted panel
   * reads the transcript.
   */
  const handleStalePanel = async (hit: { file: string; cwd?: string }): Promise<void> => {
    const resolved = resolveSession(hit.file, hit.cwd, statBytes);
    const pending = resolved && resumedSessions.get(resolved.sessionId);
    if (!resolved || !pending) {
      return;
    }
    if (!detectLivePanel(resolved.sessionId, await pending)) {
      return;
    }
    const target = await resolveReopenTarget();
    if (!target) {
      // The viewType match was only verified against a synthetic webview; if it
      // changes this degrades to a text-only warning, so name the tabs seen.
      const seen = webviewTabs().map((t) => t.entry.viewType);
      log.info(
        `No Claude panel tab to reopen for ${resolved.sessionId} in this window. Webview tabs seen: ${seen.length ? seen.join(', ') : 'none'}.`,
      );
    }
    const offer = buildReopenOffer(resolved.sessionId, true, target !== undefined, settings().onStale);
    if (!offer) {
      return;
    }
    if (offer.reopen && target) {
      await reopen(target, resolved.sessionId);
      void vscode.window.showInformationMessage(offer.message);
      return;
    }
    if (!offer.button) {
      void vscode.window.showInformationMessage(offer.message);
      return;
    }
    const choice = await Promise.resolve(
      vscode.window.showInformationMessage(offer.message, offer.button),
    );
    if (choice !== offer.button) {
      return;
    }
    // Re-resolved: a button message can sit unanswered until the tab is gone or
    // a second Claude tab exists.
    const fresh = await resolveReopenTarget();
    if (!fresh) {
      void vscode.window.showInformationMessage(
        `Limit Break: could not reopen session ${resolved.sessionId.slice(0, 8)}'s tab now; close and reopen it by hand.`,
      );
      return;
    }
    await reopen(fresh, resolved.sessionId);
  };

  /**
   * A VSIX installed outside the Marketplace never updates itself, so this is
   * the only way to learn of a release. Off until asked: the offer is made once
   * and all three answers are final ("Not now" = "Never ask"), to avoid nagging.
   */
  const offerUpdateChecks = async (): Promise<void> => {
    if (!shouldOfferFirstRunPrompt(context.globalState.get<FirstRunPromptChoice>(FIRST_RUN_PROMPT_KEY))) {
      return;
    }
    const choice = await Promise.resolve(
      vscode.window.showInformationMessage(
        'Limit Break can check GitHub for a newer release once a day. ' +
          'Nothing else will tell you: an extension installed from a .vsix never updates itself.',
        'Enable',
        'Not now',
        'Never ask',
      ),
    );
    const picked: FirstRunPromptChoice =
      choice === 'Enable' ? 'enable' : choice === 'Never ask' ? 'never' : 'not-now';
    await context.globalState.update(FIRST_RUN_PROMPT_KEY, picked);
    if (shouldEnableUpdateChecks(picked)) {
      await vscode.workspace.getConfiguration(NS).update('checkForUpdates', true, vscode.ConfigurationTarget.Global);
    }
  };

  /**
   * At most one request per activation, silent unless a newer version exists.
   * Timestamp and tag are cached.
   */
  const runUpdateCheck = async (): Promise<void> => {
    if (!settings().checkForUpdates) {
      return;
    }
    const current = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0';
    const evaluate = () =>
      decideUpdateCheck({
        currentVersion: current,
        latestTag: context.globalState.get<string>(LATEST_TAG_KEY),
        lastCheckedMs: context.globalState.get<number>(LAST_CHECKED_KEY),
        now: Date.now(),
        intervalMs: DEFAULT_CHECK_INTERVAL_MS,
        dismissedVersion: context.globalState.get<string>(DISMISSED_VERSION_KEY),
      });
    let action = evaluate();
    if (action.kind === 'check') {
      const tag = await fetchLatestReleaseTag();
      await context.globalState.update(LAST_CHECKED_KEY, Date.now());
      if (tag !== undefined) {
        await context.globalState.update(LATEST_TAG_KEY, tag);
      }
      action = evaluate();
    }
    if (action.kind !== 'notify') {
      return;
    }
    const choice = await Promise.resolve(
      vscode.window.showInformationMessage(
        `Limit Break ${action.latestTag} is available; this is ${current}.`,
        'View release',
        'Dismiss',
      ),
    );
    if (choice === 'View release') {
      void vscode.env.openExternal(vscode.Uri.parse(RELEASE_TAG_URL(action.latestTag)));
    }
    if (choice !== undefined) {
      // Either answer counts as seen; unanswered, it asks again tomorrow.
      await context.globalState.update(DISMISSED_VERSION_KEY, action.latestTag);
    }
  };

  // Fire and forget: a failure must never take activation with it, and update
  // checks stay silent on every failure.
  void offerUpdateChecks()
    .then(() => runUpdateCheck())
    .catch(() => {});

  /**
   * Terminals opened by openClaudeToTrust, so the close hook only re-checks
   * trust for those.
   */
  const trustTerminals = new Set<vscode.Terminal>();

  context.subscriptions.push(
    {
      dispose: () => {
        for (const t of [...stallChecks, ...nativeChecks]) {
          clearTimeout(t);
        }
        stallChecks.clear();
        nativeChecks.clear();
      },
    },
    channel,
    status,
    watcher,
    scheduler,
    watcher.onHit((h) => onDetection(h, 'limit')),
    watcher.onOverload((h) => onDetection(h, 'overload')),
    // Claude Code's own auto-continue lines are observed and logged, never
    // acted on from here.
    watcher.onNativeStatus((h) => {
      const id = resolveSession(h.file, h.cwd, () => 0)?.sessionId ?? h.file;
      log.info(`Claude Code auto-continue ${h.status.kind} for session ${id}: ${h.status.text}`);
    }),
    watcher.onInputNeeded((hit) => {
      // A finished turn means the session works again, so its gave-up record is
      // stale. Before the filters below: records belong to any watched session, and
      // clearing is safe while disabled (nothing launches). A subagent's turn says
      // nothing about its parent, so it never clears one. resolveSession's statBytes
      // is stubbed: only the id is wanted.
      const ended = isSubagentFile(hit.file) ? undefined : resolveSession(hit.file, hit.cwd, () => 0);
      if (ended && gaveUp.turnEnded(ended.sessionId)) {
        log.info(`Session ${ended.sessionId} finished a turn; clearing its gave-up state.`);
        render();
      }
      // A finished turn ends a run of server errors.
      if (ended && overloadStreaks.turnEnded(ended.sessionId)) {
        log.info(`Session ${ended.sessionId} finished a turn; its overload retries start over.`);
      }
      const s = settings();
      if (!s.enabled) {
        return;
      }
      // A turn ends once per Claude response in every session on the machine; only
      // this window's folders matter, for the chime and the stale tab.
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      if (!isInsideWorkspace(hit.cwd, folders)) {
        return;
      }
      // alertSound gates the chime alone; the stale-tab warning has its own gates
      // and must not go quiet when sound is off.
      if (s.alertSound) {
        playAlertSound({ file: s.alertSoundFile });
      }
      void handleStalePanel(hit);
    }),
    scheduler.onUpgrade((job) => announceUpgrade(job, settings())),
    scheduler.onChange(() => {
      // Every listed and ready session, not just the soonest; refreshTrust's mtime
      // cache keeps a tick to a bare stat per job.
      refreshAllTrust();
      render();
    }),
    scheduler.onFire((job) => {
      // Disabled means disabled, even for a job scheduled before the setting was
      // turned off. Kept for Resume Now, and checked BEFORE the claim so another
      // enabled window stays free to handle the reset.
      const s = settings();
      if (!s.enabled) {
        rememberReady(job);
        log.info(`Limit Break is disabled; kept session ${job.sessionId.slice(0, 8)} for Resume Now instead of resuming.`);
        return;
      }
      // Claim this reset first. Every window watching this account can detect and
      // schedule the SAME reset (watchScope: machine), and two can fire within a
      // second, too close for the holder check to have seen the first's child. A
      // machine-wide file claim is first-past-the-post across windows. 'taken': drop
      // entirely, before the autoResume split, so the off-autoResume path is no
      // backdoor.
      //
      // Held until the reset plus the longest jitter in force plus ten minutes, not
      // the ordinary hour: every window's copy fires somewhere in the jitter band, and
      // randomDelayMaxMinutes is unbounded, so a late copy would find an hour-old claim
      // stale and resume again. holdClaim only moves the mtime forward, so an overdue
      // fire still gets at least the ordinary hour.
      const claimKey = claimKeyFor(job);
      const holdUntil = claimHoldDeadline(job, s.randomDelayMinMinutes, s.randomDelayMaxMinutes);
      if (holdClaim(claimsDir(), claimKey, Date.now(), holdUntil, fs, log, vscode.env.sessionId) === 'taken') {
        // Worded by who holds it, for the log only; the fire is dropped either way.
        const holder =
          claimOwner(claimsDir(), claimKey, fs) === vscode.env.sessionId
            ? 'already claimed by this window'
            : 'claimed by another window';
        log.info(`Resume for ${job.sessionId.slice(0, 8)} ${holder}; dropping.`);
        return;
      }
      // A resume is only for a stop still unhandled. A real turn since detection
      // (user at an idle panel, Claude Code's auto-continue, another window, an
      // overdue restore) means the session moved on and a resume would fork it.
      // Before the autoResume split and holder check: an idle panel is what the holder
      // check cannot tell from one left idle at the limit. Nothing is remembered or
      // shown, and the claim is KEPT so every other window drops its copy too.
      if (hasContinued(job)) {
        log.info(`Session ${job.sessionId.slice(0, 8)} has continued since it stopped; not resuming.`);
        return;
      }
      // After continued-since (a moved-on session is silent), before the
      // autoResume split and holder check: whoever cancelled auto-continue has the
      // session or told us to leave it. Keeps the claim, remembers the job, offers
      // Resume Now.
      if (standDownOnNativeCancel(job, claimKey, job.transcriptBytesAtDetection)) {
        return;
      }
      // An offer-only job (reset beyond maxWaitHours) takes this path whatever
      // autoResume says; after the claim and continued-since checks so a moved-on
      // session stays silent.
      if (!s.autoResume || job.offerOnly) {
        rememberReady(job);
        log.info(
          job.offerOnly
            ? `Cooldown elapsed for ${job.sessionId}; its limit reset beyond maxWaitHours, so it is offered, not resumed.`
            : `Cooldown elapsed for ${job.sessionId}; autoResume is off, so it is waiting for you.`,
        );
        offerResumeNow(
          job,
          claimKey,
          `Limit Break: the cooldown has elapsed for session ${job.sessionId.slice(0, 8)}.`,
        );
        return;
      }
      // Before spawning a second `claude --resume`, find out who holds this
      // session: resuming into a held session forks the transcript. See
      // holderPolicy.ts's decideOnFire for the branch table; 'none', a failed listing
      // ('unknown') and an IDLE panel reach the ordinary resume below.
      const rows = detectAgentRows();
      const holder = rows === 'unknown' ? 'unknown' : classifyHolder(rows, job.sessionId, undefined, readHolderRecord);
      const decision = decideOnFire(
        holder,
        autoContinueEnabled(job.cwd, process.platform, (p) => fs.readFileSync(p, 'utf8')),
        job.sessionId.slice(0, 8),
        job.reason,
        job.rateLimitType,
      );
      if (decision.logMessage) {
        (decision.logLevel === 'warn' ? log.warn : log.info)(decision.logMessage);
      }
      if (decision.remember) {
        rememberReady(job);
      }
      if (decision.notice) {
        const notice = decision.notice;
        void Promise.resolve(vscode.window.showInformationMessage(notice.message, notice.button)).then(async (choice) => {
          if (choice !== notice.button) {
            return;
          }
          // The offer used the holder snapshot from this fire and the notice does not
          // auto-dismiss: look again, so a terminal the user has since returned to gets
          // no second writer. The job stays remembered.
          const rowsNow = detectAgentRows();
          const holderNow =
            rowsNow === 'unknown' ? 'unknown' : classifyHolder(rowsNow, job.sessionId, undefined, readHolderRecord);
          const busyNow = busyAtClickNotice(holderNow, job.sessionId.slice(0, 8));
          if (busyNow) {
            log.info(busyNow);
            void vscode.window.showInformationMessage(busyNow);
            return;
          }
          // Then ask about a session that has moved on, like every manual path.
          if (!(await confirmNotContinued(job))) {
            return;
          }
          // Takes ownership (forgetReady) like the off-autoResume "Resume Now"
          // button; no holder modal, since this button IS the confirmation.
          if (!forgetReady(job.sessionId)) {
            void vscode.window.showInformationMessage(
              `Limit Break: session ${job.sessionId.slice(0, 8)} was already resumed or cancelled.`,
            );
            return;
          }
          // This branch is reached only after decideOnFire declined to auto-resume,
          // which KEEPS the fire's claim; it may be stale by click time. Like resumeNow,
          // write/refresh our own claim before launching, ignoring its answer, so another
          // window's automatic attempt cannot also fire. Release on a failed launch only
          // if this call won the claim ('claimed', incl. stale takeover), never one
          // another window holds.
          const buttonClaim = claim(claimKey);
          if (!resume(job, true)) {
            rememberReady(job);
            if (buttonClaim === 'claimed') {
              releaseClaim(claimsDir(), claimKey, fs, log);
            }
          }
        });
      }
      if (decision.awaitNativeContinue) {
        armNativeContinueCheck(job, claimKey);
      }
      if (!decision.resume) {
        // The claim is KEPT: releasing it would let every other window (watchScope
        // machine) fire later, find the key free and show the same "Resume in Terminal
        // Anyway" offer, so two clicks would be two writers on a held session. Every
        // manual path bypasses claims, and the claim ages out after STALE_MS.
        return;
      }
      // A DIFFERENT session may be busy or waiting in the same folder. The
      // extension never writes into a session it did not create, so it tells the
      // session it is about to create: buildResumePrompt names the peer(s) and asks
      // the resumed model to coordinate via SendMessage. This never blocks the
      // resume; only the prompt changes. A failed listing (rows 'unknown') cannot
      // name peers, so it is skipped.
      let resumeJob = job;
      if (rows !== 'unknown' && decision.resume && job.cwd) {
        const peers = busyFolderPeers(rows, job.sessionId, job.cwd, process.platform);
        if (peers.length > 0) {
          const names = peers.map(peerLabel).join(', ');
          log.info(`Another Claude session is working in ${job.cwd} (${names}); telling the resumed session to coordinate with it.`);
          void vscode.window.showInformationMessage(
            `Limit Break: another Claude session (${names}) is working in this folder. ` +
              `The resumed session has been told to coordinate with it.`,
          );
          resumeJob = { ...job, prompt: buildResumePrompt(job.prompt, peers) };
        }
      }
      if (s.notify) {
        void vscode.window.showInformationMessage(
          `Limit Break: resuming session ${job.sessionId.slice(0, 8)}.`,
        );
      }
      // The scheduler cleared this job before firing, so if the launch never
      // started this is the only holder: remember it. The ORIGINAL job (unmodified
      // prompt) is kept, since a later manual resume should not carry a coordination
      // sentence tied to this fire's folder-busy snapshot.
      if (!resume(resumeJob)) {
        rememberReady(job);
        // A resume that never launched must not hold the claim, or a later automatic
        // attempt (this window's or another's) is blocked.
        releaseClaim(claimsDir(), claimKey, fs, log);
      }
    }),
    vscode.commands.registerCommand(`${NS}.resumeNow`, async () => {
      // Exactly one job moves, and only its own source is touched: cancelling the
      // scheduler while resuming a ready job (or the reverse) would discard work
      // nobody asked to.
      //
      // A source job is removed only once resume() reports the launch started.
      //
      // confirmManualResume runs first in both branches (live-holder modal).
      //
      // A MANUAL resume bypasses what claimResume reports (another window's claim is
      // no reason to refuse the user) but still calls it for the write: the fire's
      // claim may have gone stale, and refreshing it stops another window's automatic
      // attempt firing mid-launch. Release on a failed launch only if this call won
      // the claim ('claimed', incl. stale takeover), never another window's live one.
      const counting = scheduler.current;
      if (counting) {
        // Moves exactly one job; others may still be counting down.
        if (await confirmManualResume(counting)) {
          const key = claimKeyFor(counting);
          // Held to the same deadline as the automatic fire's claim: other windows'
          // copies still count down to somewhere in their jitter.
          const s = settings();
          const countingClaim = holdClaim(
            claimsDir(),
            key,
            Date.now(),
            claimHoldDeadline(counting, s.randomDelayMinMinutes, s.randomDelayMaxMinutes),
            fs,
            log,
            vscode.env.sessionId,
          );
          if (resume(counting, true)) {
            scheduler.cancel(counting.sessionId);
          } else if (countingClaim === 'claimed') {
            releaseClaim(claimsDir(), key, fs, log);
          }
        }
        return;
      }
      // Oldest first; peeked, not shifted, so a failed resume leaves it in place.
      const ready = readyJobs[0];
      if (!ready) {
        void vscode.window.showInformationMessage('Limit Break: nothing pending.');
        return;
      }
      if (await confirmManualResume(ready)) {
        const key = claimKeyFor(ready);
        const readyClaim = claim(key);
        if (resume(ready, true)) {
          forgetReady(ready.sessionId);
        } else if (readyClaim === 'claimed') {
          releaseClaim(claimsDir(), key, fs, log);
        }
      }
    }),
    vscode.commands.registerCommand(`${NS}.cancel`, () => {
      // Cancel means all of it, but log how much was thrown away: a ready job has
      // no other trace.
      //
      // With watchScope machine every window holds its own copy of the pending job;
      // claiming each cancelled key makes them drop it when they fire, held to the
      // same deadline as every other hold (a limit can count down for hours). This
      // stops other windows ACTING on their copies; the persisted job lists are not
      // merged across windows.
      const cancelled = [...scheduler.jobs, ...readyJobs];
      const nowMs = Date.now();
      const s = settings();
      for (const job of cancelled) {
        const until = claimHoldDeadline(job, s.randomDelayMinMinutes, s.randomDelayMaxMinutes);
        holdClaim(claimsDir(), claimKeyFor(job), nowMs, until, fs, log, vscode.env.sessionId);
      }
      if (cancelled.length > 0) {
        log.info(`Claimed ${cancelled.length} cancelled resume(s) so other windows drop them too.`);
      }
      // A native auto-continue check in its grace would offer back a discarded job.
      for (const t of nativeChecks) {
        clearTimeout(t);
      }
      nativeChecks.clear();
      if (readyJobs.length > 0) {
        log.info(`Discarding ${readyJobs.length} resume(s) that were waiting to be started by hand.`);
        readyJobs.length = 0;
        persistReady();
      }
      scheduler.cancel();
      // Cancel clears the gave-up state along with the jobs.
      if (gaveUp.clearAll()) {
        log.info('Cleared the gave-up state.');
      }
      // Unconditional: with nothing pending the scheduler does not fire onChange,
      // and a readyJobs-only cancel must still clear its lines.
      render();
    }),
    vscode.commands.registerCommand(`${NS}.showLog`, () => channel.show()),
    /**
     * What a click on the status bar opens. Cancel stays one deliberate pick
     * away, and dismissing the menu does nothing.
     */
    vscode.commands.registerCommand(`${NS}.statusBarMenu`, async () => {
      const waiting = scheduler.jobs.length + readyJobs.length;
      const gaveUpCount = gaveUp.list().length;
      const items = [
        {
          label: 'Resume Now',
          description: waiting > 0 ? 'Start the soonest waiting session immediately' : 'Nothing is waiting',
          command: `${NS}.resumeNow`,
        },
        {
          label: 'Cancel Pending Resume',
          // Cancel also clears the gave-up state, so with nothing waiting it still has something to do.
          description:
            waiting > 0
              ? `Discard ${waiting} waiting resume(s)${gaveUpCount > 0 ? ' and clear what gave up' : ''}`
              : gaveUpCount > 0
                ? `Clear ${gaveUpCount} session(s) that gave up`
                : 'Nothing to cancel',
          command: `${NS}.cancel`,
        },
        { label: 'Show Log', description: 'Open the Limit Break output channel', command: `${NS}.showLog` },
      ];
      // Clears the gave-up state without discarding other sessions' waiting jobs,
      // as Cancel does. Only offered when there is something to dismiss.
      const DISMISS = 'Dismiss gave-up notices';
      if (gaveUpCount > 0) {
        items.push({
          label: DISMISS,
          description: `Clear ${gaveUpCount} gave-up notice(s); waiting resumes are kept`,
          command: '',
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Limit Break',
        placeHolder: waiting > 0 ? `${waiting} resume(s) waiting` : 'Watching for usage limits',
      });
      if (!picked) {
        return;
      }
      if (picked.label === DISMISS) {
        if (gaveUp.dismissRecords()) {
          log.info('Dismissed the gave-up notices; waiting resumes are untouched.');
          render();
        }
        return;
      }
      await vscode.commands.executeCommand(picked.command);
    }),
    /**
     * Trust hotlink. Opens a terminal running plain `claude` (no `--resume`, no
     * prompt) in `cwd` so the user answers Claude's own trust dialog; the extension
     * never types into it and never writes `~/.claude.json`.
     */
    vscode.commands.registerCommand(`${NS}.openClaudeToTrust`, (cwd?: unknown) => {
      // A bare Command Palette invocation (hidden there) or a stale keybinding has
      // no folder, so log and stop rather than guess one.
      if (typeof cwd !== 'string') {
        log.warn('claudeLimitBreak.openClaudeToTrust was invoked with no folder; ignoring.');
        return;
      }
      const s = settings();
      const launcher = findLauncher(s.claudeCommand);
      if (!launcher) {
        // Same failure, and the same handling, as the resume launch below.
        log.error(`Cannot open a trust terminal for ${cwd}: no claude executable found.`);
        void vscode.window.showErrorMessage(
          'Limit Break: could not find the claude executable. Set claudeLimitBreak.claudeCommand.',
        );
        return;
      }
      // Open from the spelling the CLI has on record, so a folder trusted from a
      // terminal is recognised despite a different-cased drive letter (trust.ts).
      const onRecord = trustedSpelling(
        cwd,
        readClaudeUserConfig(defaultClaudeConfigPath(), (p) => fs.readFileSync(p, 'utf8')),
        process.platform,
      );
      const opts = buildTrustTerminalOptions(onRecord ?? cwd, launcher);
      const terminal = vscode.window.createTerminal(opts);
      trustTerminals.add(terminal);
      terminal.show();
      log.info(`Opened a terminal at ${opts.cwd} to trust it with the Claude CLI.`);
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (!trustTerminals.delete(terminal)) {
        return;
      }
      // Re-check every pending and ready job, not just the one this terminal was
      // opened for: a job's cwd can be a different spelling of the folder just
      // trusted. Render now so the marker clears before the next tick.
      refreshAllTrust();
      render();
    }),
  );

  scheduler.start();
  // Unconditional: scheduler.start() fires onChange only when something is
  // pending, and restored readyJobs can exist with nothing pending.
  render();
  void watcher.start();
  log.info('Limit Break active.');
}

export function deactivate(): void {
  /* subscriptions handle teardown */
}
