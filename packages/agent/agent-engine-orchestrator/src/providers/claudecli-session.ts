/**
 * claudecli session continuity (b31e1fe5, R3-COST).
 *
 * A follow-up task on the same agent session used to spawn `claude -p --no-session-persistence` and replay the
 * history as text, so every task opened a brand-new cache prefix and re-wrote the whole conversation cold at the
 * 1h rate. Measured on claude-haiku-4-5 with a ~6k-token first task (scratchpad r3cost/spike.log):
 *
 *   | second task                         | cache_creation 1h | first-turn cache_read | first-turn context |
 *   | text replay, no persistence (old)   | 6,312             | 0                     | 6,322              |
 *   | `--resume <id>` (this module)       | 121               | 6,288                 | 6,419  (ratio 0.98) |
 *
 * so a sessioned agent now keeps the CLI transcript and resumes it. Three rules keep that safe:
 *
 *  - Fork, never append. Each resumed run is `--resume <parent> --fork-session`: the parent transcript is only
 *    READ and the run writes its own new transcript, so two concurrent tasks on one agent session (or two
 *    agent-mcp processes) never share a mutable file (ADR-0012). CLI session ids are fresh v4 UUIDs per run.
 *  - Resume only a history the transcript provably covers. The registry stores a per-message fingerprint of what
 *    the transcript holds; any divergence (compaction, windowing, edited history, a different system prompt /
 *    model / tool set / cwd) falls back to the original full text replay. A resume the CLI cannot find
 *    ("No conversation found") is retried once as a fresh full replay by the provider.
 *  - Transcripts are not a leak. State lives in this process, so a transcript no live process can resume is
 *    garbage: they are removed on {@link ClaudeCliSessionRegistry.release}, on LRU eviction, after the idle TTL,
 *    at process exit, and on SIGTERM / SIGINT. (Cleanup keyed to the engine's own session expiry is
 *    backlog-tracked.) A process that dies without running any of those (SIGKILL, OOM, a crash, power loss)
 *    leaks the transcripts it still held; each process therefore records the ids it created in a ledger file (under the host's namespaced temp root, never in the CLI's own dirs) and
 *    the next process to start sweeps the ledgers of dead processes ({@link ClaudeCliSessionRegistry.sweepOrphans},
 *    95ee2a24 AC4). Only ids this feature recorded are ever deleted, never other files in the projects dir.
 *  - Session ids are validated as UUIDs before they enter the delete set (95ee2a24 AC2): an id reaches us from CLI
 *    output and is joined into a path, so a non-UUID is never retained, resumed, or deleted.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Message } from "@adhd/agent-base-types";

/** Idle time after which a retained transcript is dropped (the 1h cache TTL: past it a resume saves nothing). */
export const CLAUDECLI_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
/** Most agent sessions whose transcripts one process retains; the least recently used is released past it. */
export const CLAUDECLI_SESSION_MAX_RETAINED = 32;

