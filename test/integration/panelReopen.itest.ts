import assert from 'node:assert/strict';
import * as vscode from 'vscode';

/**
 * Probes for the two behaviours issue #7 could not settle by reading source -
 * both are VS Code's own behaviour, not Claude Code's, so a real Extension
 * Development Host can answer them where the unit suite's fake `vscode`
 * cannot. src/panelTab.ts and src/reopenOffer.ts cite the findings recorded
 * here; change this file's behaviour and those comments go stale with it.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await sleep(25);
  }
}

function findTab(viewType: string): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes(viewType));
}

suite('panel reopen - unverified behaviours from issue #7', () => {
  test('TabInputWebview.viewType as reported by a real tabGroups', async () => {
    const requested = 'claudeLimitBusterProbeViewType';
    const panel = vscode.window.createWebviewPanel(requested, 'CLB probe', vscode.ViewColumn.Active, {});
    try {
      await waitFor(() => findTab(requested) !== undefined);
      const tab = findTab(requested);
      assert.ok(tab, 'a created webview panel must show up in vscode.window.tabGroups');
      assert.ok(tab.input instanceof vscode.TabInputWebview, 'its input must be a TabInputWebview');
      const observed = (tab.input as vscode.TabInputWebview).viewType;

      // FINDING (VS Code 1.137.0, Extension Development Host): the runtime
      // value came back as "mainThreadWebview-claudeLimitBusterProbeViewType"
      // - prefixed with "mainThreadWebview-" ahead of exactly what was passed
      // to createWebviewPanel. That confirms the issue's premise: the match
      // against Claude Code's real viewType has to be `includes(...)`, not
      // `===`. See src/panelTab.ts.
      assert.ok(
        observed.includes(requested),
        `expected the observed viewType to contain what was requested; got ${observed}`,
      );
      assert.notEqual(observed, requested, 'if this ever fires, the prefix is gone and === can replace includes');
    } finally {
      panel.dispose();
    }
  });

  test('workbench.action.reopenClosedEditor against a registered WebviewPanelSerializer', async () => {
    const viewType = 'claudeLimitBusterProbeSerializer';
    let deserializeCalls = 0;
    let restoredPanel: vscode.WebviewPanel | undefined;
    const registration = vscode.window.registerWebviewPanelSerializer(viewType, {
      async deserializeWebviewPanel(webviewPanel) {
        deserializeCalls += 1;
        restoredPanel = webviewPanel;
        webviewPanel.webview.html = '<html><body>restored</body></html>';
      },
    });
    try {
      const panel = vscode.window.createWebviewPanel(
        viewType,
        'CLB probe serializer',
        vscode.ViewColumn.Active,
        { retainContextWhenHidden: true },
      );
      await waitFor(() => findTab(viewType) !== undefined);
      const tab = findTab(viewType);
      assert.ok(tab, 'the panel must be a tab before it can be closed');

      // Close through tabGroups.close, the exact call src/extension.ts makes -
      // not panel.dispose() - so this proves the real code path rather than a
      // stand-in for it.
      await vscode.window.tabGroups.close(tab!);
      await waitFor(() => findTab(viewType) === undefined);

      await vscode.commands.executeCommand('workbench.action.reopenClosedEditor');
      // The serializer would run asynchronously off the command; give it a
      // beat before concluding it never ran.
      await sleep(500);

      // FINDING (VS Code 1.137.0, Extension Development Host): the serializer
      // was never invoked and the tab did not come back, with or without a
      // second editor left open in the same group (checked both). Confirmed
      // reproducible, not a one-off timing miss.
      //
      // This is why src/reopenOffer.ts does not use this command at all: it
      // closes the user's real Claude Code tab, so calling a mechanism proven
      // not to restore it would trade a stale tab for a missing one. Locked
      // in here as a regression guard - if a future VS Code version starts
      // restoring webviews this way, this assertion is what will say so.
      assert.equal(deserializeCalls, 0, 'reopenClosedEditor is not expected to invoke the serializer');
      assert.equal(findTab(viewType), undefined, 'the tab is not expected to come back this way');
    } finally {
      registration.dispose();
      restoredPanel?.dispose();
    }
  });
});
