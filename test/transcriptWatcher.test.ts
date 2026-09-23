import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { installVscodeStub } from './helpers/vscode';

installVscodeStub();

const { TranscriptWatcher, isInScope, pruneOffsets, MAX_OFFSET_IDLE_MS, MAX_OFFSET_ENTRIES } =
  require('../src/transcriptWatcher') as typeof import('../src/transcriptWatcher');

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

test('an ordinary user question about limits does not arm a timer', () => {
  const questions = [
    'my usage limit resets at 3pm right?',
    'why does my session limit reset at 1:40am instead of midnight?',
    'what happens when I hit the usage limit - does it try again in 5 hours?',
    'is the rate limit reached message the one that says try again in 2 hours?',
  ];
  for (const q of questions) {
    const line = entry({ type: 'user', message: { content: q } });
    assert.equal(make().inspectLine(line, FILE).limit, undefined, q);
  }
});

test('an assistant entry describing a limit still arms a timer', () => {
  const line = entry({
    type: 'assistant',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  assert.ok(make().inspectLine(line, FILE).limit);
});

// ---------------------------------------------------------------------------
// Scope filtering (issue #2). The watcher's root stays the whole
// ~/.claude/projects tree - that default is not up for debate here - but a
// caller can now inject a narrower scope, and machine mode (what every
// existing test above exercises via make(), which passes no scope at all)
// must stay exactly as it is today.
// ---------------------------------------------------------------------------

test('machine mode is in scope no matter the cwd or folders', () => {
  assert.equal(isInScope(undefined, { mode: 'machine', folders: [] }), true);
  assert.equal(isInScope('/anywhere', { mode: 'machine', folders: ['/work/app'] }), true);
});

test('workspace mode is a bounded, case-insensitive path comparison', () => {
  const root = path.join(os.tmpdir(), 'clb-ws');
  const scope = (folders: string[]) => ({ mode: 'workspace' as const, folders });
  assert.equal(isInScope(root, scope([root])), true, 'the folder itself is inside it');
  assert.equal(isInScope(path.join(root, 'a', 'b'), scope([root])), true, 'a descendant is inside');
  assert.equal(isInScope(root.toUpperCase(), scope([root])), true, 'casing must not decide it');
  assert.equal(isInScope(`${root}-old`, scope([root])), false, 'a shared prefix is not containment');
  assert.equal(isInScope(path.join(os.tmpdir(), 'other'), scope([root])), false, 'elsewhere is outside');
  assert.equal(isInScope(undefined, scope([root])), false, 'an unknown cwd is not inside anything');
  assert.equal(isInScope(root, scope([])), false, 'a scope with no folders owns nothing');
});

test('workspace mode discards a limit hit outside the workspace before detection', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    cwd: '/elsewhere/project',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const watcher = new TranscriptWatcher(() => 24, () => 5, silent, () => ({ mode: 'workspace', folders: ['/work/app'] }));
  assert.deepEqual(watcher.inspectLine(line, FILE), {});
});

test('workspace mode keeps a limit hit inside the workspace', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    cwd: '/work/app',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  const watcher = new TranscriptWatcher(() => 24, () => 5, silent, () => ({ mode: 'workspace', folders: ['/work/app'] }));
  assert.ok(watcher.inspectLine(line, FILE).limit);
});

test('workspace mode discards an ended turn outside the workspace', () => {
  const line = entry({ type: 'assistant', cwd: '/elsewhere', message: { stop_reason: 'end_turn', content: 'Done.' } });
  const watcher = new TranscriptWatcher(() => 24, () => 5, silent, () => ({ mode: 'workspace', folders: ['/work/app'] }));
  assert.equal(watcher.inspectLine(line, FILE).inputNeeded, undefined);
});

test('a caller passing no scope gets machine mode, unchanged from today', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    cwd: '/nowhere/near/a/workspace',
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  assert.ok(make().inspectLine(line, FILE).limit);
});

// ---------------------------------------------------------------------------
// Bounded offsets (issue #2). offsets holds one entry per file ever seen and
// the projects tree only grows, so pruneOffsets decides what survives a pass.
// It is pure and Map-free - see its doc comment in src/transcriptWatcher.ts
// for where the bound numbers come from - so this needs no filesystem.
// ---------------------------------------------------------------------------

test('pruneOffsets drops a file no longer on disk', () => {
  const now = 1_000_000;
  const entries = new Map([['/a.jsonl', { offset: 10, lastActivity: now }]]);
  const survivors = pruneOffsets(entries, new Set(), now);
  assert.equal(survivors.size, 0);
});

test('pruneOffsets drops a file idle past the bound and keeps one within it', () => {
  const now = 10_000_000;
  const entries = new Map([
    ['/stale.jsonl', { offset: 10, lastActivity: now - MAX_OFFSET_IDLE_MS - 1 }],
    ['/fresh.jsonl', { offset: 10, lastActivity: now - 1 }],
  ]);
  const existing = new Set(['/stale.jsonl', '/fresh.jsonl']);
  const survivors = pruneOffsets(entries, existing, now);
  assert.deepEqual([...survivors.keys()], ['/fresh.jsonl']);
});

test('pruneOffsets enforces a hard cap by evicting the oldest activity first', () => {
  const now = 5_000;
  const entries = new Map([
    ['/one.jsonl', { offset: 1, lastActivity: 100 }],
    ['/two.jsonl', { offset: 1, lastActivity: 200 }],
    ['/three.jsonl', { offset: 1, lastActivity: 300 }],
  ]);
  const existing = new Set(entries.keys());
  const survivors = pruneOffsets(entries, existing, now, MAX_OFFSET_IDLE_MS, 2);
  assert.deepEqual([...survivors.keys()].sort(), ['/three.jsonl', '/two.jsonl']);
});

test('the idle bound and the hard cap match what the comments in src claim', () => {
  assert.equal(MAX_OFFSET_IDLE_MS, 30 * 24 * 60 * 60 * 1000, 'thirty days');
  assert.equal(MAX_OFFSET_ENTRIES, 2000, 'the hard backstop');
});
