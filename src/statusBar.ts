import * as vscode from 'vscode';
import { formatDuration } from './parsers/limitParser';
import type { PendingJob } from './scheduler';
import { GAVE_UP_ICON, REASON, type GaveUpCause, type GaveUpRecord } from './gaveUp';

/** What the item shows when no resume is counting down. */
export type StatusBarMode = 'always' | 'pending' | 'never';

/** The command the trust hotlink points at. */
const TRUST_COMMAND = 'claudeLimitBreak.openClaudeToTrust';

/**
 * Escape Markdown special characters in text this extension does not control (a folder name from a transcript or the filesystem). Otherwise a folder named `*x*` renders italic, and one crafted to look like a command link could pose as this tooltip's own trust hotlink. Covers every ASCII character CommonMark treats specially.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}

/**
 * The last path segment of `cwd`, split on both separators. Not `path.basename`: a session may have been recorded on a different OS than the one rendering (synced state, a copied transcript), and POSIX `basename` does not split on `\`.
 */
function folderBasename(cwd: string): string {
  const segments = cwd.split(/[\\/]+/).filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : cwd;
}

/**
 * `encodeURIComponent` leaves `( ) ! ' *` raw, but the query sits inside a Markdown inline link's `(...)` target, which a renderer reads only up to the first unescaped ")". A cwd containing one (an unbalanced ")" is enough, e.g. a "(copy)" folder) closed the target early and the trust command silently no-opped. So these are percent-encoded by hand afterwards.
 */
