// fork6.js - read-only verdict for the #6 experiment.
//
//   node fork6.js <sessionId> [--before CLB6-P1] [--cli CLB6-CLI] [--after CLB6-P2]
//
// Finds ~/.claude/projects/*/<sessionId>.jsonl, dedupes lines by uuid (reloads
// replay earlier segments verbatim), locates the user turn carrying each marker,
// and reports whether the post-resume panel turn descends from the CLI's turn
// (APPEND) or skips it (FORK). Writes nothing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const sessionId = argv[0];
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const markers = { before: opt('--before', 'CLB6-P1'), cli: opt('--cli', 'CLB6-CLI'), after: opt('--after', 'CLB6-P2') };
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId || '')) {
  console.error('usage: node fork6.js <sessionId> [--before M] [--cli M] [--after M]');
  process.exit(2);
}

const root = path.join(os.homedir(), '.claude', 'projects');
const files = fs.readdirSync(root)
  .map((d) => path.join(root, d, `${sessionId}.jsonl`))
  .filter((f) => fs.existsSync(f));
if (files.length !== 1) {
  console.error(`expected exactly one transcript for ${sessionId}, found ${files.length}`, files);
  process.exit(2);
}
const file = files[0];
console.log('transcript', file);

const nodes = new Map(); // uuid -> first occurrence
const repeats = new Map(); // uuid -> occurrence count
const lastPrompts = [];
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
lines.forEach((raw, i) => {
  if (!raw) return;
  let o;
  try { o = JSON.parse(raw); } catch { return; }
  if (o.type === 'last-prompt') lastPrompts.push({ line: i + 1, leaf: o.leafUuid, prompt: o.lastPrompt });
  if (!o.uuid) return;
  repeats.set(o.uuid, (repeats.get(o.uuid) || 0) + 1);
  if (!nodes.has(o.uuid)) nodes.set(o.uuid, { ...o, _line: i + 1 });
});

const textOf = (o) => {
  const c = o.message && o.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return '';
};
const short = (u) => (u ? u.slice(0, 8) : 'null');

const found = {};
for (const [key, marker] of Object.entries(markers)) {
  const hits = [...nodes.values()].filter((o) => o.type === 'user' && !o.isMeta && textOf(o).includes(marker));
  if (hits.length > 1) console.log(`WARNING: ${hits.length} distinct user turns contain "${marker}"; using the first`);
  found[key] = hits[0];
  const o = hits[0];
  console.log(o
    ? `${key.padEnd(6)} "${marker}" line ${o._line} uuid ${short(o.uuid)} parent ${short(o.parentUuid)} ` +
      `entrypoint=${o.entrypoint} version=${o.version} at ${o.timestamp}`
    : `${key.padEnd(6)} "${marker}" not found`);
}

const ancestors = (uuid) => {
  const seen = [];
  const guard = new Set();
  for (let u = uuid; u && nodes.has(u) && !guard.has(u); u = nodes.get(u).parentUuid) {
    guard.add(u);
    seen.push(u);
  }
  return seen;
};
const childrenOf = (uuid) => [...nodes.values()].filter((o) => o.parentUuid === uuid);

const replayed = [...repeats.values()].filter((n) => n > 1).length;
console.log(`nodes ${nodes.size} (distinct uuids), replayed ${replayed}`);

if (found.before && found.cli) {
  const ok = ancestors(found.cli.uuid).includes(found.before.uuid);
  console.log(`CLI turn descends from the pre-resume turn: ${ok ? 'yes' : 'NO - the resume did not attach to the panel history'}`);
}
if (!found.after) {
  console.log('VERDICT: PENDING - no post-resume panel turn yet');
} else if (!found.cli) {
  console.log('VERDICT: INCONCLUSIVE - CLI turn not found');
} else {
  const chain = ancestors(found.after.uuid);
  if (chain.includes(found.cli.uuid)) {
    console.log('VERDICT: APPEND - the post-resume turn descends from the CLI turn');
  } else {
    const cliChain = new Set(ancestors(found.cli.uuid));
    const branch = chain.find((u) => cliChain.has(u));
    console.log('VERDICT: FORK - the post-resume turn does not descend from the CLI turn');
    if (branch) {
      const kids = childrenOf(branch);
      console.log(`branch point line ${nodes.get(branch)._line} uuid ${short(branch)} type=${nodes.get(branch).type}, ` +
        `${kids.length} children: ` + kids.map((k) => `${short(k.uuid)}(line ${k._line}, ${k.entrypoint})`).join(', '));
    } else {
      console.log('no common ancestor - the two turns are on disconnected trees');
    }
  }
}
if (found.cli) {
  const after = lastPrompts.filter((p) => p.line > found.cli._line);
  if (after.length) {
    console.log('last-prompt lines after the CLI turn:');
    for (const p of after) {
      const n = nodes.get(p.leaf);
      console.log(`  line ${p.line} leaf ${short(p.leaf)}${n ? ` (line ${n._line}, ${n.entrypoint})` : ''} "${String(p.prompt).slice(0, 40)}"`);
    }
  }
}
