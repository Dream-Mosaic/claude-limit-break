import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import { claudeHome } from './claudeHome';
import { isTurnEndEntry, InputDetection } from './parsers/inputParser';
import {
    classifyLimit,
    resolveStructuredReset,
    compactionLimitText,
    MAX_NOTICE_LENGTH,
    MAX_RESET_DAYS,
    RESET_GRACE_MS,
    LimitDetection,
    LimitRejection,
    normalize,
    rateLimitTypeFromText,
} from './parsers/limitParser';
import type { Logger } from './log';
import { detectOverload, OverloadDetection } from './parsers/overloadParser';
import { classifyNativeStatus, NativeStatus } from './nativeContinue';

/** Never read more than this from one file in a single pass. */
const MAX_READ_BYTES = 2_000_000;

export function transcriptRoot(): string {
    return path.join(claudeHome(), 'projects');
}

export interface LimitHit { detection: LimitDetection; cwd?: string; file: string }
export interface OverloadHit {
    detection: OverloadDetection;
    cwd?: string;
    file: string;
    /**
     * The entry's own `timestamp` in ms, when parseable. An overload has no reset
     * time, so this identifies the event across windows (claims.ts claimKeyFor).
     */
    entryTimestampMs?: number;
}
export interface InputHit { detection: InputDetection; cwd?: string; file: string }
/** One of Claude Code's own auto-continue status lines. Observed only. */
export interface NativeStatusHit { status: NativeStatus; cwd?: string; file: string }
export interface InspectResult { limit?: LimitHit; overload?: OverloadHit; inputNeeded?: InputHit; nativeStatus?: NativeStatusHit }

export type WatchMode = 'machine' | 'workspace';

/**
 * What the watcher should react to. `folders` is only consulted in
 * `'workspace'` mode; in `'machine'` mode every cwd is in scope.
 */
export interface WatchScope {
    mode: WatchMode;
    folders: readonly string[];
}

/** Every session on the machine matters; the default when no scope is passed. */
export const DEFAULT_SCOPE: WatchScope = { mode: 'machine', folders: [] };

/**
 * Whether a transcript entry's cwd is in scope. Pure; mirrors `isInsideWorkspace`
 * in src/extension.ts (separator-boundary comparison, case-folded because Windows
 * paths from the CLI may differ in casing). Duplicated to avoid depending on extension.ts.
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
 * How long an offset entry may go without its file growing before {@link pruneOffsets}
 * evicts it. A file that resumes after this is re-read from byte zero, bounded by MAX_READ_BYTES.
 */
export const MAX_OFFSET_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard ceiling on tracked files, a backstop independent of age. */
export const MAX_OFFSET_ENTRIES = 2000;

/**
 * How stale a server-error entry's own timestamp may be before it counts as history.
 * An overload has no reset time, so age is the only signal for a replayed transcript.
 * An entry with no timestamp is treated as fresh.
 */
export const MAX_OVERLOAD_AGE_MS = 10 * 60_000;

