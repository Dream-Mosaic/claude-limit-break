import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OVERLOAD_RESUMES, OVERLOAD_BACKOFF_MINUTES, OverloadStreaks, overloadBackoffMs } from '../src/overloadBackoff';

const A = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const B = '7f2a9c41-8b3d-4e5f-9a01-6c7d8e9f0a1b';
const MIN = 60_000;

// Final fix wave A, A6: the user's decision - resume 1 keeps the usual
// random delay, resumes 2-5 add +15/+30/+60/+120 minutes, a 6th gives up.

test('the backoff for consecutive overload resumes 1 to 5 is 0, 15, 30, 60 and 120 minutes', () => {
  assert.deepEqual(OVERLOAD_BACKOFF_MINUTES, [0, 15, 30, 60, 120]);
  assert.deepEqual([0, 1, 2, 3, 4].map(overloadBackoffMs), [0, 15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN]);
});

test('after five, there is no sixth: the session gives up', () => {
  assert.equal(MAX_OVERLOAD_RESUMES, 5);
  assert.equal(overloadBackoffMs(5), undefined);
  assert.equal(overloadBackoffMs(9), undefined);
});

test('the streak counts per session, and a finished turn resets only that session', () => {
  const s = new OverloadStreaks();
  assert.equal(s.count(A), 0);
  s.planned(A);
  s.planned(A);
  s.planned(B);
  assert.equal(s.count(A), 2);
  assert.equal(s.count(B), 1);
  assert.equal(s.turnEnded(A), true);
  assert.equal(s.count(A), 0);
  assert.equal(s.count(B), 1, 'another session is left alone');
  assert.equal(s.turnEnded(A), false, 'nothing left to reset');
});
