import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeStub } from './helpers/vscode';

installVscodeStub();

const { TranscriptWatcher } = require('../src/transcriptWatcher') as
  typeof import('../src/transcriptWatcher');

const FILE = '/home/u/.claude/projects/c--projects-example/0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl';
const silent = { info() {}, warn() {}, error() {} };
const make = () => new TranscriptWatcher(() => 24, () => 5, silent);

const entry = (o: Record<string, unknown>) => JSON.stringify(o);

test('a flagged rate-limit entry arms a timer', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    cwd: 'C:\\projects\\example',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const out = make().inspectLine(line, FILE);
  assert.ok(out.limit, 'flagged entry must be detected');
  assert.equal(out.limit.cwd, 'C:\\projects\\example');
  assert.equal(out.limit.file, FILE);
});

test('a partially written line is ignored rather than throwing', () => {
  assert.deepEqual(make().inspectLine('{"type":"assis', FILE), {});
});

test('a sibling timestamp field is not misread as a reset time', () => {
  const line = entry({
    type: 'assistant',
    timestamp: '2026-08-03T18:00:00Z',
    message: { content: 'I finished reading limitParser.ts' },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});

test('a user pasting a 529 does not arm a retry', () => {
  const line = entry({
    type: 'user',
    message: { content: 'I keep seeing API Error: 529 Overloaded, what does that mean?' },
  });
  assert.equal(make().inspectLine(line, FILE).overload, undefined);
});

test('an assistant end_turn reports input needed', () => {
  const line = entry({ type: 'assistant', message: { stop_reason: 'end_turn', content: 'Done.' } });
  assert.ok(make().inspectLine(line, FILE).inputNeeded);
});

test('long strings in an entry are skipped as file contents, not banners', () => {
  const line = entry({
    type: 'assistant',
    message: { content: 'Usage limit reached. Try again in 5 hours. ' + 'x'.repeat(500) },
  });
  assert.equal(make().inspectLine(line, FILE).limit, undefined);
});
