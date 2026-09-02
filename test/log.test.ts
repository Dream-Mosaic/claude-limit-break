import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/log';

test('logger writes through to its sink', () => {
  const lines: string[] = [];
  const log = createLogger('test', (line) => lines.push(line));

  log.info('hello');
  log.warn('careful');
  log.error('boom');

  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /\[test\] INFO {2}hello$/);
  assert.match(lines[1]!, /\[test\] WARN {2}careful$/);
  assert.match(lines[2]!, /\[test\] ERROR boom$/);
});

test('logger timestamps each line', () => {
  const lines: string[] = [];
  createLogger('t', (l) => lines.push(l)).info('x');
  assert.match(lines[0]!, /^\d{4}-\d{2}-\d{2}T/);
});
