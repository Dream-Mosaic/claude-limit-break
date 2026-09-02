/**
 * Artifact audit: run the REAL TranscriptWatcher.inspectLine (not my replication)
 * against REAL-shaped Claude Code transcript entries, with vscode stubbed.
 */
const Module = require('module');
const OUT = process.env.UPSTREAM_OUT || './upstream/extension/out/';

// --- minimal vscode stub ---
class Emitter {
  constructor() { this.h = []; }
  get event() { return (fn) => { this.h.push(fn); return { dispose() {} }; }; }
  fire(v) { this.h.forEach((f) => f(v)); }
  dispose() {}
}
const vscodeStub = {
  EventEmitter: Emitter,
  window: {
    createOutputChannel: () => ({
      info() {}, warn() {}, error() {}, debug() {}, show() {}, dispose() {},
    }),
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return vscodeStub;
  return origLoad.call(this, req, ...rest);
};

const { TranscriptWatcher } = require(OUT + 'transcriptWatcher.js');
const L = require(OUT + 'limitParser.js');

const NOW = new Date('2026-08-03T12:00:00Z');
const w = new TranscriptWatcher(() => 24, () => 10);

// Real Claude Code user-entry shape, including the sibling `timestamp` field.
const userEntry = (text) => JSON.stringify({
  parentUuid: 'a1b2c3d4-0000-0000-0000-000000000001',
  isSidechain: false,
  userType: 'external',
  cwd: 'C:\\projects\\example',
  sessionId: 'ff000000-0000-0000-0000-00000000000f',
  version: '2.0.14',
  gitBranch: 'main',
  type: 'user',
  message: { role: 'user', content: text },
  uuid: 'b2c3d4e5-0000-0000-0000-000000000002',
  timestamp: '2026-08-03T12:00:00.000Z',
});

// inspectLine uses `new Date()` internally, so pin the clock to NOW.
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(NOW); }
  static now() { return NOW.getTime(); }
};

console.log('=== REAL inspectLine() on REAL user-entry JSON ===\n');
const cases = [
  ['my usage limit resets at 3pm right?', 'ordinary question'],
  ['why does my session limit reset at 1:40am instead of midnight?', 'ordinary question'],
  ['the daily limit reset at 6am and I still cannot use it', 'ordinary complaint'],
  ['I hit my usage limit. Try again in 5 hours it said.', 'quoting a banner'],
  ['what is a session limit', 'control - no time'],
  ['can you fix the bug in limitParser.ts', 'control - dev chat'],
];
let armed = 0;
for (const [text, tag] of cases) {
  const r = w.inspectLine(userEntry(text), 'x.jsonl');
  if (r.limit) armed++;
  console.log(`  ${r.limit ? 'ARMS TIMER' : 'ignored   '}  [${tag}]`);
  console.log(`      "${text}"`);
  if (r.limit) console.log(`      -> rule=${r.limit.detection.rule}  resumeAt=${r.limit.detection.resumeAt.toISOString()}`);
}
console.log(`\n  ${armed}/${cases.length} armed via the REAL code path.`);

console.log('\n=== Does the sibling `timestamp` field get misread as a reset time? ===');
const tsProbe = w.inspectLine(userEntry('what is a session limit'), 'x.jsonl');
console.log('  entry has timestamp 2026-08-03T12:00:00.000Z; detection =', tsProbe.limit ? 'TRIPPED' : 'none (guard holds)');

console.log('\n=== Terminal path: does detectLimitInLines have a looksLikeCode guard? ===');
const termCases = [
  ['Claude AI usage limit reached. Try again in 5 hours', 'real banner (should detect)', true],
  ['const HINT = /usage limit reached/; // try again in 5 hours', 'SOURCE CODE echoed to terminal', false],
  ['  * usage limit reached - try again in 5 hours', 'a doc line printed by `cat DOCS.md`', false],
  ['commit 9f2a: handle usage limit reached, try again in 5 hours', 'a git log line', false],
];
for (const [text, tag, want] of termCases) {
  const hit = L.detectLimitInLines(text, NOW, 24);
  const ok = !!hit === want;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${!!hit ? 'DETECTS' : 'ignores'}  [${tag}]`);
  console.log(`         "${text}"`);
}
console.log('\n  looksLikeCode called by detectLimitInLines? ',
  /looksLikeCode/.test(L.detectLimitInLines.toString()) ? 'yes' : 'NO - terminal path has no code guard');

global.Date = RealDate;
Module._load = origLoad;
