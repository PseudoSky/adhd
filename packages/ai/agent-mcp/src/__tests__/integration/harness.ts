/**
 * Integration test harness.
 *
 * Builds a fully-wired real system against a fresh temp sqlite database.
 * Runs the same drizzle migrations used by the production server.
 * Constructs real stores/queue/PolicyEngine/orchestrator/DagEngine with
 * the same dispatchFn wiring as index.ts.
 *
 * The only scripted/stubbed components are:
 *  - LLMProvider (ScriptedProvider from scripted-provider.ts)
 *  - External MCP tool clients (in-process stubs at the registry boundary)
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { fileURLToPath } from "node:url";

import * as schema from "../../db/schema.js";
import { AgentStore } from "../../store/agent-store.js";
import { SessionStore } from "../../store/session-store.js";
import { TaskStore } from "../../store/task-store.js";
import { BackgroundQueue } from "../../engine/queue.js";
import { DagEngine } from "../../engine/dag-engine.js";
import { Orchestrator } from "../../engine/orchestrator.js";
import { HookRegistry } from "../../engine/hooks.js";
import { PolicyEngine } from "../../engine/policy.js";
import { startSseServer } from "../../streaming/sse-server.js";
import { enqueueExistingTask } from "../../tools/task.js";
import { runMigrationsOn } from "../../db/migrate-runner.js";
import { taskTool, taskCancel, taskResume } from "../../tools/task.js";
import type { TaskDeps } from "../../tools/task.js";
import type { AgentCreateInput } from "../../validation/index.js";
import type { LLMProvider } from "../../providers/types.js";
import type { TaskStore as ITaskStore } from "../../store/task-store.js";
import { tasksTable } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { generateId } from "../../utils/ids.js";
import { nowIso } from "../../utils/timestamps.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../../drizzle");

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface Harness {
    db: TestDb;
    rawSqlite: InstanceType<typeof Database>;
    agentStore: AgentStore;
    sessionStore: SessionStore;
    taskStore: TaskStore;
    queue: BackgroundQueue;
    orchestrator: Orchestrator;
    policy: PolicyEngine;
    dagEngine: DagEngine;
    taskDeps: TaskDeps;
    hooks: HookRegistry;
    /** Tear down: close DB, stop SSE server if started */
    teardown: () => Promise<void>;
    /** The file path of the temp DB (for restart tests) */
    dbPath: string;
    /** SSE server (if started) */
    sseServer?: http.Server;
    /** Ephemeral port the SSE server is bound to (if started) */
    ssePort?: number;
}

export interface HarnessOptions {
    /** Start an SSE server on an ephemeral port */
    withSse?: boolean;
    /** Override server-max-tool-loops */
    serverMaxToolLoops?: number;
    /** Use an explicit DB path (for restart tests) */
    dbPath?: string;
    /**
     * Skip the automatic orphan-scan re-enqueue on build.
     * Prefer `defaultProvider` over this flag: that keeps the real scan
     * exercised while avoiding the external-provider race.
     */
    skipOrphanScan?: boolean;
    /**
     * Inject a scripted LLMProvider into the harness orchestrator so every
     * task dispatched through taskDeps (including the startup orphan scan)
     * uses it instead of the real provider built from agentDefinition.provider.
     *
     * This mirrors the pattern used for per-task provider injection but applies
     * it at harness construction time — so the orphan scan that fires during
     * buildHarness already has the right provider, with no race against a
     * parallel bad-provider run.
     */
    defaultProvider?: LLMProvider;
}

/**
 * Build a fully-wired harness. Call teardown() when done.
 */
