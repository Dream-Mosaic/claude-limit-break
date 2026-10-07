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
  claimOwner,
  holdClaim,
  claimHoldDeadline,
  CLAIM_MARGIN_MS,
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

test('claimKeyFor for an overload job with no entry timestamp falls back to bucketing the DETECTION instant (baseResumeAtMs), not the padded fire time', () => {
  // The key uses baseResumeAtMs (the moment planResume read `now` at detection), not
  // resumeAtMs: that carries each window's own jitter, so windows would land in
  // different buckets and both fire.
  const key = claimKeyFor({
    sessionId: 'abc-123',
    baseResumeAtMs: 6_000_000,
    resumeAtMs: 1_000_000, // a different bucket - must be ignored
    reason: 'overload',
  });
  assert.equal(key, `abc-123-overload-${Math.floor(6_000_000 / 600_000)}`);
});

test('claimKeyFor gives two overload jobs with the same detection instant the same key, however far apart their jitter rolled', () => {
  // Two windows detect the SAME overload (same baseResumeAtMs) but roll very different
  // backoffs; their resumeAtMs values land far apart, yet the key must still collide.
  const a = claimKeyFor({ sessionId: 's', baseResumeAtMs: 1_000_000, resumeAtMs: 1_300_000, reason: 'overload' });
  const b = claimKeyFor({ sessionId: 's', baseResumeAtMs: 1_000_000, resumeAtMs: 2_800_000, reason: 'overload' });
  assert.equal(a, b, 'the same detection instant must collide no matter how far apart the jitter rolls landed');
});

test('claimKeyFor gives two overload jobs a different key when their detection instants land in different buckets, even with identical resumeAtMs', () => {
  const a = claimKeyFor({ sessionId: 's', baseResumeAtMs: 0, resumeAtMs: 5_000_000, reason: 'overload' });
  const b = claimKeyFor({ sessionId: 's', baseResumeAtMs: 600_000, resumeAtMs: 5_000_000, reason: 'overload' });
  assert.notEqual(a, b, 'a genuinely different detection instant must not collide just because resumeAtMs matches');
});

// An overload claim keyed on a 10-minute bucket collided with this window's OWN
// earlier claim (a fresh 1h claim from a successful resume), dropping a genuine
// second overload in the same bucket. The detection entry's own timestamp is
// identical in every window and distinct per event.

test('claimKeyFor keys an overload job on its detection entry timestamp when it has one', () => {
  const key = claimKeyFor({
    sessionId: 'abc-123',
    baseResumeAtMs: 6_000_000,
    resumeAtMs: 7_000_000,
    reason: 'overload',
    entryTimestampMs: 5_999_123,
  });
  assert.equal(key, 'abc-123-overload-5999123');
});

test('two distinct overload events in the same 10 minutes get different keys, and both can be claimed', () => {
  const dir = tempDir();
  const first = { sessionId: 's', baseResumeAtMs: 6_000_000, resumeAtMs: 6_300_000, reason: 'overload' as const, entryTimestampMs: 6_000_000 };
  const second = { ...first, baseResumeAtMs: 6_120_000, entryTimestampMs: 6_120_000 };
  assert.equal(Math.floor(first.baseResumeAtMs / 600_000), Math.floor(second.baseResumeAtMs / 600_000), 'setup: same bucket');
  assert.notEqual(claimKeyFor(first), claimKeyFor(second));
  assert.equal(claimResume(dir, claimKeyFor(first), Date.now(), fs), 'claimed');
  assert.equal(claimResume(dir, claimKeyFor(second), Date.now(), fs), 'claimed', 'the second event must not collide with the first');
});

test('the same overload event seen by two windows collides, however their detection instants and jitter differ', () => {
  const dir = tempDir();
  const windowA = { sessionId: 's', baseResumeAtMs: 6_000_050, resumeAtMs: 6_300_000, reason: 'overload' as const, entryTimestampMs: 5_999_000 };
  const windowB = { ...windowA, baseResumeAtMs: 6_700_000, resumeAtMs: 8_100_000 };
  assert.equal(claimKeyFor(windowA), claimKeyFor(windowB));
  assert.equal(claimResume(dir, claimKeyFor(windowA), Date.now(), fs), 'claimed');
  assert.equal(claimResume(dir, claimKeyFor(windowB), Date.now(), fs), 'taken');
});

test('a limit key ignores the entry timestamp: it stays the un-jittered reset', () => {
  const key = claimKeyFor({ sessionId: 'abc', baseResumeAtMs: 1_000_000, resumeAtMs: 1_500_000, reason: 'limit', entryTimestampMs: 42 });
  assert.equal(key, 'abc-1000000');
});

// --- claim owner --------------------------------------------

test('claimResume records the window that took the claim, and claimOwner reads it back', () => {
  const dir = tempDir();
  assert.equal(claimResume(dir, 'k', Date.now(), fs, undefined, 'window-a1b2'), 'claimed');
  assert.equal(claimOwner(dir, 'k', fs), 'window-a1b2');
});

test('claimOwner is undefined for a missing claim or one written without an owner (an older build)', () => {
  const dir = tempDir();
  assert.equal(claimOwner(dir, 'missing', fs), undefined);
  fs.writeFileSync(path.join(dir, 'legacy.claim'), `${process.pid} ${Date.now()}`);
  assert.equal(claimOwner(dir, 'legacy', fs), undefined);
});

