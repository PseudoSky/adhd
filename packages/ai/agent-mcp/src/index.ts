#!/usr/bin/env node
import "dotenv/config";

/** Default max_tokens for providers that do not set maxTokens in their config. */
export const AGENT_MCP_DEFAULT_MAX_TOKENS = parseInt(
    process.env["AGENT_MCP_DEFAULT_MAX_TOKENS"] ?? "8192",
    10
);

// Re-export HookRegistry so plugins can import it for testing without deep internal paths
export { HookRegistry } from "./engine/hooks.js";
// Re-export stores so consumers (tests, plugins) can import from the package root
export { ComposedPromptStore } from "./store/composed-prompt-store.js";
// Re-export prompt resolver for consumers that wire the compiler integration
export { resolveComposedPrompt, computeContextHash } from "./engine/prompt-resolver.js";
export type { ResolveInput, ResolveResult, ResolveResult as PromptResolveResult, CompileAgentFn, PromptResolverDeps } from "./engine/prompt-resolver.js";

import { db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./logger.js";
import { AgentStore, SessionStore, TaskStore } from "./store/index.js";
import { BackgroundQueue } from "./engine/queue.js";
import { DagEngine } from "./engine/dag-engine.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { HookRegistry } from "./engine/hooks.js";
import { PolicyEngine } from "./engine/policy.js";
import { UsagePlugin } from "./plugins/index.js";
import { loadExternalPlugins } from "./plugins/loader.js";
import { startServer } from "./server.js";
import { startSseServer } from "./streaming/sse-server.js";
import { enqueueExistingTask } from "./tools/task.js";
import { tasksTable } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { ToolError } from "./validation/errors.js";

// DEBT-001: top-level safety net for anything that escapes the per-component
// handlers (SSE 'error' event: BUG-001; queue catch: BackgroundQueue.enqueue;
// orchestrator try/catch; provider pRetry). An unhandled error here means a
// structural bug — log structured context and exit so the process doesn't
// silently hang or produce opaque output.
process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — exiting");
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled promise rejection — exiting");
    process.exit(1);
});

async function main() {
    // Run DB migrations synchronously before advertising tools
    runMigrations();

    // Instantiate hooks registry
    const hooks = new HookRegistry();

    // Instantiate stores
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    const agentStore = new AgentStore(dbAny, hooks);
    const sessionStore = new SessionStore(dbAny, hooks);
    const taskStore = new TaskStore(dbAny);

    // Observational usage tracking: accumulates per-task token usage into
    // task_usage on every post:model_response and finalises on terminal events.
    // Must never throw — handlers are internally guarded.
    const usagePlugin = new UsagePlugin(dbAny);
    await usagePlugin.install(hooks);

    // External plugins: loaded from AGENT_MCP_PLUGINS env var.
    // Each entry is a module specifier (absolute path or npm package name) that
    // exports a createPlugin(ctx) factory. Failures are logged and skipped.
    await loadExternalPlugins(hooks, dbAny);

    // Instantiate engine components
    const queue = new BackgroundQueue();
    const orchestrator = new Orchestrator();
    const policy = new PolicyEngine({
        serverMaxDepth: parseInt(process.env["AGENT_MCP_MAX_DEPTH"] ?? "5", 10),
        serverMaxToolLoops: parseInt(process.env["AGENT_MCP_MAX_TOOL_LOOPS"] ?? "50", 10),
        serverAllowedAgents: process.env["ALLOWED_AGENTS"]
            ?.split(",")
            .map(s => s.trim())
            .filter(Boolean),
    });

    // Build DagEngine with an injected dispatchFn closure.
    //
    // The closure avoids a circular import between dag-engine.ts and tools/task.ts:
    // DagEngine dispatches waiting→pending tasks by calling dispatchFn(taskId) rather
    // than importing enqueueExistingTask directly. The closure captures `taskDeps`
    // which is populated after startServer resolves (below).
    //
    // dispatchFn is only invoked when DagEngine.dispatchReady() finds a ready task,
    // which always happens AFTER server startup, so `taskDeps` is guaranteed to be
    // set by the time the closure executes.
    let taskDeps: Parameters<typeof enqueueExistingTask>[1] | undefined;

    const dispatchFn = async (taskId: string): Promise<void> => {
        if (!taskDeps) {
            throw new Error(`DagEngine.dispatchFn called before server initialised (taskId=${taskId})`);
        }
        await enqueueExistingTask(taskId, taskDeps);
    };

    const dagEngine = new DagEngine(dbAny, queue, taskStore, dispatchFn);

    // Start SSE server alongside MCP server — shares taskStore for terminal-on-connect checks.
    const sseServer = startSseServer(taskStore);

    const { close } = await startServer({
        agentStore,
        sessionStore,
        taskStore,
        queue,
        orchestrator,
        policy,
        hooks,
        db: dbAny,
        dagEngine,
    });

    // Startup re-enqueue scan: recover tasks that were transitioned to "pending"
    // by DagEngine.dispatchReady() but lost their queue slot due to a process
    // crash between the DB UPDATE and queue.enqueue(). Safe to run every startup
    // because the queue is idempotent — already-running tasks are just re-queued.
    //
    // taskDeps must be set before the orphan scan so dispatchFn can call
    // enqueueExistingTask.
    //
    // NOTE: inProcessDescriptors and inProcessHandler are not available here
    // (they are local to server.ts). Dag-dispatched tasks do NOT support
    // in-process recursive calls at the dispatch level — they can use in-process
    // tools once running via the normal orchestrator path through server.ts.
    // Pass empty stubs: the orchestrator builds its own registry per task.
    taskDeps = {
        agentStore,
        sessionStore,
        taskStore,
        orchestrator,
        queue,
        policy,
        hooks,
        selfUrl: undefined,
        inProcessDescriptors: [],
        inProcessHandler: async () => {
            throw new ToolError("VALIDATION_ERROR", "in-process tools unavailable during dag dispatch");
        },
        db: dbAny,
        dagEngine,
    };

    const orphanedPending = dbAny
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.status, "pending"))
        .all() as Array<{ id: string }>;

    if (orphanedPending.length > 0) {
        logger.info({ count: orphanedPending.length }, "Re-enqueueing orphaned pending tasks");
        for (const row of orphanedPending) {
            try {
                await enqueueExistingTask(row.id, taskDeps);
            } catch (err) {
                logger.warn({ taskId: row.id, err }, "Failed to re-enqueue orphaned task");
            }
        }
    }

    const shutdown = async (signal: string) => {
        logger.info({ signal }, "Server shutdown");
        await close();
        // Await SSE drain before exiting — close() is callback-based, so calling
        // process.exit on the next line would race the drain.
        await new Promise<void>(resolve => sseServer.close(() => resolve()));
        process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(err => {
    logger.fatal({ err }, "Fatal startup error");
    process.exit(1);
});
