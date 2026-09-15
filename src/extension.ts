import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './log';
import { readSettings } from './config';
import { TranscriptWatcher } from './transcriptWatcher';
import { ResumeScheduler, type PendingJob } from './scheduler';
import { CountdownStatusBar } from './statusBar';
import { planResume } from './policy';
import { randomJitterMs } from './randomDelay';
import { playAlertSound } from './sound';
import { buildTerminalOptions, resolveClaudeLauncher, cwdExists } from './resumer';
import { isFolderTrusted, readClaudeUserConfig, defaultClaudeConfigPath } from './trust';
import { GRACE_MS, stallVerdict } from './stallWatch';
import { execFileSync } from 'node:child_process';

const NS = 'claudeLimitBuster';

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

  /** Drop a remembered job. Reports whether it was still there to drop. */
  const forgetReady = (sessionId: string) => {
    const at = readyJobs.findIndex((j) => j.sessionId === sessionId);
    if (at < 0) {
      return false;
    }
    readyJobs.splice(at, 1);
    return true;
  };

  /** Remember a job for manual resume, replacing any earlier one for the same session. */
  const rememberReady = (job: PendingJob) => {
    forgetReady(job.sessionId);
    readyJobs.push(job);
  };

  const onDetection = (hit: Parameters<typeof planResume>[0], reason: 'limit' | 'overload') => {
    const s = settings();
    const plan = planResume(hit, reason, s, statBytes, new Date(), randomJitterMs);
    if (plan.kind === 'ignore') {
      log.info(plan.reason);
      return;
    }
    if (plan.kind === 'refuse') {
      log.warn(plan.reason);
      void vscode.window.showWarningMessage(`Claude Limit Buster: ${plan.reason}`);
      return;
    }
    // Checked here, at schedule time, rather than when the cooldown fires:
    // the user is still at the keyboard for this notice, and can trust the
    // folder before walking away. By fire time they are already gone, which
    // is exactly why an untrusted folder stalls silently at Claude's own
    // trust prompt (#5). Never written back here, only read - answering that
    // prompt is the user's call, not this extension's.
    const folderTrusted = plan.job.cwd
      ? isFolderTrusted(
          plan.job.cwd,
          readClaudeUserConfig(defaultClaudeConfigPath(), (p) => fs.readFileSync(p, 'utf8')),
        )
      : undefined;
    const job = { ...plan.job, folderTrusted };
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
        `Claude Limit Buster: resuming at ${at} (~${plan.estimate.toLocaleString()} tokens).${trustNote}`,
      );
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
  const resume = (job: PendingJob): boolean => {
    const s = settings();
    if (s.resumeMode === 'headless') {
      // Headless mode is declared in settings but not yet routed here; it is a
      // follow-up. Note that rather than pretending otherwise: this resume
      // still runs interactively.
      log.warn('resumeMode is "headless" but headless resume is not yet implemented; resuming interactively.');
    }
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
    if (!cwdExists(job.cwd, fs.existsSync)) {
      log.error(`Cannot resume ${job.sessionId}: cwd "${job.cwd}" no longer exists (recorded in ${job.transcript}).`);
      void vscode.window.showErrorMessage(
        `Claude Limit Buster: the folder for session ${job.sessionId.slice(0, 8)} no longer exists: ${job.cwd}. ` +
          'The resume was not started. Use "Resume Now" again once the folder is back, or check the transcript.',
      );
      return false;
    }
    const opts = buildTerminalOptions(
      { sessionId: job.sessionId, transcript: job.transcript, cwd: job.cwd, bytes: 0 },
      job.prompt,
      launcher,
    );
    // A NEW terminal, every time. Never activeTerminal, never sendText: if
    // Claude has died, the prompt would land in whatever shell is sitting there.
    const terminal = vscode.window.createTerminal(opts);
    terminal.show();
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
      if (!s.enabled || !s.alertSound) {
        return;
      }
      // A turn ends roughly once per Claude response, in every session on the
      // machine. Only this window's own folders are worth making a noise about.
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      if (!isInsideWorkspace(hit.cwd, folders)) {
        return;
      }
      playAlertSound({ file: s.alertSoundFile });
    }),
    scheduler.onChange((job) => status.update(job, scheduler.jobs.length)),
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
      }
      scheduler.cancel();
    }),
    vscode.commands.registerCommand(`${NS}.showLog`, () => channel.show()),
  );

  scheduler.start();
  void watcher.start();
  log.info('Claude Limit Buster active.');
}

export function deactivate(): void {
  /* subscriptions handle teardown */
}
