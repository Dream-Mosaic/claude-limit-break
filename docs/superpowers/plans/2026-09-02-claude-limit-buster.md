# Claude Limit Buster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VS Code extension that detects Claude Code usage limits and transient server errors from session transcripts, waits out the reset, and resumes the correct session by ID in a fresh terminal without ever typing into an existing one.

**Architecture:** A file watcher tails Claude Code's own JSONL transcripts and feeds candidate strings to three pure parsers. A detection yields a session ID (the transcript filename) and a resume time; a wall-clock scheduler fires at that time; a resumer launches a **new** terminal whose shell process *is* `claude`, passing the prompt as an argv element so no shell ever parses it. A budget module estimates token cost before resuming, because recovery competes with the quota it is recovering.

**Tech Stack:** TypeScript 5.6, VS Code extension API ^1.93.0, Node's built-in `node:test` runner. **Zero runtime dependencies.**

**Spec:** [docs/design/2026-09-01-design.md](../../design/2026-09-01-design.md) — read it before starting. This plan argues from it.

**Upstream source:** [docs/UPSTREAM.md](../../UPSTREAM.md) explains how to obtain the compiled modules this project incorporates. Several tasks port from them; you need them extracted at `upstream/` in the repo root (gitignored) before Task 2.

## Global Constraints

Every task's requirements implicitly include this section.

- **VS Code engine:** `^1.93.0`. **TypeScript:** `^5.6.3`. **@types/node:** `^22.9.0`. **@types/vscode:** `^1.93.0`.
- **Zero runtime dependencies.** `dependencies` in `package.json` stays empty. Tests use `node:test` and `node:assert/strict` only.
- **Config namespace:** `claudeLimitBuster.*`. Extension `name`: `claude-limit-buster`. `displayName`: `Claude Limit Buster`. `publisher`: `dream-mosaic`.
- **Never write to an existing terminal.** No `Terminal.sendText` anywhere in `src/`. No `vscode.window.activeTerminal` fallback. Finding #1.
- **Never hand-quote a prompt for a shell.** The prompt reaches `claude` as an argv element via `TerminalOptions.shellArgs` or `child_process.spawn` args. Finding #2 — upstream's `quoteForShell` let PowerShell `$(1+41)` evaluate to `42`.
- **Execution-adjacent settings are `"scope": "machine"`** so a workspace cannot set them. Finding #3.
- **Target sessions by ID only.** Never "most recent file", never `claude --continue`. Finding #4.
- **No `--permission-mode` in default interactive mode.** Interactive resume already runs at the user's normal autonomy (verified). The extension grants no autonomy it was not given.
- **`LICENSE` and `THIRDPARTY.md` must ship inside the `.vsix`**, not merely in the repo. Enforced in Task 14.
- **Every commit leaves `npm test` green.** Tasks that fix a bug write the failing test first, in that same task.

---

## File Structure

```
package.json                     manifest, contributes.configuration, scripts
tsconfig.json                    strict, outDir ./out, rootDir .
.vscodeignore                    must NOT exclude LICENSE or THIRDPARTY.md
src/
  extension.ts                   activation, wiring, command registration
  config.ts                      typed reader over workspace configuration
  log.ts                         output channel
  parsers/
    limitParser.ts               rules + time resolution + guards   (ported, 2 fixes)
    overloadParser.ts            transient server error rules       (ported, 1 fix)
    inputParser.ts               turn-end / input-needed detection  (ported)
  transcriptWatcher.ts           tails ~/.claude/projects/**/*.jsonl (ported, 1 fix)
  sessionResolver.ts             transcript path -> session ID + cwd   (new)
  budget.ts                      pre-flight token estimate + cap       (new)
  policy.ts                      detection -> job, or a stated refusal  (new)
  resumer.ts                     fresh-terminal / headless launch      (rewritten)
  scheduler.ts                   wall-clock tick, survives sleep     (ported)
  randomDelay.ts                 resume jitter                       (ported)
  statusBar.ts                   countdown item                      (ported)
  sound.ts                       alert chime, WITHOUT soundCommand   (ported, trimmed)
test/
  helpers/vscode.ts              Module._load stub for the `vscode` module
  parsers/limitParser.test.ts
  parsers/overloadParser.test.ts
  parsers/inputParser.test.ts
  transcriptWatcher.test.ts
  sessionResolver.test.ts
  budget.test.ts
  policy.test.ts
  resumer.test.ts
  scheduler.test.ts
  sound.test.ts
  config.test.ts
```

Parsers live together because they change together — a hint list and the rule
that consumes it are one unit. `sessionResolver`, `budget`, and `resumer` are
separate files because each is independently the subject of a security finding
and each gets its own test file. `policy.ts` holds every branch that decides
*whether* to resume, so `extension.ts` can stay glue with nothing to test.

The existing throwaway harnesses in [test/corpus/](../../../test/corpus/) are the
**source of test data**, not code to keep. Tasks 2, 4, and 6 mine them for cases
and then they are deleted in Task 15.

---

### Task 1: Project skeleton and green build

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.vscodeignore`
- Create: `src/log.ts`
- Test: `test/log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs `tsc -p .` then `node --test "out/test/**/*.test.js"`. `createLogger(name: string, sink: Sink): Logger` where `Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void }` and `Sink = (line: string) => void`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "claude-limit-buster",
  "displayName": "Claude Limit Buster",
  "description": "Waits out Claude Code usage limits and resumes your session by ID.",
  "version": "0.1.0",
  "publisher": "dream-mosaic",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/Dream-Mosaic/claude-limit-buster.git" },
  "engines": { "vscode": "^1.93.0" },
  "categories": ["Other"],
  "extensionKind": ["workspace"],
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": false,
      "description": "Resuming a session launches the Claude CLI in the workspace folder."
    }
  },
  "activationEvents": ["onStartupFinished"],
  "main": "./out/src/extension.js",
  "contributes": {},
  "scripts": {
    "compile": "tsc -p .",
    "watch": "tsc -p . -w",
    "vscode:prepublish": "npm run compile",
    "test": "npm run compile && node --test \"out/test/**/*.test.js\""
  },
  "devDependencies": {
    "@types/node": "^22.9.0",
    "@types/vscode": "^1.93.0",
    "typescript": "^5.6.3"
  }
}
```

Note `main` is `./out/src/extension.js`: `rootDir` is the repo root so that
`test/` compiles alongside `src/`, which puts the entry point one level deeper
than upstream's layout. Getting this wrong means the extension activates to
nothing.

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "out", "upstream", "test/corpus"]
}
```

`test/corpus` is excluded because those are throwaway `.js` harnesses that
`require()` upstream by path; they are not part of the build.

- [ ] **Step 3: Write `.vscodeignore`**

```
.vscode/**
node_modules/**
out/test/**
test/**
upstream/**
src/**
docs/**
**/*.ts
**/*.map
tsconfig.json
.gitignore
```

Do **not** add `LICENSE` or `THIRDPARTY.md`. Their absence from this file is
what makes the packaging gate in Task 14 pass. Everything under `docs/` is
excluded to keep the package small; the notice files sit at the root.

- [ ] **Step 4: Write the failing test**

Create `test/log.test.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
npm install
npm test
```

Expected: `tsc` fails with `Cannot find module '../src/log'`.

- [ ] **Step 6: Write the minimal implementation**

Create `src/log.ts`. The sink is injected so this file has **no `vscode`
import** and is therefore directly unit-testable; `extension.ts` supplies the
real output channel later.

```ts
export type Sink = (line: string) => void;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(name: string, sink: Sink): Logger {
  const write = (level: string, msg: string) => {
    sink(`${new Date().toISOString()} [${name}] ${level.padEnd(5)} ${msg}`);
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
npm test
```

Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .vscodeignore src/log.ts test/log.test.ts
git commit -m "build: TypeScript skeleton with node:test harness"
```

---

### Task 2: Port the limit parser with its corpus

**Files:**
- Create: `src/parsers/limitParser.ts` (port of `upstream/extension/out/limitParser.js`)
- Test: `test/parsers/limitParser.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_NOTICE_LENGTH: 400`
  - `stripAnsi(input: string): string`
  - `normalize(input: string): string`
  - `looksLikeLimitMessage(text: string): boolean`
  - `looksLikeCode(text: string): boolean`
  - `detectLimit(rawText: string, now?: Date, maxWaitHours?: number): LimitDetection | undefined`
  - `detectLimitInLines(text: string, now?: Date, maxWaitHours?: number, maxLineLength?: number): LimitDetection | undefined`
  - `formatDuration(ms: number): string`
  - `parseManualWait(input: string, now?: Date): Date | undefined`
  - `interface LimitDetection { resumeAt: Date; rule: string; text: string }`

This task ports **behaviour-for-behaviour with no fixes**. The two known
defects stay broken here and are fixed in Task 3, so that the fix arrives with
a red-to-green test rather than buried inside a 400-line port.

- [ ] **Step 1: Port the module**

Copy `upstream/extension/out/limitParser.js` to `src/parsers/limitParser.ts`
and convert it: strip the `"use strict"` / `exports.*` preamble, change
`function foo` to `export function foo`, and add the type annotations below.
Keep every regex, every rule, and every comment — the comments explain
non-obvious timezone reasoning you will not want to re-derive.

Add these declarations at the top:

```ts
export interface LimitDetection {
  resumeAt: Date;
  rule: string;
  text: string;
}

interface Rule {
  id: string;
  re: RegExp;
  resolve(m: RegExpExecArray, now: Date): Date | undefined;
}

