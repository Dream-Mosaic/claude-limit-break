/**
 * Installing Limit Break's Claude Code mod (the plugin in `mod/`).
 *
 * The extension folder is versioned (`publisher.name-1.1.0`), so Claude Code
 * cannot be pointed at it for good. Instead the mod is copied out into
 * `globalStorage/marketplace/mod`, a stable folder that is a one-plugin
 * marketplace Claude Code reads in place. After an extension update the copy is
 * refreshed and `claude plugin update` picks it up.
 *
 * Everything here is pure or takes its IO as an argument. `runSteps` takes the
 * `claude` runner, so tests never run the CLI.
 */
import * as path from 'node:path';

export const MOD_ID = 'limit-break@limit-break';
export const MARKETPLACE = 'limit-break';
/** globalState key: 'never' once the user has refused the offer for good. */
export const OFFER_KEY = 'claudeLimitBreak.modOffer';
/** globalState key: the extension version whose copy of the mod was last installed. */
export const INSTALLED_VERSION_KEY = 'claudeLimitBreak.modVersion';

/** The one-plugin marketplace Claude Code reads; the mod sits in `./mod` beside it. */
export function marketplaceJson(): string {
  return JSON.stringify(
    { name: MARKETPLACE, owner: { name: 'Dream Mosaic' }, plugins: [{ name: 'limit-break', source: './mod' }] },
    null,
    2,
  );
}

/** Whether `claude plugin list --json` output holds the mod; undefined when the output is not a plugin list at all (can't tell, like a failed listing). */
export function isModInstalled(listJson: string): boolean | undefined {
  try {
    const list: unknown = JSON.parse(listJson);
    if (!Array.isArray(list)) {
      return undefined;
    }
    return list.some((e) => typeof e === 'object' && e !== null && (e as { id?: unknown }).id === MOD_ID);
  } catch {
    return undefined;
  }
}

/** `claude plugin list --json` through `run`; the extension calls it through this module so tests can stub it. */
export function listInstalledPlugins(run: (args: string[]) => Promise<string>): Promise<string> {
  return run(['plugin', 'list', '--json']);
}

/** The `claude` invocations that register the marketplace and install the mod for the user. */
export function installSteps(marketplaceDir: string): string[][] {
  return [
    ['plugin', 'marketplace', 'add', marketplaceDir],
    ['plugin', 'install', MOD_ID, '--scope', 'user'],
  ];
}

/** Refresh the marketplace, then the installed mod, after the copy was replaced. */
export function updateSteps(): string[][] {
  return [
    ['plugin', 'marketplace', 'update', MARKETPLACE],
    ['plugin', 'update', MOD_ID],
  ];
}

export function removeSteps(): string[][] {
  return [
    ['plugin', 'uninstall', MOD_ID, '--scope', 'user'],
    ['plugin', 'marketplace', 'remove', MARKETPLACE],
  ];
}

/** The slice of `node:fs` copyMod uses. */
export interface CopyFs {
  mkdirSync(p: string, o: { recursive: true }): unknown;
  readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  copyFileSync(from: string, to: string): void;
  rmSync(p: string, o: { recursive: true; force: true }): void;
  existsSync(p: string): boolean;
}

/**
 * Replace `destDir` with a copy of the mod in `srcDir`, leaving out `*.test.ts`
 * (the VSIX does not ship them either). Replaced rather than merged, so a file
 * dropped from the mod does not linger. Throws before deleting anything when
 * the source is missing.
 */
export function copyMod(srcDir: string, destDir: string, fs: CopyFs): void {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`the mod folder ${srcDir} is missing`);
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  const walk = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(from, entry.name), path.join(to, entry.name));
      } else if (!entry.name.endsWith('.test.ts')) {
        fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
      }
    }
  };
  walk(srcDir, destDir);
}

/**
 * Offer the install only when it can help (Limit Break on, continuing in place
 * on), the mod is not already there, and the user has not said "Never".
 */
export function shouldOfferInstall(i: {
  enabled: boolean;
  continueInPlace: boolean;
  installed: boolean;
  offer: string | undefined;
}): boolean {
  return i.enabled && i.continueInPlace && !i.installed && i.offer !== 'never';
}

