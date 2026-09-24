import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { isTurnEndEntry, InputDetection } from './parsers/inputParser';
import { detectLimit, MAX_NOTICE_LENGTH, LimitDetection } from './parsers/limitParser';
import type { Logger } from './log';
import { detectOverload, OverloadDetection } from './parsers/overloadParser';

/** Never read more than this from one file in a single pass. */
const MAX_READ_BYTES = 2_000_000;

export function transcriptRoot(): string {
    return path.join(os.homedir(), '.claude', 'projects');
}

export interface LimitHit { detection: LimitDetection; cwd?: string; file: string }
export interface OverloadHit { detection: OverloadDetection; cwd?: string; file: string }
export interface InputHit { detection: InputDetection; cwd?: string; file: string }
export interface InspectResult { limit?: LimitHit; overload?: OverloadHit; inputNeeded?: InputHit }

export type WatchMode = 'machine' | 'workspace';

/**
 * What the watcher should react to. `folders` is only consulted in
 * `'workspace'` mode; in `'machine'` mode every cwd is in scope.
 */
export interface WatchScope {
    mode: WatchMode;
    folders: readonly string[];
}

/**
 * Today's behaviour, unconditionally: every session on the machine matters.
 * This is what a caller gets by not passing a scope at all (see the 4th
 * constructor argument below), so the default cannot regress by omission.
 */
export const DEFAULT_SCOPE: WatchScope = { mode: 'machine', folders: [] };

/**
 * Whether a transcript entry's cwd is in scope, given an injected scope.
 *
 * Pure and filesystem-free, mirroring `isInsideWorkspace` in
 * src/extension.ts on purpose: same resolved-path, separator-boundary
 * comparison (so /work/app does not swallow /work/app-old) and the same case
 * fold, because a Windows path recorded by the CLI need not match the casing
 * VS Code reports for the same folder. Duplicated rather than imported, so
 * this module - which extension.ts wires up, not the other way round - has
 * no dependency in that direction.
 */
export function isInScope(cwd: string | undefined, scope: WatchScope): boolean {
    if (scope.mode === 'machine') {
        return true;
    }
    if (!cwd) {
        return false;
    }
    const key = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    const target = key(cwd);
    return scope.folders.some((folder) => {
        const root = key(folder);
        return target === root || target.startsWith(root + path.sep);
    });
}

/** One offsets entry: how far into `file` has been read, and when it last grew. */
export interface OffsetEntry {
    offset: number;
    lastActivity: number;
}

/**
 * How long an offset entry may go without its file growing before it is
 * evicted by {@link pruneOffsets}.
 *
 * Derived from this machine's own ~/.claude/projects, not guessed: of 184
 * transcripts present today, 156 (85%) live under a subagents/ directory and
 * are written once, during a single agent run, then never touched again -
 * the process that could grow them exits before the watcher would ever
 * consider pruning it. Only the 28 top-level session files are plausibly
 * resumed after a gap. The oldest file on disk is 46 days old at this
 * 184-file count (~4 new files/day), so 30 days comfortably clears the bulk
 * of the tree while leaving a resumed project a wide margin.
 *
 * A file that does resume after sitting idle this long is read from byte
 * zero rather than from where it left off - the same tradeoff `previous ===
 * undefined` in scanFile already accepts for a session that predates this
 * process - and MAX_READ_BYTES above bounds how much of that replay a single
 * pass actually looks at.
 */
export const MAX_OFFSET_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Hard ceiling on tracked files, independent of age: a backstop for a clock
 * that cannot advance (e.g. every file touched more often than
 * {@link MAX_OFFSET_IDLE_MS}), not the primary mechanism. This machine
 * reached 184 files after 46 days of continuous use (~4/day); 2000 is
 * roughly a year of that rate, far past what the idle bound alone is
 * expected to need.
 */
export const MAX_OFFSET_ENTRIES = 2000;

/**
 * Decide which offset entries survive a prune pass.
 *
 * Pure and Map-free: `existing` is whatever the caller's own directory
 * listing turned up, `now` is the caller's own clock, so this is testable
 * without a filesystem or a real timer. Existence is checked before age - a
 * just-deleted file is dropped immediately regardless of how recently it was
 * active - and the count cap is a last-resort pass, applied only if the
 * first two were not enough.
 */
