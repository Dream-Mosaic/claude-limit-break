import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LATE_FIRE_MS, lateByMinutes } from '../src/lateFire';

test('a fire up to ten minutes late is on time', () => {
  assert.equal(LATE_FIRE_MS, 600_000);
  assert.equal(lateByMinutes(1_000_000, 1_000_000), undefined);
  assert.equal(lateByMinutes(1_000_000, 1_000_000 + 9 * 60_000), undefined);
  assert.equal(lateByMinutes(1_000_000, 1_000_000 + LATE_FIRE_MS), undefined, 'exactly ten minutes is still on time');
});

test('a fire more than ten minutes late reports whole minutes', () => {
  assert.equal(lateByMinutes(0, LATE_FIRE_MS + 1), 10);
  assert.equal(lateByMinutes(0, 11 * 60_000 + 59_000), 11);
  assert.equal(lateByMinutes(0, 26 * 3_600_000), 1560);
});
