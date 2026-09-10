import assert from 'node:assert/strict';
import * as vscode from 'vscode';

/**
 * Integration tests: these run inside a real VS Code, against the real API.
 *
 * The unit suite covers the logic, but it does so against a hand-written fake
 * `vscode` that stubs only what it needs - so it cannot tell whether the
 * extension actually activates, whether the commands the manifest declares get
 * registered, or whether the settings it declares reach the configuration API
 * with the defaults it claims. A fake agreeing with itself proves none of that.
 * These do.
 *
 * Deliberately a handful. Booting VS Code costs seconds where the unit tests
 * cost milliseconds, so anything provable against the fake stays there.
 */

const ID = 'dream-mosaic.claude-limit-buster';
const NS = 'claudeLimitBuster';

suite('claude-limit-buster activation', () => {
  test('the extension is present and activates', async () => {
    const ext = vscode.extensions.getExtension(ID);
    assert.ok(ext, `${ID} is not installed in the test instance`);
    await ext.activate();
    assert.equal(ext.isActive, true, 'activate() resolved but the extension is not active');
  });

  test('every command the manifest declares is registered', async () => {
    await vscode.extensions.getExtension(ID)?.activate();
    const registered = await vscode.commands.getCommands(true);
    for (const id of [`${NS}.resumeNow`, `${NS}.cancel`, `${NS}.showLog`]) {
      assert.ok(registered.includes(id), `${id} is declared in package.json but not registered`);
    }
  });

  test('resuming with nothing pending opens no terminal', async () => {
    await vscode.extensions.getExtension(ID)?.activate();
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand(`${NS}.resumeNow`);
    assert.equal(
      vscode.window.terminals.length,
      before,
      'resumeNow launched a terminal with no pending job',
    );
  });

  test('cancelling with nothing pending is harmless', async () => {
    await vscode.extensions.getExtension(ID)?.activate();
    // Nothing to assert beyond "does not throw": the command has to survive
    // being invoked from the palette when no resume is scheduled, which is the
    // state a user is most likely to be in.
    await vscode.commands.executeCommand(`${NS}.cancel`);
  });

  test('the declared settings reach the configuration API with their declared defaults', () => {
    const config = vscode.workspace.getConfiguration(NS);
    // Values chosen to match package.json. A default that disagrees between the
    // manifest and src/config.ts is invisible to the unit suite, which injects
    // its own ConfigSource rather than reading VS Code's.
    assert.equal(config.get('enabled'), true);
    assert.equal(config.get('autoResume'), true);
    assert.equal(config.get('resumeMode'), 'interactive');
    assert.equal(config.get('headlessPermissionMode'), '');
    assert.equal(config.get('claudeCommand'), '');
    assert.equal(config.get('resumePrompt'), 'Continue where you left off.');
    assert.equal(config.get('maxResumeTokens'), 150000);
    assert.equal(config.get('maxWaitHours'), 24);
  });

  test('the execution-adjacent settings are machine-scoped in the running instance', () => {
    const config = vscode.workspace.getConfiguration(NS);
    // `inspect` exposes where a value may come from. A machine-scoped setting
    // has no workspace slot at all, which is the property that stops a repo you
    // merely opened from changing what gets executed. The unit suite asserts
    // the manifest says so; this asserts VS Code agrees.
    for (const key of ['resumeMode', 'headlessPermissionMode', 'claudeCommand', 'resumePrompt']) {
      const seen = config.inspect(key);
      assert.ok(seen, `${key} is not a known configuration key`);
      assert.equal(
        seen.workspaceValue,
        undefined,
        `${key} resolved a workspace value, so it is not machine-scoped`,
      );
    }
  });
});
