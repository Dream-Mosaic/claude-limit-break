/**
 * `workbench.action.reopenClosedEditor` is the stable, documented candidate
 * for bringing a closed tab back - but `test/integration/panelReopen.itest.ts`
 * registered a `WebviewPanelSerializer`, opened a panel, closed it through
 * `vscode.window.tabGroups.close`, and ran the command: the serializer was
 * never invoked and the tab did not return (VS Code 1.137.0, Extension
 * Development Host). So it is not used here. Closing a user's real Claude
 * Code tab on the strength of a mechanism just proven not to restore it
 * would trade a stale tab for a missing one, which is worse than doing
 * nothing.
 *
 * `claude-vscode.reopenClosedSession` is Claude Code's own equivalent
 * (see issue #7 - they maintain a `claude-vscode.lastClosedWasSession`
 * context key for exactly this close-then-reopen flow), so it is the one
 * candidate here. It is a private command from another extension, checked
 * for existence at runtime because that extension may not be installed.
 */
const REOPEN_COMMAND = 'claude-vscode.reopenClosedSession';

export function chooseReopenCommand(availableCommands: readonly string[]): string | undefined {
  return availableCommands.includes(REOPEN_COMMAND) ? REOPEN_COMMAND : undefined;
}

export interface ReopenOffer {
  message: string;
  /** Present only when the user is the one who decides. */
  button?: string;
  /** Whether the caller should reopen the tab without being asked. */
  reopen: boolean;
}

export type StaleAction = 'notify' | 'reopen';

const BUTTON_LABEL = 'Reopen session tab';

/**
 * Decide what, if anything, to do when a resumed session's turn ends.
 *
 * `hasLivePanel` comes from liveSessions.ts - `claude agents --json` for
 * liveness, the per-pid record for the entrypoint - and answers whether a
 * panel tab is holding this session open somewhere. No live panel means
 * nobody has a stale tab, so there is nothing to say: the end-of-turn chime
 * already covers "your turn".
 *
 * `canReopen` is the narrower question of whether this extension can act:
 * exactly one Claude tab in this window (selectClaudePanelTab) and a command
 * that can bring it back (chooseReopenCommand). It is false for a tab in
 * another window, which the tab API cannot reach - then all that is available
 * is the warning, which is also the case that matters most, because that tab
 * is the one the user is most likely to type into without thinking.
 *
 * The wording is deliberate. The experiment in
 * docs/research/2026-09-20-panel-fork-experiment.md found that typing into the
 * stale tab anchors the message before the resumed turn and abandons it, in
 * silence, on both sides. "Your tab is out of date" invites exactly that
 * keystroke, so the message names what it costs instead.
 */
export function buildReopenOffer(
  sessionId: string,
  hasLivePanel: boolean,
  canReopen: boolean,
  action: StaleAction,
): ReopenOffer | undefined {
  if (!hasLivePanel) {
    return undefined;
  }
  const short = sessionId.slice(0, 8);
  if (action === 'reopen' && canReopen) {
    return {
      message:
        `Claude Limit Buster: session ${short} was resumed, and its panel tab has been ` +
        `reopened so it shows the new turn.`,
      reopen: true,
    };
  }
  const warning =
    `Claude Limit Buster: session ${short} was resumed in a terminal, but its panel tab is ` +
    `still on the conversation as it was before. Reopen that tab before you type in it, or ` +
    `your message will start a branch that drops the resumed turn.`;
  return canReopen ? { message: warning, button: BUTTON_LABEL, reopen: false } : { message: warning, reopen: false };
}
