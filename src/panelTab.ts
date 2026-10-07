/**
 * A `vscode.Tab` reduced to the two fields this extension can read: the label VS Code shows and the webview's viewType. A plain object so the selection logic is unit-testable without VS Code.
 */
export interface WebviewTab {
  viewType: string;
  label: string;
}

/**
 * The substring Claude Code's panel view type carries, not the whole string: VS Code reports a webview tab as `mainThreadWebview-<the requested viewType>`, so `===` would never match.
 */
const CLAUDE_PANEL_VIEW_TYPE = 'claudeVSCodePanel';

export function isClaudePanelTab(tab: WebviewTab): boolean {
  return tab.viewType.includes(CLAUDE_PANEL_VIEW_TYPE);
}

/**
 * Choose the one Claude panel tab to close and reopen.
 *
 * `TabInputWebview` carries no session identity; Claude Code itself reconciles a tab to a session only by `title === tab.label`. So zero matches means nothing to reopen, and more than one cannot be told apart without guessing; both return undefined and the caller falls back to a text-only notice.
 */
export function selectClaudePanelTab(tabs: readonly WebviewTab[]): WebviewTab | undefined {
  const matches = tabs.filter(isClaudePanelTab);
  return matches.length === 1 ? matches[0] : undefined;
}
