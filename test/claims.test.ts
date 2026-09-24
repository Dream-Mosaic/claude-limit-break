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
  const { log, lines } = logger();
  releaseClaim(dir, 'never-claimed', fs, log);
  assert.equal(lines.length, 0, 'a missing claim is expected, not a failure worth logging');
});

test('releaseClaim logs when the underlying error is something other than "missing"', () => {
  const dir = tempDir();
  const { log, lines } = logger();
  const brokenFs: ClaimFs = {
    ...fs,
    unlinkSync: () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    },
  };
  assert.doesNotThrow(() => releaseClaim(dir, 'sess-1', brokenFs, log));
  assert.ok(lines.length > 0, 'an unexpected release failure must be logged');
});

test('claimResume retries a stale claim exactly once, then fails open rather than looping', () => {
  // A pathological fs that reports EEXIST + a stale mtime forever, so every
  // attempt wants to retry. This must still terminate after one retry.
  const dir = tempDir();
  let opens = 0;
  const pathologicalFs: ClaimFs = {
    ...fs,
    openSync: () => {
      opens += 1;
      throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    },
    statSync: () => ({ mtimeMs: 0 }),
    unlinkSync: () => {},
  };
  assert.equal(claimResume(dir, 'sess-1', Date.now(), pathologicalFs), 'claimed');
  assert.equal(opens, 2, 'exactly one retry: two open attempts total, never more');
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

test('claimKeyFor for an overload job buckets the DETECTION instant (baseResumeAtMs), not the padded fire time', () => {
  // Fix round 1: this used to bucket resumeAtMs. resumeAtMs is padded with
  // each window's own independently-rolled jitter, so two windows detecting
  // the identical overload landed in different buckets and both fired.
  // baseResumeAtMs - the moment planResume read `now` at detection - is
  // near-identical across windows, which is what this key must use.
  const key = claimKeyFor({
    sessionId: 'abc-123',
    baseResumeAtMs: 6_000_000,
    resumeAtMs: 1_000_000, // a different bucket under the old (buggy) logic - must be ignored
    reason: 'overload',
  });
  assert.equal(key, `abc-123-overload-${Math.floor(6_000_000 / 600_000)}`);
});

test('claimKeyFor gives two overload jobs with the same detection instant the same key, however far apart their jitter rolled', () => {
  // The core regression this fix closes: two windows detect the SAME
  // overload (same baseResumeAtMs) but roll very different backoffs
  // (randomDelayMinMinutes..randomDelayMaxMinutes, e.g. 5m vs 30m) - their
  // OWN resumeAtMs values land far apart, but the key must still collide.
  const a = claimKeyFor({ sessionId: 's', baseResumeAtMs: 1_000_000, resumeAtMs: 1_300_000, reason: 'overload' });
  const b = claimKeyFor({ sessionId: 's', baseResumeAtMs: 1_000_000, resumeAtMs: 2_800_000, reason: 'overload' });
  assert.equal(a, b, 'the same detection instant must collide no matter how far apart the jitter rolls landed');
});

test('claimKeyFor gives two overload jobs a different key when their detection instants land in different buckets, even with identical resumeAtMs', () => {
  const a = claimKeyFor({ sessionId: 's', baseResumeAtMs: 0, resumeAtMs: 5_000_000, reason: 'overload' });
  const b = claimKeyFor({ sessionId: 's', baseResumeAtMs: 600_000, resumeAtMs: 5_000_000, reason: 'overload' });
  assert.notEqual(a, b, 'a genuinely different detection instant must not collide just because resumeAtMs matches');
});

// --- claimsDir ---------------------------------------------------------------

test('claimsDir is machine-wide: under the OS temp dir, not per-workspace', () => {
  const dir = claimsDir();
  assert.ok(dir.startsWith(os.tmpdir()));
  assert.match(dir, /claude-limit-break[\\/]claims$/);
});