const RULES: Rule[] = [ /* ...unchanged from upstream... */ ];
```

`zoneOffsetMs`, `zoneToday`, `zonedWallClockToInstant`, and `resolveClockTime`
stay module-private (no `export`).

- [ ] **Step 2: Write the corpus as a test file**

Create `test/parsers/limitParser.test.ts`. The cases come from
`test/corpus/parser-corpus.js`; `NOW` is fixed so every fixture is
deterministic.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLimit,
  detectLimitInLines,
  looksLikeCode,
  formatDuration,
  MAX_NOTICE_LENGTH,
} from '../../src/parsers/limitParser';

const NOW = new Date('2026-08-03T12:00:00Z');
const MAXW = 24;
const epochAt = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

test('detects every documented limit format', () => {
  const positives: [string, string][] = [
    [`Claude AI usage limit reached|${epochAt('2026-08-03T17:00:00Z')}`, 'epoch'],
    ['You have hit your session limit, resets at 2026-08-03T18:00:00Z', 'iso'],
    ["You've hit your session limit - resets 1:40am (Asia/Jerusalem)", 'clock+tz'],
    ['Claude usage limit reached, resets at 12:00 (UTC+3)', 'clock+offset'],
    ['Claude AI usage limit reached. Try again in 5 hours', 'duration-hours'],
    ['Usage limit reached - retry in about 4h 32m', 'duration-compound'],
    ['Session limit reached. Try again in 45 minutes', 'duration-minutes'],
    ['You have reached your usage limit. Try again in 5 hours.', 'phrasing'],
    ['Error 429: rate limit exceeded, try again in 2 hours', '429-routes-here'],
  ];
  for (const [text, tag] of positives) {
    assert.ok(detectLimit(text, NOW, MAXW), `${tag}: ${text}`);
  }
});

test('ignores prose and source code that merely discuss limits', () => {
  const negatives: [string, string][] = [
    ['const LIMIT_HINTS = [/usage limit reached/i]; // resets at 3pm', 'source'],
    ['function isLimit() { return /limit reached/.test(s); }', 'source'],
    ['Claude finished the task successfully.', 'unrelated'],
    ['resets at 14:00 (UTC)', 'time-without-hint'],
    ['Try again in 5 hours', 'duration-without-hint'],
  ];
  for (const [text, tag] of negatives) {
    assert.equal(detectLimit(text, NOW, MAXW), undefined, `${tag}: ${text}`);
  }
});

test('rejects a reset time beyond the wait horizon', () => {
  assert.equal(detectLimit('Usage limit reached. Try again in 40 hours', NOW, MAXW), undefined);
});

test('rejects a reset time already in the past', () => {
  const past = `Claude AI usage limit reached|${epochAt('2026-08-03T09:00:00Z')}`;
  assert.equal(detectLimit(past, NOW, MAXW), undefined);
});

test('resolves the epoch format to the exact instant', () => {
  const hit = detectLimit(`Claude AI usage limit reached|${epochAt('2026-08-03T17:00:00Z')}`, NOW, MAXW);
  assert.equal(hit?.resumeAt.toISOString(), '2026-08-03T17:00:00.000Z');
});

test('line scanner strips ANSI and matches a single line', () => {
  const buf = `\x1b[31mbuilding\x1b[0m\nClaude AI usage limit reached. Try again in 5 hours\ndone`;
  assert.ok(detectLimitInLines(buf, NOW, MAXW));
});

test('line scanner skips lines longer than the notice cap', () => {
  const long = 'Usage limit reached. Try again in 5 hours' + ' padding'.repeat(60);
  assert.ok(long.length > MAX_NOTICE_LENGTH);
  assert.equal(detectLimitInLines(long, NOW, MAXW), undefined);
});

test('looksLikeCode flags the punctuation prose does not use', () => {
  assert.ok(looksLikeCode('const x = () => 1;'));
  assert.ok(looksLikeCode('// resets at 3pm'));
  assert.equal(looksLikeCode('Usage limit reached. Try again in 5 hours.'), false);
});

test('formatDuration renders compact countdowns', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(3_600_000 * 4 + 60_000 * 32), '4h 32m');
});
```

Two documented formats are deliberately **absent** from the positives above —
`Your limit will reset at 14:00 (UTC)` and the user-question negative. They
arrive in Task 3 as the failing tests that drive the fix.

- [ ] **Step 3: Run the tests**

```bash
npm test
```

Expected: PASS. If a positive fails, the port dropped a rule — diff your
`RULES` array against upstream rather than editing the test.

- [ ] **Step 4: Commit**

```bash
git add src/parsers/limitParser.ts test/parsers/limitParser.test.ts
git commit -m "feat: port limit parser with its regression corpus"
```

---

### Task 3: Fix limit-parser admission control

**Files:**
- Modify: `src/parsers/limitParser.ts`
- Test: `test/parsers/limitParser.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: `detectLimit` gains a fourth parameter —
  `detectLimit(rawText: string, now?: Date, maxWaitHours?: number, opts?: { trusted?: boolean }): LimitDetection | undefined`.
  `trusted: true` skips the source-code guard, for entries Claude Code itself
  tagged as a rate-limit event. `detectLimitInLines` keeps its existing
  signature and always calls with `trusted` unset.

Spec changes 1 and 3a. Upstream applied `looksLikeCode` in **one caller**
(`transcriptWatcher.js:273`), leaving `detectLimitInLines` — the terminal
detection path — with no guard at all. `detectOverload` already guards
internally; this makes the limit parser match.

- [ ] **Step 1: Write the failing tests**

Append to `test/parsers/limitParser.test.ts`:

```ts
test('detects the bare "your limit" format from the docs', () => {
  const hit = detectLimit('Your limit will reset at 14:00 (UTC)', NOW, MAXW);
  assert.ok(hit, 'documented format must be recognised');
  assert.equal(hit.resumeAt.toISOString(), '2026-08-03T14:00:00.000Z');
});

test('detectLimit guards against source code internally', () => {
  const code = 'const LIMIT_HINTS = [/usage limit reached/i]; // try again in 5 hours';
  assert.equal(detectLimit(code, NOW, MAXW), undefined);
});

test('the line scanner inherits the source-code guard', () => {
  const code = 'if (usage limit reached) { return retryIn(5 hours); }';
  assert.equal(detectLimitInLines(code, NOW, MAXW), undefined);
});

test('detectLimit rejects text longer than the notice cap', () => {
  const long = 'Usage limit reached. Try again in 5 hours.' + ' x'.repeat(MAX_NOTICE_LENGTH);
  assert.equal(detectLimit(long, NOW, MAXW), undefined);
});

test('a trusted entry bypasses the source-code guard', () => {
  const banner = 'Claude AI usage limit reached `retry` => try again in 5 hours';
  assert.equal(detectLimit(banner, NOW, MAXW), undefined, 'untrusted: guarded');
  assert.ok(detectLimit(banner, NOW, MAXW, { trusted: true }), 'trusted: allowed');
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test
```

Expected: 3 failures — the `your limit` format misses, and both guard tests
pass text straight through because the guard lives in the caller.

- [ ] **Step 3: Add the missing hint pattern**

In `src/parsers/limitParser.ts`, add one entry to `LIMIT_HINTS`. Keep it
narrow — this list is the admission gate for everything downstream, and a
broad pattern here is how ordinary prose arms a timer.

```ts
const LIMIT_HINTS = [
  /usage limit reached/i,
  /\blimit reached\b/i,
  /\b(?:session|usage|weekly|daily|opus|sonnet) limit\b/i,
  /\byour limit\b/i,            // <-- added: documented format, previously missed
  /\brate[- ]limit(?:ed|s)?\b/i,
  // ...rest unchanged...
];
```

- [ ] **Step 4: Move the guard inside `detectLimit`**

Replace the head of `detectLimit`:

```ts
export function detectLimit(
  rawText: string,
  now: Date = new Date(),
  maxWaitHours = 24,
  opts: { trusted?: boolean } = {},
): LimitDetection | undefined {
  const text = normalize(rawText);
  if (!text || text.length > MAX_NOTICE_LENGTH) {
    return undefined;
  }
  if (!looksLikeLimitMessage(text)) {
    return undefined;
  }
  // Source code and conversation *about* limits - which is exactly what a
  // transcript of working on this extension looks like - must not arm a timer.
  // Mirrors detectOverload, which has always guarded internally. Entries Claude
  // Code itself tagged as a rate-limit event are trusted past this.
  if (!opts.trusted && looksLikeCode(text)) {
    return undefined;
  }

  const horizon = now.getTime() + maxWaitHours * HOUR_MS;
  // ...rest of the function unchanged...
}
```

`looksLikeCode` is defined below `detectLimit` in the ported file. Function
declarations hoist, so no reordering is needed.

- [ ] **Step 5: Run to verify they pass**

```bash
npm test
```

Expected: all green. The negatives from Task 2 must still pass — they are now
caught earlier, which is the point.

- [ ] **Step 6: Commit**

```bash
git add src/parsers/limitParser.ts test/parsers/limitParser.test.ts
git commit -m "fix: guard detectLimit internally and recognise bare 'your limit'

The source-code guard lived in one caller, so detectLimitInLines - the
terminal detection path - had none. Moves it inside detectLimit, mirroring
detectOverload, with a trusted bypass for entries Claude Code tagged as
rate-limit events."
```

---
### Task 4: Port the overload and input parsers

**Files:**
- Create: `src/parsers/overloadParser.ts` (port of `upstream/extension/out/overloadParser.js`)
- Create: `src/parsers/inputParser.ts` (port of `upstream/extension/out/inputParser.js`)
- Test: `test/parsers/overloadParser.test.ts`
- Test: `test/parsers/inputParser.test.ts`

**Interfaces:**
- Consumes: `normalize`, `stripAnsi`, `looksLikeLimitMessage`, `looksLikeCode`, `MAX_NOTICE_LENGTH` from `src/parsers/limitParser`.
- Produces:
  - `looksLikeOverloadMessage(text: string): boolean`
  - `detectOverload(rawText: string): OverloadDetection | undefined`
  - `detectOverloadInLines(text: string): OverloadDetection | undefined`
  - `describeOverload(d: OverloadDetection): string`
  - `interface OverloadDetection { rule: string; status?: number; text: string }`
  - `detectInputNeeded(rawText: string): InputDetection | undefined`
  - `detectInputNeededInLines(text: string): InputDetection | undefined`
  - `isTurnEndEntry(entry: Record<string, unknown>): boolean`
  - `describeInput(d: InputDetection): string`
  - `interface InputDetection { rule: string; kind: 'prompt' | 'turnEnd'; text: string }`

Both port unchanged. `detectOverload` already applies its guards internally —
it is the model Task 3 copied. The one known defect (`socket hang up`) is
fixed in Task 5.

- [ ] **Step 1: Port both modules**

Convert as in Task 2. Keep `quotesSourceCode` and `sniffStatus`
module-private in `overloadParser.ts`; keep `isEchoedInput` module-private in
`inputParser.ts`.

Type the rule arrays:

```ts
// overloadParser.ts
interface OverloadRule { id: string; re: RegExp; statusGroup?: number }
const RULES: OverloadRule[] = [ /* ...unchanged... */ ];

// inputParser.ts
interface InputRule { id: string; re: RegExp }
const RULES: InputRule[] = [ /* ...unchanged... */ ];
```

`isTurnEndEntry` takes an arbitrary parsed JSON object. Type it as
`Record<string, unknown>` and narrow internally rather than inventing a
transcript-entry interface — the format is explicitly internal and changes
between versions, so a structural type here would be a liability.

```ts
export function isTurnEndEntry(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'assistant') {
    return false;
  }
  const message = entry.message;
  if (!message || typeof message !== 'object') {
    return false;
  }
  if ((message as Record<string, unknown>).stop_reason !== 'end_turn') {
    return false;
  }
  // Sub-agent transcripts carry the same shape; their turns end constantly
  // while the main session is still busy, so they must not ring the bell.
  return entry.isSidechain !== true;
}
```

- [ ] **Step 2: Write the overload test file**

Create `test/parsers/overloadParser.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOverload, detectOverloadInLines } from '../../src/parsers/overloadParser';

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

test('line scanner takes the newest error from a repainted screen', () => {
  const buf = 'API Error: 500 Internal Server Error\nretrying\nAPI Error: 503 Service Unavailable';
  assert.equal(detectOverloadInLines(buf)?.status, 503);
});
```

`Error: socket hang up` is in the positives because upstream's rule already
contains that string and the prefixed form works. The **bare** form is Task 5.

- [ ] **Step 3: Write the input test file**

Create `test/parsers/inputParser.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectInputNeeded,
  detectInputNeededInLines,
  isTurnEndEntry,
} from '../../src/parsers/inputParser';

test('detects every permission-prompt wording', () => {
  const positives = [
    'No, and tell Claude what to do differently',
    'Do you want to proceed?',
    'Do you want to make this edit to limitParser.ts?',
    'Do you want to create README.md?',
    'Would you like to proceed?',
    'Waiting for your input',
    'Awaiting confirmation',
  ];
  for (const text of positives) {
    assert.ok(detectInputNeeded(text), text);
  }
});

test('ignores the user typing a question into the input box', () => {
  const buf = '> do you want to proceed with the refactor';
  assert.equal(detectInputNeededInLines(buf), undefined);
});

test('a numbered choice inside a permission box is the prompt, not typing', () => {
  const buf = '❯ 1. Yes\n  2. No, and tell Claude what to do differently';
  assert.ok(detectInputNeededInLines(buf));
});

test('an assistant end_turn entry hands the conversation back', () => {
  assert.ok(isTurnEndEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } }));
});