/** Run `claude` steps in order through `run`; stops at the first failure and names it. */
export async function runSteps(
  steps: string[][],
  run: (args: string[]) => Promise<string>,
): Promise<{ ok: true } | { ok: false; step: string[]; error: string }> {
  for (const step of steps) {
    try {
      await run(step);
    } catch (e) {
      return { ok: false, step, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true };
}

/** What install, update and remove need from their surroundings; extension.ts supplies the real ones. */
export interface ModDeps {
  run: (args: string[]) => Promise<string>;
  /** Put a fresh copy of the mod and the marketplace file in the marketplace folder. */
  copy: () => void;
  marketplaceDir: string;
  /** The running extension's version. */
  version: string;
  /** The version whose copy was last installed (INSTALLED_VERSION_KEY). */
  storedVersion: () => string | undefined;
  storeVersion: (v: string | undefined) => Promise<void>;
  notify: (message: string, level: 'info' | 'warn') => void;
  log: (message: string) => void;
  /** Delete the mod's status files (`~/.limit-break/sessions/*.json`), errors ignored. */
  clearStatusFiles: () => void;
}

const stepText = (step: string[]) => `claude ${step.join(' ')}`;

/** Copy the mod out and install it; stores the version and reports either way. */
export async function installMod(d: ModDeps): Promise<void> {
  let result: Awaited<ReturnType<typeof runSteps>>;
  try {
    d.copy();
    result = await runSteps(installSteps(d.marketplaceDir), d.run);
  } catch (e) {
    result = { ok: false, step: ['(copy the mod)'], error: e instanceof Error ? e.message : String(e) };
  }
  if (result.ok) {
    await d.storeVersion(d.version);
    d.log('Installed the Claude Code mod.');
    d.notify(
      'Limit Break: the Claude Code mod is installed. Sessions started from now on load it; an open session loads it after /reload-plugins.',
      'info',
    );
    return;
  }
  d.log(`Could not install the Claude Code mod (${stepText(result.step)}): ${result.error}`);
  d.notify(
    `Limit Break: couldn't install the Claude Code mod (\`${stepText(result.step)}\`: ${result.error}). Limit Break still works through each session's inbox.`,
    'warn',
  );
}

/** After an extension update: re-copy and update an installed mod whose stored version differs. Log only. */
export async function updateMod(d: ModDeps): Promise<void> {
  d.copy();
  const result = await runSteps(updateSteps(), d.run);
  if (result.ok) {
    await d.storeVersion(d.version);
    d.log(`Updated the Claude Code mod to ${d.version}.`);
  } else {
    d.log(`Could not update the Claude Code mod (${stepText(result.step)}): ${result.error}`);
  }
}

/**
 * Remove the mod. Uninstalls only when it is installed, but always tries to
 * remove the marketplace, so a half-finished install does not leave one
 * registered. The stored version and the mod's status files are cleared once the
 * plugin is gone.
 */
export async function removeMod(d: ModDeps): Promise<void> {
  let installed: boolean;
  try {
    installed = isModInstalled(await listInstalledPlugins(d.run)) ?? true; // unparseable: cannot tell either
  } catch {
    installed = true; // cannot tell; let uninstall find out
  }
  const [uninstall, removeMarketplace] = removeSteps() as [string[], string[]];
  const failures: { step: string[]; error: string }[] = [];
  let pluginGone = true;
  if (installed) {
    const r = await runSteps([uninstall], d.run);
    if (!r.ok) {
      pluginGone = false;
      failures.push(r);
    }
  }
  const m = await runSteps([removeMarketplace], d.run);
  if (!m.ok) {
    failures.push(m);
  }
  if (pluginGone) {
    await d.storeVersion(undefined);
    // A stale status file would make the extension send a control message to a session that no longer has the mod.
    d.clearStatusFiles();
  }
  const first = failures[0];
  if (!first) {
    d.log('Removed the Claude Code mod.');
    d.notify('Limit Break: the Claude Code mod is removed.', 'info');
    return;
  }
  d.log(`Could not fully remove the Claude Code mod (${stepText(first.step)}): ${first.error}`);
  d.notify(
    `Limit Break: couldn't remove the Claude Code mod (\`${stepText(first.step)}\`: ${first.error}). Limit Break still works through each session's inbox.`,
    'warn',
  );
}
