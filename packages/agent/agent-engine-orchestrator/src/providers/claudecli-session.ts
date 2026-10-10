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
 *    and at process exit. (Cleanup keyed to the engine's own session expiry is backlog-tracked.)
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Message } from "@adhd/agent-base-types";

/** Idle time after which a retained transcript is dropped (the 1h cache TTL: past it a resume saves nothing). */
export const CLAUDECLI_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
/** Most agent sessions whose transcripts one process retains; the least recently used is released past it. */
export const CLAUDECLI_SESSION_MAX_RETAINED = 32;

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
    configDir: string;
    lastUsedMs: number;
}

/** Fingerprint of one message as the transcript holds it: role + visible text (tool traces are CLI-internal). */
export function messageFingerprint(m: Pick<Message, "role" | "content">): string {
    return createHash("sha256").update(`${m.role}\0${m.content ?? ""}`).digest("hex");
}

/** Fingerprint of everything that shapes the request prefix besides the history. */
export function sessionConfigKey(parts: Array<string | undefined>): string {
    return createHash("sha256").update(parts.map((p) => p ?? "\u0001").join("\u0000")).digest("hex");
}

/** The CLI's config dir, from the spawned child's environment (it decides where transcripts are written). */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
    return env["CLAUDE_CONFIG_DIR"] ?? join(env["HOME"] ?? homedir(), ".claude");
}

/** Remove the transcripts with these ids from every project dir under `configDir`. Best-effort, never throws. */
export function removeTranscripts(configDir: string, ids: Iterable<string>): void {
    const wanted = [...ids];
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
    private exitHookInstalled = false;

    constructor(
        private readonly now: () => number = Date.now,
        private readonly limits: { idleTtlMs: number; maxRetained: number } = {
            idleTtlMs: CLAUDECLI_SESSION_IDLE_TTL_MS,
            maxRetained: CLAUDECLI_SESSION_MAX_RETAINED,
        },
    ) {}

    /**
     * Decide how the next spawn for engine session `key` uses the CLI session. `nonSystem` is the request's
     * non-system history INCLUDING the new message(s). Always registers the id a fresh plan will create, so a run
     * that fails mid-way still has its transcript cleaned up.
     */
    plan(key: string, configKey: string, configDir: string, nonSystem: Message[]): ClaudeCliSessionPlan {
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
                return { mode: "resume", parentId: head.cliSessionId, tail: nonSystem.slice(covered) };
            }
        }
        const newId = randomUUID();
        const target = entry ?? this.create(key, configDir);
        target.ids.add(newId);
        target.configDir = configDir;
        target.lastUsedMs = this.now();
        return { mode: "fresh", newId };
    }

    /** Record that the transcript `cliSessionId` now covers `nonSystem` plus the assistant `reply`. */
    commit(key: string, args: { configKey: string; configDir: string; cliSessionId: string; nonSystem: Message[]; reply: string }): void {
        const entry = this.sessions.get(key) ?? this.create(key, args.configDir);
        entry.ids.add(args.cliSessionId);
        entry.configDir = args.configDir;
        entry.lastUsedMs = this.now();
        entry.head = {
            cliSessionId: args.cliSessionId,
            configKey: args.configKey,
            hashes: [...args.nonSystem.map(messageFingerprint), messageFingerprint({ role: "assistant", content: args.reply })],
        };
        this.evict();
    }

    /** Forget `key` and delete every transcript it created. */
    release(key: string): void {
        const entry = this.sessions.get(key);
        if (!entry) return;
        this.sessions.delete(key);
        removeTranscripts(entry.configDir, entry.ids);
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

    private create(key: string, configDir: string): IRetained {
        const entry: IRetained = { ids: new Set(), configDir, lastUsedMs: this.now() };
        this.sessions.set(key, entry);
        this.installExitHook();
        return entry;
    }

    private expire(): void {
        const cutoff = this.now() - this.limits.idleTtlMs;
        for (const [key, entry] of [...this.sessions]) if (entry.lastUsedMs < cutoff) this.release(key);
    }

    private evict(): void {
        while (this.sessions.size > this.limits.maxRetained) {
            let oldest: string | undefined;
            let oldestMs = Infinity;
            for (const [key, entry] of this.sessions) if (entry.lastUsedMs < oldestMs) { oldest = key; oldestMs = entry.lastUsedMs; }
            if (oldest === undefined) return;
            this.release(oldest);
        }
    }

    private installExitHook(): void {
        if (this.exitHookInstalled) return;
        this.exitHookInstalled = true;
        process.once("exit", () => this.releaseAll());
    }
}

/** The process-wide registry the provider uses unless a test injects its own. */
export const claudeCliSessions = new ClaudeCliSessionRegistry();