test('a sidechain end_turn does not, because sub-agents end turns constantly', () => {
  assert.equal(
    isTurnEndEntry({ type: 'assistant', message: { stop_reason: 'end_turn' }, isSidechain: true }),
    false,
  );
});

test('a tool_use stop reason is mid-turn', () => {
  assert.equal(isTurnEndEntry({ type: 'assistant', message: { stop_reason: 'tool_use' } }), false);
});

test('a user entry is never a turn end', () => {
  assert.equal(isTurnEndEntry({ type: 'user', message: { stop_reason: 'end_turn' } }), false);
});
```

- [ ] **Step 4: Run the tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/overloadParser.ts src/parsers/inputParser.ts test/parsers/
git commit -m "feat: port overload and input parsers with their corpora"
```

---

### Task 5: Recognise a bare `socket hang up`

**Files:**
- Modify: `src/parsers/overloadParser.ts`
- Test: `test/parsers/overloadParser.test.ts`

**Interfaces:**
- Consumes: Task 4's exports. No signature changes.
- Produces: no signature changes.

Spec change 3b. `ERROR_MARKERS` is a cheap pre-gate that runs before the rules.
Node prints exactly `socket hang up` with no `Error:` prefix, so the documented
case is the one that fails: the connection rule literally contains the string
but never runs.

- [ ] **Step 1: Write the failing test**

Append to `test/parsers/overloadParser.test.ts`:

```ts
test('recognises a bare socket hang up, which is how Node prints it', () => {
  assert.ok(detectOverload('socket hang up'));
  assert.ok(detectOverload('Error: socket hang up'), 'prefixed form must keep working');
});

test('the added marker does not admit prose about sockets', () => {
  assert.equal(detectOverload('the socket layer hangs up on idle connections'), undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: 1 failure — the bare form returns `undefined`.

- [ ] **Step 3: Add the marker**

```ts
const ERROR_MARKERS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bunavailable\b/i,
  /\boverloaded_error\b/i,
  /^overloaded\b/i,
  /\btimed out\b/i,
  /\bsocket hang up\b/i,   // <-- added: Node prints this bare, with no "Error:" prefix
  /\b5\d{2}\b/,
];
```

Match the exact phrase, not `socket` or `hang up` separately — the second test
above is what stops the pattern from being widened later.

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/overloadParser.ts test/parsers/overloadParser.test.ts
git commit -m "fix: admit a bare 'socket hang up' to the overload rules

The connection rule already matched the string, but ERROR_MARKERS rejected
it before the rule ran - so the form Node actually prints was the one that
failed."
```

---

### Task 6: Port the transcript watcher

**Files:**
- Create: `src/transcriptWatcher.ts` (port of `upstream/extension/out/transcriptWatcher.js`)
- Create: `test/helpers/vscode.ts`
- Test: `test/transcriptWatcher.test.ts`

**Interfaces:**
- Consumes: the three parsers; `Logger` from `src/log`.
- Produces:
  - `transcriptRoot(): string`
  - `class TranscriptWatcher` with constructor
    `(getMaxWaitHours: () => number, getPollSeconds: () => number, log: Logger)`
  - events `onHit: Event<LimitHit>`, `onOverload: Event<OverloadHit>`, `onInputNeeded: Event<InputHit>`
  - `start(): Promise<void>`, `stop(): void`, `dispose(): void`
  - `inspectLine(line: string, file: string): InspectResult` — **made `public`** so it is testable without touching the filesystem. Upstream keeps it private; that is the only structural change.
  - ```ts
    export interface LimitHit { detection: LimitDetection; cwd?: string; file: string }
    export interface OverloadHit { detection: OverloadDetection; cwd?: string; file: string }
    export interface InputHit { detection: InputDetection; cwd?: string; file: string }
    export interface InspectResult { limit?: LimitHit; overload?: OverloadHit; inputNeeded?: InputHit }
    ```

Upstream's watcher is sound and is carried: offset tracking per file, baselined
at startup so history never arms a timer, consuming only through the last
complete newline, `fs.watch` recursive with a polling backstop, and a
`MAX_READ_BYTES` cap. Two changes only: `log` is injected rather than imported
from a module singleton, and `inspectLine` becomes public.

- [ ] **Step 1: Write the `vscode` stub**

The watcher imports `vscode` for `EventEmitter`. Tests run in plain Node, so
the module must be faked. Create `test/helpers/vscode.ts` — this is a cleaned-up
version of the hook already proven in `test/corpus/watcher-e2e.js`:

```ts
import Module from 'node:module';

class FakeEventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    } };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      l(e);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

const fakeVscode = { EventEmitter: FakeEventEmitter };

/**
 * Intercepts `require('vscode')` so extension modules load under plain Node.
 * Call once, at the top of any test file that imports a module touching the
 * VS Code API. Idempotent.
 */
export function installVscodeStub(): void {
  const mod = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
    __stubbed?: boolean;
  };
  if (mod.__stubbed) {
    return;
  }
  const original = mod._load;
  mod._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return fakeVscode;
    }
    return original.call(this, request, parent, isMain);
  };
  mod.__stubbed = true;
}
```

- [ ] **Step 2: Port the watcher**

Convert `transcriptWatcher.js` to TypeScript. Keep `MAX_READ_BYTES`,
`listTranscripts`, `scheduleScan`, the debounce, the offset map, and every
comment. Change the constructor to take the logger, and replace each
`log_1.log.x(...)` with `this.log.x(...)`:

```ts
constructor(
  private readonly getMaxWaitHours: () => number,
  private readonly getPollSeconds: () => number,
  private readonly log: Logger,
) {}
```

Keep `isRateLimitEntry`, `isApiErrorEntry`, and `collectStrings` as
module-private functions, typed against `Record<string, unknown>` /
`unknown`.

Mark `inspectLine` `public` and give it the `InspectResult` return type.

Port `inspectLine` **exactly as upstream has it** — including the limit scan
with no entry-type gate. That defect is Task 7, and it needs to be measurable
here first.

- [ ] **Step 3: Write the watcher tests**

Create `test/transcriptWatcher.test.ts`. `installVscodeStub()` must run before
the watcher is imported, so use a `require` after the stub rather than a
top-level `import` of the watcher.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeStub } from './helpers/vscode';

installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-var-requires
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
```

- [ ] **Step 4: Run the tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transcriptWatcher.ts test/helpers/vscode.ts test/transcriptWatcher.test.ts
git commit -m "feat: port the transcript watcher with an injectable logger

inspectLine is made public so detection is testable without the filesystem,
and the vscode module is stubbed so watcher code runs under plain node:test."
```

---

### Task 7: Gate the limit path on entry type

**Files:**
- Modify: `src/transcriptWatcher.ts`
- Test: `test/transcriptWatcher.test.ts`

**Interfaces:**
- Consumes: `detectLimit`'s `opts.trusted` parameter from Task 3.
- Produces: no signature changes.

Spec change 2, and the highest-value fix in this plan. Upstream gates the
**overload** scan on entry type, with the author's own comment: *"the user
pasting an error into the chat — or asking about one — must never kick off an
automatic retry."* The identical reasoning was never applied to limits.
Measured against the real `inspectLine`: **4 of 6 ordinary user questions armed
a timer.**

**The trap:** you cannot simply write `entry.type !== 'user'`. Claude Code
writes its own API-error notices as synthetic entries that can carry
`type: 'user'` alongside `isApiErrorMessage: true`. A bare type check would
suppress real limit detection — the exact failure this extension exists to
prevent. The gate must admit an entry that Claude Code itself flagged, which is
what the `trusted` term is for. Task 6's first test covers precisely this case
and must keep passing.

- [ ] **Step 1: Write the failing tests**

Append to `test/transcriptWatcher.test.ts`:

```ts
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

test('a flagged entry arms a timer even when its type is user', () => {
  const line = entry({
    type: 'user',
    isApiErrorMessage: true,
    message: { content: 'Claude AI usage limit reached. Try again in 5 hours' },
  });
  assert.ok(
    make().inspectLine(line, FILE).limit,
    'Claude Code writes its own error notices as user-type entries',
  );
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test
```

Expected: the first test fails on all four questions. The other two already
pass — they are there to pin the behaviour the fix must not break.

- [ ] **Step 3: Apply the gate**

In `inspectLine`, wrap the limit scan. Replace:

```ts
const flagged = isRateLimitEntry(entry);
const apiError = isApiErrorEntry(entry);
const maxWait = this.getMaxWaitHours();
const now = new Date();
for (const candidate of candidates) {
  if (candidate.length > MAX_NOTICE_LENGTH) {
    continue;
  }
  if (!flagged && looksLikeCode(candidate)) {
    continue;
  }
  const detection = detectLimit(candidate, now, maxWait);
  if (detection) {
    return { limit: { detection, cwd, file } };
  }
}
```

with:

```ts
const flagged = isRateLimitEntry(entry);
const apiError = isApiErrorEntry(entry);
const maxWait = this.getMaxWaitHours();
const now = new Date();

// The user pasting a limit notice into the chat - or asking about one - must
// never arm a resume timer. This is the same rule the overload scan below has
// always had; it was never applied to limits, and 4 of 6 ordinary user
// questions armed a timer as a result.
//
// `flagged` has to come first: Claude Code writes its own API-error notices as
// synthetic entries that can carry type "user", so a bare type check would
// suppress exactly the detection this extension exists for.
if (flagged || apiError || entry.type !== 'user') {
  for (const candidate of candidates) {
    if (candidate.length > MAX_NOTICE_LENGTH) {
      continue;
    }
    // Trusted entries skip the source-code guard inside detectLimit, which is
    // where that guard now lives.
    const detection = detectLimit(candidate, now, maxWait, { trusted: flagged });
    if (detection) {
      return { limit: { detection, cwd, file } };
    }
  }
}
```

The `!flagged && looksLikeCode(candidate)` line is deleted: that guard moved
inside `detectLimit` in Task 3, and `trusted` carries the same exemption.

- [ ] **Step 4: Run to verify they pass**

```bash
npm test
```

Expected: all green, including every Task 6 test.

- [ ] **Step 5: Commit**

```bash
git add src/transcriptWatcher.ts test/transcriptWatcher.test.ts
git commit -m "fix: apply the entry-type gate to the limit scan

The overload scan has always refused to act on user-typed entries. The limit
scan never did, so 4 of 6 ordinary questions about limits armed a resume
timer. Flagged entries stay admitted: Claude Code writes its own error
notices as user-type entries."
```

---
### Task 8: Session resolver

**Files:**
- Create: `src/sessionResolver.ts`
- Test: `test/sessionResolver.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ResolvedSession { sessionId: string; transcript: string; cwd?: string; bytes: number }`
  - `resolveSession(transcriptPath: string, cwd: string | undefined, statBytes: (p: string) => number): ResolvedSession | undefined`
  - `isSessionId(value: string): boolean`

