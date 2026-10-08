import assert from 'node:assert/strict';
import * as vscode from 'vscode';

/**
 * Probes for VS Code's own panel-reopen behaviour, which the unit suite's fake
 * `vscode` cannot answer. src/panelTab.ts and src/reopenOffer.ts cite the
 * findings here; keep them in step.
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

suite('panel reopen - unverified behaviours', () => {
  test('TabInputWebview.viewType as reported by a real tabGroups', async () => {
    const requested = 'claudeLimitBreakProbeViewType';
    const panel = vscode.window.createWebviewPanel(requested, 'CLB probe', vscode.ViewColumn.Active, {});
    try {
      await waitFor(() => findTab(requested) !== undefined);
      const tab = findTab(requested);
      assert.ok(tab, 'a created webview panel must show up in vscode.window.tabGroups');
      assert.ok(tab.input instanceof vscode.TabInputWebview, 'its input must be a TabInputWebview');
      const observed = (tab.input as vscode.TabInputWebview).viewType;

      // FINDING: the runtime viewType is "mainThreadWebview-" plus what was
      // passed to createWebviewPanel, so the match against Claude Code's
      // viewType must use `includes(...)`, not `===`. See src/panelTab.ts.
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
    const viewType = 'claudeLimitBreakProbeSerializer';
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

      // Close through tabGroups.close, the call src/extension.ts makes, not
      // panel.dispose().
      await vscode.window.tabGroups.close(tab!);
      await waitFor(() => findTab(viewType) === undefined);

      await vscode.commands.executeCommand('workbench.action.reopenClosedEditor');
      // The serializer would run asynchronously off the command; give it a
      // beat before concluding it never ran.
      await sleep(500);

      // FINDING: the serializer is never invoked and the tab does not come
      // back, with or without a second editor open in the group. This is why
      // src/reopenOffer.ts avoids this command: it closes the user's real
      // Claude Code tab. Kept as a regression guard in case a future VS Code
      // restores webviews this way.
      assert.equal(deserializeCalls, 0, 'reopenClosedEditor is not expected to invoke the serializer');
      assert.equal(findTab(viewType), undefined, 'the tab is not expected to come back this way');
    } finally {
      registration.dispose();
      restoredPanel?.dispose();
    }
  });
});
