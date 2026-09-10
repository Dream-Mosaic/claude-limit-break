import * as vscode from 'vscode';
import { formatDuration } from './parsers/limitParser';
import type { PendingJob } from './scheduler';

/**
 * Countdown pill in the status bar. Hidden entirely when nothing is pending,
 * so the extension is invisible until it has something to say.
 */
export class CountdownStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claudeLimitBuster.cancel';
    this.item.name = 'Claude Limit Buster';
  }

  update(job: PendingJob | undefined): void {
    if (!job) {
      this.item.hide();
      return;
    }
    const remaining = job.resumeAtMs - Date.now();
    const at = new Date(job.resumeAtMs);
    this.item.text = `$(clock) Claude resumes in ${formatDuration(remaining)}`;

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**Claude Limit Buster**\n\n`);
    tooltip.appendMarkdown(`Resuming at **${at.toLocaleString()}**\n\n`);
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
    tooltip.appendMarkdown(`_Click to cancel._`);
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
