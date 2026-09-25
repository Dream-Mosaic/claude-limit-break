import * as vscode from 'vscode';
import { formatDuration } from './parsers/limitParser';
import type { PendingJob } from './scheduler';
import { GAVE_UP_ICON, REASON, type GaveUpCause, type GaveUpRecord } from './gaveUp';

/** What the item shows when no resume is counting down. */
export type StatusBarMode = 'always' | 'pending' | 'never';

/** The Task 5a command the trust hotlink points at. */
const TRUST_COMMAND = 'claudeLimitBuster.openClaudeToTrust';

/**
 * Escape Markdown special characters in text this extension does not
 * control (a folder name, taken from a transcript or the filesystem).
 *
 * Without this, a folder literally named `*x*` renders as italic text, and
 * one named `[a](b)` renders as a link - or, worse, a folder name crafted to
 * look like a command link could pose as this tooltip's own trust hotlink.
 * The set covers every ASCII character CommonMark treats specially, per
 * Task 5b ruling 2.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}

/**
 * The last path segment of `cwd`, split on both separators.
 *
 * Not `path.basename`: this extension's tooltip can describe a session
 * recorded on a different OS than the one it is currently rendering on (a
 * synced settings/state profile, or a transcript copied between machines),
 * and POSIX `basename` does not split on `\`. Mirrors the same reasoning as
 * `resolveSession`'s filename split in sessionResolver.ts.
 */
function folderBasename(cwd: string): string {
  const segments = cwd.split(/[\\/]+/).filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : cwd;
}

/**
 * `encodeURIComponent` leaves `( ) ! ' *` raw - RFC 3986 calls them
 * "unreserved", which is exactly wrong here: the query sits inside a
 * Markdown inline link's `(...)` target, and a renderer reads that target
 * only up to the first UNESCAPED ")". A cwd containing any of these -
 * an unbalanced ")" is enough (`/home/me/foo)`, or an ordinary
 * "(copy)" folder) - closed the link target early: `openClaudeToTrust` ran
 * with no arguments and silently no-opped (review 1, Important 1). Percent-
 * encoded by hand, after `encodeURIComponent`, since that is the only gap
 * it leaves for a Markdown link target specifically.
 */
const LEFT_RAW_BY_ENCODE_URI_COMPONENT = /[()!'*]/g;

/**
 * The command-URI for the trust hotlink (Task 5a's `openClaudeToTrust`),
 * the VS Code command-URI convention: `command:<id>?<args>`, args being
 * `encodeURIComponent(JSON.stringify([cwd]))` - a one-element argument
 * array, since that command takes the cwd as its sole parameter - with the
 * characters above additionally escaped so the result is safe as a Markdown
 * link target, not just as a URI.
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
 * One Markdown line (no leading bullet) for a session: short id, escaped
 * folder basename, its state (a formatted resume time, "ready", or neither
 * for a gave-up-only session), its gave-up cause if it has one, and an
 * untrusted-folder marker with the trust link if its folder is known
 * untrusted. `state` is `undefined` for a gave-up-only session - see the
 * "gave-up-only" handling in `buildSessionLines` below.
 */
function buildSessionLine(entry: {
  sessionId: string;
  cwd?: string;
  folderTrusted?: boolean;
  state?: 'counting' | 'ready';
  resumeAtMs?: number;
  gaveUpCause?: GaveUpCause;
}): SessionLine {
  const id = `\`${entry.sessionId.slice(0, 8)}\``;
  const folder = entry.cwd ? escapeMarkdown(folderBasename(entry.cwd)) : '_no folder recorded_';
  const bits = [`${id} in ${folder}`];
  if (entry.state === 'counting' && entry.resumeAtMs !== undefined) {
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
 * Build the tooltip's unified session list (controller ruling: "T5 tooltip
 * lists gave-up sessions with their reason - one status-bar model, not
 * two"): every counting-down job, every job waiting for "Resume Now", and
 * every gave-up session, folded into one line each.
 *
 * A session present in more than one input (a launcher/cwd failure leaves
 * the job in `ready` so it can be retried, and a failed manual retry on a
 * counting-down job leaves it counting down - Task 4b implementer concern
 * 4) gets exactly one line, carrying whichever pending state it has plus its
 * gave-up cause. `ready` is only consulted for a session `jobs` does not
 * already cover: a session can genuinely hold both a counting-down job and
 * an unrelated stale ready job at once (Task 4b fix round 1, finding 1), and
 * the countdown is what is actually going to happen next, so that is what
 * the one line shows.
 *
 * Order: pending/ready lines first, soonest first (a ready job's own
 * deadline already elapsed, so it sorts ahead of anything still counting
 * down); gave-up-only lines after, oldest first (GaveUpState.list()'s own
 * order).
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
   * `jobs` are counting down, soonest first; `ready` are waiting for
   * "Resume Now" (their own countdowns already elapsed); `gaveUp` are
   * sessions this window has stopped retrying (Task 4b). Task 5b folds all
   * three into the one tooltip list built by `buildSessionLines`.
   */
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
        idle.appendMarkdown(`**Claude Limit Buster**\n\n`);
        idle.appendMarkdown(`Watching for usage limits. Nothing pending.\n\n`);
        idle.appendMarkdown(`_Click for actions._`);
        this.item.tooltip = idle;
        this.item.backgroundColor = undefined;
        this.item.show();
        return;
      }
      // Something to show even with nothing counting down: a gave-up
      // session, a ready one, or (per buildSessionLines) both on one line.
      // The gave-up icon wins when anything has given up - that is the more
      // urgent signal - even if other sessions are merely ready.
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
    this.item.text = `$(clock) Claude resumes in ${formatDuration(remaining)}${others}`;
    this.renderTooltip(lines, hasTrustLink, gaveUpCount > 0);

    // Nudge the colour as the deadline approaches so it reads at a glance.
    this.item.backgroundColor =
      remaining <= 60_000 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  /**
   * The shared tooltip body for every non-idle state: header, one bullet per
   * `buildSessionLines` line, a reminder of how to clear a gave-up notice
   * when one is present, and the click-for-actions footer. `isTrusted` is
   * set only when a line actually carries the trust command link (ruling 3)
   * - an unconditional `true` would trust every link a folder name could be
   * crafted to look like, not just this one command.
   */
  private renderTooltip(lines: readonly string[], hasTrustLink: boolean, hasGaveUp: boolean): void {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**Claude Limit Buster**\n\n`);
    for (const line of lines) {
      tooltip.appendMarkdown(`- ${line}\n`);
    }
    if (lines.length > 0) {
      tooltip.appendMarkdown(`\n`);
    }
    if (hasGaveUp) {
      tooltip.appendMarkdown(`A new limit for a session, or "Cancel Pending Resume", clears this.\n\n`);
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
