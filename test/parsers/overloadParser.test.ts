import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOverload } from '../../src/parsers/overloadParser';

test('detects transient server failures', () => {
  const positives = [
    'API Error: 500 Internal Server Error',
    'API Error: 503 Service Unavailable',
    'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}',
    'Overloaded',
    'Request failed: fetch failed',
    'Error: connect ECONNRESET',
    'Error: socket hang up',
    'The request timed out',
  ];
  for (const text of positives) {
    assert.ok(detectOverload(text), text);
  }
});

test('a 429 is a rate limit and belongs to the limit parser', () => {
  assert.equal(detectOverload('API Error: 429 Too Many Requests'), undefined);
  assert.equal(detectOverload('Error 429: rate limit exceeded, try again in 2 hours'), undefined);
});

test('ignores prose and source code discussing server errors', () => {
  const negatives = [
    'const RULES = [{ id: "overloaded", re: /529/ }];',
    'I think the API was overloaded earlier in the queue.',
    'describe("overload", () => { expect(status).toBe(503); });',
    'Claude finished the task successfully.',
  ];
  for (const text of negatives) {
    assert.equal(detectOverload(text), undefined, text);
  }
});

test('reports the status code when one is present', () => {
  assert.equal(detectOverload('API Error: 503 Service Unavailable')?.status, 503);
  assert.equal(detectOverload('API Error: 529 Overloaded')?.status, 529);
});

test('rejects text longer than the notice cap', () => {
  assert.equal(detectOverload('API Error: 500 ' + 'x'.repeat(500)), undefined);
});

test('recognises a bare socket hang up, which is how Node prints it', () => {
  assert.ok(detectOverload('socket hang up'));
  assert.ok(detectOverload('Error: socket hang up'), 'prefixed form must keep working');
});

test('the added marker does not admit prose about sockets', () => {
  assert.equal(detectOverload('the socket layer hangs up on idle connections'), undefined);
});
