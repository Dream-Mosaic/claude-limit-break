import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import { claudeHome } from './claudeHome';
import { isTurnEndEntry, InputDetection } from './parsers/inputParser';
import { detectLimit, resolveStructuredReset, compactionLimitText, MAX_NOTICE_LENGTH, LimitDetection, normalize, rateLimitTypeFromText } from './parsers/limitParser';
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
     * The reporting entry's own `timestamp`, in ms, when it had a parseable
     * one. An overload has no reset time, so this is what identifies the
     * event: identical in every window (they all read the same line) and
     * distinct for every separate failure. The cross-window claim keys on it
     * (claims.ts claimKeyFor; final review, Important 3).
     */
    entryTimestampMs?: number;
}
export interface InputHit { detection: InputDetection; cwd?: string; file: string }
/** One of Claude Code's own auto-continue status lines (wave C, C4). Observed only. */
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
 * How stale a server-error entry's own timestamp may be before it is treated
 * as history rather than a live overload. A usage limit carries a reset time
 * to test staleness against; an overload has none, so age since the entry
 * was written is the only signal a replayed transcript - a fork, or a
 * session resumed after a long gap - gives for "this already happened and
 * does not need retrying now". An entry with no timestamp of its own is
 * treated as fresh, as it always has been.
 */