export function pruneOffsets(
    entries: ReadonlyMap<string, OffsetEntry>,
    existing: ReadonlySet<string>,
    now: number,
    idleMs: number = MAX_OFFSET_IDLE_MS,
    maxEntries: number = MAX_OFFSET_ENTRIES,
): Map<string, OffsetEntry> {
    const kept = new Map<string, OffsetEntry>();
    for (const [file, entry] of entries) {
        if (!existing.has(file)) {
            continue;
        }
        if (now - entry.lastActivity > idleMs) {
            continue;
        }
        kept.set(file, entry);
    }
    if (kept.size > maxEntries) {
        // Oldest activity first: whatever has been quiet longest goes first.
        const oldestFirst = [...kept.entries()].sort((a, b) => a[1].lastActivity - b[1].lastActivity);
        for (const [file] of oldestFirst.slice(0, kept.size - maxEntries)) {
            kept.delete(file);
        }
    }
    return kept;
}

/**
 * Tails Claude Code's session transcripts.
 *
 * Claude Code appends one JSON object per line to
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, so a limit notice shows
 * up there whether the session runs in a VS Code terminal, an external one, or
 * another editor entirely. Only bytes appended after start-up are examined,
 * which keeps old cooldowns in the history from arming a timer.
 */
export class TranscriptWatcher {
    private readonly onHitEmitter = new vscode.EventEmitter<LimitHit>();
    readonly onHit = this.onHitEmitter.event;

    private readonly onOverloadEmitter = new vscode.EventEmitter<OverloadHit>();
    /** Fires on a transient server error, which wants a retry rather than a wait. */
    readonly onOverload = this.onOverloadEmitter.event;

    private readonly onInputNeededEmitter = new vscode.EventEmitter<InputHit>();
    /** Fires when an assistant turn ends, which hands the conversation back. */
    readonly onInputNeeded = this.onInputNeededEmitter.event;

    private watcher?: fs.FSWatcher;
    private poll?: NodeJS.Timeout;
    private debounce?: NodeJS.Timeout;
    private scanning = false;
    private readonly offsets = new Map<string, OffsetEntry>();

    constructor(
        private readonly getMaxWaitHours: () => number,
        private readonly getPollSeconds: () => number,
        private readonly log: Logger,
        // Defaults to machine mode - today's behaviour - so every existing
        // caller (extension.ts, and every test that constructs a watcher
        // without a 4th argument) is unaffected by this parameter existing.
        private readonly getScope: () => WatchScope = () => DEFAULT_SCOPE,
    ) {}

    async start(): Promise<void> {
        const root = transcriptRoot();
        try {
            await fsp.access(root);
        }
        catch {
            this.log.warn(`No Claude transcripts at ${root}; transcript watching is off.`);
            return;
        }
        // Baseline every existing file at its current length so history is skipped.
        const startedAt = Date.now();
        for (const file of await this.listTranscripts(root)) {
            try {
                const stat = await fsp.stat(file);
                this.offsets.set(file, { offset: stat.size, lastActivity: startedAt });
            }
            catch {
                /* file vanished between listing and stat; it will be picked up later */
            }
        }
        this.log.info(`Transcript watcher started on ${root} (${this.offsets.size} existing files).`);
        try {
            this.watcher = fs.watch(root, { recursive: true }, () => this.scheduleScan());
            this.watcher.on('error', (err) => this.log.warn(`Transcript watch error: ${String(err)}`));
        }
        catch (err) {
            this.log.warn(`Recursive watch unavailable (${String(err)}); relying on polling.`);
        }
        // Polling backstop: recursive fs.watch is unreliable across platforms and
        // network drives, and misses writes that never touch directory metadata.
        this.poll = setInterval(() => this.scheduleScan(), this.getPollSeconds() * 1000);
    }

    private scheduleScan(): void {
        if (this.debounce) {
            clearTimeout(this.debounce);
        }
        this.debounce = setTimeout(() => void this.scan(), 300);
    }

