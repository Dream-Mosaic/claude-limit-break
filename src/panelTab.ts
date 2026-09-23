/**
 * A `vscode.Tab` reduced to the two fields this extension can actually read
 * off it: the label VS Code shows and the webview's viewType. Kept as a
 * plain object, rather than passing `vscode.Tab` itself around, so the
 * selection logic below is unit-testable without a running VS Code - the
 * same reason `buildTerminalOptions` in resumer.ts works on plain objects
 * instead of the real terminal API.
 */
export interface WebviewTab {
  viewType: string;
  label: string;
}

/**
 * The substring Claude Code's panel view type carries. Not the whole string:
 * `test/integration/panelReopen.itest.ts` created a throwaway webview panel
 * and read back what `vscode.window.tabGroups` reported for it, which came
 * back as `mainThreadWebview-<the requested viewType>` - VS Code renders the
 * webview on its own process and prefixes the id it assigns there. `===`
 * would never match; `includes` does.
 */
const CLAUDE_PANEL_VIEW_TYPE = 'claudeVSCodePanel';

export function isClaudePanelTab(tab: WebviewTab): boolean {
  return tab.viewType.includes(CLAUDE_PANEL_VIEW_TYPE);
}

/**
 * Choose the one Claude panel tab to close and reopen.
 *
 * `TabInputWebview` carries no session identity - issue #7 confirmed Claude
 * Code itself only reconciles a tab to a session by `title === tab.label`,
 * which this extension cannot do any better at (and the title is not even
 * written to the transcript). So zero matches means nothing to reopen, and
 * more than one means this cannot tell which is the stale one without
 * guessing at someone's open tabs - both return undefined, and the caller
 * falls back to a text-only notice rather than acting on a guess.
 */
export function selectClaudePanelTab(tabs: readonly WebviewTab[]): WebviewTab | undefined {
  const matches = tabs.filter(isClaudePanelTab);
  return matches.length === 1 ? matches[0] : undefined;
}