// --- holdClaim -------------------------------------------

test('holdClaim writes a claim that stays fresh until the held deadline, not just for STALE_MS from now', () => {
  // Cancel writes one for a job that may not fire for hours; another window
  // firing the same reset then must still find it fresh.
  const dir = tempDir();
  const now = Date.now();
  const until = now + 5 * HOUR_MS;
  assert.equal(holdClaim(dir, 'k', now, until, fs, undefined, 'window-A'), 'claimed');
  assert.equal(claimResume(dir, 'k', until + 30 * 60_000, fs), 'taken', 'still fresh half an hour after the deadline');
  assert.equal(claimOwner(dir, 'k', fs), 'window-A');
  assert.equal(claimResume(dir, 'k', until + 2 * HOUR_MS, fs), 'claimed', 'but it does age out like any claim');
});

test('holdClaim with a deadline already past is an ordinary claim', () => {
  const dir = tempDir();
  const now = Date.now();
  assert.equal(holdClaim(dir, 'k', now, now - HOUR_MS, fs), 'claimed');
  assert.equal(claimResume(dir, 'k', now + 30 * 60_000, fs), 'taken');
});

test('holdClaim leaves a claim another window holds alone', () => {
  const dir = tempDir();
  const now = Date.now();
  assert.equal(claimResume(dir, 'k', now, fs, undefined, 'window-B'), 'claimed');
  assert.equal(holdClaim(dir, 'k', now, now + 5 * HOUR_MS, fs, undefined, 'window-A'), 'taken');
  assert.equal(claimOwner(dir, 'k', fs), 'window-B');
  assert.equal(claimResume(dir, 'k', now + 2 * HOUR_MS, fs), 'claimed', 'nor is the other window\'s claim kept alive past its own life');
});

test('holdClaim fails soft when the deadline cannot be set: still claimed, and logged', () => {
  const dir = tempDir();
  const { log, lines } = logger();
  const brokenFs = {
    ...fs,
    utimesSync: () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    },
  };
  assert.equal(holdClaim(dir, 'k', Date.now(), Date.now() + HOUR_MS * 3, brokenFs, log), 'claimed');
  assert.ok(lines.length > 0);
});

// --- claimsDir ---------------------------------------------------------------

test('claimsDir is machine-wide: under the OS temp dir, not per-workspace', () => {
  const dir = claimsDir();
  assert.ok(dir.startsWith(os.tmpdir()));
  assert.match(dir, /claude-limit-break[\\/]claims$/);
});

// One deadline for every hold - the automatic fire, the counting Resume Now and Cancel -
// so none lapses before another window's copy, which fires anywhere up to the longest jitter.
test('a hold runs to the reset plus the longest configured jitter plus the margin', () => {
  const MIN = 60_000;
  const job = { baseResumeAtMs: 1_000_000_000, resumeAtMs: 1_000_000_000 + 7 * MIN };
  assert.equal(CLAIM_MARGIN_MS, 10 * MIN);
  assert.equal(claimHoldDeadline(job, 5, 30), job.baseResumeAtMs + 40 * MIN);
  assert.equal(claimHoldDeadline(job, 0, 90), job.baseResumeAtMs + 100 * MIN);
  assert.equal(claimHoldDeadline(job, 30, 10), job.baseResumeAtMs + 40 * MIN, 'an inverted band is read as the range it describes');
});

test('a hold never ends before the fire time of the job itself', () => {
  // A job planned under a wider jitter setting than the one now in force.
  const job = { baseResumeAtMs: 1_000_000_000, resumeAtMs: 1_000_000_000 + 120 * 60_000 };
  assert.equal(claimHoldDeadline(job, 0, 30), job.resumeAtMs);
});

// --- an unusable claims directory fails open ---

/** A directory path that can never be created: a child of a regular file. */
function impossibleDir(): string {
  const file = path.join(tempDir(), 'not-a-directory');
  fs.writeFileSync(file, 'x');
  return path.join(file, 'claims');
}

test('claimResume fails open when the claims directory cannot be created: claimed, logged, no throw', () => {
  const { log, lines } = logger();
  let result: string | undefined;
  assert.doesNotThrow(() => {
    result = claimResume(impossibleDir(), 'sess-1', Date.now(), fs, log);
  });
  assert.equal(result, 'claimed');
  assert.ok(lines.some((l) => /claims directory/i.test(l)), `the failure must be logged; saw ${JSON.stringify(lines)}`);
});

test('claimResume fails open when mkdirSync throws for any reason (a fake fs, as the other fail-open tests do)', () => {
  const { log, lines } = logger();
  const brokenFs: ClaimFs = {
    ...fs,
    mkdirSync: () => {
      throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    },
  };
  assert.equal(claimResume(tempDir(), 'sess-1', Date.now(), brokenFs, log), 'claimed');
  assert.ok(lines.length > 0);
});

test('holdClaim fails open the same way: claimed, no throw (Cancel and the automatic fire both use it)', () => {
  const { log } = logger();
  let result: string | undefined;
  assert.doesNotThrow(() => {
    result = holdClaim(impossibleDir(), 'k', Date.now(), Date.now() + 3 * HOUR_MS, fs, log, 'window-A');
  });
  assert.equal(result, 'claimed');
});