    private async listTranscripts(root: string): Promise<string[]> {
        const out: string[] = [];
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(root, { withFileTypes: true, recursive: true });
        }
        catch (err) {
            this.log.warn(`Cannot list ${root}: ${String(err)}`);
            return out;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }
            // parentPath is set on recursive readdir results from Node 20.12;
            // the old Dirent.path alias was removed in Node 24, which is what
            // VS Code 1.138 (Electron 42) runs.
            const parent = entry.parentPath ?? root;
            out.push(path.join(parent, entry.name));
        }
        return out;
    }

    private async scan(): Promise<void> {
        if (this.scanning) {
            return;
        }
        this.scanning = true;
        try {
            const files = await this.listTranscripts(transcriptRoot());
            for (const file of files) {
                await this.scanFile(file);
            }
            // Bound offsets here rather than in scanFile: this is the one place
            // that already knows the full current listing, which pruneOffsets
            // needs to tell "gone" from "just quiet".
            this.prune(files);
        }
        catch (err) {
            this.log.warn(`Transcript scan failed: ${String(err)}`);
        }
        finally {
            this.scanning = false;
        }
    }

    private prune(existingFiles: readonly string[]): void {
        const survivors = pruneOffsets(this.offsets, new Set(existingFiles), Date.now());
        if (survivors.size === this.offsets.size) {
            return;
        }
        this.offsets.clear();
        for (const [file, offsetEntry] of survivors) {
            this.offsets.set(file, offsetEntry);
        }
    }

    private async scanFile(file: string): Promise<void> {
        let size: number;
        try {
            size = (await fsp.stat(file)).size;
        }
        catch {
            return;
        }
        const now = Date.now();
        const previous = this.offsets.get(file);
        if (previous === undefined) {
            // A session started after we booted: read it from the beginning.
            this.offsets.set(file, { offset: 0, lastActivity: now });
        }
        else if (size < previous.offset) {
            // Truncated or replaced; start over rather than reading garbage.
            this.offsets.set(file, { offset: 0, lastActivity: now });
        }
        else if (size === previous.offset) {
            // Nothing new. lastActivity is deliberately left untouched here -
            // it tracks real growth, not "we looked" - which is what makes it
            // usable as an idle signal for pruneOffsets.
            return;
        }
        let from = this.offsets.get(file)?.offset ?? 0;
        if (size - from > MAX_READ_BYTES) {
            from = size - MAX_READ_BYTES;
        }
        let text: string;
        let handle: fsp.FileHandle | undefined;
        try {
            handle = await fsp.open(file, 'r');
            const length = size - from;
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, from);
            text = buffer.toString('utf8');
        }
        catch (err) {
            this.log.info(`Cannot read ${file}: ${String(err)}`);
            return;
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
        // Only consume through the last complete line; the tail may still be mid-write.
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) {
            return;
        }
        this.offsets.set(file, {
            offset: from + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'),
            lastActivity: now,
        });
        let overload: OverloadHit | undefined;
        let inputNeeded: InputHit | undefined;
        for (const line of text.slice(0, lastNewline).split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            const scan = this.inspectLine(trimmed, file);
            if (scan.limit) {
                // A usage limit outranks everything else in the batch: it means waiting,
                // and retrying into a limit only burns attempts against a closed door.
                this.log.info(`Limit detected in transcript ${path.basename(file)}: ${scan.limit.detection.text}`);
                this.onHitEmitter.fire(scan.limit);
                return;
            }
            // Keep the last overload rather than the first: a burst of failures writes
            // several, and the freshest one describes the state the session is in now.
            overload = scan.overload ?? overload;
            inputNeeded = scan.inputNeeded ?? inputNeeded;
        }
        if (overload) {
            this.log.info(`Server overload in transcript ${path.basename(file)}: ${overload.detection.text}`);
            this.onOverloadEmitter.fire(overload);
            // A failed turn is not an invitation to type: the session is being
            // recovered, and announcing it as "your turn" would be a lie.
            return;
        }
        if (inputNeeded) {
            this.log.info(`Turn ended in transcript ${path.basename(file)}; input awaited.`);
            this.onInputNeededEmitter.fire(inputNeeded);
        }
    }

    public inspectLine(line: string, file: string): InspectResult {
        let entry: Record<string, unknown>;
        try {
            entry = JSON.parse(line);
        }
        catch {
            // A partially written line; the next pass will see it complete.
            return {};
        }
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        // Scope is checked as early as it can be: cwd only exists once the line
        // is parsed, but nothing past this point - candidate collection, the
        // limit/overload regex work, or a dispatched event - runs for an entry
        // outside scope. In machine mode (the default) isInScope is always
        // true, so this is a no-op today; the earlier version of this comment
        // is what issue #2 called "read, parsed and dispatched before being
        // thrown away" in the consumer instead of here.
        if (!isInScope(cwd, this.getScope())) {
            return {};
        }
        // Decided before the text scan, because a finished turn is a property of
        // the entry itself rather than of anything written inside it.
        const inputNeeded: InputHit | undefined = isTurnEndEntry(entry)
            ? {
                detection: { rule: 'turn-end', kind: 'turnEnd', text: 'Claude finished its turn.' },
                cwd,
                file,
            }
            : undefined;
        const candidates: string[] = [];
        collectStrings(entry, candidates, 0);
        // Claude Code tags a genuine limit entry as an API error. When those markers
        // are present the entry is definitely a rate-limit event, so its text is
        // trusted outright; otherwise the text has to clear a stricter bar.
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
                // Only short strings are considered: a real banner is one line, whereas a
                // long string is a file the session happened to read. Without this, a
                // transcript containing source code about rate limits arms a timer.
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
        // No limit here. A transient server error is worth reporting instead, but
        // only from an entry Claude Code itself marked as an API failure or from a
        // non-user entry: the user pasting an error into the chat - or asking about
        // one - must never kick off an automatic retry.
        if (apiError || entry.type !== 'user') {
            for (const candidate of candidates) {
                if (candidate.length > MAX_NOTICE_LENGTH) {
                    continue;
                }
                const overload = detectOverload(candidate);
                if (overload) {
                    return { overload: { detection: overload, cwd, file } };
                }
            }
        }
        return { inputNeeded };
    }

    stop(): void {
        this.watcher?.close();
        this.watcher = undefined;
        if (this.poll) {
            clearInterval(this.poll);
            this.poll = undefined;
        }
        if (this.debounce) {
            clearTimeout(this.debounce);
            this.debounce = undefined;
        }
    }

    dispose(): void {
        this.stop();
        this.onHitEmitter.dispose();
        this.onOverloadEmitter.dispose();
        this.onInputNeededEmitter.dispose();
    }
}

