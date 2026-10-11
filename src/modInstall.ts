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

/** Whether `claude plugin list --json` output holds the mod. Unparseable output reads as not installed. */
export function isModInstalled(listJson: string): boolean {
  try {
    const list: unknown = JSON.parse(listJson);
    return Array.isArray(list) && list.some((e) => typeof e === 'object' && e !== null && (e as { id?: unknown }).id === MOD_ID);
  } catch {
    return false;
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
}

/**
 * Replace `destDir` with a copy of the mod in `srcDir`, leaving out `*.test.ts`
 * (the VSIX does not ship them either). Replaced rather than merged, so a file
 * dropped from the mod does not linger.
 */
export function copyMod(srcDir: string, destDir: string, fs: CopyFs): void {
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
