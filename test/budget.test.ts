import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BYTES_PER_TOKEN,
  estimateResumeTokens,
  checkBudget,
  IncidentBudget,
} from '../src/budget';

test('the estimate matches the measured calibration point', () => {
  // Spike: a cold resume of a 1,618,394-byte transcript cost 288,574
  // cache-creation tokens. Hold the estimator to within 5% of that.
  const measured = 288_574;
  const estimate = estimateResumeTokens(1_618_394);
  const drift = Math.abs(estimate - measured) / measured;
  assert.ok(drift < 0.05, `estimate ${estimate} drifted ${(drift * 100).toFixed(1)}% from ${measured}`);
});

test('the divisor is the documented one', () => {
  assert.equal(BYTES_PER_TOKEN, 5.6);
  assert.equal(estimateResumeTokens(5600), 1000);
});

test('zero bytes estimates zero', () => {
  assert.equal(estimateResumeTokens(0), 0);
});

test('allows a resume under the cap', () => {
  const v = checkBudget(500_000, 150_000);
  assert.equal(v.allowed, true);
  assert.equal(v.estimate, estimateResumeTokens(500_000));
});

test('refuses a resume over the cap and says why', () => {
  const v = checkBudget(1_618_394, 150_000);
  assert.equal(v.allowed, false);
  assert.match(v.reason!, /288,\d{3}/);
  assert.match(v.reason!, /150,000/);
});

test('checkBudget: an estimate exactly at the cap is allowed, not rejected', () => {
  // Issue #12 boundary: `estimate > maxResumeTokens` in checkBudget. 5600
  // bytes estimates to exactly 1000 tokens (Math.round(5600 / 5.6) === 1000,
  // the same figures the divisor test above uses), an exact tie with the cap.
  const v = checkBudget(5600, 1000);
  assert.equal(v.estimate, 1000);
  assert.equal(v.allowed, true, 'an estimate exactly at the cap must still be allowed');
});

test('a cap of zero disables the check', () => {
  assert.equal(checkBudget(10_000_000, 0).allowed, true);
});

test('unknown size is allowed but flagged', () => {
  const v = checkBudget(0, 150_000);
  assert.equal(v.allowed, true);
  assert.equal(v.estimate, 0);
});

test('incident budget accumulates and hard-stops', () => {
  const b = new IncidentBudget();
  assert.equal(b.total, 0);
  b.add(100_000);
  b.add(60_000);
  assert.equal(b.total, 160_000);
  assert.equal(b.exceeded(150_000), true);
  assert.equal(b.exceeded(200_000), false);
  b.reset();
  assert.equal(b.total, 0);
});

test('incident budget ignores nonsense usage numbers', () => {
  const b = new IncidentBudget();
  b.add(Number.NaN);
  b.add(-5);
  assert.equal(b.total, 0);
});
