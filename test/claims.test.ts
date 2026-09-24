import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../src/log';
import {
  claimResume,
  releaseClaim,
  cleanupStaleClaims,
  claimKeyFor,
  claimsDir,
  type ClaimFs,
} from '../src/claims';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A fresh real directory per test, so tests never touch the real machine-wide claims dir. */
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clb-claims-'));
}

function logger() {
  const lines: string[] = [];
  return { log: createLogger('t', (l) => lines.push(l)), lines };
}

// --- claimResume -------------------------------------------------------------

test('claiming a free key succeeds and writes the pid and time', () => {
  const dir = tempDir();
  const now = Date.now();
  assert.equal(claimResume(dir, 'sess-1', now, fs), 'claimed');
  const body = fs.readFileSync(path.join(dir, 'sess-1.claim'), 'utf8');
  assert.match(body, new RegExp(`^${process.pid} ${now}`));
});

test('two claimers on one key: exactly one gets claimed', () => {
  // The whole point of this module: two VS Code windows racing to claim the
  // same reset must not both win.
  const dir = tempDir();
  const now = Date.now();
  const first = claimResume(dir, 'sess-1', now, fs);
  const second = claimResume(dir, 'sess-1', now, fs);
  assert.deepEqual([first, second].sort(), ['claimed', 'taken']);
});

test('a claim older than 1h is stale: it is unlinked and retried, succeeding', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sess-1.claim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '999 0');
  const oldMtime = new Date(Date.now() - HOUR_MS - 1000);
  fs.utimesSync(file, oldMtime, oldMtime);
  const now = Date.now();
  assert.equal(claimResume(dir, 'sess-1', now, fs), 'claimed');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, new RegExp(`^${process.pid} ${now}`), 'the stale claim was replaced with a fresh one');
});

test('a claim under 1h old is honoured, not treated as stale', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sess-1.claim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '999 0');
  const recentMtime = new Date(Date.now() - HOUR_MS + 60_000);
  fs.utimesSync(file, recentMtime, recentMtime);
  assert.equal(claimResume(dir, 'sess-1', Date.now(), fs), 'taken');
});

test('an unexpected filesystem error fails open: claimed, and logged', () => {
  const dir = tempDir();
  const { log, lines } = logger();
  const brokenFs: ClaimFs = {
    ...fs,
    openSync: () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    },
  };
  assert.equal(claimResume(dir, 'sess-1', Date.now(), brokenFs, log), 'claimed');
  assert.ok(lines.length > 0, 'the fail-open path must log something');
});

test('claimResume creates the claims directory when it does not exist yet', () => {
  const dir = path.join(tempDir(), 'nested', 'claims');
  assert.equal(claimResume(dir, 'sess-1', Date.now(), fs), 'claimed');
  assert.ok(fs.existsSync(path.join(dir, 'sess-1.claim')));
});

// --- releaseClaim --------------------------------------------------------

test('releaseClaim removes an existing claim, freeing the key', () => {
  const dir = tempDir();
  const now = Date.now();
  assert.equal(claimResume(dir, 'sess-1', now, fs), 'claimed');
  releaseClaim(dir, 'sess-1', fs);
  assert.equal(claimResume(dir, 'sess-1', now, fs), 'claimed', 'released claim must be claimable again');
});

test('releaseClaim on a claim that does not exist is a silent no-op', () => {
  const dir = tempDir();
  assert.doesNotThrow(() => releaseClaim(dir, 'never-claimed', fs));
});

// --- cleanupStaleClaims ----------------------------------------------------

test('cleanupStaleClaims removes claim files older than 24h and keeps newer ones', () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'old.claim');
  const fresh = path.join(dir, 'fresh.claim');
  fs.writeFileSync(old, '1 0');
  fs.writeFileSync(fresh, '2 0');
  const oldMtime = new Date(Date.now() - DAY_MS - 60_000);
  fs.utimesSync(old, oldMtime, oldMtime);
  cleanupStaleClaims(dir, Date.now(), fs);
  assert.equal(fs.existsSync(old), false, 'a claim older than 24h must be removed');
  assert.equal(fs.existsSync(fresh), true, 'a claim under 24h must be kept');
});

test('cleanupStaleClaims on a directory that does not exist yet does nothing and does not throw', () => {
  const dir = path.join(tempDir(), 'never-created');
  assert.doesNotThrow(() => cleanupStaleClaims(dir, Date.now(), fs));
});

test('cleanupStaleClaims ignores files that are not claim files', () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  const other = path.join(dir, 'not-a-claim.txt');
  fs.writeFileSync(other, 'x');
  const oldMtime = new Date(Date.now() - DAY_MS - 60_000);
  fs.utimesSync(other, oldMtime, oldMtime);
  cleanupStaleClaims(dir, Date.now(), fs);
  assert.equal(fs.existsSync(other), true, 'a non-.claim file must be left alone');
});

// --- claimKeyFor -----------------------------------------------------------

test('claimKeyFor for a limit job is sessionId-baseResumeAtMs, the un-jittered reset', () => {
  const key = claimKeyFor({
    sessionId: 'abc-123',
    baseResumeAtMs: 1_000_000,
    resumeAtMs: 1_500_000,
    reason: 'limit',
  });
  assert.equal(key, 'abc-123-1000000');
});

test('claimKeyFor for an overload job buckets the fire time into 10-minute windows', () => {
  const key = claimKeyFor({
    sessionId: 'abc-123',
    baseResumeAtMs: 1_000_000,
    resumeAtMs: 6_000_000,
    reason: 'overload',
  });
  assert.equal(key, `abc-123-overload-${Math.floor(6_000_000 / 600_000)}`);
});

test('claimKeyFor gives two overload jobs in the same 10-minute bucket the same key', () => {
  const a = claimKeyFor({ sessionId: 's', baseResumeAtMs: 0, resumeAtMs: 600_100, reason: 'overload' });
  const b = claimKeyFor({ sessionId: 's', baseResumeAtMs: 0, resumeAtMs: 609_999, reason: 'overload' });
  assert.equal(a, b);
});

// --- claimsDir ---------------------------------------------------------------

test('claimsDir is machine-wide: under the OS temp dir, not per-workspace', () => {
  const dir = claimsDir();
  assert.ok(dir.startsWith(os.tmpdir()));
  assert.match(dir, /claude-limit-break[\\/]claims$/);
});