/**
 * Decide which offset entries survive a prune pass. Pure: `existing` and `now` are
 * injected. Existence is checked before age; the count cap is a last resort.
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

    private readonly onNativeStatusEmitter = new vscode.EventEmitter<NativeStatusHit>();
    /** Fires for each of Claude Code's own auto-continue status lines. Observation only; never parsed for a time. */
    readonly onNativeStatus = this.onNativeStatusEmitter.event;

    private watcher?: fs.FSWatcher;
    private poll?: NodeJS.Timeout;
    private debounce?: NodeJS.Timeout;
    private scanning = false;
    private readonly offsets = new Map<string, OffsetEntry>();
    /**
     * Files that already had their one "reset already passed" warning: a fork replays
     * every stale limit of its parent. Pruned with the offsets.
     */
    private readonly warnedPast = new Set<string>();

    constructor(
        private readonly getMaxWaitHours: () => number,
        private readonly getPollSeconds: () => number,
        private readonly log: Logger,
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
            // parentPath needs Node 20.12+; Dirent.path was removed in Node 24.
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
            // Bound offsets here: this is the one place that knows the full listing, which pruneOffsets needs.
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
        for (const file of this.warnedPast) {
            if (!survivors.has(file)) {
                this.warnedPast.delete(file);
            }
        }
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
            // lastActivity tracks real growth, not "we looked"; pruneOffsets uses it as an idle signal.
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
        let limit: LimitHit | undefined;
        let overload: OverloadHit | undefined;
        let inputNeeded: InputHit | undefined;
        for (const line of text.slice(0, lastNewline).split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            // One bad line must not drop a limit already recorded in this batch; the offset is already consumed.
            let scan: InspectResult;
            try {
                scan = this.inspectLine(trimmed, file);
            }
            catch (err) {
                this.log.warn(`Cannot inspect a line in ${path.basename(file)}: ${String(err)}`);
                continue;
            }
            if (scan.nativeStatus) {
                // Logged even after a limit in the same batch: the stand-down scan starts past this batch's end.
                this.onNativeStatusEmitter.fire(scan.nativeStatus);
            }
            if (scan.limit) {
                // The first limit wins; keep reading only so later status lines are still reported.
                limit ??= scan.limit;
                continue;
            }
            // Keep the last overload rather than the first: a burst of failures writes
            // several, and the freshest one describes the state the session is in now.
            overload = scan.overload ?? overload;
            inputNeeded = scan.inputNeeded ?? inputNeeded;
        }
        if (limit) {
            // A usage limit outranks everything else in the batch: it means waiting,
            // and retrying into a limit only burns attempts against a closed door.
            this.log.info(`Limit detected in transcript ${path.basename(file)}: ${limit.detection.text}`);
            this.onHitEmitter.fire(limit);
            return;
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
        // Valid JSON that is not an object (`null`, a number, an array) is not
        // a transcript entry, and reading `.cwd` off it would throw.
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return {};
        }
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        // Checked as early as possible: nothing past this runs for an out-of-scope entry.
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
        // Claude Code's own auto-continue status lines: logged only; they carry no limit or overload.
        const nativeStatus = classifyNativeStatus(entry);
        if (nativeStatus) {
            return { nativeStatus: { status: nativeStatus, cwd, file }, inputNeeded };
        }
        const candidates: Candidate[] = [];
        collectStrings(entry, candidates, 0);
        // The one admission gate for a limit or overload: Claude Code itself flagged the entry as an
        // API error (`isApiErrorMessage` literally `true`). Unflagged entries are someone talking
        // about a limit (model prose, tool_result, user paste) and must never arm a resume.
        const flagged = entry.isApiErrorMessage === true;
        const maxWait = this.getMaxWaitHours();
        // The first limit notice in a flagged entry that could not be scheduled, and why; warned
        // about at the end, once no overload claims the entry.
        let textRejection: { verdict: LimitRejection; text: string } | undefined;
        // The real current time: staleness and the grace window are always
        // decided against this, never against the entry's own timestamp.
        const now = new Date();
        // What a relative notice ("in 5 hours") is resolved against: the entry's own timestamp when
        // parseable, so a fork's copied lines are read as of when they were written; otherwise now.
        const rawTimestamp = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : undefined;
        const writtenAt = rawTimestamp && !Number.isNaN(rawTimestamp.getTime()) ? rawTimestamp : undefined;
        const basis = writtenAt ?? now;

        // Limits only from a flagged entry. Entry type is not consulted: Claude Code writes its
        // notices as synthetic entries that can carry type "user". Flagged entries in subagents/
        // files still arm. Turn-end detection above is unaffected.
        if (flagged) {
            // quotaLimits.resetsAt is an absolute epoch instant Claude Code writes on the flagged
            // entry; it wins over the text when present.
            // Skipped when the entry's own text is a transient-429 render ("not your usage limit"):
            // belt and braces, such an entry falls through and routes to overload.
            const isTransientRateLimit = candidates.some((c) => {
                const rule = detectOverload(c.text)?.rule;
                return rule === 'transient-429' || rule === 'rejected-429';
            });
            if (!isTransientRateLimit) {
                const quotaLimits = entry.quotaLimits;
                const resetsAt =
                    quotaLimits && typeof quotaLimits === 'object'
                        ? (quotaLimits as Record<string, unknown>).resetsAt
                        : undefined;
                // Which limit tripped, from the same object (five_hour, seven_day, ...); left off when not
                // a string, so the fire decision can tell the one limit native auto-continue covers.
                const fieldType =
                    quotaLimits && typeof quotaLimits === 'object'
                        ? (quotaLimits as Record<string, unknown>).rateLimitType
                        : undefined;
                // An empty string is no type; fall back to the entry's own text, as the text path does.
                const limitType =
                    typeof fieldType === 'string' && fieldType !== ''
                        ? fieldType
                        : candidates.map((c) => rateLimitTypeFromText(normalize(c.text))).find((t) => t !== undefined);
                if (typeof resetsAt === 'number' && Number.isFinite(resetsAt)) {
                    const verdict = resolveStructuredReset(resetsAt, now, maxWait);
                    // Decisive: a value failing the grace/8-day check is history, not a cue to fall back to
                    // the text. Still logged.
                    if (verdict.kind === 'rejected') {
                        this.warnUnscheduled('Usage limit', file, verdict, `quotaLimits.resetsAt ${resetsAt}`);
                        return { inputNeeded };
                    }
                    return {
                        limit: {
                            detection: {
                                resumeAt: verdict.at,
                                rule: 'quota-limits',
                                text: 'quotaLimits.resetsAt',
                                ...(limitType !== undefined ? { rateLimitType: limitType } : {}),
                                // Beyond maxWaitHours: offered at the reset, never resumed on its own.
                                ...(verdict.kind === 'offerOnly' ? { offerOnly: true as const } : {}),
                            },
                            cwd,
                            file,
                        },
                    };
                }
            }
            for (const candidate of candidates) {
                // Only short strings are considered: a real banner is one line, whereas a
                // long string is a file the session happened to read. Without this, a
                // transcript containing source code about rate limits arms a timer.
                if (candidate.text.length > MAX_NOTICE_LENGTH) {
                    continue;
                }
                // Every entry here is flagged, so its text is trusted and skips classifyLimit's
                // source-code and quotation guards.
                const verdict = classifyLimit(candidate.text, basis, maxWait, { trusted: true, readAt: now });
                if (verdict?.kind === 'detected') {
                    return { limit: { detection: verdict.detection, cwd, file } };
                }
                // Held, not warned yet: the entry may still turn out to be an
                // overload (below), which is not a limit and must not warn.
                if (verdict) {
                    textRejection ??= { verdict, text: candidate.text };
                }
            }
        }
        // The one unflagged shape admitted: a usage limit during `/compact`, a `system` /
        // `local_command` entry (see compactionLimitText). Read as trusted text, same parser and
        // grace window.
        const compactionText = flagged ? undefined : compactionLimitText(entry);
        if (compactionText !== undefined) {
            // A weekly limit during compaction is read like any other (the dated form, offer-only).
            const verdict = classifyLimit(compactionText, basis, maxWait, { trusted: true, readAt: now });
            if (verdict?.kind === 'detected') {
                return { limit: { detection: verdict.detection, cwd, file } };
            }
            // Say why nothing armed: unparseable, absurd, or history (once per file, since a fork repeats it).
            if (verdict) {
                this.warnUnscheduled('Usage limit during compaction', file, verdict, compactionText);
            }
            return { inputNeeded };
        }
        // No limit here. A transient server error from flagged entries is reported instead. An
        // overload has no reset time, so a replayed one is judged on age alone (MAX_OVERLOAD_AGE_MS).
        const overloadTooOld = writtenAt !== undefined && now.getTime() - writtenAt.getTime() > MAX_OVERLOAD_AGE_MS;
        if (!overloadTooOld && flagged) {
            for (const candidate of candidates) {
                if (candidate.text.length > MAX_NOTICE_LENGTH) {
                    continue;
                }
                const overload = detectOverload(candidate.text);
                if (overload) {
                    return { overload: { detection: overload, cwd, file, entryTimestampMs: writtenAt?.getTime() } };
                }
            }
        }
        // A flagged entry that reads as a usage limit but yielded no limit and is no overload is a
        // missed resume the user would not otherwise hear about: warn (unparseable, absurd, or
        // already past). An overload render, even a stale one, never warns.
        if (textRejection && !candidates.some((c) => c.text.length <= MAX_NOTICE_LENGTH && detectOverload(c.text))) {
            this.warnUnscheduled('Usage limit', file, textRejection.verdict, textRejection.text);
        }
        return { inputNeeded };
    }

    /**
     * The one warning for a limit that was detected but not scheduled, naming the session and
     * the reason. A past reset (a fork's copy) warns at most once per file.
     */
    private warnUnscheduled(what: string, file: string, rejection: LimitRejection, text: string): void {
        const session = path.basename(file, '.jsonl');
        const shown = text.slice(0, MAX_NOTICE_LENGTH);
        const at = rejection.at?.toISOString() ?? 'an unknown time';
        if (rejection.reason === 'past') {
            if (this.warnedPast.has(file)) {
                return;
            }
            this.warnedPast.add(file);
            this.log.warn(
                `${what} in session ${session} reset at ${at}, more than ${RESET_GRACE_MS / 60_000} minutes ago; ` +
                    `not picking it up, as history (a fork's copy, say). Further ones in this file are not reported: ${shown}`,
            );
            return;
        }
        if (rejection.reason === 'absurd') {
            this.log.warn(
                `${what} in session ${session} resets at ${at}, more than ${MAX_RESET_DAYS} days out, longer than any ` +
                    `Claude usage limit; not picking it up as a likely misread: ${shown}`,
            );
            return;
        }
        const why = rejection.detail ? ` (${rejection.detail})` : '';
        this.log.warn(`${what} in session ${session} has no parseable reset time${why}; not picking it up: ${shown}`);
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
        this.onNativeStatusEmitter.dispose();
    }
}

/**
 * Whether a transcript file lives under a `subagents/` directory. A subagent's turn ending
 * says nothing about its parent session, so extension.ts never lets one clear a gave-up record.
 */
export function isSubagentFile(file: string): boolean {
    return /[\\/]subagents[\\/]/i.test(file);
}

/** One string pulled out of a transcript entry. */
interface Candidate {
    text: string;
}

/**
 * Pull every human-readable string out of a transcript entry. Limit notices
 * turn up in assistant text blocks and error fields depending on where the
 * refusal originated, so the shape is not worth hard-coding.
 */
function collectStrings(value: unknown, out: Candidate[], depth: number): void {
    if (depth > 6 || out.length > 200) {
        return;
    }
    if (typeof value === 'string') {
        if (value.length > 8) {
            out.push({ text: value });
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
        for (const item of Object.values(value as Record<string, unknown>)) {
            collectStrings(item, out, depth + 1);
        }
    }
}