export async function buildHarness(opts: HarnessOptions = {}): Promise<Harness> {
    const dbPath =
        opts.dbPath ??
        path.join(os.tmpdir(), `agent-mcp-test-${crypto.randomUUID()}.db`);

    const rawSqlite = new Database(dbPath);
    rawSqlite.pragma("journal_mode = WAL");
    rawSqlite.pragma("foreign_keys = ON");

    const db = drizzle(rawSqlite, { schema }) as unknown as TestDb;

    // Run migrations — same folder + FK-safe runner as production
    runMigrationsOn(
        rawSqlite,
        db as Parameters<typeof runMigrationsOn>[1],
        MIGRATIONS_FOLDER
    );

    const hooks = new HookRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;

    const agentStore = new AgentStore(dbAny, hooks);
    const sessionStore = new SessionStore(dbAny, hooks);
    const taskStore = new TaskStore(dbAny);

    const queue = new BackgroundQueue(5);
    const orchestrator = new Orchestrator();
    const policy = new PolicyEngine({
        serverMaxDepth: 5,
        serverMaxToolLoops: opts.serverMaxToolLoops ?? 50,
    });

    // Mirror dispatchFn wiring from index.ts.
    // Ref-box pattern: const closure captures the box; the box's value is filled
    // after all stores are constructed (same pattern as index.ts main()).
    const taskDepsRef: { value: TaskDeps | undefined } = { value: undefined };

    const dispatchFn = async (taskId: string): Promise<void> => {
        if (!taskDepsRef.value) throw new Error("dispatchFn called before harness initialized");
        await enqueueExistingTask(taskId, taskDepsRef.value);
    };

    const dagEngine = new DagEngine(dbAny, queue, taskStore, dispatchFn);

    // SSE server (optional)
    let sseServer: http.Server | undefined;
    let ssePort: number | undefined;

    if (opts.withSse) {
        // Bind an ephemeral port (0) directly — startSseServer does the single
        // listen() internally; we just wait for it and read the chosen port.
        sseServer = startSseServer(taskStore, 0, "127.0.0.1");
        await new Promise<void>((resolve) => {
            const readPort = () => {
                const addr = sseServer!.address() as { port: number } | null;
                ssePort = addr?.port;
                resolve();
            };
            if (sseServer!.listening) readPort();
            else sseServer!.once("listening", readPort);
        });
    }

    // Build taskDeps — same shape as index.ts.
    // When defaultProvider is supplied, wrap the orchestrator so every run
    // that goes through taskDeps (including the startup orphan scan) uses it
    // instead of the real provider built from agentDefinition.provider.
    const effectiveOrchestrator: Orchestrator = opts.defaultProvider
        ? ({
            run: (input: Parameters<Orchestrator["run"]>[0]) =>
                orchestrator.run({ ...input, provider: opts.defaultProvider! }),
          } as Orchestrator)
        : orchestrator;

    taskDepsRef.value = {
        agentStore,
        sessionStore,
        taskStore,
        orchestrator: effectiveOrchestrator,
        queue,
        policy,
        hooks,
        selfUrl: undefined,
        inProcessDescriptors: [],
        inProcessHandler: async () => {
            throw new Error("in-process tools not configured in test harness");
        },
        db: dbAny,
        dagEngine,
    };

    // Re-enqueue orphaned pending tasks (mirrors startup scan in index.ts).
    // Skipped when opts.skipOrphanScan is true — callers that need custom
    // (patched) deps can trigger enqueueExistingTask manually.
    if (!opts.skipOrphanScan) {
        const orphanedPending = dbAny
            .select()
            .from(tasksTable)
            .where(eq(tasksTable.status, "pending"))
            .all() as Array<{ id: string }>;

        for (const row of orphanedPending) {
            try {
                await enqueueExistingTask(row.id, taskDepsRef.value!);
            } catch {
                // ignore failures in teardown
            }
        }
    }

    const teardown = async (): Promise<void> => {
        // 1. Close the SSE server first so no new HTTP responses write to the DB.
        if (sseServer) {
            await new Promise<void>((resolve) => sseServer!.close(() => resolve()));
        }

        // 2. Drain the queue fully via p-queue's onIdle() — more reliable than
        //    polling pending+size, which can momentarily read zero between tasks.
        //    Race against a 15s deadline to avoid hanging test suite.
        await Promise.race([
            queue.onIdle(),
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error("teardown: queue.onIdle() timed out after 15s")), 15_000)
            ),
        ]).catch(() => {
            // Log but don't rethrow — we still need to close the DB.
        });

        // 3. One event-loop tick so the last task's finally-block DB writes settle.
        await new Promise<void>((r) => setImmediate(r));

        // 4. Close the connection cleanly BEFORE unlinking the file.
        //
        //    The previous strategy (leak the handle, unlink the open file) caused
        //    the intermittent teardown SIGSEGV (exit 139): in WAL mode, at process
        //    exit better-sqlite3's destructor checkpoints the WAL — but the backing
        //    file had already been unlinked, so the checkpoint operates on a deleted
        //    file and crashes the native addon. Leaking also let connections
        //    accumulate across the suite, multiplying the destructor work at exit.
        //
        //    Closing here, after onIdle()+setImmediate have settled all statements,
        //    is race-free: TRUNCATE-checkpoint the WAL into the still-present file,
        //    then close(). better-sqlite3 finalizes drizzle's cached statements on
        //    close. Only then do we unlink the (now fully released) files.
        if (rawSqlite.open) {
            try {
                rawSqlite.pragma("wal_checkpoint(TRUNCATE)");
            } catch {
                // checkpoint is best-effort
            }
            try {
                rawSqlite.close();
            } catch {
                // already closed (e.g. a test closed it explicitly)
            }
        }
        for (const suffix of ["", "-wal", "-shm"]) {
            try {
                fs.unlinkSync(`${dbPath}${suffix}`);
            } catch {
                // ignore — file may not exist (e.g. -wal after TRUNCATE close)
            }
        }
    };

    return {
        db,
        rawSqlite,
        agentStore,
        sessionStore,
        taskStore,
        queue,
        // Expose the effective orchestrator (wrapped when defaultProvider is set)
        // so per-test overrides in runTaskViaToolWithProvider compose correctly.
        orchestrator: effectiveOrchestrator,
        policy,
        dagEngine,
        taskDeps: taskDepsRef.value as TaskDeps,
        hooks,
        teardown,
        dbPath,
        sseServer,
        ssePort,
    };
}

