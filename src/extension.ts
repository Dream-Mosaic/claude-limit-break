import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { createLogger } from './log';
import { readSettings } from './config';
import { TranscriptWatcher } from './transcriptWatcher';
import { ResumeScheduler, type PendingJob } from './scheduler';
import { CountdownStatusBar } from './statusBar';
import { planResume } from './policy';
import { randomJitterMs } from './randomDelay';
import { playAlertSound } from './sound';
import { buildTerminalOptions, resolveClaudeLauncher } from './resumer';
import { execFileSync } from 'node:child_process';

const NS = 'claudeLimitBuster';

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

  // A job whose cooldown elapsed while autoResume was off. The scheduler clears
  // its own state before firing — a deliberate re-entrancy guard — so without
  // holding it here the job would simply be gone and "Resume Now" would report
  // nothing pending.
  let readyJob: PendingJob | undefined;

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
    if (scheduler.schedule(plan.job) && s.notify) {
      const at = new Date(plan.job.resumeAtMs).toLocaleTimeString();
      void vscode.window.showInformationMessage(
        `Claude Limit Buster: resuming at ${at} (~${plan.estimate.toLocaleString()} tokens).`,
      );
    }
  };

  const resume = (job: PendingJob) => {
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
      return;
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
  };

  context.subscriptions.push(
    channel,
    status,
    watcher,
    scheduler,
    watcher.onHit((h) => onDetection(h, 'limit')),
    watcher.onOverload((h) => onDetection(h, 'overload')),
    watcher.onInputNeeded(() => {
      const s = settings();
      if (s.alertSound) {
        playAlertSound({ file: s.alertSoundFile });
      }
    }),
    scheduler.onChange((job) => status.update(job)),
    scheduler.onFire((job) => {
      const s = settings();
      if (!s.autoResume) {
        readyJob = job;
        log.info(`Cooldown elapsed for ${job.sessionId}; autoResume is off, so it is waiting for you.`);
        void Promise.resolve(
          vscode.window.showInformationMessage(
            'Claude Limit Buster: the cooldown has elapsed. Resume when you are ready.',
            'Resume Now',
          ),
        ).then((choice) => {
          if (choice === 'Resume Now') {
            void vscode.commands.executeCommand(`${NS}.resumeNow`);
          }
        });
        return;
      }
      if (s.notify) {
        void vscode.window.showInformationMessage(
          `Claude Limit Buster: resuming session ${job.sessionId.slice(0, 8)}.`,
        );
      }
      resume(job);
    }),
    vscode.commands.registerCommand(`${NS}.resumeNow`, () => {
      // Falls back to a job that already fired: with autoResume off the
      // scheduler has nothing pending, but the job is still resumable.
      const job = scheduler.current ?? readyJob;
      if (!job) {
        void vscode.window.showInformationMessage('Claude Limit Buster: nothing pending.');
        return;
      }
      readyJob = undefined;
      scheduler.cancel();
      resume(job);
    }),
    vscode.commands.registerCommand(`${NS}.cancel`, () => {
      readyJob = undefined;
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
