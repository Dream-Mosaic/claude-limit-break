/**
 * Plays a short alert sound.
 *
 * VS Code has no API for playing arbitrary audio, so this shells out to
 * whatever the platform already ships with. Every branch is fire-and-forget:
 * a missing player is a reason to try the next one, never a reason to break
 * the thing that wanted to make a noise.
 */
import { spawn } from 'node:child_process';

/** Give up on a player that never exits, so it cannot pile up processes. */
const PLAY_TIMEOUT_MS = 10_000;

/** Escape a path for embedding in a single-quoted PowerShell string. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const LINUX_PLAYERS: { file: string; args: (path: string) => string[] }[] = [
  { file: 'paplay', args: (p) => [p] },
  { file: 'aplay', args: (p) => ['-q', p] },
  { file: 'canberra-gtk-play', args: (p) => ['-f', p] },
];

export function buildSoundCommand(
  platform: NodeJS.Platform,
  file?: string,
): { file: string; args: string[] } | undefined {
  switch (platform) {
    case 'win32': {
      const target = file
        ? psQuote(file)
        : `(Join-Path $env:WINDIR 'Media\\Windows Notify System Generic.wav')`;
      const script =
        `$p = ${target}; ` +
        `if (Test-Path -LiteralPath $p) { (New-Object Media.SoundPlayer $p).PlaySync() } ` +
        `else { [console]::beep(880, 250) }`;
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      };
    }
    case 'darwin':
      return { file: 'afplay', args: [file ?? '/System/Library/Sounds/Ping.aiff'] };
    default: {
      // No single player is guaranteed on Linux. Each is spawned directly with
      // its own argument shape; playAlertSound tries the next when one is missing.
      const path = file ?? '/usr/share/sounds/freedesktop/stereo/message.oga';
      const first = LINUX_PLAYERS[0]!;
      return { file: first.file, args: first.args(path) };
    }
  }
}

/** Make a noise. Returns immediately; the sound plays in a detached process. */
export function playAlertSound(options: { file?: string } = {}): void {
  const file = options.file?.trim() || undefined;
  const cmd = buildSoundCommand(process.platform, file);
  if (!cmd) {
    return;
  }
  if (process.platform !== 'linux') {
    tryEach([cmd]);
    return;
  }
  const path = file ?? '/usr/share/sounds/freedesktop/stereo/message.oga';
  tryEach(LINUX_PLAYERS.map((p) => ({ file: p.file, args: p.args(path) })));
}

function tryEach(candidates: { file: string; args: string[] }[]): void {
  const next = candidates[0];
  if (!next) {
    process.stderr.write('\x07'); // terminal bell, last resort
    return;
  }
  try {
    const child = spawn(next.file, next.args, { stdio: 'ignore', detached: true, windowsHide: true });
    const killer = setTimeout(() => child.kill(), PLAY_TIMEOUT_MS);
    killer.unref();
    child.on('error', () => tryEach(candidates.slice(1)));
    child.unref();
  } catch {
    tryEach(candidates.slice(1));
  }
}