Replaces upstream's `lastPrompt.js` fallback wholesale. `findLatestTranscript`
walked to the newest `.jsonl` **anywhere** under `~/.claude/projects/`, which
could resume an unrelated project's session with another project's prompt
(Finding #4). Detection already knows which file produced the hit, and the
filename *is* the session ID (verified during the spike), so no search is
needed at all.

`statBytes` is injected so the resolver is pure and testable; the caller passes
a real `fs.statSync(...).size`. The byte count feeds the budget estimate in
Task 9.

- [ ] **Step 1: Write the failing test**

Create `test/sessionResolver.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSession, isSessionId } from '../src/sessionResolver';

const ID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const FILE = `/home/u/.claude/projects/c--projects-example/${ID}.jsonl`;
const bytes = () => 1_618_394;

test('the transcript filename is the session id', () => {
  const s = resolveSession(FILE, 'C:\\projects\\example', bytes);
  assert.equal(s?.sessionId, ID);
  assert.equal(s?.transcript, FILE);
  assert.equal(s?.cwd, 'C:\\projects\\example');
  assert.equal(s?.bytes, 1_618_394);
});

test('works on Windows-style transcript paths', () => {
  const win = `C:\\Users\\u\\.claude\\projects\\c--projects-example\\${ID}.jsonl`;
  assert.equal(resolveSession(win, undefined, bytes)?.sessionId, ID);
});

test('refuses a filename that is not a session id', () => {
  const bad = '/home/u/.claude/projects/p/summary.jsonl';
  assert.equal(resolveSession(bad, undefined, bytes), undefined);
});

test('refuses a path that is not a transcript', () => {
  assert.equal(resolveSession(`/tmp/${ID}.txt`, undefined, bytes), undefined);
});

test('survives an unstattable file by reporting zero bytes', () => {
  const throwing = () => {
    throw new Error('ENOENT');
  };
  assert.equal(resolveSession(FILE, undefined, throwing)?.bytes, 0);
});

test('isSessionId accepts a uuid and rejects anything else', () => {
  assert.ok(isSessionId(ID));
  assert.equal(isSessionId('not-a-uuid'), false);
  assert.equal(isSessionId(`${ID} --dangerously-skip-permissions`), false);
  assert.equal(isSessionId(''), false);
});
```

The `--dangerously-skip-permissions` case is the point of the whole module: the
session ID becomes an argv element handed to a CLI, so it is validated at the
boundary rather than trusted because it came off the filesystem.

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: `Cannot find module '../src/sessionResolver'`.

- [ ] **Step 3: Write the implementation**

```ts
import * as path from 'node:path';

export interface ResolvedSession {
  sessionId: string;
  transcript: string;
  cwd?: string;
  bytes: number;
}

/**
 * Claude Code names each transcript for its session, so the id is a v4 uuid.
 * Validated rather than trusted: this value is handed to a CLI as an argv
 * element, and a filename is attacker-influenced input on a shared machine.
 */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

/**
 * Turn the transcript that produced a detection into a resume target.
 *
 * There is deliberately no search here. Upstream fell back to the newest
 * transcript anywhere under ~/.claude/projects, which could pair one project's
 * session with another project's prompt.
 */
export function resolveSession(
  transcriptPath: string,
  cwd: string | undefined,
  statBytes: (p: string) => number,
): ResolvedSession | undefined {
  if (path.extname(transcriptPath).toLowerCase() !== '.jsonl') {
    return undefined;
  }
  const sessionId = path.basename(transcriptPath, path.extname(transcriptPath));
  if (!isSessionId(sessionId)) {
    return undefined;
  }
  let bytes = 0;
  try {
    bytes = statBytes(transcriptPath);
  } catch {
    // A rotated or deleted transcript still has a usable id; the budget check
    // treats zero as "unknown" and falls back to asking.
  }
  return { sessionId, transcript: transcriptPath, cwd, bytes };
}
```

Note: `path.basename` on POSIX does not split Windows separators, so the
Windows test above passes only because the final segment is still extracted by
`path.win32` semantics on win32 and by the last `/` on POSIX. If the Windows
test fails on a POSIX CI runner, split on both separators explicitly:
`transcriptPath.split(/[\\/]/).pop()!`.

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/sessionResolver.ts test/sessionResolver.test.ts
git commit -m "feat: resolve the resume target from the detecting transcript

The filename is the session id, so no most-recent-file search is needed -
and that search was how one project's session could be resumed with another
project's prompt."
```

---

### Task 9: Token budget

**Files:**
- Create: `src/budget.ts`
- Test: `test/budget.test.ts`

**Interfaces:**
- Consumes: `ResolvedSession` from `src/sessionResolver`.
- Produces:
  - `BYTES_PER_TOKEN: 5.6`
  - `estimateResumeTokens(bytes: number): number`
  - `interface BudgetVerdict { allowed: boolean; estimate: number; limit: number; reason?: string }`
  - `checkBudget(bytes: number, maxResumeTokens: number): BudgetVerdict`
  - `class IncidentBudget` with `add(tokens: number): void`, `get total(): number`, `exceeded(cap: number): boolean`, `reset(): void`

Replaces upstream's `overloadMaxAttempts: 6`, which counts attempts with no
idea what each costs. A usage-limit wait guarantees a **cold prompt cache**, so
resuming a large session reprocesses its whole history. Calibration point from
the spike: 1,618,394 bytes produced 288,574 cache-creation tokens.

- [ ] **Step 1: Write the failing test**

Create `test/budget.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: `Cannot find module '../src/budget'`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Bytes of transcript per cache-creation token, calibrated from one measured
 * resume: 1,618,394 bytes -> 288,574 tokens. One data point, so this is an
 * order-of-magnitude guard rather than an accounting figure. Recalibrate as
 * real numbers accumulate.
 */
export const BYTES_PER_TOKEN = 5.6;

export function estimateResumeTokens(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  return Math.round(bytes / BYTES_PER_TOKEN);
}

export interface BudgetVerdict {
  allowed: boolean;
  estimate: number;
  limit: number;
  reason?: string;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * Pre-flight check. A usage-limit wait guarantees a cold prompt cache, so a
 * resume reprocesses the whole session history - recovery competes with the
 * quota it is recovering.
 */
export function checkBudget(bytes: number, maxResumeTokens: number): BudgetVerdict {
  const estimate = estimateResumeTokens(bytes);
  if (maxResumeTokens <= 0) {
    return { allowed: true, estimate, limit: maxResumeTokens };
  }
  if (estimate > maxResumeTokens) {
    return {
      allowed: false,
      estimate,
      limit: maxResumeTokens,
      reason:
        `Resuming this session is estimated at ~${fmt(estimate)} tokens, ` +
        `over the ${fmt(maxResumeTokens)} limit.`,
    };
  }
  return { allowed: true, estimate, limit: maxResumeTokens };
}

/**
 * Post-flight accounting across one incident. Only headless mode can feed this:
 * `--output-format json` returns a `usage` block, while the default interactive
 * mode returns nothing to read. Enforcement in interactive mode is therefore
 * estimate-only, which the settings description states plainly.
 */
export class IncidentBudget {
  private spent = 0;

  add(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.spent += tokens;
    }
  }

  get total(): number {
    return this.spent;
  }

  exceeded(cap: number): boolean {
    return cap > 0 && this.spent > cap;
  }

  reset(): void {
    this.spent = 0;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/budget.ts test/budget.test.ts
git commit -m "feat: estimate and cap the token cost of a resume

Replaces a fixed attempt count with a pre-flight estimate, because a cold
cache after a limit wait means a resume reprocesses the entire session."
```

---

### Task 10: Resumer

**Files:**
- Create: `src/resumer.ts`
- Test: `test/resumer.test.ts`

**Interfaces:**
- Consumes: `ResolvedSession` from `src/sessionResolver`; `Logger` from `src/log`.
- Produces:
  - `interface Launcher { file: string; args: string[] }`
  - `resolveClaudeLauncher(configured: string, platform: NodeJS.Platform, which: (cmd: string) => string | undefined, readShim: (p: string) => string | undefined): Launcher | undefined`
  - `buildResumeArgs(sessionId: string, prompt: string): string[]`
  - `buildHeadlessArgs(sessionId: string, prompt: string, permissionMode: string): string[]`
  - `buildTerminalOptions(session: ResolvedSession, prompt: string, launcher: Launcher): TerminalOptionsLike`
  - `interface TerminalOptionsLike { name: string; cwd?: string; shellPath: string; shellArgs: string[]; isTransient: boolean }`

**This is the security centre of the project.** Three rules, all testable:

1. The prompt is an **argv element**, never a string a shell parses. VS Code's
   `TerminalOptions.shellArgs` is passed to the child process as argv — no shell
   is involved, which is what makes `$(1+41)` inert. Upstream's `quoteForShell`
   double-quoted on Windows, where PowerShell expands `$(...)` inside double
   quotes; verified evaluating to `42`.
2. A **fresh** terminal every time. Never `activeTerminal`, never `sendText`.
   If Claude has died, upstream's `sendText` hands the prompt to whatever shell
   is sitting there.
3. **No `--permission-mode`** in interactive mode. Interactive resume already
   runs at the user's normal autonomy (verified during the spike), so the flag
   would only ever escalate.

- [ ] **Step 1: Write the failing test**

Create `test/resumer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResumeArgs,
  buildHeadlessArgs,
  buildTerminalOptions,
  resolveClaudeLauncher,
} from '../src/resumer';
import type { ResolvedSession } from '../src/sessionResolver';

const ID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const session: ResolvedSession = {
  sessionId: ID,
  transcript: `/h/.claude/projects/p/${ID}.jsonl`,
  cwd: '/projects/example',
  bytes: 1000,
};

test('the prompt is a single argv element, never concatenated', () => {
  const args = buildResumeArgs(ID, 'continue where you left off');
  assert.deepEqual(args, ['--resume', ID, 'continue where you left off']);
});

test('shell metacharacters stay inert because nothing quotes them', () => {
  const hostile = '$(1+41) `whoami` && rm -rf / ; "quoted"';
  const args = buildResumeArgs(ID, hostile);
  assert.equal(args.length, 3);
  assert.equal(args[2], hostile, 'prompt is passed through verbatim as one argument');
  assert.ok(!args.some((a) => a.includes('""')), 'no hand-quoting anywhere');
});

test('interactive resume never sets a permission mode', () => {
  const args = buildResumeArgs(ID, 'go');
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('interactive resume never uses --continue', () => {
  assert.ok(!buildResumeArgs(ID, 'go').includes('--continue'));
});

test('headless mode asks for json and carries an explicit permission mode', () => {
  const args = buildHeadlessArgs(ID, 'go', 'acceptEdits');
  assert.deepEqual(args, [
    '-p', '--resume', ID, 'go', '--output-format', 'json', '--permission-mode', 'acceptEdits',
  ]);
});

test('headless mode omits the flag when no mode is configured', () => {
  const args = buildHeadlessArgs(ID, 'go', '');
  assert.deepEqual(args, ['-p', '--resume', ID, 'go', '--output-format', 'json']);
});

test('terminal options launch claude directly, with no shell', () => {
  const opts = buildTerminalOptions(session, 'go', { file: '/usr/bin/claude', args: [] });
  assert.equal(opts.shellPath, '/usr/bin/claude');
  assert.deepEqual(opts.shellArgs, ['--resume', ID, 'go']);
  assert.equal(opts.cwd, '/projects/example');
  assert.match(opts.name, /Limit Buster/);
  assert.ok(opts.name.includes(ID.slice(0, 8)));
});

test('a node-shim launcher prepends its own args before the resume args', () => {
  const opts = buildTerminalOptions(session, 'go', {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
  });
  assert.deepEqual(opts.shellArgs, [
    'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    '--resume',
    ID,
    'go',
  ]);
});

test('an explicitly configured binary is used as-is', () => {
  const l = resolveClaudeLauncher('/opt/claude/bin/claude', 'linux', () => undefined, () => undefined);
  assert.deepEqual(l, { file: '/opt/claude/bin/claude', args: [] });
});

test('on posix the binary is found on PATH', () => {
  const l = resolveClaudeLauncher('', 'linux', (c) => (c === 'claude' ? '/usr/local/bin/claude' : undefined), () => undefined);
  assert.deepEqual(l, { file: '/usr/local/bin/claude', args: [] });
});

test('on windows a .cmd shim resolves to node plus the cli entry point', () => {
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const l = resolveClaudeLauncher(
    '',
    'win32',
    (c) => (c === 'claude' ? 'C:\\npm\\claude.cmd' : c === 'node' ? 'C:\\nodejs\\node.exe' : undefined),
    () => shim,
  );
  assert.equal(l?.file, 'C:\\nodejs\\node.exe');
  assert.equal(l?.args.length, 1);
  assert.match(l!.args[0]!, /cli\.js$/);
});

test('resolution fails cleanly when claude is not on PATH', () => {
  assert.equal(resolveClaudeLauncher('', 'linux', () => undefined, () => undefined), undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

Expected: `Cannot find module '../src/resumer'`.

- [ ] **Step 3: Write the implementation**

```ts
import * as path from 'node:path';
import type { ResolvedSession } from './sessionResolver';

export interface Launcher {
  /** Executable to spawn. Never a shell. */
  file: string;
  /** Arguments that must precede the claude arguments (a script path, usually). */
  args: string[];
}

export interface TerminalOptionsLike {
  name: string;
  cwd?: string;
  shellPath: string;
  shellArgs: string[];
  isTransient: boolean;
}

/**
 * Arguments for an interactive resume.
 *
 * The prompt is one array element. Nothing quotes it, because nothing parses
 * it: VS Code hands shellArgs to the child process as argv. Upstream built a
 * command string instead and double-quoted it on Windows, where PowerShell
 * expands $(...) inside double quotes - $(1+41) reached Claude as 42.
 *
 * No --permission-mode: an interactive resume already runs at the user's own
 * autonomy level, so the flag could only ever escalate it.
 *
 * No --continue: it resumes "the most recent interactive session", skipping -p,
 * SDK, background and /loop sessions. We know the id, so we name it.
 */
export function buildResumeArgs(sessionId: string, prompt: string): string[] {
  return ['--resume', sessionId, prompt];
}

/**
 * Arguments for opt-in headless mode. `--output-format json` returns a `usage`
 * block for post-flight accounting and structured `permission_denials`.
 *
 * Headless does NOT inherit the session's permission mode (verified: an
 * acceptEdits session resumed with -p was denied a Write), so an explicit mode
 * is required for it to do tool work. That is exactly why the setting is
 * machine-scoped and off by default.
 */
export function buildHeadlessArgs(sessionId: string, prompt: string, permissionMode: string): string[] {
  const args = ['-p', '--resume', sessionId, prompt, '--output-format', 'json'];
  if (permissionMode) {
    args.push('--permission-mode', permissionMode);
  }
  return args;
}

export function buildTerminalOptions(
  session: ResolvedSession,
  prompt: string,
  launcher: Launcher,
): TerminalOptionsLike {
  return {
    name: `Limit Buster: ${session.sessionId.slice(0, 8)}`,
    cwd: session.cwd,
    shellPath: launcher.file,
    shellArgs: [...launcher.args, ...buildResumeArgs(session.sessionId, prompt)],
    isTransient: true,
  };
}

/**
 * Find something spawnable for `claude`.
 *
 * On Windows the PATH entry is usually `claude.cmd`, an npm shim. A .cmd is not
 * a PE image, so it cannot be spawned directly - and running it through cmd.exe
 * would reintroduce a command-line parser, which is the thing this module
 * exists to avoid. So the shim is read and its cli.js extracted, and node runs
 * that directly.
 */
export function resolveClaudeLauncher(
  configured: string,
  platform: NodeJS.Platform,
  which: (cmd: string) => string | undefined,
  readShim: (p: string) => string | undefined,
): Launcher | undefined {
  const found = configured.trim() || which('claude');
  if (!found) {
    return undefined;
  }
  const ext = path.extname(found).toLowerCase();
  if (platform !== 'win32' || (ext !== '.cmd' && ext !== '.bat' && ext !== '.ps1')) {
    return { file: found, args: [] };
  }
  const node = which('node');
  const shim = readShim(found);
  const entry = shim ? /"?([^"\s]+cli\.js)"?/.exec(shim)?.[1] : undefined;
  if (!node || !entry) {
    // Better to fail visibly than to fall back to a shell.
    return undefined;
  }
  const resolved = path.isAbsolute(entry) ? entry : path.resolve(path.dirname(found), entry);
  return { file: node, args: [resolved] };
}
```

The `%dp0%` in a real npm shim is a cmd variable, not a path this code can
expand. `path.resolve(path.dirname(found), entry)` handles the common relative
case; if the extracted entry still does not exist on disk, the caller logs and
reports that Claude could not be launched rather than guessing.

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/resumer.ts test/resumer.test.ts
git commit -m "feat: resume by launching claude directly with argv

The prompt is an argv element handed to a fresh terminal whose shell process
is claude itself, so no shell ever parses it and no existing terminal is
written to. Replaces upstream's sendText plus hand-quoting, which let
PowerShell subexpressions in recovered text execute."
```

---
### Task 11: Scheduler and jitter

**Files:**
- Create: `src/randomDelay.ts` (port of `upstream/extension/out/randomDelay.js`)
- Create: `src/scheduler.ts` (port of `upstream/extension/out/scheduler.js`)
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: `Logger` from `src/log`.
- Produces:
  - `randomJitterMs(minMinutes: number, maxMinutes: number): number`
  - ```ts
    export interface PendingJob {
      sessionId: string;
      transcript: string;
      cwd?: string;
      prompt: string;
      /** Deadline including jitter. What the scheduler fires on. */
      resumeAtMs: number;
      /** Deadline the notice actually stated, before jitter. Used for dedupe. */
      baseResumeAtMs: number;
      jitterMs: number;
      reason: 'limit' | 'overload';
    }
    export interface MementoLike {
      get<T>(key: string): T | undefined;
      update(key: string, value: unknown): Thenable<void>;
    }
    ```
  - `class ResumeScheduler` — constructor `(memento: MementoLike, log: Logger)`; members `current`, `msRemaining`, `schedule(job: PendingJob): boolean`, `cancel(): void`, `start(): void`, `dispose(): void`; events `onFire: Event<PendingJob>`, `onChange: Event<PendingJob | undefined>`.

Both port unchanged in behaviour. The scheduler compares wall-clock on a 1s
tick rather than arming one long `setTimeout`, which is what makes it survive
laptop sleep and a VS Code restart — a `setTimeout` for six hours does not.
State lives in a `Memento` so a pending resume survives a window reload.

Two changes from upstream: `log` is injected, and `PendingJob` carries
`sessionId`/`transcript` (upstream carried a terminal name and a prompt file).

- [ ] **Step 1: Port `randomDelay.ts`**

```ts
/**
 * Milliseconds of random padding to add to a resume deadline.
 *
 * Every client that saw the same reset time would otherwise reconnect on the
 * same second. Returns 0 when the window is degenerate.
 */
export function randomJitterMs(minMinutes: number, maxMinutes: number): number {
  const lo = Math.max(0, Math.min(minMinutes, maxMinutes));
  const hi = Math.max(0, Math.max(minMinutes, maxMinutes));
  if (hi <= 0) {
    return 0;
  }
  return Math.floor((lo + Math.random() * (hi - lo)) * 60_000);
}
```

- [ ] **Step 2: Port `scheduler.ts`**

Convert as in Task 2. Keep `STATE_KEY = 'claudeLimitBuster.pending'` (renamed
from upstream's namespace), `TICK_MS = 1000`, the `firing` re-entrancy guard,
the migration of `baseResumeAtMs`/`jitterMs` for stored jobs, and the dedupe
rule in `schedule` — *a later deadline never replaces an earlier one still
counting down*, because repeated limit notices for one cooldown would otherwise
push the resume further and further out.

Replace `log_1.log.x(...)` with `this.log.x(...)`.

- [ ] **Step 3: Write the tests**

Create `test/scheduler.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeStub } from './helpers/vscode';
import { randomJitterMs } from '../src/randomDelay';

installVscodeStub();

const { ResumeScheduler } = require('../src/scheduler') as typeof import('../src/scheduler');
import type { PendingJob, MementoLike } from '../src/scheduler';

const silent = { info() {}, warn() {}, error() {} };

function memento(seed?: Record<string, unknown>): MementoLike {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: <T>(k: string) => store.get(k) as T | undefined,
    update: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
  };
}

const job = (resumeAtMs: number): PendingJob => ({
  sessionId: '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234',
  transcript: '/h/p/0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234.jsonl',
  prompt: 'continue',
  resumeAtMs,
  baseResumeAtMs: resumeAtMs,
  jitterMs: 0,
  reason: 'limit',
});

test('scheduling stores the job', () => {
  const s = new ResumeScheduler(memento(), silent);
  assert.equal(s.schedule(job(Date.now() + 60_000)), true);
  assert.equal(s.current?.sessionId, '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234');
});

test('a later deadline never replaces an earlier one still counting down', () => {
  const s = new ResumeScheduler(memento(), silent);
  const early = Date.now() + 60_000;
  s.schedule(job(early));
  assert.equal(s.schedule(job(Date.now() + 600_000)), false);
  assert.equal(s.current?.resumeAtMs, early);
});

test('an earlier deadline does replace a later one', () => {
  const s = new ResumeScheduler(memento(), silent);
  s.schedule(job(Date.now() + 600_000));
  const sooner = Date.now() + 60_000;
  assert.equal(s.schedule(job(sooner)), true);
  assert.equal(s.current?.resumeAtMs, sooner);
});

test('a pending job survives reconstruction from the memento', () => {
  const m = memento();
  new ResumeScheduler(m, silent).schedule(job(Date.now() + 60_000));
  assert.equal(new ResumeScheduler(m, silent).current?.prompt, 'continue');
});

test('cancel clears the pending job', () => {
  const s = new ResumeScheduler(memento(), silent);
  s.schedule(job(Date.now() + 60_000));
  s.cancel();
  assert.equal(s.current, undefined);
});

test('a deadline already past fires on the first tick', async () => {
  const s = new ResumeScheduler(memento(), silent);
  const fired: PendingJob[] = [];
  s.onFire((j) => fired.push(j));
  s.schedule(job(Date.now() - 1000));
  s.start();
  await new Promise((r) => setTimeout(r, 1200));
  s.dispose();
  assert.equal(fired.length, 1, 'a deadline missed while closed must still fire');
});

test('jitter stays inside its window', () => {
  for (let i = 0; i < 200; i++) {
    const ms = randomJitterMs(5, 30);
    assert.ok(ms >= 5 * 60_000 && ms <= 30 * 60_000, String(ms));
  }
});

test('a zero window produces no jitter', () => {
  assert.equal(randomJitterMs(0, 0), 0);
});

test('a reversed window is treated as a window, not an error', () => {
  const ms = randomJitterMs(30, 5);
  assert.ok(ms >= 5 * 60_000 && ms <= 30 * 60_000);
});
```

- [ ] **Step 4: Run the tests**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts src/randomDelay.ts test/scheduler.test.ts
git commit -m "feat: port the wall-clock scheduler and resume jitter

Ticking against wall-clock rather than one long setTimeout is what lets a
six-hour cooldown survive sleep and a window reload."
```

---

### Task 12: Status bar and alert sound

**Files:**
- Create: `src/statusBar.ts` (port of `upstream/extension/out/statusBar.js`)
- Create: `src/sound.ts` (port of `upstream/extension/out/sound.js`, trimmed)
- Test: `test/sound.test.ts`

**Interfaces:**
- Consumes: `formatDuration` from `src/parsers/limitParser`.
- Produces:
  - `class CountdownStatusBar` — `update(job: PendingJob | undefined): void`, `dispose(): void`
  - `playAlertSound(options?: { file?: string }): void`
  - `buildSoundCommand(platform: NodeJS.Platform, file?: string): { file: string; args: string[] } | undefined`

Two deliberate removals from upstream's `sound.js`:

- **`soundCommand` is gone entirely.** Upstream read it at `config.js:61` and
  executed it at `sound.js:56-65` via `powershell.exe -Command`. It was
  undeclared in `package.json`, so it had no `scope` and a workspace-level
  `.vscode/settings.json` could set it — arbitrary command execution on
  detection, from a repo you merely opened. There is no replacement setting.
- **The Linux `/bin/sh -c` chain is gone.** Upstream built a shell string with
  a `shQuote` helper that replaced `'` with `'''` instead of `'\''`, so a path
  containing an apostrophe broke the command. Players are now spawned directly
  with argv and tried in turn, so no shell is involved and no quoting exists to
  get wrong.

- [ ] **Step 1: Write the failing test**

Create `test/sound.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSoundCommand } from '../src/sound';

test('macOS plays the file with afplay as an argument', () => {
  const c = buildSoundCommand('darwin', '/Users/u/my ping.aiff');
  assert.equal(c?.file, 'afplay');
  assert.deepEqual(c?.args, ['/Users/u/my ping.aiff']);
});

test('linux passes the path as an argument, never through a shell', () => {
  const c = buildSoundCommand('linux', "/home/u/o'brien/ping.oga");
  assert.notEqual(c?.file, '/bin/sh');
  assert.ok(!c?.args.includes('-c'));
  assert.ok(c?.args.includes("/home/u/o'brien/ping.oga"));
});

test('windows runs powershell with the profile disabled', () => {
  const c = buildSoundCommand('win32', 'C:\\snd\\ping.wav');
  assert.equal(c?.file, 'powershell.exe');
  assert.ok(c?.args.includes('-NoProfile'));
  assert.ok(c?.args.includes('-NonInteractive'));
});

test('an apostrophe in a windows path is doubled for the powershell literal', () => {
  const c = buildSoundCommand('win32', "C:\\o'brien\\ping.wav");
  const script = c!.args[c!.args.length - 1]!;
  assert.ok(script.includes("o''brien"), 'single quotes must be doubled inside a PS literal');
});

test('there is no way to supply an arbitrary command', () => {
  // The whole soundCommand escape hatch is gone; the only input is a file path.
  assert.equal(typeof (buildSoundCommand as unknown as { length: number }).length, 'number');
  assert.equal((buildSoundCommand as unknown as { length: number }).length, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

- [ ] **Step 3: Port `sound.ts` with the command builder extracted**

Extract the platform branches into the pure `buildSoundCommand` so they are
testable, and keep `playAlertSound` as the thin `spawn` wrapper. Keep upstream's
`psQuote` — doubling `'` is the correct escape for a single-quoted PowerShell
literal — and delete `shQuote` along with the shell chain it served.

```ts
import { spawn } from 'node:child_process';

/** Escape a path for embedding in a single-quoted PowerShell string. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const LINUX_PLAYERS = ['paplay', 'aplay', 'canberra-gtk-play'];

export function buildSoundCommand(
  platform: NodeJS.Platform,
  file?: string,
): { file: string; args: string[] } | undefined {
  switch (platform) {
    case 'win32': {
      const target = file
        ? psQuote(file)
        : `(Join-Path $env:WINDIR 'Media\\Windows Notify System Generic.wav')`;
      const script =
        `$p = ${target}; ` +
        `if (Test-Path -LiteralPath $p) { (New-Object Media.SoundPlayer $p).PlaySync() } ` +
        `else { [console]::beep(880, 250) }`;
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      };
    }
    case 'darwin':
      return { file: 'afplay', args: [file ?? '/System/Library/Sounds/Ping.aiff'] };
    default:
      // No single player is guaranteed on Linux. Each is spawned directly with
      // the path as argv; playAlertSound tries the next when one is missing.
      return {
        file: LINUX_PLAYERS[0]!,
        args: [file ?? '/usr/share/sounds/freedesktop/stereo/message.oga'],
      };
  }
}

/** Make a noise. Returns immediately; the sound plays in a detached process. */
export function playAlertSound(options: { file?: string } = {}): void {
  const cmd = buildSoundCommand(process.platform, options.file?.trim() || undefined);
  if (!cmd) {
    return;
  }
  const candidates = process.platform === 'linux'
    ? LINUX_PLAYERS.map((p) => ({ file: p, args: cmd.args }))
    : [cmd];
  tryEach(candidates);
}

function tryEach(candidates: { file: string; args: string[] }[]): void {
  const next = candidates[0];
  if (!next) {
    process.stderr.write('\x07'); // terminal bell, last resort
    return;
  }
  try {
    const child = spawn(next.file, next.args, { stdio: 'ignore', detached: true });
    child.on('error', () => tryEach(candidates.slice(1)));
    child.unref();
  } catch {
    tryEach(candidates.slice(1));
  }
}
```

- [ ] **Step 4: Port `statusBar.ts`**

Convert unchanged. It renders `formatDuration(msRemaining)` into a
`StatusBarItem` and exposes `update(job)`. Point its `command` at
`claudeLimitBuster.cancel`, registered in Task 14.

- [ ] **Step 5: Run to verify it passes**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/sound.ts src/statusBar.ts test/sound.test.ts
git commit -m "feat: port the status bar and alert sound without soundCommand

Drops the undeclared soundCommand setting, which a workspace could set to
run an arbitrary command through powershell -Command on detection, and
replaces the Linux shell chain with direct argv spawns."
```

---

### Task 13: Settings and typed config

**Files:**
- Modify: `package.json` (replace the empty `contributes` block)
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - ```ts
    export interface Settings {
      enabled: boolean;
      autoResume: boolean;
      resumeMode: 'interactive' | 'headless';
      headlessPermissionMode: '' | 'default' | 'acceptEdits' | 'plan';
      claudeCommand: string;
      resumePrompt: string;
      maxResumeTokens: number;
      maxWaitHours: number;
      transcriptPollSeconds: number;
      randomDelayMinMinutes: number;
      randomDelayMaxMinutes: number;
      notify: boolean;
      alertSound: boolean;
      alertSoundFile: string;
    }
    export interface ConfigSource { get<T>(key: string, fallback: T): T }
    export function readSettings(source: ConfigSource): Settings
    ```

**The scope column is a security control, not documentation.** Anything that
influences what gets executed is `"scope": "machine"`, so a workspace's
`.vscode/settings.json` cannot set it by being opened. That is the defect
behind Finding #3.

- [ ] **Step 1: Declare the settings**

Replace `"contributes": {}` in `package.json`:

```json
"contributes": {
  "commands": [
    { "command": "claudeLimitBuster.resumeNow", "title": "Claude Limit Buster: Resume Now" },
    { "command": "claudeLimitBuster.cancel", "title": "Claude Limit Buster: Cancel Pending Resume" },
    { "command": "claudeLimitBuster.showLog", "title": "Claude Limit Buster: Show Log" }
  ],
  "configuration": {
    "title": "Claude Limit Buster",
    "properties": {
      "claudeLimitBuster.enabled": {
        "type": "boolean", "default": true, "scope": "window",
        "description": "Watch Claude Code transcripts for usage limits and server errors."
      },
      "claudeLimitBuster.autoResume": {
        "type": "boolean", "default": true, "scope": "window",
        "description": "Resume automatically when the cooldown elapses. When off, the status bar offers a manual resume."
      },
      "claudeLimitBuster.resumeMode": {
        "type": "string", "enum": ["interactive", "headless"], "default": "interactive",
        "scope": "machine",
        "markdownDescription": "`interactive` opens a new terminal running Claude at your normal autonomy level. `headless` runs it with `-p` and needs an explicit permission mode to do any tool work. Machine-scoped: a workspace cannot change how the extension launches Claude."
      },
      "claudeLimitBuster.headlessPermissionMode": {
        "type": "string", "enum": ["", "default", "acceptEdits", "plan"], "default": "",
        "scope": "machine",
        "markdownDescription": "Permission mode passed to headless resumes. Empty means none, so tool calls are denied. Machine-scoped: a workspace must not be able to grant autonomy."
      },
      "claudeLimitBuster.claudeCommand": {
        "type": "string", "default": "", "scope": "machine",
        "markdownDescription": "Path to the `claude` executable. Empty auto-detects from PATH. Machine-scoped: this names the program that gets run."
      },
      "claudeLimitBuster.resumePrompt": {
        "type": "string", "default": "Continue where you left off.", "scope": "window",
        "description": "Prompt sent when resuming. Passed as a single argument, never through a shell."
      },
      "claudeLimitBuster.maxResumeTokens": {
        "type": "number", "default": 150000, "scope": "window",
        "markdownDescription": "Refuse to resume when the estimated cost exceeds this. A limit wait guarantees a cold cache, so a resume reprocesses the whole session. Measured against the **pre-flight estimate**, not actual usage. `0` disables the check."
      },
      "claudeLimitBuster.maxWaitHours": {
        "type": "number", "default": 24, "scope": "window",
        "description": "Ignore a reset time further out than this, which is usually a misparse."
      },
      "claudeLimitBuster.transcriptPollSeconds": {
        "type": "number", "default": 5, "scope": "window",
        "description": "Polling backstop interval, for when recursive file watching is unreliable."
      },
      "claudeLimitBuster.randomDelayMinMinutes": {
        "type": "number", "default": 5, "scope": "window",
        "description": "Minimum random padding added after a reset time."
      },
      "claudeLimitBuster.randomDelayMaxMinutes": {
        "type": "number", "default": 30, "scope": "window",
        "description": "Maximum random padding added after a reset time."
      },
      "claudeLimitBuster.notify": {
        "type": "boolean", "default": true, "scope": "window",
        "description": "Show a notification when a limit is detected and when a resume fires."
      },
      "claudeLimitBuster.alertSound": {
        "type": "boolean", "default": true, "scope": "window",
        "description": "Chime when Claude is waiting on you."
      },
      "claudeLimitBuster.alertSoundFile": {
        "type": "string", "default": "", "scope": "machine",
        "markdownDescription": "Sound file to play. Empty uses the system default. Machine-scoped: the path reaches a media player."
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSettings } from '../src/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = (values: Record<string, unknown> = {}) => ({
  get: <T>(key: string, fallback: T): T => (key in values ? (values[key] as T) : fallback),
});

test('defaults match the declared manifest defaults', () => {
  const s = readSettings(source());
  assert.equal(s.enabled, true);
  assert.equal(s.autoResume, true);
  assert.equal(s.resumeMode, 'interactive');
  assert.equal(s.headlessPermissionMode, '');
  assert.equal(s.maxResumeTokens, 150_000);
  assert.equal(s.maxWaitHours, 24);
});

test('an unknown resume mode falls back to interactive', () => {
  assert.equal(readSettings(source({ resumeMode: 'yolo' })).resumeMode, 'interactive');
});

test('an unknown permission mode falls back to none', () => {
  assert.equal(
    readSettings(source({ headlessPermissionMode: 'bypassPermissions' })).headlessPermissionMode,
    '',
    'bypassPermissions is not offered, and an injected value must not pass through',
  );
});

test('negative numbers are clamped rather than trusted', () => {
  const s = readSettings(source({ maxWaitHours: -5, transcriptPollSeconds: 0, maxResumeTokens: -1 }));
  assert.ok(s.maxWaitHours > 0);
  assert.ok(s.transcriptPollSeconds >= 1);
  assert.equal(s.maxResumeTokens, 0, 'a negative cap means disabled, not inverted');
});

test('every setting the code reads is declared in the manifest', () => {
  // Upstream read claudeTimeout.soundCommand without declaring it, which left
  // it with no scope - so a workspace could set it. This test is that finding,
  // frozen.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  );
  const declared = new Set(Object.keys(manifest.contributes.configuration.properties));
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'config.ts'), 'utf8');
  for (const m of src.matchAll(/get\(\s*'([a-zA-Z]+)'/g)) {
    assert.ok(
      declared.has(`claudeLimitBuster.${m[1]}`),
      `config.ts reads '${m[1]}' but package.json does not declare it`,
    );
  }
});

test('execution-adjacent settings are machine-scoped', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  );
  const props = manifest.contributes.configuration.properties;
  for (const key of ['resumeMode', 'headlessPermissionMode', 'claudeCommand', 'alertSoundFile']) {
    assert.equal(
      props[`claudeLimitBuster.${key}`].scope,
      'machine',
      `${key} influences what gets executed and must not be workspace-settable`,
    );
  }
});
```

The last two tests are the security findings turned into build failures. They
are the reason this task exists separately from Task 14.

- [ ] **Step 3: Write `src/config.ts`**

```ts
export interface Settings {
  enabled: boolean;
  autoResume: boolean;
  resumeMode: 'interactive' | 'headless';
  headlessPermissionMode: '' | 'default' | 'acceptEdits' | 'plan';
  claudeCommand: string;
  resumePrompt: string;
  maxResumeTokens: number;
  maxWaitHours: number;
  transcriptPollSeconds: number;
  randomDelayMinMinutes: number;
  randomDelayMaxMinutes: number;
  notify: boolean;
  alertSound: boolean;
  alertSoundFile: string;
}

export interface ConfigSource {
  get<T>(key: string, fallback: T): T;
}

const RESUME_MODES = ['interactive', 'headless'] as const;
const PERMISSION_MODES = ['', 'default', 'acceptEdits', 'plan'] as const;

const oneOf = <T extends readonly string[]>(list: T, value: unknown, fallback: T[number]): T[number] =>
  (list as readonly string[]).includes(value as string) ? (value as T[number]) : fallback;

const atLeast = (value: unknown, floor: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(floor, value) : fallback;

export function readSettings(c: ConfigSource): Settings {
  return {
    enabled: c.get('enabled', true),
    autoResume: c.get('autoResume', true),
    resumeMode: oneOf(RESUME_MODES, c.get('resumeMode', 'interactive'), 'interactive'),
    headlessPermissionMode: oneOf(PERMISSION_MODES, c.get('headlessPermissionMode', ''), ''),
    claudeCommand: c.get('claudeCommand', ''),
    resumePrompt: c.get('resumePrompt', 'Continue where you left off.'),
    maxResumeTokens: atLeast(c.get('maxResumeTokens', 150_000), 0, 150_000),
    maxWaitHours: atLeast(c.get('maxWaitHours', 24), 1, 24),
    transcriptPollSeconds: atLeast(c.get('transcriptPollSeconds', 5), 1, 5),
    randomDelayMinMinutes: atLeast(c.get('randomDelayMinMinutes', 5), 0, 5),
    randomDelayMaxMinutes: atLeast(c.get('randomDelayMaxMinutes', 30), 0, 30),
    notify: c.get('notify', true),
    alertSound: c.get('alertSound', true),
    alertSoundFile: c.get('alertSoundFile', ''),
  };
}
```

`bypassPermissions` is deliberately absent from `PERMISSION_MODES`. The
extension will not offer a setting whose effect is "run every tool call without
asking", and `oneOf` means a hand-edited settings file cannot smuggle it in.

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add package.json src/config.ts test/config.test.ts
git commit -m "feat: declare every setting, machine-scoping the executable ones

Adds a test asserting that each setting config.ts reads is declared, and
that execution-adjacent settings are machine-scoped - the two properties
whose absence upstream made soundCommand workspace-settable."
```

---
### Task 14: Resume policy and extension wiring

**Files:**
- Create: `src/policy.ts`
- Create: `src/extension.ts`
- Test: `test/policy.test.ts`

**Interfaces:**
- Consumes: `LimitHit`/`OverloadHit` from `src/transcriptWatcher`; `resolveSession`; `checkBudget`; `randomJitterMs`; `Settings`; `PendingJob`.
- Produces:
  - ```ts
    export type Plan =
      | { kind: 'schedule'; job: PendingJob; estimate: number }
      | { kind: 'refuse'; reason: string }
      | { kind: 'ignore'; reason: string };
    export function planResume(
      hit: { detection: { resumeAt?: Date; text: string }; cwd?: string; file: string },
      reason: 'limit' | 'overload',
      settings: Settings,
      statBytes: (p: string) => number,
      now: Date,
      jitter: (min: number, max: number) => number,
    ): Plan;
    ```
  - `activate(context: vscode.ExtensionContext): void`, `deactivate(): void`

All the decision-making lives in `policy.ts` as one pure function, so it can be
tested without a VS Code host. `extension.ts` is glue: construct, subscribe,
dispose. Resist putting any condition in `extension.ts` — anything with an `if`
in it belongs in `policy.ts` where a test can reach it.

- [ ] **Step 1: Write the failing policy test**

Create `test/policy.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planResume } from '../src/policy';
import { readSettings } from '../src/config';

const ID = '0b3d1f66-4c2e-4a1b-9f77-2a5d6e8c1234';
const FILE = `/h/.claude/projects/p/${ID}.jsonl`;
const NOW = new Date('2026-08-03T12:00:00Z');
const settings = (over: Record<string, unknown> = {}) =>
  readSettings({ get: <T>(k: string, f: T) => (k in over ? (over[k] as T) : f) });
const small = () => 100_000;
const noJitter = () => 0;

const hit = (resumeAt: Date, file = FILE) => ({
  detection: { resumeAt, text: 'Claude AI usage limit reached. Try again in 5 hours' },
  cwd: '/projects/example',
  file,
});

test('a limit hit schedules a job for the stated time plus jitter', () => {
  const at = new Date('2026-08-03T17:00:00Z');
  const p = planResume(hit(at), 'limit', settings(), small, NOW, () => 600_000);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.sessionId, ID);
  assert.equal(p.job.baseResumeAtMs, at.getTime());
  assert.equal(p.job.resumeAtMs, at.getTime() + 600_000);
  assert.equal(p.job.jitterMs, 600_000);
  assert.equal(p.job.cwd, '/projects/example');
  assert.equal(p.job.prompt, 'Continue where you left off.');
});

test('a transcript that is not a session is ignored, not guessed at', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z'), '/h/p/summary.jsonl'), 'limit', settings(), small, NOW, noJitter);
  assert.equal(p.kind, 'ignore');
  assert.match(p.reason, /session/i);
});

test('a session too expensive to resume is refused with the numbers', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), () => 5_000_000, NOW, noJitter);
  assert.equal(p.kind, 'refuse');
  assert.match(p.reason, /token/i);
});

test('the budget check can be disabled', () => {
  const p = planResume(
    hit(new Date('2026-08-03T17:00:00Z')), 'limit',
    settings({ maxResumeTokens: 0 }), () => 5_000_000, NOW, noJitter,
  );
  assert.equal(p.kind, 'schedule');
});

test('a disabled extension schedules nothing', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings({ enabled: false }), small, NOW, noJitter);
  assert.equal(p.kind, 'ignore');
});

test('an overload has no stated time and retries after jitter alone', () => {
  const p = planResume(
    { detection: { text: 'API Error: 529 Overloaded' }, cwd: '/projects/example', file: FILE },
    'overload', settings(), small, NOW, () => 300_000,
  );
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.job.reason, 'overload');
  assert.equal(p.job.resumeAtMs, NOW.getTime() + 300_000);
});

test('the estimate is reported so it can be surfaced before resuming', () => {
  const p = planResume(hit(new Date('2026-08-03T17:00:00Z')), 'limit', settings(), () => 560_000, NOW, noJitter);
  assert.equal(p.kind, 'schedule');
  if (p.kind !== 'schedule') return;
  assert.equal(p.estimate, 100_000);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test
```

- [ ] **Step 3: Write `src/policy.ts`**

```ts
import { resolveSession } from './sessionResolver';
import { checkBudget } from './budget';
import type { Settings } from './config';
import type { PendingJob } from './scheduler';

export type Plan =
  | { kind: 'schedule'; job: PendingJob; estimate: number }
  | { kind: 'refuse'; reason: string }
  | { kind: 'ignore'; reason: string };

export function planResume(
  hit: { detection: { resumeAt?: Date; text: string }; cwd?: string; file: string },
  reason: 'limit' | 'overload',
  settings: Settings,
  statBytes: (p: string) => number,
  now: Date,
  jitter: (min: number, max: number) => number,
): Plan {
  if (!settings.enabled) {
    return { kind: 'ignore', reason: 'Extension disabled.' };
  }
  const session = resolveSession(hit.file, hit.cwd, statBytes);
  if (!session) {
    // No fallback to "the newest transcript somewhere". Resuming a session we
    // cannot name is how one project's prompt lands in another project.
    return { kind: 'ignore', reason: `Not a session transcript: ${hit.file}` };
  }
  const verdict = checkBudget(session.bytes, settings.maxResumeTokens);
  if (!verdict.allowed) {
    return { kind: 'refuse', reason: verdict.reason ?? 'Over the token budget.' };
  }
  // An overload has no stated reset time, so the jitter *is* the backoff.
  const base = hit.detection.resumeAt?.getTime() ?? now.getTime();
  const jitterMs = jitter(settings.randomDelayMinMinutes, settings.randomDelayMaxMinutes);
  return {
    kind: 'schedule',
    estimate: verdict.estimate,
    job: {
      sessionId: session.sessionId,
      transcript: session.transcript,
      cwd: session.cwd,
      prompt: settings.resumePrompt,
      baseResumeAtMs: base,
      resumeAtMs: base + jitterMs,
      jitterMs,
      reason,
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npm test
```

- [ ] **Step 5: Write `src/extension.ts`**

Glue only. Every branch worth testing already lives in `policy.ts`.

```ts
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { createLogger } from './log';
import { readSettings } from './config';
import { TranscriptWatcher } from './transcriptWatcher';
import { ResumeScheduler, type PendingJob } from './scheduler';
import { CountdownStatusBar } from './statusBar';
import { planResume } from './policy';
import { randomJitterMs } from './randomDelay';
import { playAlertSound } from './sound';
import { buildTerminalOptions, resolveClaudeLauncher } from './resumer';
import { execFileSync } from 'node:child_process';

const NS = 'claudeLimitBuster';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Claude Limit Buster');
  const log = createLogger('limit-buster', (line) => channel.appendLine(line));
  const settings = () => readSettings(vscode.workspace.getConfiguration(NS));

  const scheduler = new ResumeScheduler(context.globalState, log);
  const status = new CountdownStatusBar();
  const watcher = new TranscriptWatcher(
    () => settings().maxWaitHours,
    () => settings().transcriptPollSeconds,
    log,
  );

  const statBytes = (p: string) => fs.statSync(p).size;

  const onDetection = (hit: Parameters<typeof planResume>[0], reason: 'limit' | 'overload') => {
    const s = settings();
    const plan = planResume(hit, reason, s, statBytes, new Date(), randomJitterMs);
    if (plan.kind === 'ignore') {
      log.info(plan.reason);
      return;
    }
    if (plan.kind === 'refuse') {
      log.warn(plan.reason);
      void vscode.window.showWarningMessage(`Claude Limit Buster: ${plan.reason}`);
      return;
    }
    if (scheduler.schedule(plan.job) && s.notify) {
      const at = new Date(plan.job.resumeAtMs).toLocaleTimeString();
      void vscode.window.showInformationMessage(
        `Claude Limit Buster: resuming at ${at} (~${plan.estimate.toLocaleString()} tokens).`,
      );
    }
  };

  const resume = (job: PendingJob) => {
    const s = settings();
    const which = (cmd: string) => {
      try {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        return execFileSync(finder, [cmd], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim() || undefined;
      } catch {
        return undefined;
      }
    };
    const readShim = (p: string) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    };
    const launcher = resolveClaudeLauncher(s.claudeCommand, process.platform, which, readShim);
    if (!launcher) {
      void vscode.window.showErrorMessage(
        'Claude Limit Buster: could not find the claude executable. Set claudeLimitBuster.claudeCommand.',
      );
      return;
    }
    const opts = buildTerminalOptions(
      { sessionId: job.sessionId, transcript: job.transcript, cwd: job.cwd, bytes: 0 },
      job.prompt,
      launcher,
    );
    // A NEW terminal, every time. Never activeTerminal, never sendText: if
    // Claude has died, the prompt would land in whatever shell is sitting there.
    const terminal = vscode.window.createTerminal(opts);
    terminal.show();
    log.info(`Resumed ${job.sessionId} in a new terminal.`);
  };

  context.subscriptions.push(
    channel,
    status,
    watcher,
    scheduler,
    watcher.onHit((h) => onDetection(h, 'limit')),
    watcher.onOverload((h) => onDetection(h, 'overload')),
    watcher.onInputNeeded(() => {
      const s = settings();
      if (s.alertSound) {
        playAlertSound({ file: s.alertSoundFile });
      }
    }),
    scheduler.onChange((job) => status.update(job)),
    scheduler.onFire((job) => {
      if (settings().autoResume) {
        resume(job);
      }
    }),
    vscode.commands.registerCommand(`${NS}.resumeNow`, () => {
      const job = scheduler.current;
      if (!job) {
        void vscode.window.showInformationMessage('Claude Limit Buster: nothing pending.');
        return;
      }
      scheduler.cancel();
      resume(job);
    }),
    vscode.commands.registerCommand(`${NS}.cancel`, () => scheduler.cancel()),
    vscode.commands.registerCommand(`${NS}.showLog`, () => channel.show()),
  );

  scheduler.start();
  void watcher.start();
  log.info('Claude Limit Buster active.');
}

export function deactivate(): void {
  /* subscriptions handle teardown */
}
```

Headless mode is declared in settings but not yet routed here; it is a
follow-up, and `resumeMode` reading `headless` currently falls through to the
interactive path. Note that in the log rather than pretending otherwise.

- [ ] **Step 6: Manual smoke test in the Extension Development Host**

`npm test` cannot exercise activation. Press `F5` and check, in order:

1. Output panel shows `Claude Limit Buster active.`
2. Run `Claude Limit Buster: Show Log` from the command palette.
3. In a terminal in that host window, append a synthetic limit line to a real
   transcript and confirm a notification and a status-bar countdown appear:
   ```bash
   ID=$(basename "$(ls -t ~/.claude/projects/*/*.jsonl | head -1)" .jsonl)
   printf '%s\n' '{"type":"assistant","isApiErrorMessage":true,"cwd":"'"$PWD"'","message":{"content":"Claude AI usage limit reached. Try again in 5 minutes"}}' \
     >> ~/.claude/projects/*/"$ID".jsonl
   ```
4. Run `Claude Limit Buster: Resume Now`. A **new** terminal must open, running
   `claude`, with no text typed into any existing terminal.
5. **Answer the open question from `docs/NEXT.md`:** if that session was created
   in the Claude Code *panel*, reopen it from Session history and check whether
   the resumed turn is rendered. Record the answer in `docs/NEXT.md`. If it does
   not render, this task gains a follow-up: prompt the user to reload the panel
   after a resume.

- [ ] **Step 7: Commit**

```bash
git add src/policy.ts src/extension.ts test/policy.test.ts
git commit -m "feat: wire detection to scheduling and terminal resume

All branching lives in policy.ts as a pure function; extension.ts only
constructs, subscribes and disposes."
```

---

### Task 15: CI, packaging gate, and corpus retirement

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `docs/NEXT.md`
- Modify: `test/corpus/README.md`
- Delete: `test/corpus/parser-corpus.js`, `test/corpus/diagnose-failures.js`, `test/corpus/watcher-e2e.js`

**Interfaces:**
- Consumes: everything.
- Produces: a CI run that fails if `LICENSE` or `THIRDPARTY.md` is missing from the packaged `.vsix`.

The packaging gate is the one attribution detail that can silently break at
release time — MIT requires the notice to accompany the distributed artifact,
and the `.vsix` is the artifact, not the repository.

- [ ] **Step 1: Write the workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm test

  package:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npx --yes @vscode/vsce package --out limit-buster.vsix
      - name: Attribution files must ship inside the vsix
        run: |
          set -euo pipefail
          for f in LICENSE THIRDPARTY.md; do
            unzip -l limit-buster.vsix | grep -q "extension/$f" \
              || { echo "::error::$f is missing from the .vsix"; exit 1; }
          done
          echo "LICENSE and THIRDPARTY.md are present."
      - uses: actions/upload-artifact@v4
        with:
          name: vsix
          path: limit-buster.vsix
```

The matrix includes Windows because the Windows launcher path in
`resolveClaudeLauncher` and the PowerShell escaping in `sound.ts` are exactly
where a POSIX-only CI would miss a regression.

- [ ] **Step 2: Verify the gate actually fails when it should**

Temporarily add `LICENSE` to `.vscodeignore`, run the package step locally, and
confirm the check reports the error. Then revert.

```bash
npx --yes @vscode/vsce package --out /tmp/probe.vsix
unzip -l /tmp/probe.vsix | grep -E "LICENSE|THIRDPARTY"
```

A gate that has never been seen to fail is not a gate.

- [ ] **Step 3: Retire the throwaway harnesses**

Every case in `test/corpus/*.js` now lives in `test/parsers/` and
`test/transcriptWatcher.test.ts` as a real test against our own source. The
harnesses `require()` upstream by path and cannot run in CI.

```bash
git rm test/corpus/parser-corpus.js test/corpus/diagnose-failures.js test/corpus/watcher-e2e.js
```

Rewrite `test/corpus/README.md` to a short note recording where the cases went
and what is still missing:

```markdown
# Corpus notes

The detection fixtures that used to live here as standalone harnesses are now
real tests in [../parsers/](../parsers/) and
[../transcriptWatcher.test.ts](../transcriptWatcher.test.ts).

## Known gap

**Every fixture is synthetic**, written from documented formats. No real
captured limit entry exists in this suite. Capture one the first time a real
usage limit is hit and add it — that is the highest-value single addition here.
```

- [ ] **Step 4: Update `docs/NEXT.md`**

Remove the "Not yet pushed" section (done), replace "Then" with a pointer to
this plan, and record the answer to the panel-rendering question from Task 14
step 6.

- [ ] **Step 5: Run everything once more and commit**

```bash
npm test
git add -A
git commit -m "ci: build, test on linux and windows, and gate on packaged notices

A release that ships a .vsix without LICENSE and THIRDPARTY.md is not MIT
compliant, and nothing else would catch it."
git push
```

---

## Self-Review

Run against [the spec](../../design/2026-09-01-design.md) after the plan is written.

**Spec coverage**

| Spec section | Task |
|---|---|
| Goal 1 — detect for panel and terminal alike | 2, 4, 6 (transcript-based, so client-agnostic) |
| Goal 2 — resume the correct session unattended | 8, 10, 14 |
| Goal 3 — never escalate autonomy | 10 (no `--permission-mode`), 13 (machine scope, no `bypassPermissions`) |
| Goal 4 — bound token spend | 9, 14 |
| Finding 1 — raw `sendText` | 10, 14 |
| Finding 2 — PowerShell quoting | 10 |
| Finding 3 — `soundCommand` | 12, 13 |
| Finding 4 — cross-project prompt leak | 8 |
| Finding 5 — broad transcript read | 6 (carried caps: `MAX_READ_BYTES`, `MAX_NOTICE_LENGTH`, depth 6) |
| Finding 6 — false positives, unguarded terminal path | 3, 7 |
| Parser change 1 — guard inside `detectLimit` | 3 |
| Parser change 2 — entry-type gate on limits | 7 |
| Parser change 3 — two gate lists | 3 (`your limit`), 5 (`socket hang up`) |
| `sessionResolver` | 8 |
| `budget` pre-flight | 9 |
| `resumer` rewrite | 10 |
| Carried: scheduler, jitter, status bar, sound | 11, 12 |
| Settings table + machine scope | 13 |
| Testing: corpus as regression suite | 2, 4, 6, 15 |
| Repo: CI runs build and tests, `.vsix` on releases | 15 |

**Known deferrals, stated rather than hidden:**

- **Headless mode is declared but not routed.** `resumeMode: headless` falls
  through to the interactive path in Task 14. `buildHeadlessArgs` and
  `IncidentBudget` exist and are tested, so wiring it is a small follow-up — but
  it is not done in this plan, and the spec lists it as optional and off by
  default.
- **Post-flight accounting for interactive mode** stays deferred, exactly as the
  spec's Open items describe. Reading real `usage` back from assistant entries
  would widen the parsing surface this design deliberately shrinks.
- **The bytes-per-token divisor rests on one measurement.** Task 9's test holds
  it to within 5% of that single point, which catches a broken estimator but
  says nothing about accuracy across sessions.
- **Every detection fixture is synthetic.** Recorded in Task 15's corpus note.

**Type consistency:** `LimitDetection`, `OverloadDetection`, `InputDetection`,
`InspectResult`, `ResolvedSession`, `BudgetVerdict`, `Launcher`,
`TerminalOptionsLike`, `Settings`, `PendingJob`, `MementoLike`, and `Plan` are
each defined once, in the task named in the Interfaces block, and referenced by
that exact name afterwards. `detectLimit`'s signature changes once, in Task 3,
and Task 7 is the only caller that passes the new parameter.
