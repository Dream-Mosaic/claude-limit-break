/**
 * `workbench.action.reopenClosedEditor` is not used: it did not restore a closed webview tab (the serializer was never invoked), and closing a user's real Claude Code tab with no way to bring it back would trade a stale tab for a missing one.
 *
 * `claude-vscode.reopenClosedSession` is Claude Code's own equivalent and the one candidate. It is a private command from another extension, checked for existence at runtime because that extension may not be installed.
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
 * `hasLivePanel` (liveSessions.ts) says whether a panel tab is holding this session open somewhere. No live panel means no stale tab, so there is nothing to say: the end-of-turn chime covers "your turn".
 *
 * `canReopen` is whether this extension can act: exactly one Claude tab in this window (selectClaudePanelTab) and a command that can bring it back (chooseReopenCommand). It is false for a tab in another window, which the tab API cannot reach; then only the warning is available.
 *
 * The wording is deliberate: typing into the stale tab anchors the message before the resumed turn and abandons it, silently. "Your tab is out of date" invites that keystroke, so the message names what it costs instead.
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
        `Limit Break: session ${short} was resumed, and its panel tab has been ` +
        `reopened so it shows the new turn.`,
      reopen: true,
    };
  }
  const warning =
    `Limit Break: session ${short} was resumed in a terminal, but its panel tab is ` +
    `still on the conversation as it was before. Reopen that tab before you type in it, or ` +
    `your message will start a branch that drops the resumed turn.`;
  return canReopen ? { message: warning, button: BUTTON_LABEL, reopen: false } : { message: warning, reopen: false };
}