const LEFT_RAW_BY_ENCODE_URI_COMPONENT = /[()!'*]/g;

/**
 * The command-URI for the trust hotlink (`openClaudeToTrust`): `command:<id>?<args>`, args being `encodeURIComponent(JSON.stringify([cwd]))`, with the characters above additionally escaped so the result is safe as a Markdown link target, not just as a URI.
 */
export function trustCommandUri(cwd: string): string {
  const args = encodeURIComponent(JSON.stringify([cwd])).replace(
    LEFT_RAW_BY_ENCODE_URI_COMPONENT,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `command:${TRUST_COMMAND}?${args}`;
}

/** One session's line, and whether it carries the trust hotlink. */
interface SessionLine {
  markdown: string;
  hasTrustLink: boolean;
}

/**
 * One Markdown line (no leading bullet) for a session: short id, escaped folder basename, its state (a formatted resume time, "ready", or neither for a gave-up-only session), its gave-up cause if any, and an untrusted-folder marker with the trust link if its folder is known untrusted.
 */
function buildSessionLine(entry: {
  sessionId: string;
  cwd?: string;
  folderTrusted?: boolean;
  state?: 'counting' | 'ready';
  resumeAtMs?: number;
  offerOnly?: true;
  gaveUpCause?: GaveUpCause;
}): SessionLine {
  const id = `\`${entry.sessionId.slice(0, 8)}\``;
  const folder = entry.cwd ? escapeMarkdown(folderBasename(entry.cwd)) : '_no folder recorded_';
  const bits = [`${id} in ${folder}`];
  if (entry.state === 'counting' && entry.resumeAtMs !== undefined && entry.offerOnly) {
    // A reset beyond maxWaitHours: still waiting, but nothing launches at the deadline; Resume Now is offered then.
    bits.push(`**manual**: Resume Now offered at **${new Date(entry.resumeAtMs).toLocaleString()}**`);
  } else if (entry.state === 'counting' && entry.resumeAtMs !== undefined) {
    bits.push(`resuming at **${new Date(entry.resumeAtMs).toLocaleString()}**`);
  } else if (entry.state === 'ready') {
    bits.push('**ready**');
  }
  if (entry.gaveUpCause) {
    bits.push(`**Gave up**: ${REASON[entry.gaveUpCause]}`);
  }
  let hasTrustLink = false;
  if (entry.folderTrusted === false && entry.cwd) {
    hasTrustLink = true;
    bits.push(`$(warning) not trusted — [Trust this folder](${trustCommandUri(entry.cwd)})`);
  }
  return { markdown: bits.join(', '), hasTrustLink };
}

/**
 * Build the tooltip's unified session list: every counting-down job, every job waiting for "Resume Now", and every gave-up session, folded into one line each.
 *
 * A session present in more than one input (a launcher/cwd failure leaves the job in `ready` for retry; a failed manual retry leaves a counting-down job counting down) gets exactly one line, carrying its pending state plus its gave-up cause. `ready` is only consulted for a session `jobs` does not already cover: a session can hold both a counting-down job and an unrelated stale ready job, and the countdown is what happens next.
 *
 * Order: pending/ready lines first, soonest first (a ready job's deadline already elapsed, so it sorts ahead of anything counting down); gave-up-only lines after, oldest first (GaveUpState.list()'s order).
 */
export function buildSessionLines(
  jobs: readonly PendingJob[],
  ready: readonly PendingJob[],
  gaveUp: readonly GaveUpRecord[],
): { lines: string[]; hasTrustLink: boolean; waitingCount: number } {
  interface Entry {
    sessionId: string;
    cwd?: string;
    folderTrusted?: boolean;
    state?: 'counting' | 'ready';
    resumeAtMs?: number;
    offerOnly?: true;
    gaveUpCause?: GaveUpCause;
  }
  const byId = new Map<string, Entry>();
  for (const job of jobs) {
    byId.set(job.sessionId, {
      sessionId: job.sessionId,
      cwd: job.cwd,
      folderTrusted: job.folderTrusted,
      state: 'counting',
      resumeAtMs: job.resumeAtMs,
      ...(job.offerOnly ? { offerOnly: true as const } : {}),
    });
  }
  for (const job of ready) {
    if (!byId.has(job.sessionId)) {
      byId.set(job.sessionId, {
        sessionId: job.sessionId,
        cwd: job.cwd,
        folderTrusted: job.folderTrusted,
        state: 'ready',
        resumeAtMs: job.resumeAtMs,
      });
    }
  }
  const waiting = [...byId.values()].sort((a, b) => (a.resumeAtMs ?? 0) - (b.resumeAtMs ?? 0));
  const waitingCount = waiting.length;

  const gaveUpOnly: Entry[] = [];
  for (const record of gaveUp) {
    const existing = byId.get(record.sessionId);
    if (existing) {
      existing.gaveUpCause = record.cause;
    } else {
      gaveUpOnly.push({ sessionId: record.sessionId, cwd: record.cwd, gaveUpCause: record.cause });
    }
  }

  let hasTrustLink = false;
  const lines = [...waiting, ...gaveUpOnly].map((entry) => {
    const line = buildSessionLine(entry);
    hasTrustLink = hasTrustLink || line.hasTrustLink;
    return line.markdown;
  });
  return { lines, hasTrustLink, waitingCount };
}

/**
 * Countdown pill in the status bar, and - when nothing is counting down - a bare marker saying the extension is running. A window showing nothing at all is indistinguishable from a failed install, since this extension is installed from a VSIX to wait for an event hours away. `pending` restores hiding it when idle.
 */
export class CountdownStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    // A menu, not the cancel command: a single click must not destroy the pending resume with no confirmation or undo.
    this.item.command = 'claudeLimitBreak.statusBarMenu';
    this.item.name = 'Limit Break';
  }

  /** `jobs` are counting down, soonest first; `ready` are waiting for "Resume Now" (their own countdowns already elapsed); `gaveUp` are sessions this window has stopped retrying. All three feed the one tooltip list built by `buildSessionLines`. */
  update(
    jobs: readonly PendingJob[],
    ready: readonly PendingJob[] = [],
    mode: StatusBarMode = 'always',
    gaveUp: readonly GaveUpRecord[] = [],
  ): void {
    if (mode === 'never') {
      this.item.hide();
      return;
    }
    const { lines, hasTrustLink, waitingCount } = buildSessionLines(jobs, ready, gaveUp);
    const soonest = jobs[0];
    const gaveUpCount = gaveUp.length;

    if (!soonest) {
      if (waitingCount === 0 && gaveUpCount === 0) {
        if (mode === 'pending') {
          this.item.hide();
          return;
        }
        this.item.text = '$(eye)';
        const idle = new vscode.MarkdownString(undefined, true);
        idle.appendMarkdown(`**Limit Break**\n\n`);
        idle.appendMarkdown(`Watching for usage limits. Nothing pending.\n\n`);
        idle.appendMarkdown(`_Click for actions._`);
        this.item.tooltip = idle;
        this.item.backgroundColor = undefined;
        this.item.show();
        return;
      }
      // Something to show even with nothing counting down: a gave-up session, a ready one, or both on one line. The gave-up icon wins, the more urgent signal.
      if (gaveUpCount > 0) {
        const count = gaveUpCount > 1 ? ` (${gaveUpCount} sessions)` : '';
        this.item.text = `${GAVE_UP_ICON} Resume gave up${count}`;
      } else {
        const count = waitingCount > 1 ? ` (${waitingCount} sessions)` : '';
        this.item.text = `$(clock) Claude ready to resume${count}`;
      }
      this.renderTooltip(lines, hasTrustLink, gaveUpCount > 0);
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const remaining = soonest.resumeAtMs - Date.now();
    const others = waitingCount > 1 ? ` (${waitingCount} sessions)` : '';
    // An offer-only job (a reset beyond maxWaitHours) counts down to an offer, not a resume, and the pill must not promise one.
    this.item.text = soonest.offerOnly
      ? `$(clock) Claude limit resets in ${formatDuration(remaining)}${others} (manual)`
      : `$(clock) Claude resumes in ${formatDuration(remaining)}${others}`;
    this.renderTooltip(lines, hasTrustLink, gaveUpCount > 0);

    // Nudge the colour as the deadline approaches so it reads at a glance.
    this.item.backgroundColor =
      remaining <= 60_000 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  /**
   * The shared tooltip body for every non-idle state: header, one bullet per `buildSessionLines` line, a reminder of how to clear a gave-up notice when present, and the click-for-actions footer. `isTrusted` is set only when a line actually carries the trust command link; an unconditional `true` would trust every link a folder name could be crafted to look like.
   */
  private renderTooltip(lines: readonly string[], hasTrustLink: boolean, hasGaveUp: boolean): void {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**Limit Break**\n\n`);
    for (const line of lines) {
      tooltip.appendMarkdown(`- ${line}\n`);
    }
    if (lines.length > 0) {
      tooltip.appendMarkdown(`\n`);
    }
    if (hasGaveUp) {
      // Every way a gave-up record clears (gaveUp.ts), not just two: a new detection, the session finishing a turn, a resume launching, the menu's dismiss item, and Cancel.
      tooltip.appendMarkdown(
        `This clears on a new detection for the session, when the session finishes a turn or is resumed, ` +
          `or with "Dismiss gave-up notices" or "Cancel Pending Resume" from the menu.\n\n`,
      );
    }
    tooltip.appendMarkdown(`_Click for actions._`);
    if (hasTrustLink) {
      tooltip.isTrusted = { enabledCommands: [TRUST_COMMAND] };
    }
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    this.item.dispose();
  }
}