/** The only shape of a CLI session id this module will retain, resume or delete (95ee2a24 AC2). */
export const CLI_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` is a well-formed CLI session UUID (safe to use as a transcript file stem). */
export function isCliSessionId(id: unknown): id is string {
    return typeof id === "string" && CLI_SESSION_ID_RE.test(id);
}

/** Directory (under the host's namespaced temp root) holding one orphan-sweep ledger per live-or-dead process. */
const LEDGER_DIR = "claudecli-ledgers";

/** What a spawn should do about the CLI session. */
export type ClaudeCliSessionPlan =
    | {
          mode: "resume";
          /** Transcript to fork from (`--resume <parentId> --fork-session`). */
          parentId: string;
          /** The engine messages the transcript does not cover yet: the only thing sent on stdin. */
          tail: Message[];
      }
    | {
          mode: "fresh";
          /** Id pinned for the new transcript (`--session-id <newId>`). */
          newId: string;
      };

interface IRetained {
    /** Every transcript id this agent session created in this process (the chain), for cleanup. */
    ids: Set<string>;
    /** The newest fully-recorded transcript and exactly what it covers. */
    head?: { cliSessionId: string; hashes: string[]; configKey: string };
    configDir: string | undefined;
    lastUsedMs: number;
    /** True once a later task actually resumed this session: only then is it known to be resumable. */
    resumed: boolean;
}

/** The slice of `process` the registry needs; injectable so tests bind no real signal handler. */
export interface IRegistryProcess {
    readonly pid: number;
    once(event: string, listener: () => void): unknown;
    removeListener(event: string, listener: () => void): unknown;
    listenerCount(event: string): number;
}

/** Fingerprint of one message as the transcript holds it: role + visible text (tool traces are CLI-internal). */
export function messageFingerprint(m: Pick<Message, "role" | "content">): string {
    return createHash("sha256").update(`${m.role}\0${m.content ?? ""}`).digest("hex");
}

/** Fingerprint of everything that shapes the request prefix besides the history. */
export function sessionConfigKey(parts: Array<string | undefined>): string {
    return createHash("sha256").update(parts.map((p) => p ?? "\u0001").join("\u0000")).digest("hex");
}

/** Everything besides the history that shapes the CLI request prefix; see {@link claudeCliResumeConfigKey}. */
export interface IResumeKeyInputs {
    systemPrompt: string | undefined;
    model: string | undefined;
    cwd: string | undefined;
    /** The declared built-in tool allowlist (compiled tools or `allowedBuiltinTools`), or null. */
    builtinTools: unknown;
    /** The gate-filtered `--tools` argv actually passed to the CLI. */
    builtinToolsArgv: readonly string[];
    /** The MCP tools bridged to the CLI: names AND descriptions (and schemas) are part of the cached prefix. */
    bridgedTools: ReadonlyArray<{ name: string; description: string; inputSchema?: unknown }>;
    /** The resolved `--setting-sources` value (undefined = CLI default). */
    settingSources: string | undefined;
    /** The CLI permission mode flag the run uses. */
    permissionMode: string;
}

/**
 * The resume key (95ee2a24 AC3): a retained transcript is only resumed when every input here is unchanged, because
 * the transcript was built with that exact tool surface, settings and permission mode. Bridged tools are
 * hashed order-independently (name + description + schema).
 */
export function claudeCliResumeConfigKey(i: IResumeKeyInputs): string {
    const bridged = createHash("sha256")
        .update(JSON.stringify([...i.bridgedTools]
            .map((t) => [t.name, t.description, t.inputSchema ?? null])
            .sort((a, b) => (a[0] as string).localeCompare(b[0] as string))))
        .digest("hex");
    return sessionConfigKey([
        i.systemPrompt,
        i.model,
        i.cwd,
        JSON.stringify(i.builtinTools ?? null),
        JSON.stringify(i.builtinToolsArgv),
        bridged,
        i.settingSources ?? "\u0002inherit",
        i.permissionMode,
    ]);
}

/**
 * The CLI's config dir, from the spawned child's environment (it decides where transcripts are written).
 * `undefined` when the environment names neither `CLAUDE_CONFIG_DIR` nor a home directory: transcripts then
 * cannot be located, and cleanup is skipped rather than guessed.
 */
export function claudeConfigDir(env: Record<string, string | undefined>): string | undefined {
    const explicit = env["CLAUDE_CONFIG_DIR"];
    if (explicit) return explicit;
    const home = env["HOME"] ?? env["USERPROFILE"];
    return home ? join(home, ".claude") : undefined;
}

/**
 * Remove the transcripts with these ids from every project dir under `configDir`. Best-effort, never throws.
 * Ids that are not UUIDs are ignored (95ee2a24 AC2): the id is joined into a path.
 */
export function removeTranscripts(configDir: string | undefined, ids: Iterable<string>): void {
    if (!configDir) return;
    const wanted = [...ids].filter(isCliSessionId);
    if (wanted.length === 0) return;
    const projects = join(configDir, "projects");
    let dirs: string[];
    try { dirs = readdirSync(projects); } catch { return; }
    for (const d of dirs) {
        for (const id of wanted) {
            try { rmSync(join(projects, d, `${id}.jsonl`), { force: true }); } catch { /* best-effort */ }
        }
    }
}

export class ClaudeCliSessionRegistry {
    private readonly sessions = new Map<string, IRetained>();
    private hooksInstalled = false;
    private readonly swept = new Set<string>();
    private ledgerRoot: string | undefined;
    private readonly ledgerName: string;
    private readonly signalHandlers = new Map<string, () => void>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly limits: { idleTtlMs: number; maxRetained: number } = {
            idleTtlMs: CLAUDECLI_SESSION_IDLE_TTL_MS,
            maxRetained: CLAUDECLI_SESSION_MAX_RETAINED,
        },
        private readonly deps: {
            proc?: IRegistryProcess;
            /** Re-raise a termination signal once cleanup ran and nothing else handles it. */
            reraise?: (signal: NodeJS.Signals) => void;
            /** Whether a pid is a live process (orphan sweep). */
            isAlive?: (pid: number) => boolean;
        } = {},
    ) {
        this.ledgerName = `${this.proc.pid}-${randomUUID()}.json`;
    }

    private get proc(): IRegistryProcess { return this.deps.proc ?? (process as IRegistryProcess); }

    /**
     * Decide how the next spawn for engine session `key` uses the CLI session. `nonSystem` is the request's
     * non-system history INCLUDING the new message(s). Always registers the id a fresh plan will create, so a run
     * that fails mid-way still has its transcript cleaned up.
     */
    plan(key: string, configKey: string, configDir: string | undefined, nonSystem: Message[]): ClaudeCliSessionPlan {
        this.expire();
        const entry = this.sessions.get(key);
        const head = entry?.head;
        if (entry && head?.configKey === configKey && nonSystem.length > head.hashes.length) {
            const covered = head.hashes.length;
            let matches = true;
            for (let i = 0; i < covered; i++) {
                if (messageFingerprint(nonSystem[i]) !== head.hashes[i]) { matches = false; break; }
            }
            if (matches) {
                entry.lastUsedMs = this.now();
                entry.resumed = true;
                return { mode: "resume", parentId: head.cliSessionId, tail: nonSystem.slice(covered) };
            }
        }
        const newId = randomUUID();
        const target = entry ?? this.create(key, configDir);
        target.ids.add(newId);
        target.configDir = configDir;
        target.lastUsedMs = this.now();
        this.writeLedger();
        return { mode: "fresh", newId };
    }

    /**
     * Record that the transcript `cliSessionId` now covers `nonSystem` plus the assistant `reply`. Returns false
     * (and records nothing) when `cliSessionId` is not a UUID: it comes from CLI output and becomes a path.
     */
    commit(key: string, args: { configKey: string; configDir: string | undefined; cliSessionId: string; nonSystem: Message[]; reply: string }): boolean {
        if (!isCliSessionId(args.cliSessionId)) return false;
        const entry = this.sessions.get(key) ?? this.create(key, args.configDir);
        entry.ids.add(args.cliSessionId);
        entry.configDir = args.configDir;
        entry.lastUsedMs = this.now();
        entry.head = {
            cliSessionId: args.cliSessionId,
            configKey: args.configKey,
            hashes: [...args.nonSystem.map(messageFingerprint), messageFingerprint({ role: "assistant", content: args.reply })],
        };
        this.writeLedger();
        this.evict();
        return true;
    }

    /** Forget `key` and delete every transcript it created. */
    release(key: string): void {
        const entry = this.sessions.get(key);
        if (!entry) return;
        this.sessions.delete(key);
        removeTranscripts(entry.configDir, entry.ids);
        this.writeLedger();
    }

    /** Forget the resumable head of `key` (a resume that failed) but keep its ids for cleanup. */
    invalidate(key: string): void {
        const entry = this.sessions.get(key);
        if (entry) delete entry.head;
    }

    /** Number of agent sessions currently retained (tests / diagnostics). */
    get size(): number { return this.sessions.size; }

    /** Release everything (process exit, tests). */
    releaseAll(): void {
        for (const key of [...this.sessions.keys()]) this.release(key);
    }

    /**
     * Delete the transcripts left by processes that died without cleaning up (SIGKILL, crash, power loss) --
     * 95ee2a24 AC4. Each process keeps a ledger of the ids it created in `<ledgerRoot>/claudecli-ledgers`
     * (`ledgerRoot` is the host's namespaced temp root, `EngineConfig.wire.tempDir`); a ledger whose pid is no
     * longer alive is an orphan: its (UUID-validated) ids are removed from the config dirs it names and the ledger
     * dropped. Ledgers of live processes (including this one) are never touched, so concurrent agent-mcp
     * processes (ADR-0012) cannot sweep each other's working transcripts. Also makes this registry write its own
     * ledger under `ledgerRoot`. Runs at most once per root per registry. Best-effort, never throws. Returns the
     * number of orphaned ledgers swept.
     */
    sweepOrphans(ledgerRoot: string | undefined): number {
        if (!ledgerRoot || this.swept.has(ledgerRoot)) return 0;
        this.swept.add(ledgerRoot);
        this.ledgerRoot = ledgerRoot;
        const dir = join(ledgerRoot, LEDGER_DIR);
        let names: string[];
        try { names = readdirSync(dir); } catch { return 0; }
        const isAlive = this.deps.isAlive ?? defaultIsAlive;
        let swept = 0;
        for (const name of names) {
            if (name === this.ledgerName) continue;
            const m = /^(\d+)-[0-9a-f-]{36}\.json$/i.exec(name);
            if (!m) continue; // not a ledger this feature wrote
            if (isAlive(Number(m[1]))) continue;
            try {
                const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as { entries?: Array<{ configDir?: unknown; ids?: unknown }> };
                for (const e of Array.isArray(parsed.entries) ? parsed.entries : []) {
                    if (typeof e.configDir !== "string" || !Array.isArray(e.ids)) continue;
                    removeTranscripts(e.configDir, e.ids.filter(isCliSessionId));
                }
                rmSync(join(dir, name), { force: true });
                swept++;
            } catch { /* unreadable ledger: leave it, never guess */ }
        }
        return swept;
    }

    private create(key: string, configDir: string | undefined): IRetained {
        const entry: IRetained = { ids: new Set(), configDir, lastUsedMs: this.now(), resumed: false };
        this.sessions.set(key, entry);
        this.installHooks();
        return entry;
    }

    private expire(): void {
        const cutoff = this.now() - this.limits.idleTtlMs;
        for (const [key, entry] of [...this.sessions]) if (entry.lastUsedMs < cutoff) this.release(key);
    }

    /**
     * Past the cap, drop sessions that were never resumed (one-shot dispatches that may never see a second task)
     * before any proven-resumable session; within each class the least recently used goes first (95ee2a24 AC4).
     */
    private evict(): void {
        while (this.sessions.size > this.limits.maxRetained) {
            let victim: string | undefined;
            let victimResumed = true;
            let victimMs = Infinity;
            for (const [key, entry] of this.sessions) {
                const better = victim === undefined
                    || (!entry.resumed && victimResumed)
                    || (entry.resumed === victimResumed && entry.lastUsedMs < victimMs);
                if (better) { victim = key; victimResumed = entry.resumed; victimMs = entry.lastUsedMs; }
            }
            if (victim === undefined) return;
            this.release(victim);
        }
    }

    /** Persist the ids this process holds so a later process can sweep them if this one dies uncleanly. */
    private writeLedger(): void {
        if (!this.ledgerRoot) return;
        const byDir = new Map<string, string[]>();
        for (const entry of this.sessions.values()) {
            if (!entry.configDir) continue;
            const list = byDir.get(entry.configDir) ?? [];
            list.push(...entry.ids);
            byDir.set(entry.configDir, list);
        }
        const dir = join(this.ledgerRoot, LEDGER_DIR);
        const file = join(dir, this.ledgerName);
        try {
            if (byDir.size === 0) { rmSync(file, { force: true }); return; }
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const tmp = `${file}.${randomUUID()}.tmp`;
            const entries = [...byDir].map(([configDir, ids]) => ({ configDir, ids }));
            writeFileSync(tmp, JSON.stringify({ pid: this.proc.pid, entries }), { mode: 0o600 });
            renameSync(tmp, file);
        } catch { /* best-effort: a missing ledger only widens the crash leak window */ }
    }

    private installHooks(): void {
        if (this.hooksInstalled) return;
        this.hooksInstalled = true;
        this.proc.once("exit", () => this.releaseAll());
        for (const sig of ["SIGTERM", "SIGINT"] as const) {
            const handler = (): void => {
                this.releaseAll();
                this.proc.removeListener(sig, handler);
                this.signalHandlers.delete(sig);
                // Node's default action (terminate) is suppressed once any listener exists; restore it unless
                // something else in the host is handling this signal.
                if (this.proc.listenerCount(sig) === 0) (this.deps.reraise ?? defaultReraise)(sig);
            };
            this.signalHandlers.set(sig, handler);
            this.proc.once(sig, handler);
        }
    }
}

function defaultIsAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function defaultReraise(signal: NodeJS.Signals): void {
    process.kill(process.pid, signal);
}

/** The process-wide registry the provider uses unless a test injects its own. */
export const claudeCliSessions = new ClaudeCliSessionRegistry();
