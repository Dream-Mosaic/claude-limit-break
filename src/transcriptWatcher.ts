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
    private readonly offsets = new Map<string, number>();

    constructor(
        private readonly getMaxWaitHours: () => number,
        private readonly getPollSeconds: () => number,
        private readonly log: Logger,
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
        for (const file of await this.listTranscripts(root)) {
            try {
                const stat = await fsp.stat(file);
                this.offsets.set(file, stat.size);
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
            // Node >=20 sets parentPath on recursive readdir results.
            const parent = entry.parentPath ??
                entry.path ??
                root;
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
            for (const file of await this.listTranscripts(transcriptRoot())) {
                await this.scanFile(file);
            }
        }
        catch (err) {
            this.log.warn(`Transcript scan failed: ${String(err)}`);
        }
        finally {
            this.scanning = false;
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
        const previous = this.offsets.get(file);
        if (previous === undefined) {
            // A session started after we booted: read it from the beginning.
            this.offsets.set(file, 0);
        }
        else if (size < previous) {
            // Truncated or replaced; start over rather than reading garbage.
            this.offsets.set(file, 0);
        }
        else if (size === previous) {
            return;
        }
        let from = this.offsets.get(file) ?? 0;
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
        this.offsets.set(file, from + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'));
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