/**
 * Rebuild a harness against the SAME DB file (for restart/persistence tests).
 * Does NOT re-run migrations (they're already applied).
 * DOES run the orphan scan.
 */
export async function rebuildHarness(dbPath: string, opts: Omit<HarnessOptions, "dbPath"> = {}): Promise<Harness> {
    return buildHarness({ ...opts, dbPath });
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Wait for the queue to drain (all enqueued tasks finished).
 * Uses p-queue's onIdle() with a bounded deadline, which is more reliable
 * than polling pending+size (which can momentarily read zero between batches).
 */
export async function drainQueue(queue: BackgroundQueue, timeoutMs = 10_000): Promise<void> {
    await Promise.race([
        queue.onIdle(),
        new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`drainQueue timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
    ]);
    // One extra tick to let the last task's finally-block DB writes settle.
    await new Promise<void>((r) => setImmediate(r));
}

/**
 * Create a minimal test agent + open a session. Returns { agentName, sessionId }.
 */
export async function createSessionAndAgent(
    harness: Harness,
    provider: LLMProvider,
    agentOverrides: Partial<AgentCreateInput> = {}
): Promise<{ agentName: string; sessionId: string }> {
    const agentName = `test-agent-${generateId()}`;

    // Inject the provider into the factory by using a special "stub" type
    // The provider is passed via the harness task runner helper
    harness.agentStore.create({
        name: agentName,
        provider: { type: "openai", model: "test-model", baseURL: "http://localhost:1234/v1" },
        systemPrompt: "You are a test assistant.",
        mcpServers: {},
        permissions: {},
        ...agentOverrides,
    });

    const agentDef = harness.agentStore.read(agentName);
    const session = harness.sessionStore.create({
        agentName,
        agentDefinition: agentDef,
    });

    return { agentName, sessionId: session.id };
}

/**
 * Run a task synchronously via the real taskTool, injecting the given provider
 * into the orchestrator for this task only.
 *
 * We achieve provider injection by temporarily monkey-patching the registry
 * to use the scripted provider — the cleanest approach without modifying
 * production source. The provider is captured in a closure inside the harness
 * task runner below.
 */
export async function runTaskViaToolWithProvider(
    harness: Harness,
    sessionId: string,
    prompt: string,
    provider: LLMProvider,
    extraInput: Record<string, unknown> = {}
) {
    // Wrap the orchestrator to inject the scripted provider for this one run
    const realOrchestrator = harness.orchestrator;
    const originalRun = realOrchestrator.run.bind(realOrchestrator);

    const patchedDeps: TaskDeps = {
        ...harness.taskDeps,
        orchestrator: {
            run: (input) => originalRun({ ...input, provider }),
        } as Orchestrator,
    };

    return taskTool(
        { session_id: sessionId, prompt, background: false, ...extraInput } as Parameters<typeof taskTool>[0],
        patchedDeps
    );
}

/**
 * Background version — enqueues and returns immediately; use drainQueue to wait.
 */
export async function enqueueTaskWithProvider(
    harness: Harness,
    sessionId: string,
    prompt: string,
    provider: LLMProvider,
    extraInput: Record<string, unknown> = {}
) {
    const realOrchestrator = harness.orchestrator;
    const originalRun = realOrchestrator.run.bind(realOrchestrator);

    const patchedDeps: TaskDeps = {
        ...harness.taskDeps,
        orchestrator: {
            run: (input) => originalRun({ ...input, provider }),
        } as Orchestrator,
    };

    return taskTool(
        { session_id: sessionId, prompt, background: true, ...extraInput } as Parameters<typeof taskTool>[0],
        patchedDeps
    );
}

// ──────────────────────────────────────────────────────────────────────────────
// Latch utility
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A binary latch. One side waits; the other releases.
 * Used for proving concurrency without sleeps.
 */
export class Latch {
    private _resolve!: () => void;
    private _reject!: (err: Error) => void;
    readonly promise: Promise<void>;

    constructor() {
        this.promise = new Promise<void>((res, rej) => {
            this._resolve = res;
            this._reject = rej;
        });
    }

    release(): void {
        this._resolve();
    }

    fail(err: Error): void {
        this._reject(err);
    }

    /** Await with a bounded deadline. Rejects if deadline exceeded. */
    async wait(timeoutMs = 5_000): Promise<void> {
        return Promise.race([
            this.promise,
            new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error(`Latch.wait timed out after ${timeoutMs}ms`)), timeoutMs)
            ),
        ]);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SSE client helper
// ──────────────────────────────────────────────────────────────────────────────

export interface SseFrame {
    type: string;
    data: Record<string, unknown>;
}

/**
 * Connect to the real SSE server and collect frames until "done" or timeout.
 * Returns collected frames in order.
 *
 * @param port - Ephemeral port from harness.ssePort
 * @param taskId - Task UUID
 * @param timeoutMs - Bounded deadline (default 8s)
 * @param onConnected - Optional callback fired when the HTTP 200 response
 *   headers are received (i.e. the SSE connection is established and the
 *   server has accepted the request). Use this to release a latch that
 *   unblocks a background task, guaranteeing the SSE subscription is active
 *   before any events are emitted.
 */
export async function collectSseFrames(
    port: number,
    taskId: string,
    timeoutMs = 8_000,
    onConnected?: () => void
): Promise<SseFrame[]> {
    return new Promise<SseFrame[]>((resolve, reject) => {
        const frames: SseFrame[] = [];
        const timer = setTimeout(() => {
            reject(new Error(`collectSseFrames timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const req = http.get(
            `http://127.0.0.1:${port}/tasks/${taskId}/stream`,
            { headers: { Accept: "text/event-stream" } },
            (res) => {
                // Fire the onConnected callback as soon as the HTTP response
                // headers arrive — this confirms the SSE endpoint has accepted
                // the request and the subscription is active on the server.
                onConnected?.();
                let buf = "";
                let currentEventType = "";

                res.on("data", (chunk: Buffer) => {
                    buf += chunk.toString();
                    const lines = buf.split("\n");
                    buf = lines.pop() ?? "";

                    for (const line of lines) {
                        if (line.startsWith("event: ")) {
                            currentEventType = line.slice("event: ".length).trim();
                        } else if (line.startsWith("data: ")) {
                            const raw = line.slice("data: ".length).trim();
                            try {
                                const data = JSON.parse(raw) as Record<string, unknown>;
                                frames.push({ type: currentEventType, data });
                                if (currentEventType === "done") {
                                    clearTimeout(timer);
                                    req.destroy();
                                    resolve(frames);
                                }
                            } catch {
                                // ignore parse errors (e.g. ping lines)
                            }
                        }
                        // reset event type on blank line (SSE spec)
                        if (line === "") {
                            currentEventType = "";
                        }
                    }
                });

                res.on("error", (err) => {
                    clearTimeout(timer);
                    // If connection was destroyed after done frame, that's fine
                    if (frames.some((f) => f.type === "done")) {
                        resolve(frames);
                    } else {
                        reject(err);
                    }
                });

                res.on("end", () => {
                    clearTimeout(timer);
                    resolve(frames);
                });
            }
        );

        req.on("error", (err) => {
            clearTimeout(timer);
            // Destroyed connections after done frame are fine
            if (frames.some((f) => f.type === "done")) {
                resolve(frames);
            } else {
                reject(err);
            }
        });
    });
}

// Re-export tools for convenience
export { taskTool, taskCancel, taskResume };
export type { TaskDeps };