export const MAX_OVERLOAD_AGE_MS = 10 * 60_000;

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

    private readonly onNativeStatusEmitter = new vscode.EventEmitter<NativeStatusHit>();
    /**
     * Fires for each of Claude Code's own auto-continue status lines (armed,
     * cancelled, fired). Observation only: nothing is armed from it, and the
     * text is never parsed for a time (wave C, C4).
     */
    readonly onNativeStatus = this.onNativeStatusEmitter.event;

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
        let limit: LimitHit | undefined;
        let overload: OverloadHit | undefined;
        let inputNeeded: InputHit | undefined;
        for (const line of text.slice(0, lastNewline).split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            const scan = this.inspectLine(trimmed, file);
            if (scan.nativeStatus) {
                // Every such line is reported, ahead of the limit early-return
                // below: a cancel line must not be swallowed by a limit that
                // happens to sit in the same batch.
                this.onNativeStatusEmitter.fire(scan.nativeStatus);
            }
            if (scan.limit) {
                // The first limit in the batch wins. The loop keeps reading
                // (wave C, C4) only so that the status lines after it - an
                // armed line, a cancel line - are still reported; nothing
                // else in the batch can act once a limit is found.
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
        // Wave C, C4: Claude Code's own auto-continue status lines. Recognised
        // by type, subtype and prefix alone (nativeContinue.ts) and reported
        // for the log; they carry no limit and no overload, so nothing below
        // applies to them.
        const nativeStatus = classifyNativeStatus(entry);
        if (nativeStatus) {
            return { nativeStatus: { status: nativeStatus, cwd, file }, inputNeeded };
        }
        const candidates: Candidate[] = [];
        collectStrings(entry, candidates, 0);
        // The one admission gate for a resume, limit and overload alike (final
        // fix wave A, A1 and A2): the entry must be one Claude Code itself
        // flagged as an API error. Every limit and error message the 2.1.282
        // binary writes is built by one constructor that sets
        // `isApiErrorMessage: true` (research-api-errors-binary.md Q1: every
        // branch of INn returns $o(...)), GitHub #64030 shows the same flag on
        // 2.1.145, and all 138 limit entries on this machine carry it
        // (task-4c-report.md). What an unflagged entry holds is someone
        // TALKING about a limit or an error - the model's prose about a GitHub
        // or npm rate limit, a thinking block, a Bash description, a user's
        // paste, a grep hit in a tool_result - and every one of those used to
        // be able to arm a resume of a session that never stopped (final
        // review C1). Checked as the literal `true`: a bare `error:
        // "rate_limit"` string, a 429 or a 5xx status without the flag, no
        // longer admits an entry (final review M1). Cost if an old build wrote
        // a limit without the flag: that build's limits are not detected; the
        // local scan found no such entry.
        const flagged = entry.isApiErrorMessage === true;
        const maxWait = this.getMaxWaitHours();
        // The real current time: staleness and the grace window are always
        // decided against this, never against the entry's own timestamp.
        const now = new Date();
        // What a relative notice ("in 5 hours", "resets 1am") is resolved
        // against: the entry's own timestamp when it has a parseable one, so
        // a forked transcript's copied lines are read as of when they were
        // originally written. A fork replays every line with its original
        // timestamp intact - that is how last night's "resets 1am" re-armed
        // an 18-hour timer when this watcher met the file fresh and resolved
        // it against the time of reading instead. Missing or unparseable
        // falls back to now, exactly as it behaved before entries carried a
        // timestamp into this calculation at all.
        const rawTimestamp = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : undefined;
        const writtenAt = rawTimestamp && !Number.isNaN(rawTimestamp.getTime()) ? rawTimestamp : undefined;
        const basis = writtenAt ?? now;

        // Limits only from a flagged entry (see `flagged` above). The entry's
        // type is not consulted: Claude Code writes its own notices as
        // synthetic entries that can carry type "user". A flagged entry in a
        // subagents/ file still arms (Task 3 fix round 1): a subagent that
        // genuinely hits the limit writes Claude Code's own marker into its own
        // file too. Turn-end detection above is unaffected by this gate.
        if (flagged) {
            // quotaLimits.resetsAt is an absolute epoch instant Claude Code writes
            // on the flagged entry itself - immune to every way the text can be
            // misread (zone, DST, calendar rollover) - so it wins over the text
            // outright when present. Only trusted on a flagged entry: the field
            // turning up on an ordinary turn is not itself a limit event.
            // The two transient-429 renders disclaim being a usage limit in
            // their own text ("not your usage limit", "a temporary capacity
            // issue"). Claude Code attaches quotaLimits only to a REJECTED
            // usage-limit 429 - the branch that writes the "You've hit your ...
            // limit" text - and never to a transient one (2.1.282 binary,
            // research-api-errors-binary.md Q2: the transient branch never calls
            // the quotaLimits builder), so this skip cannot fire on anything
            // Claude Code writes today. It stays as belt and braces (an earlier
            // reading of the evidence said every rate_limit entry carried the
            // field, and a build that did would turn a transient 429 into a
            // usage-limit timer): it asks the overload parser itself (not a
            // duplicated regex) whether any of the entry's own candidate text is
            // one of those renders; if so the quotaLimits branch is skipped
            // outright, whatever its status, and the entry falls through to the
            // ordinary text/overload path below and is routed to overload.
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
                // Which limit tripped (Task 4c, R4): the same object names it, in
                // the vocabulary the binary uses everywhere (five_hour, seven_day,
                // ...). Taken only when it is a string, and left off the detection
                // otherwise, so the fire decision can tell the one limit Claude
                // Code's native auto-continue covers from every other.
                const fieldType =
                    quotaLimits && typeof quotaLimits === 'object'
                        ? (quotaLimits as Record<string, unknown>).rateLimitType
                        : undefined;
                // An empty string is no type. With no usable field the entry's own
                // text may still name it ("You've hit your weekly limit"), the same
                // label the text path reads; the field wins when it is there.
                const limitType =
                    typeof fieldType === 'string' && fieldType !== ''
                        ? fieldType
                        : candidates.map((c) => rateLimitTypeFromText(normalize(c.text))).find((t) => t !== undefined);
                if (typeof resetsAt === 'number' && Number.isFinite(resetsAt)) {
                    const resumeAt = resolveStructuredReset(resetsAt, now, maxWait);
                    // Decisive either way: this is the authoritative field, so a
                    // value that fails the grace/horizon check is not a cue to
                    // fall back to the text - it is history (or absurd), and the
                    // text does not get a second opinion on that.
                    return resumeAt
                        ? {
                            limit: {
                                detection: {
                                    resumeAt,
                                    rule: 'quota-limits',
                                    text: 'quotaLimits.resetsAt',
                                    ...(limitType !== undefined ? { rateLimitType: limitType } : {}),
                                },
                                cwd,
                                file,
                            },
                        }
                        : { inputNeeded };
                }
            }
            for (const candidate of candidates) {
                // Only short strings are considered: a real banner is one line, whereas a
                // long string is a file the session happened to read. Without this, a
                // transcript containing source code about rate limits arms a timer.
                if (candidate.text.length > MAX_NOTICE_LENGTH) {
                    continue;
                }
                // Every entry read here is flagged, so its text is trusted: it
                // skips the source-code and quotation guards inside detectLimit,
                // which exist for text nobody vouched for. The tool_result veto
                // that used to sit here went with the unflagged path (A1).
                const detection = detectLimit(candidate.text, basis, maxWait, { trusted: true, readAt: now });
                if (detection) {
                    return { limit: { detection, cwd, file } };
                }
            }
        }
        // Wave C, C1: the one unflagged shape admitted - a usage limit hit
        // during `/compact`, which Claude Code writes as a `system` /
        // `local_command` entry (see compactionLimitText for every condition
        // and why model prose can never be one). Read as trusted text from
        // here on, exactly like a flagged entry's own: the same parser, the
        // same grace window and horizon, so a fork's copy of an old failure is
        // history and everything after detection (continuedSince, the holder
        // policy, claims, backoff) is unchanged.
        const compactionText = flagged ? undefined : compactionLimitText(entry);
        if (compactionText !== undefined) {
            const detection = detectLimit(compactionText, basis, maxWait, { trusted: true, readAt: now });
            if (detection) {
                return { limit: { detection, cwd, file } };
            }
            // Say why nothing armed, but only when no reset time could be read
            // at all. A readable time that is merely stale (a fork's copy) or
            // past the horizon is history, not a miss, and must not log as one.
            const anyTime = detectLimit(compactionText, basis, Infinity, { trusted: true, readAt: new Date(0) });
            if (!anyTime) {
                this.log.warn(
                    `Usage limit during compaction in session ${path.basename(file, '.jsonl')} has no parseable reset time; ` +
                        `not picking it up: ${compactionText.slice(0, MAX_NOTICE_LENGTH)}`,
                );
            }
            return { inputNeeded };
        }
        // No limit here. A transient server error is worth reporting instead,
        // from the same flagged entries only (Task 4c R3, tightened to the
        // literal flag by A2 / final review M1). A scan of the 168
        // `<synthetic>` assistant entries in this machine's ~/.claude/projects
        // found 138 flagged (all rate_limit / 429) and 30 unflagged (all "No
        // response requested."), none an error render; the unflagged side is
        // the model or the user talking ABOUT an error. An overload carries no
        // reset time of its own, so a replayed one is judged on age alone:
        // written longer ago than MAX_OVERLOAD_AGE_MS, it is history rather
        // than something to retry now.
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
        this.onNativeStatusEmitter.dispose();
    }
}

/**
 * Whether a transcript file lives under a `subagents/` directory (synthesis
 * A3). A subagent's turn ending says nothing about its parent session, so
 * extension.ts never lets one clear a gave-up record - see the doc comment on
 * {@link MAX_OFFSET_IDLE_MS} for how common these files are (~85% of
 * everything on disk for a typical project).
 */
export function isSubagentFile(file: string): boolean {
    return /[\\/]subagents[\\/]/i.test(file);
}

/**
 * One string pulled out of a transcript entry. Only a flagged entry's strings
 * are ever read (A1), so where inside the entry a string sat no longer
 * matters: the tool_result tag the unflagged path needed went with it.
 */
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
