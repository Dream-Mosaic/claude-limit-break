import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './log';
import { readSettings, type Settings } from './config';
import { TranscriptWatcher, isSubagentFile } from './transcriptWatcher';
import { ResumeScheduler, type PendingJob } from './scheduler';
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
import { resolveSession } from './sessionResolver';
import {
  livePanelDetector,
  agentRowsDetector,
  classifyHolder,
  busyFolderPeers,
  type HolderRecord,
} from './liveSessions';
import { decideOnFire, manualResumeWarning, buildResumePrompt } from './holderPolicy';
import { autoContinueEnabled } from './autoContinue';
import { sessionRegistryDir, readSessionRecord } from './sessionRegistry';
import { selectClaudePanelTab, type WebviewTab } from './panelTab';
import { buildReopenOffer, chooseReopenCommand } from './reopenOffer';
import { execFileSync } from 'node:child_process';
import { claimsDir, claimKeyFor, claimResume, releaseClaim, cleanupStaleClaims } from './claims';
import { GaveUpState, gaveUpNotice, budgetRefusalNotice } from './gaveUp';

const NS = 'claudeLimitBuster';

/** Label for the trust-hotlink button on the untrusted-folder notice (Task 5a). */
const TRUST_BUTTON = 'Open Claude to Trust';

/**
 * Where jobs waiting for "Resume Now" are kept across a reload. Separate from
 * the scheduler's own `claudeLimitBuster.pending`: these have already fired,
 * and putting them back there would leave the scheduler counting down to a
 * deadline that has passed.
 */
const READY_KEY = 'claudeLimitBuster.ready';

/**
 * How much of a transcript's end to read when looking for its newest usage
 * record. Generous next to one entry, trivial next to a file that reached
 * 11.2 MB in a single session.
 */
const USAGE_TAIL_BYTES = 256 * 1024;

