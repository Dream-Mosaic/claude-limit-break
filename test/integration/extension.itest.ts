import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

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

/**
 * The resume terminal clears inherited Claude session variables by setting
 * them to null in `TerminalOptions.env` (#9). The API types allow null there
 * but the docs do not say what it does, so this checks it against the real
 * terminal: a variable the window genuinely has is removed from the child when
 * nulled - not set to the string "null", and not left alone - while the rest
 * of the environment still comes through.
 */
suite('resume terminal environment', () => {
  test('a variable set to null in TerminalOptions.env is removed from the child process', async function () {
    this.timeout(30000);
    const node = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' })
      .split(/\r?\n/)[0]
      ?.trim();
    assert.ok(node, 'node must be on PATH for this probe');

    // Always present in a real environment, on each platform.
    const inherited = process.platform === 'win32' ? 'USERNAME' : 'HOME';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clb-env-'));
    const out = path.join(dir, 'env.json');
    const terminal = vscode.window.createTerminal({
      name: 'clb env probe',
      shellPath: node,
      shellArgs: ['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`],
      env: { [inherited]: null, CLB_PROBE_SET: 'present' },
      isTransient: true,
    });
    try {
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(out) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(fs.existsSync(out), 'the probe process never wrote its environment');
      // A partial write is possible on a slow machine; give it a moment.
      await new Promise((r) => setTimeout(r, 200));
      const env = JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, string>;

      // Recorded, not asserted: whether the window this test runs in carries a
      // parent Claude session's variables depends on how it was launched.
      console.log(`[clb env probe] window environment has CLAUDECODE: ${'CLAUDECODE' in env}`);

      assert.equal(env.CLB_PROBE_SET, 'present', 'a set variable must reach the child');
      const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path');
      assert.ok(pathKey, 'the rest of the environment must still be inherited');
      assert.ok(!(inherited in env), `${inherited} was nulled but reached the child as ${JSON.stringify(env[inherited])}`);
    } finally {
      terminal.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
