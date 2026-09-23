import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './log';
import { readSettings, type Settings } from './config';
import { TranscriptWatcher } from './transcriptWatcher';
import { ResumeScheduler, type PendingJob } from './scheduler';
import { CountdownStatusBar } from './statusBar';
import { planResume } from './policy';
import { randomJitterMs } from './randomDelay';
import { playAlertSound } from './sound';
import {
  buildTerminalOptions,
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
import { livePanelDetector } from './liveSessions';
import { sessionRegistryDir, readSessionRecord } from './sessionRegistry';
import { selectClaudePanelTab, type WebviewTab } from './panelTab';
import { buildReopenOffer, chooseReopenCommand } from './reopenOffer';
import { execFileSync } from 'node:child_process';

const NS = 'claudeLimitBuster';

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

  const scheduler = new ResumeScheduler(context.globalState, log);
  const status = new CountdownStatusBar();
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

  /** Drop a remembered job. Reports whether it was still there to drop. */
  const forgetReady = (sessionId: string) => {
    const at = readyJobs.findIndex((j) => j.sessionId === sessionId);
    if (at < 0) {
      return false;
    }
    readyJobs.splice(at, 1);
    persistReady();
    return true;
  };

  /** Remember a job for manual resume, replacing any earlier one for the same session. */
  const rememberReady = (job: PendingJob) => {
    forgetReady(job.sessionId);
    readyJobs.push(job);
    persistReady();
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
      void vscode.window.showInformationMessage(
        `Claude Limit Buster: resuming at ${at} (~${estimate.toLocaleString()} tokens).${trustNote}`,
      );
    }
  };

  const onDetection = (hit: Parameters<typeof planResume>[0], reason: 'limit' | 'overload') => {
    const s = settings();
    const plan = planResume(hit, reason, s, statBytes, new Date(), randomJitterMs, readUsage);
    if (plan.kind === 'ignore') {
      log.info(plan.reason);
      return;
    }
    if (plan.kind === 'refuse') {
      log.warn(plan.reason);
      // Offered, not just announced. The estimate can be several times too
      // high on a long session - the byte count counts history that
      // compaction already summarised away - and refusing outright takes the
      // decision away from the person whose session it is. Saying yes plans
      // the same resume with the cap lifted for this one incident.
      void Promise.resolve(
        vscode.window.showWarningMessage(`Claude Limit Buster: ${plan.reason}`, 'Resume anyway'),
      ).then((choice) => {
        if (choice !== 'Resume anyway') {
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
   * Is a panel tab holding this session open, apart from our own resume?
   *
   * `claude agents --json` for liveness, the per-pid record for the
   * entrypoint - see liveSessions.ts for why it is split that way. Run with a
   * timeout: this is on the path of an end-of-turn event, and a CLI that hangs
   * must not take the handler with it.
   */
  const detectLivePanel = livePanelDetector(
    () => {
      const launcher = findLauncher(settings().claudeCommand);
      if (!launcher) {
        throw new Error('no claude executable');
      }
      return execFileSync(launcher.file, [...launcher.args, 'agents', '--json'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
    },
    (pid) => readSessionRecord(sessionRegistryDir(), pid, (f) => fs.readFileSync(f, 'utf8')),
  );

  const resume = (job: PendingJob): boolean => {
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
      void vscode.window.showErrorMessage(
        'Claude Limit Buster: could not find the claude executable. Set claudeLimitBuster.claudeCommand.',
      );
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
      void vscode.window.showErrorMessage(
        `Claude Limit Buster: the folder for session ${job.sessionId.slice(0, 8)} no longer exists: ${job.cwd}. ` +
          'The resume was not started. Use "Resume Now" again once the folder is back, or check the transcript.',
      );
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
      void vscode.window.showWarningMessage(
        `Claude Limit Buster: the resume of session ${job.sessionId.slice(0, 8)} does not appear to have started.${trustFirst}`,
      );
    }, GRACE_MS);
    stallChecks.add(check);
    return true;
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
      status.update(job, scheduler.jobs.length, settings().statusBar);
    }),
    scheduler.onFire((job) => {
      const s = settings();
      if (!s.autoResume) {
        rememberReady(job);
        log.info(`Cooldown elapsed for ${job.sessionId}; autoResume is off, so it is waiting for you.`);
        void Promise.resolve(
          vscode.window.showInformationMessage(
            `Claude Limit Buster: the cooldown has elapsed for session ${job.sessionId.slice(0, 8)}.`,
            'Resume Now',
          ),
        ).then((choice) => {
          if (choice === 'Resume Now') {
            // This job, closed over here - not "whatever is ready now". Another
            // session can come ready while this notification is still on
            // screen, and the offer names a session, so it must honour it.
            //
            // Removing it is also how this click claims it. The notification
            // outlives the job: the same session can be resumed from the
            // command palette first, and without the claim a later click here
            // would launch a second `claude --resume` on it.
            if (!forgetReady(job.sessionId)) {
              void vscode.window.showInformationMessage(
                `Claude Limit Buster: session ${job.sessionId.slice(0, 8)} was already resumed or cancelled.`,
              );
              return;
            }
            // forgetReady above is how this click claims the job; if the
            // launch never actually started, the claim must be undone or the
            // job is gone with no way back.
            if (!resume(job)) {
              rememberReady(job);
            }
          }
        });
        return;
      }
      if (s.notify) {
        void vscode.window.showInformationMessage(
          `Claude Limit Buster: resuming session ${job.sessionId.slice(0, 8)}.`,
        );
      }
      // The scheduler already cleared this job before firing (its own
      // re-entrancy guard, see consume()), so if the launch never started this
      // is the only place still holding it - without rememberReady it would
      // simply be gone.
      if (!resume(job)) {
        rememberReady(job);
      }
    }),
    vscode.commands.registerCommand(`${NS}.resumeNow`, () => {
      // Exactly one job moves, and only its own source is touched. Cancelling
      // the scheduler while resuming a ready job - or dropping a ready job
      // while resuming the scheduler's - would throw away work nobody asked to
      // discard.
      //
      // Each branch below removes the job from its source only once resume()
      // reports the launch actually started. resume() can fail (missing cwd,
      // no claude executable), and doing the removal first - as this used to -
      // left a failed resume with no path back to the job.
      const counting = scheduler.current;
      if (counting) {
        // Only this session's job: others may still be counting down, and
        // "Resume Now" moves exactly one.
        if (resume(counting)) {
          scheduler.cancel(counting.sessionId);
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
      if (resume(ready)) {
        forgetReady(ready.sessionId);
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
      const items = [
        {
          label: 'Resume Now',
          description: waiting > 0 ? 'Start the soonest waiting session immediately' : 'Nothing is waiting',
          command: `${NS}.resumeNow`,
        },
        {
          label: 'Cancel Pending Resume',
          description: waiting > 0 ? `Discard ${waiting} waiting resume(s)` : 'Nothing to cancel',
          command: `${NS}.cancel`,
        },
        { label: 'Show Log', description: 'Open the Claude Limit Buster output channel', command: `${NS}.showLog` },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Claude Limit Buster',
        placeHolder: waiting > 0 ? `${waiting} resume(s) waiting` : 'Watching for usage limits',
      });
      if (!picked) {
        return;
      }
      await vscode.commands.executeCommand(picked.command);
    }),
  );

  scheduler.start();
  void watcher.start();
  log.info('Claude Limit Buster active.');
}

export function deactivate(): void {
  /* subscriptions handle teardown */
}