/**
 * Whether a transcript entry's working directory belongs to this window.
 *
 * The transcript watcher is global — it sees every Claude session in every
 * project under ~/.claude/projects — so anything that reacts per turn has to
 * ask this first, or every window reacts to every project on the machine.
 *
 * Compared as resolved paths with a separator boundary rather than a bare
 * startsWith, so /work/app does not swallow /work/app-old, and folded to lower
 * case because a Windows path recorded by the CLI need not match the casing VS
 * Code reports for the same folder.
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

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Claude Limit Buster');
  const log = createLogger('limit-buster', (line) => channel.appendLine(line));
  const settings = () => readSettings(vscode.workspace.getConfiguration(NS));

  // Task 10: sweep claim files this window's own crashes or a stale race left
  // behind. Disk hygiene, not a correctness step - claimResume's own 1h
  // staleness check is what keeps a claim from blocking anything for long;
  // this just keeps the machine-wide directory from growing forever.
  cleanupStaleClaims(claimsDir(), Date.now(), fs, log);

  const scheduler = new ResumeScheduler(context.globalState, log);
  const status = new CountdownStatusBar();

  /**
   * Sessions this window has stopped trying to resume, and why (Task 4b -
   * see gaveUp.ts). In memory only: a reload starts clean, which the brief
   * allows, and the ready-job persistence (#11) is a separate mechanism.
   */
  const gaveUp = new GaveUpState();

  /**
   * The one place the status bar is drawn from. Reads `scheduler.jobs` and
   * `readyJobs` fresh every call, rather than taking either as a parameter,
   * so every caller - a countdown tick, a ready-job change, a gave-up
   * change, a trust change - draws the exact same picture. Task 5b: the
   * tooltip now lists every one of them, not just the soonest.
   */
  const render = (): void => {
    status.update(scheduler.jobs, readyJobs, settings().statusBar, gaveUp.list());
  };
  const watcher = new TranscriptWatcher(
    () => settings().maxWaitHours,
    () => settings().transcriptPollSeconds,
    log,
    // The watcher discards out-of-scope entries before parsing them, rather
    // than every consumer filtering afterwards (#2). Read per call, so
    // changing the setting or opening a folder takes effect without a reload.
    () => ({
      mode: settings().watchScope,
      folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    }),
  );

  const statBytes = (p: string) => fs.statSync(p).size;

  // Jobs whose cooldown elapsed while autoResume was off. The scheduler clears
  // its own state before firing — a deliberate re-entrancy guard — so without
  // holding them here they would simply be gone and "Resume Now" would report
  // nothing pending.
  //
  // A list, not a slot. Sessions in different projects hit their limits
  // independently, so a second one can come ready while the first is still
  // sitting in an unanswered notification. One slot would silently overwrite
  // the first, and its notification would then resume the wrong session.
  const readyJobs: PendingJob[] = [];

  /**
   * Written through to globalState on every change, and read back at
   * activation.
   *
   * Without this a reload silently destroyed a job waiting to be started by
   * hand: the scheduler clears its own state before firing, so this list was
   * the only thing holding it, and it lived in memory alone (#11). That
   * matters more since #7, where reopening the window is the remedy offered
   * for a stale panel tab — the advice would otherwise take the job with it.
   */
  const persistReady = () => {
    void context.globalState.update(READY_KEY, readyJobs.length > 0 ? [...readyJobs] : undefined);
  };

  /**
   * Drop a remembered job. Reports whether it was still there to drop.
   * Re-renders on an actual removal (Task 5b: the tooltip now lists ready
   * jobs, so every change to this list must reach the status bar - not just
   * the ones that happened to be followed by some other render() already).
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

  // Restored before anything can add to the list. A job read back here is one
  // the previous window offered and nobody answered; it stays claimable from
  // "Resume Now", which is what the setting's description promises.
  const restoredReady = context.globalState.get<PendingJob[]>(READY_KEY) ?? [];
  if (restoredReady.length > 0) {
    readyJobs.push(...restoredReady);
    log.info(`Restored ${restoredReady.length} resume(s) still waiting to be started by hand.`);
  }

  /**
   * The newest usage record in a transcript, read from the end of the file.
   *
   * A window off the end rather than the whole file: transcripts reach tens of
   * megabytes, this runs on a detection, and only the last record matters.
   * Any failure - missing file, unreadable, no record in the window - is
   * undefined, which puts the estimate back on the byte count.
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
  const schedule = (planned: PendingJob, s: Settings, estimate: number): void => {
    // Checked here, at schedule time, rather than when the cooldown fires:
    // the user is still at the keyboard for this notice, and can trust the
    // folder before walking away. By fire time they are already gone, which
    // is exactly why an untrusted folder stalls silently at Claude's own
    // trust prompt (#5). Never written back here, only read - answering that
    // prompt is the user's call, not this extension's.
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
    if (folderTrusted === false) {
      log.warn(
        `Folder ${job.cwd} is not trusted by the Claude CLI; the resume will stall at its trust prompt unless you trust it first.`,
      );
    }
    if (s.notify) {
      const at = new Date(job.resumeAtMs).toLocaleTimeString();
      const trustNote =
        folderTrusted === false
          ? ' This folder is not trusted by the Claude CLI yet; the resume will stall at its trust prompt unless you trust it first.'
          : '';
      const message = `Claude Limit Buster: resuming at ${at} (~${estimate.toLocaleString()} tokens).${trustNote}`;
      if (folderTrusted === false) {
        // A one-click way to answer the trust dialog ahead of the resume,
        // right when the user is at the keyboard to see this notice (Task
        // 5a). The button only ever opens a terminal - see
        // openClaudeToTrust below - never answers the dialog itself (#2).
        void Promise.resolve(vscode.window.showInformationMessage(message, TRUST_BUTTON)).then((choice) => {
          if (choice === TRUST_BUTTON) {
            void vscode.commands.executeCommand(`${NS}.openClaudeToTrust`, job.cwd);
          }
        });
      } else {
        void vscode.window.showInformationMessage(message);
      }
    }
  };

  const onDetection = (hit: Parameters<typeof planResume>[0], reason: 'limit' | 'overload') => {
    const s = settings();
    const plan = planResume(hit, reason, s, statBytes, new Date(), randomJitterMs, readUsage);
    if (plan.kind === 'ignore') {
      log.info(plan.reason);
      return;
    }
    // A new detection for a session - refused or scheduled, limit or
    // overload - means it is live again: whatever it last gave up on is
    // history, and the next failure is news (Task 4b ruling 2). 'ignore'
    // never names a session, so it cannot clear one.
    if (gaveUp.detected(plan.kind === 'refuse' ? plan.sessionId : plan.job.sessionId)) {
      render();
    }
    if (plan.kind === 'refuse') {
      log.warn(plan.reason);
      // Offered, not just announced. The estimate can be several times too
      // high on a long session - the byte count counts history that
      // compaction already summarised away - and refusing outright takes the
      // decision away from the person whose session it is. Saying yes plans
      // the same resume with the cap lifted for this one incident.
      void Promise.resolve(
        vscode.window.showWarningMessage(budgetRefusalNotice(plan.sessionId, plan.reason), 'Resume anyway'),
      ).then((choice) => {
        if (choice !== 'Resume anyway') {
          // Closed without going ahead (the promise resolves undefined when
          // the notification is dismissed): this session will not be resumed,
          // so it gives up - visibly, in the status bar. No second popup: the
          // refusal just closed WAS the notice for this cause, naming it and
          // both ways through (budgetRefusalNotice).
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
    schedule(plan.job, s, plan.estimate);
  };

  /**
   * Re-read trust for a job whose folder was untrusted when it was scheduled.
   *
   * The warning exists to get the folder trusted *during* the countdown, so
   * the one state change it is designed to cause was the one it could not see:
   * the flag was computed once and rendered until the resume fired (#8).
   *
   * Only ever false -> true. Trust being withdrawn mid-countdown is not worth
   * chasing, and a stale "trusted" costs nothing the resume itself will not
   * discover. Keyed on the config file's mtime so the common case - nothing
   * changed - is a stat rather than a parse of a file that grows with every
   * project the user opens. An unreadable mtime falls through to re-reading,
   * which is the safe direction: the read itself is the thing that answers.
   */
  // Keyed by session, not one scalar for the window. onChange only ever
  // reports the soonest job, so a second session's first check can land on an
  // mtime a different session's check already recorded - and then its trust is
  // never re-read at all, which is the bug this function exists to fix.
  const trustStamps = new Map<string, number>();
  const refreshTrust = (job: PendingJob | undefined): void => {
    if (!job || job.folderTrusted !== false || !job.cwd) {
      return;
    }
    const configPath = defaultClaudeConfigPath();
    let stamp: number | undefined;
    try {
      stamp = fs.statSync(configPath).mtimeMs;
    } catch {
      stamp = undefined;
    }
    if (stamp !== undefined && stamp === trustStamps.get(job.sessionId)) {
      return;
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

  /**
   * Attempts to launch a resume. Returns whether a terminal launch was
   * actually attempted - false covers everything that stops before
   * createTerminal (no claude executable found, a cwd that no longer
   * exists). Callers rely on this to decide whether the job has been
   * discharged or is still outstanding: every call site here used to drop
   * the job the moment it decided to resume it, before knowing whether the
   * launch would actually start.
   */
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
   * Sessions THIS extension has resumed, this window, this run, each against
   * the pid of the terminal it was resumed in.
   *
   * onInputNeeded fires for every turn in every session on the machine, and a
   * panel tab going stale is only this extension's doing for the sessions it
   * actually put a `--resume` terminal against. The pid is what stops the
   * detector counting that resume as somebody else holding the session (#7).
   */
  const resumedSessions = new Map<string, Promise<number | undefined>>();

  /**
   * `claude agents --json`, run with a timeout so a hung CLI cannot take
   * whichever handler called this with it. Shared by every reader of the
   * listing below - detectLivePanel (end-of-turn) and detectAgentRows (a
   * manual resume, and scheduler.onFire) - so a hang or a missing executable
   * is one behaviour to reason about, not three.
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
   *
   * `claude agents --json` for liveness, the per-pid record for the
   * entrypoint - see liveSessions.ts for why it is split that way.
   */
  const detectLivePanel = livePanelDetector(runAgentsListing, readHolderRecord);

  /**
   * `claude agents --json`, run once and parsed - or `'unknown'` when the
   * listing itself could not be run. A manual resume's live-holder check
   * (confirmManualResume, below) and scheduler.onFire's holder AND
   * busy-folder-peers checks are all built on this one snapshot function,
   * via the pure `classifyHolder` / `busyFolderPeers` (liveSessions.ts).
   */
  const detectAgentRows = agentRowsDetector(runAgentsListing);

  /**
   * Record that a resume of `job` failed for `cause`, and notify - through
   * `show`, so each site keeps its own severity - the first time that cause
   * is seen for that session since its last detection (Task 4b ruling 1),
   * and every time when `manual`: a failure answering a user's click is
   * always shown (ruling on concern 1; see GaveUpState.record). The caller
   * logs; this only decides about the popup and the status bar. Never
   * touches claims: every caller's claim release happens after resume()
   * returns, exactly as before (Task 10).
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
   * `manual` is true for every call that runs because the user clicked
   * something (the resumeNow command, the Resume Now notification button,
   * "Resume in Terminal Anyway"): its launch failures are always notified.
   * Only scheduler.onFire's own automatic resume leaves it false. The stall
   * check below takes it too: one session can hold a ready job AND a
   * counting-down job, so two manual launches - and two stalls - can happen
   * with no detection in between (fix round 1, finding 1).
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
      // Logged every time, notified once per session (Task 4b ruling 1): a
      // repeat must still leave a trace somewhere.
      log.error(`Cannot resume ${job.sessionId}: no claude executable found for "${s.claudeCommand || 'claude'}".`);
      giveUp(job, 'launcher', (m) => vscode.window.showErrorMessage(m), manual);
      return false;
    }
    // vscode.window.createTerminal does not throw on a bad cwd - VS Code
    // reports "Starting directory (cwd) ... does not exist" asynchronously,
    // inside the terminal process, well after this function would already
    // have logged success. The cwd is whatever the session started in,
    // recorded whenever that transcript entry was written - possibly weeks
    // ago, and a renamed project or an unplugged drive is enough to make it
    // stale. Checking first turns that into a synchronous refusal that names
    // the path and the transcript it came from, instead of a generic VS Code
    // error days later that names neither.
    //
    // fs.existsSync is true for a regular file, not only a directory - a
    // transcript's cwd pointing at a file (renamed-over project folder, a
    // stray path) would sail through it and hit the exact async
    // createTerminal failure this check exists to avoid (#8). statSync's
    // isDirectory() is the only one of the two that actually distinguishes
    // them; wrapped in try/catch because statSync throws on a missing path,
    // which must still read as "does not exist", not as an uncaught error.
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
    // Headless is opt-in and machine-scoped, and does NOT inherit the
    // session's permission mode - a verified acceptEdits session resumed with
    // -p was denied a Write - so headlessPermissionMode is what decides
    // whether it can do tool work at all. Empty means it cannot, which is the
    // safe default for something that runs while nobody is watching.
    const claudeArgs =
      s.resumeMode === 'headless'
        ? buildHeadlessArgs(job.sessionId, job.prompt, s.headlessPermissionMode)
        : buildResumeArgs(job.sessionId, job.prompt);
    // The CLI finds its trust record by exact key, and one folder can hold
    // several: the panel writes the drive letter the way VS Code reports it,
    // trusting from a terminal writes another. Launching from the spelling on
    // record as trusted is what lets the CLI see the answer the user already
    // gave. Same directory either way - only the name changes.
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
    // Recorded only once the terminal actually launched: the returns above
    // mean no resume happened, and a session this never resumed must not
    // later be warned about on this extension's behalf.
    resumedSessions.set(job.sessionId, Promise.resolve(terminal.processId).catch(() => undefined));
    log.info(`Resumed ${job.sessionId} in a new terminal.`);
    // A resume that launched is no longer given up (ruling 2); if it stalls,
    // the check below records it again.
    if (gaveUp.launched(job.sessionId)) {
      render();
    }

    // A terminal existing is not a resume happening. Two observed failures
    // leave one sitting there looking healthy: an untrusted folder parks
    // `claude` at its own trust prompt waiting for a keypress nobody is there
    // to give (#5), and a launch that fails inside the terminal process does
    // so asynchronously, after this function has already logged success (#4).
    // A resumed session that is actually working appends to its transcript,
    // so that is what gets checked - once, after a grace period long enough
    // for a cold cache to be rebuilt.
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
   * The gate every MANUAL resume goes through before `resume()` is ever
   * called: the command, and the off-autoResume notification's own button.
   *
   * A scheduled fire has its own, separate holder check (see
   * scheduler.onFire below) that never spawns a second writer at all; this
   * one is different on purpose - the person clicking Resume Now already
   * knows which session they mean, so a live holder is a warning to click
   * through, not a reason to silently redirect them into "remembered for
   * later" the way the automatic path does. `ourPid` is omitted (undefined):
   * the job has not been resumed yet, so there is no terminal pid of our own
   * to exclude.
   */
  const confirmManualResume = async (job: PendingJob): Promise<boolean> => {
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
   * After a resumed session's turn ends, deal with the panel tab that is
   * still open on the conversation as it stood before the resume.
   *
   * This is not cosmetic. The experiment in
   * docs/research/2026-09-20-panel-fork-experiment.md showed that the next
   * message typed into that tab is anchored to the node from before the
   * resume, which forks the transcript and leaves the resumed turn on a branch
   * nothing follows afterwards - with no error on either side. Reopening the
   * tab resyncs it, because a restarted panel reads the transcript instead of
   * its own memory.
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
      // The viewType match was verified against a synthetic webview, not the
      // real Claude panel (#7). If that string ever changes, this degrades to
      // a text-only warning - correct, but silent about why - so the tabs it
      // actually looked at are named here.
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
    // Re-resolved rather than reusing `target`: a message with a button does
    // not auto-dismiss and can sit unanswered for a long time, by which point
    // the tab may be gone or a second Claude tab may have been opened.
    const fresh = await resolveReopenTarget();
    if (!fresh) {
      void vscode.window.showInformationMessage(
        `Claude Limit Buster: could not reopen session ${resolved.sessionId.slice(0, 8)}'s tab now; close and reopen it by hand.`,
      );
      return;
    }
    await reopen(fresh, resolved.sessionId);
  };

  /**
   * A VSIX installed outside the Marketplace never updates itself and VS Code
   * will never mention it (#1), so this is the only way someone finds out. It
   * is off until asked for: the offer is made once, and all three answers are
   * final - "Not now" means the same as "Never ask" here, because an offer
   * that keeps coming back is the nag this is trying not to be.
   */
  const offerUpdateChecks = async (): Promise<void> => {
    if (!shouldOfferFirstRunPrompt(context.globalState.get<FirstRunPromptChoice>(FIRST_RUN_PROMPT_KEY))) {
      return;
    }
    const choice = await Promise.resolve(
      vscode.window.showInformationMessage(
        'Claude Limit Buster can check GitHub for a newer release once a day. ' +
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
   * At most one request per activation, and silent about everything except a
   * version that is actually newer. Both the timestamp and the tag are cached,
   * so a day's worth of activations cost nothing.
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
        `Claude Limit Buster ${action.latestTag} is available; this is ${current}.`,
        'View release',
        'Dismiss',
      ),
    );
    if (choice === 'View release') {
      void vscode.env.openExternal(vscode.Uri.parse(RELEASE_TAG_URL(action.latestTag)));
    }
    if (choice !== undefined) {
      // Either answer counts as seen. Left unanswered it asks again tomorrow,
      // which is the one case where repeating is the right behaviour.
      await context.globalState.update(DISMISSED_VERSION_KEY, action.latestTag);
    }
  };

  // Fire and forget: a failure here must never take activation with it, and
  // the issue asks for silence on every failure, not just no notification.
  void offerUpdateChecks()
    .then(() => runUpdateCheck())
    .catch(() => {});

  /**
   * Terminals opened by openClaudeToTrust, tracked so the close hook below
   * (ruling 2) only re-checks trust for terminals THIS command opened - a
   * resume terminal, or any other terminal in the window, closing must not
   * trigger it.
   */
  const trustTerminals = new Set<vscode.Terminal>();

  context.subscriptions.push(
    {
      dispose: () => {
        for (const t of stallChecks) {
          clearTimeout(t);
        }
        stallChecks.clear();
      },
    },
    channel,
    status,
    watcher,
    scheduler,
    watcher.onHit((h) => onDetection(h, 'limit')),
    watcher.onOverload((h) => onDetection(h, 'overload')),
    watcher.onInputNeeded((hit) => {
      // A finished turn is evidence the session works again, so a gave-up
      // record for it is stale (fix round 1, ruling 2a). Ahead of both
      // filters below: gave-up records belong to any watched session, not
      // just this window's folders, and clearing one is safe while disabled -
      // it launches and notifies nothing, it only stops the status bar
      // showing a problem that is over. A subagent's transcript finishing a
      // turn says nothing about its parent session, so it never clears one.
      // resolveSession's statBytes is stubbed: only the id is wanted here.
      const ended = isSubagentFile(hit.file) ? undefined : resolveSession(hit.file, hit.cwd, () => 0);
      if (ended && gaveUp.turnEnded(ended.sessionId)) {
        log.info(`Session ${ended.sessionId} finished a turn; clearing its gave-up state.`);
        render();
      }
      const s = settings();
      if (!s.enabled) {
        return;
      }
      // A turn ends roughly once per Claude response, in every session on the
      // machine. Only this window's own folders are worth reacting to - for
      // the chime, and for the stale tab below, since tabGroups is per-window
      // anyway.
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      if (!isInsideWorkspace(hit.cwd, folders)) {
        return;
      }
      // alertSound gates the chime alone. The stale-tab warning has its own
      // gates - this extension resumed the session, and a panel still holds
      // it - and must not go quiet because someone turned the sound off.
      if (s.alertSound) {
        playAlertSound({ file: s.alertSoundFile });
      }
      void handleStalePanel(hit);
    }),
    scheduler.onChange((job) => {
      refreshTrust(job);
      render();
    }),
    scheduler.onFire((job) => {
      // Task 10: claim this reset before anything else. Every window watching
      // this account can independently detect and schedule the SAME reset -
      // watchScope: machine means every copy of the extension watches every
      // transcript - and two windows have been seen firing within a second or
      // two of each other, too close for Task 2's holder check (which reads
      // `claude agents`) to have caught the first window's child yet. A
      // machine-wide file claim is first-past-the-post across windows in a way
      // an in-memory guard inside one extension host cannot be. 'taken' means
      // some other window already won this race: drop entirely, before the
      // autoResume split below, so the off-autoResume path cannot become a
      // backdoor around a lost claim either.
      const claimKey = claimKeyFor(job);
      if (claimResume(claimsDir(), claimKey, Date.now(), fs, log) === 'taken') {
        log.info(`Resume for ${job.sessionId.slice(0, 8)} claimed by another window; dropping.`);
        return;
      }
      const s = settings();
      if (!s.autoResume) {
        rememberReady(job);
        log.info(`Cooldown elapsed for ${job.sessionId}; autoResume is off, so it is waiting for you.`);
        void Promise.resolve(
          vscode.window.showInformationMessage(
            `Claude Limit Buster: the cooldown has elapsed for session ${job.sessionId.slice(0, 8)}.`,
            'Resume Now',
          ),
        ).then(async (choice) => {
          if (choice !== 'Resume Now') {
            return;
          }
          // Same live-holder gate the resumeNow command goes through - this
          // button is just as much a manual resume as the palette command is.
          if (!(await confirmManualResume(job))) {
            return;
          }
          // This job, closed over here - not "whatever is ready now". Another
          // session can come ready while this notification is still on
          // screen, and the offer names a session, so it must honour it.
          //
          // Removing it is also how this click takes ownership of it
          // (forgetReady) - not the Task 10 cross-window claim below, which
          // is a separate thing. The notification outlives the job: the same
          // session can be resumed from the command palette first, and
          // without that ownership a later click here would launch a second
          // `claude --resume` on it.
          if (!forgetReady(job.sessionId)) {
            void vscode.window.showInformationMessage(
              `Claude Limit Buster: session ${job.sessionId.slice(0, 8)} was already resumed or cancelled.`,
            );
            return;
          }
          // forgetReady above is how this click takes ownership of the job;
          // if the launch never actually started, that ownership must be
          // undone (rememberReady) or the job is gone with no way back.
          //
          // Task 10, fix round 3: this notification can sit unanswered for a
          // long time - autoResume is off, so nothing else resumes it in the
          // meantime - long enough for the claim onFire wrote at fire time to
          // go stale (>1h) and another window to take it over before this
          // click happens. Round 1 released that claim unconditionally,
          // reasoning it was always this window's own; round 2 fixed the same
          // assumption on the other three manual paths but missed this one.
          // Same fix: bypass the answer to decide whether to launch (the
          // user's explicit intent), but only release if this call actually
          // won the claim itself ('claimed', including a stale takeover it
          // just performed) - never a claim 'taken' by someone else.
          const notifyClaim = claimResume(claimsDir(), claimKey, Date.now(), fs, log);
          if (!resume(job, true)) {
            rememberReady(job);
            if (notifyClaim === 'claimed') {
              releaseClaim(claimsDir(), claimKey, fs, log);
            }
          }
        });
        return;
      }
      // Task 2: before ever spawning a second `claude --resume`, find out who
      // already holds this session - a resume into a session a panel or
      // another terminal already holds forks the transcript (see the
      // docs/research/2026-09-20-panel-fork-experiment.md incident this task
      // is named for). See holderPolicy.ts's decideOnFire for the full branch
      // table; 'none', a failed listing ('unknown') and an IDLE panel are the
      // cases that reach the ordinary resume below.
      const rows = detectAgentRows();
      const holder = rows === 'unknown' ? 'unknown' : classifyHolder(rows, job.sessionId, undefined, readHolderRecord);
      const decision = decideOnFire(
        holder,
        autoContinueEnabled(job.cwd, process.platform, (p) => fs.readFileSync(p, 'utf8')),
        job.sessionId.slice(0, 8),
      );
      if (decision.logMessage) {
        (decision.logLevel === 'warn' ? log.warn : log.info)(decision.logMessage);
      }
      if (decision.remember) {
        rememberReady(job);
      }
      if (decision.notice) {
        const notice = decision.notice;
        void Promise.resolve(vscode.window.showInformationMessage(notice.message, notice.button)).then((choice) => {
          if (choice !== notice.button) {
            return;
          }
          // "Resume in Terminal Anyway" takes ownership of the job
          // (forgetReady) exactly as the off-autoResume "Resume Now" button
          // does, then resumes it - no second confirmation, because this
          // button IS the confirmation.
          if (!forgetReady(job.sessionId)) {
            void vscode.window.showInformationMessage(
              `Claude Limit Buster: session ${job.sessionId.slice(0, 8)} was already resumed or cancelled.`,
            );
            return;
          }
          // Task 10, fix round 1: this branch is reached only after
          // decideOnFire declined to auto-resume, which already released
          // this job's original claim (see `!decision.resume` above) - by
          // the time someone clicks this button that claim is long gone. The
          // click is exactly as much an explicit user action as the
          // resumeNow command, so - same as resumeNow - it writes/refreshes
          // its own claim before launching, ignoring whatever claimResume
          // reports, so another window's own automatic attempt cannot also
          // fire while this launch is in flight.
          //
          // Fix round 2: bypassing the ANSWER (above) is not the same as
          // OWNING the claim. If claimResume just reported 'taken', another
          // window already holds this key - unconditionally releasing on a
          // failed launch, as round 1 did, would delete THAT window's live
          // claim out from under it. Only release when this call actually
          // won the claim itself ('claimed', which includes a stale
          // takeover it just performed).
          const buttonClaim = claimResume(claimsDir(), claimKey, Date.now(), fs, log);
          if (!resume(job, true)) {
            rememberReady(job);
            if (buttonClaim === 'claimed') {
              releaseClaim(claimsDir(), claimKey, fs, log);
            }
          }
        });
      }
      if (!decision.resume) {
        // This window is not launching anything automatically - the claim it
        // just took must not sit there blocking another window (or a later
        // manual retry) for up to an hour over a resume nobody is making.
        releaseClaim(claimsDir(), claimKey, fs, log);
        return;
      }
      // A second, independent controller ruling: on EVERY resume we are
      // about to launch here - whether nobody is on this session at all, or
      // (fix round 1, scope ruling) it is an idle panel we are resuming
      // anyway - a DIFFERENT session may be busy or waiting in the same
      // folder. The extension cannot message that session itself
      // (constraint #3 - never write into a session it did not create), so
      // instead it tells the session it is ABOUT to create: buildResumePrompt
      // appends a sentence naming the peer(s) and asking the resumed model to
      // coordinate with them via SendMessage before editing anything. This
      // never blocks the resume - only the prompt passed to it changes.
      // `decision.resume` (just checked above) is the gate: it is true for
      // exactly 'none', an idle panel, and a listing failure - and `rows !==
      // 'unknown'` already excludes that last one, since `holder` (and so
      // `decision`) is only ever 'unknown' when `rows` is too.
      let resumeJob = job;
      if (rows !== 'unknown' && decision.resume && job.cwd) {
        const peers = busyFolderPeers(rows, job.sessionId, job.cwd, process.platform);
        if (peers.length > 0) {
          const names = peers.map((p) => p.name ?? String(p.pid)).join(', ');
          log.info(`Another Claude session is working in ${job.cwd} (${names}); telling the resumed session to coordinate with it.`);
          void vscode.window.showInformationMessage(
            `Claude Limit Buster: another Claude session (${names}) is working in this folder. ` +
              `The resumed session has been told to coordinate with it.`,
          );
          resumeJob = { ...job, prompt: buildResumePrompt(job.prompt, peers) };
        }
      }
      if (s.notify) {
        void vscode.window.showInformationMessage(
          `Claude Limit Buster: resuming session ${job.sessionId.slice(0, 8)}.`,
        );
      }
      // The scheduler already cleared this job before firing (its own
      // re-entrancy guard, see consume()), so if the launch never started this
      // is the only place still holding it - without rememberReady it would
      // simply be gone. The ORIGINAL job (unmodified prompt) is what gets
      // remembered: a later manual resume should not carry a coordination
      // sentence tied to a folder-busy snapshot from this particular fire.
      if (!resume(resumeJob)) {
        rememberReady(job);
        // A resume that never launched must not hold the claim: a manual
        // retry (which bypasses the claim anyway) is not what this protects -
        // a LATER automatic attempt, from this window's own retry path or
        // another window's, is.
        releaseClaim(claimsDir(), claimKey, fs, log);
      }
    }),
    vscode.commands.registerCommand(`${NS}.resumeNow`, async () => {
      // Exactly one job moves, and only its own source is touched. Cancelling
      // the scheduler while resuming a ready job - or dropping a ready job
      // while resuming the scheduler's - would throw away work nobody asked to
      // discard.
      //
      // Each branch below removes the job from its source only once resume()
      // reports the launch actually started. resume() can fail (missing cwd,
      // no claude executable), and doing the removal first - as this used to -
      // left a failed resume with no path back to the job.
      //
      // confirmManualResume runs first in both branches: a live holder gets a
      // modal warning naming it before anything is claimed or launched (#2).
      //
      // Task 10: this is a MANUAL resume - the user's own explicit click or
      // command - so it bypasses whatever claimResume reports (another
      // window's claim, even a fresh one, is not a reason to refuse someone
      // who is looking right at this). It still calls claimResume, purely for
      // the write: the original claim from this job's own fire may have gone
      // stale by now (the user did not answer right away), and refreshing it
      // here is what stops a different window's own automatic attempt from
      // also firing while this launch is in flight.
      //
      // Fix round 2: bypassing the ANSWER is not the same as OWNING the
      // claim. If claimResume reports 'taken', another window already holds
      // this key - releasing on a failed launch must not delete that OTHER
      // window's live claim. Only release when this call actually won the
      // claim itself ('claimed', including a stale takeover it just did).
      const counting = scheduler.current;
      if (counting) {
        // Only this session's job: others may still be counting down, and
        // "Resume Now" moves exactly one.
        if (await confirmManualResume(counting)) {
          const key = claimKeyFor(counting);
          const countingClaim = claimResume(claimsDir(), key, Date.now(), fs, log);
          if (resume(counting, true)) {
            scheduler.cancel(counting.sessionId);
          } else if (countingClaim === 'claimed') {
            releaseClaim(claimsDir(), key, fs, log);
          }
        }
        return;
      }
      // Oldest first: the session that has been waiting longest goes first.
      // Peeked, not shifted, so a failed resume leaves it exactly where it was
      // instead of needing to be spliced back in.
      const ready = readyJobs[0];
      if (!ready) {
        void vscode.window.showInformationMessage('Claude Limit Buster: nothing pending.');
        return;
      }
      if (await confirmManualResume(ready)) {
        const key = claimKeyFor(ready);
        const readyClaim = claimResume(claimsDir(), key, Date.now(), fs, log);
        if (resume(ready, true)) {
          forgetReady(ready.sessionId);
        } else if (readyClaim === 'claimed') {
          releaseClaim(claimsDir(), key, fs, log);
        }
      }
    }),
    vscode.commands.registerCommand(`${NS}.cancel`, () => {
      // "Cancel Pending Resume" means all of it, but say how much it threw
      // away: a job dropped from readyJobs has no other trace.
      if (readyJobs.length > 0) {
        log.info(`Discarding ${readyJobs.length} resume(s) that were waiting to be started by hand.`);
        readyJobs.length = 0;
        persistReady();
      }
      scheduler.cancel();
      // Ruling 3: Cancel clears the gave-up state along with the jobs.
      if (gaveUp.clearAll()) {
        log.info('Cleared the gave-up state.');
      }
      // Rendered unconditionally, not left to scheduler.onChange or folded
      // into the gaveUp.clearAll() branch above: with nothing pending the
      // scheduler has nothing to cancel and does not fire onChange, and a
      // readyJobs-only cancel (Task 5b: readyJobs now reach the tooltip)
      // must still clear their lines even when nothing had given up.
      render();
    }),
    vscode.commands.registerCommand(`${NS}.showLog`, () => channel.show()),
    /**
     * What a click on the status bar opens (#3).
     *
     * It used to run Cancel directly: a countdown invites a click to look at
     * it, and the only warning that the click destroyed the pending resume
     * was the last line of a six-line tooltip. Every other status-bar item in
     * VS Code that shows state opens something. Cancel is still here, one
     * deliberate keystroke further away, and dismissing the menu does nothing
     * at all.
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
          // Cancel also clears the gave-up state (ruling 3), so with nothing
          // waiting it still has something to do - say so, rather than
          // "Nothing to cancel" next to a status bar saying otherwise.
          description:
            waiting > 0
              ? `Discard ${waiting} waiting resume(s)${gaveUpCount > 0 ? ' and clear what gave up' : ''}`
              : gaveUpCount > 0
                ? `Clear ${gaveUpCount} session(s) that gave up`
                : 'Nothing to cancel',
          command: `${NS}.cancel`,
        },
        { label: 'Show Log', description: 'Open the Claude Limit Buster output channel', command: `${NS}.showLog` },
      ];
      // Fix round 1, ruling 2b: a way to clear the gave-up state that does
      // not also discard every other session's waiting jobs, as Cancel does.
      // Only offered when there is something to dismiss.
      const DISMISS = 'Dismiss gave-up notices';
      if (gaveUpCount > 0) {
        items.push({
          label: DISMISS,
          description: `Clear ${gaveUpCount} gave-up notice(s); waiting resumes are kept`,
          command: '',
        });
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Claude Limit Buster',
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
     * Trust hotlink (Task 5a). Opens a terminal running plain `claude` (no
     * `--resume`, no prompt) in `cwd`, so the user answers Claude's own trust
     * dialog themselves - the extension never types into this terminal and
     * never writes `~/.claude.json` (constraint 2). Linked from the
     * untrusted-folder notice above; the tooltip link is Task 5b.
     */
    vscode.commands.registerCommand(`${NS}.openClaudeToTrust`, (cwd?: unknown) => {
      // Only ever invoked with a cwd today (the notice button, and Task 5b's
      // tooltip link); a bare Command Palette invocation - which is why it is
      // hidden there (`"when": "false"` in package.json) - or a stale
      // keybinding has no folder to open, so this logs and stops rather than
      // guessing one.
      if (typeof cwd !== 'string') {
        log.warn('claudeLimitBuster.openClaudeToTrust was invoked with no folder; ignoring.');
        return;
      }
      const s = settings();
      const launcher = findLauncher(s.claudeCommand);
      if (!launcher) {
        // Same failure, and the same handling, as the resume launch below.
        log.error(`Cannot open a trust terminal for ${cwd}: no claude executable found.`);
        void vscode.window.showErrorMessage(
          'Claude Limit Buster: could not find the claude executable. Set claudeLimitBuster.claudeCommand.',
        );
        return;
      }
      // Same reasoning as the resume launch: open from whichever spelling
      // the CLI already has on record, so a folder trusted from a terminal
      // is recognised even when VS Code reports a different-cased drive
      // letter for the same directory (trust.ts).
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
      // Ruling 2: re-check EVERY pending job, not just the one the terminal
      // was opened for - refreshTrust is mtime-cached per session, so this is
      // cheap, and it is what catches a job whose cwd is a different spelling
      // of the same folder the user just trusted. Then force the same render
      // call scheduler.onChange uses (above), so the tooltip's marker clears
      // now instead of waiting for the next countdown tick.
      for (const job of scheduler.jobs) {
        refreshTrust(job);
      }
      render();
    }),
  );

  scheduler.start();
  // Unconditional, not left to scheduler.start()'s own onChange (which fires
  // only when something is pending): readyJobs restored above can be
  // non-empty with nothing pending, and before this the status bar simply
  // never showed them - the marker stayed hidden until the next event. The
  // "install from a VSIX and see nothing" doubt this class's own tooltip
  // reasoning is about applies just as much to a ready session restored
  // across a reload.
  render();
  void watcher.start();
  log.info('Claude Limit Buster active.');
}

export function deactivate(): void {
  /* subscriptions handle teardown */
}