/**
 * Whether a transcript entry is one of Claude Code's own rate-limit errors.
 * Observed shape: `"error":"rate_limit"`, `"isApiErrorMessage":true`,
 * `"apiErrorStatus":429`.
 */
function isRateLimitEntry(entry: Record<string, unknown>): boolean {
    if (entry.isApiErrorMessage === true) {
        return true;
    }
    if (typeof entry.error === 'string' && /rate.?limit/i.test(entry.error)) {
        return true;
    }
    return entry.apiErrorStatus === 429 || entry.status === 429;
}

/**
 * Whether a transcript entry is one of Claude Code's own API failures, of any
 * kind. Broader than {@link isRateLimitEntry}: any 5xx counts, as does the
 * generic marker the CLI writes for "API Error:" turns.
 */
function isApiErrorEntry(entry: Record<string, unknown>): boolean {
    if (entry.isApiErrorMessage === true) {
        return true;
    }
    const status = entry.apiErrorStatus ?? entry.status;
    if (typeof status === 'number' && status >= 500 && status < 600) {
        return true;
    }
    return typeof entry.error === 'string' && entry.error.length > 0;
}

/**
 * Pull every human-readable string out of a transcript entry. Limit notices
 * turn up in assistant text blocks, tool results and error fields depending on
 * where the refusal originated, so the shape is not worth hard-coding.
 */
function collectStrings(value: unknown, out: string[], depth: number): void {
    if (depth > 6 || out.length > 200) {
        return;
    }
    if (typeof value === 'string') {
        if (value.length > 8) {
            out.push(value);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectStrings(item, out, depth + 1);
        }
        return;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) {
            collectStrings(item, out, depth + 1);
        }
    }
}
