import * as vscode from 'vscode';
import { formatDuration } from './parsers/limitParser';
import type { PendingJob } from './scheduler';
import { GAVE_UP_ICON, describeGaveUp, type GaveUpRecord } from './gaveUp';

/** What the item shows when no resume is counting down. */
export type StatusBarMode = 'always' | 'pending' | 'never';

/**
 * Countdown pill in the status bar, and — when nothing is counting down — a
 * bare marker saying the extension is running.
 *
 * It used to hide entirely when idle, on the reasoning that an extension
 * should be invisible until it has something to say. That reads differently
 * from the user's side: this extension is installed from a VSIX to wait for an
 * event that may be hours away, and a window showing nothing at all is
 * indistinguishable from one where the install silently failed. `pending`
 * restores the old behaviour for anyone who prefers it.
 */
export class CountdownStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    // A menu, not the cancel command. A single click used to destroy the
    // pending resume with no confirmation and no undo, while the only warning
    // sat at the bottom of a six-line tooltip (#3).
    this.item.command = 'claudeLimitBuster.statusBarMenu';
    this.item.name = 'Claude Limit Buster';
  }

  /**
   * `waiting` is how many sessions have a resume pending. The pill shows the
   * soonest; without the count, a second session's resume would be invisible,
   * which reads exactly like it had been dropped.
   */
  update(
    job: PendingJob | undefined,
    waiting = 1,
    mode: StatusBarMode = 'always',
    gaveUp: readonly GaveUpRecord[] = [],
  ): void {
    if (mode === 'never') {
      this.item.hide();
      return;
    }
    if (!job && gaveUp.length > 0) {
      // Shown under 'pending' too: that mode hides the idle marker, and a
      // session this extension has stopped retrying is not idle - hiding it
      // would be the silent failure the gave-up state exists to end (A8).
      const count = gaveUp.length > 1 ? ` (${gaveUp.length} sessions)` : '';
      this.item.text = `${GAVE_UP_ICON} Resume gave up${count}`;
      const tip = new vscode.MarkdownString(undefined, true);
      tip.appendMarkdown(`**Claude Limit Buster**\n\n`);
      appendGaveUp(tip, gaveUp);
      tip.appendMarkdown(`_Click for actions._`);
      this.item.tooltip = tip;
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    if (!job) {
      if (mode === 'pending') {
        this.item.hide();
        return;
      }
      this.item.text = '$(eye)';
      const idle = new vscode.MarkdownString(undefined, true);
      idle.appendMarkdown(`**Claude Limit Buster**\n\n`);
      idle.appendMarkdown(`Watching for usage limits. Nothing pending.\n\n`);
      idle.appendMarkdown(`_Click for actions._`);
      this.item.tooltip = idle;
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    const remaining = job.resumeAtMs - Date.now();
    const at = new Date(job.resumeAtMs);
    const others = waiting > 1 ? ` (${waiting} sessions)` : '';
    this.item.text = `$(clock) Claude resumes in ${formatDuration(remaining)}${others}`;

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**Claude Limit Buster**\n\n`);
    tooltip.appendMarkdown(`Resuming at **${at.toLocaleString()}**\n\n`);
    if (waiting > 1) {
      tooltip.appendMarkdown(`**${waiting} sessions** are waiting to resume; this one is due first.\n\n`);
    }
    if (job.jitterMs > 0) {
      tooltip.appendMarkdown(
        `Padded by a random **${formatDuration(job.jitterMs)}** past the reset time\n\n`,
      );
    }
    tooltip.appendMarkdown(`Reason: \`${job.reason}\`\n\n`);
    tooltip.appendMarkdown(`Session: \`${job.sessionId}\`\n\n`);
    if (job.cwd) {
      tooltip.appendMarkdown(`Folder: \`${job.cwd}\`\n\n`);
    }
    if (job.folderTrusted === false) {
      // Checked at schedule time, not here: by the time this tooltip is read
      // the countdown may already be near zero, which is too late to trust
      // the folder before Claude stalls at its trust prompt (#5).
      tooltip.appendMarkdown(
        `**This folder is not trusted for the CLI.** Claude will stop at its trust ` +
          `prompt and wait for a keypress. Trust it now if you plan to be away when this fires.\n\n`,
      );
    }
    appendGaveUp(tooltip, gaveUp);
    tooltip.appendMarkdown(`_Click for actions._`);
    this.item.tooltip = tooltip;

    // Nudge the colour as the deadline approaches so it reads at a glance.
    this.item.backgroundColor =
      remaining <= 60_000 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

/**
 * The gave-up section of a tooltip: one line per session and its cause.
 * Deliberately a separate block rather than woven into the countdown text -
 * Task 5b folds it and the pending jobs into one list.
 */
function appendGaveUp(tip: vscode.MarkdownString, gaveUp: readonly GaveUpRecord[]): void {
  if (gaveUp.length === 0) {
    return;
  }
  tip.appendMarkdown(`**Gave up** on ${gaveUp.length === 1 ? 'this session' : 'these sessions'}:\n\n`);
  for (const r of gaveUp) {
    tip.appendMarkdown(`- ${describeGaveUp(r)}\n`);
  }
  tip.appendMarkdown(`\nA new limit for a session, or "Cancel Pending Resume", clears this.\n\n`);
}
