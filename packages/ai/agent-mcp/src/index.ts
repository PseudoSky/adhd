#!/usr/bin/env node
// config.ts handles dotenv hierarchy loading at module-load time; no separate
// "dotenv/config" import needed.
import os from "node:os";
import path from "node:path";

// Re-export HookRegistry so plugins can import it for testing without deep internal paths
export { HookRegistry } from "./engine/hooks.js";
// Re-export stores so consumers (tests, plugins) can import from the package root
export { ComposedPromptStore } from "./store/composed-prompt-store.js";
// Re-export prompt resolver for consumers that wire the compiler integration
export { resolveComposedPrompt, computeContextHash } from "./engine/prompt-resolver.js";
export type { ResolveInput, ResolveResult, ResolveResult as PromptResolveResult, CompileAgentFn, PromptResolverDeps } from "./engine/prompt-resolver.js";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { compileAgent } from "@adhd/agent-compiler";

import { db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { AgentStore, SessionStore, TaskStore } from "./store/index.js";
import { ComposedPromptStore } from "./store/composed-prompt-store.js";
import type { PromptResolverDeps } from "./engine/prompt-resolver.js";
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
import type { AgentDefinition } from "./validation/index.js";

// ── buildPromptResolver ───────────────────────────────────────────────────────
//
// Pure factory that constructs the PromptResolverDeps struct from environment
// config.  Extracted from main() so tests can drive it directly without booting
// the full server.
//
// Exported at the package root so index-wiring.test.ts can import it and assert
// the composition-root wiring behaviour (Plan 6 gap F-P6-8b).

export interface BuildPromptResolverOpts {
    /** Path to the agent-registry SQLite file.  Absent → resolver is undefined. */
    registryDbPath?: string;
    /**
     * The agent-mcp Drizzle DB handle, used to construct ComposedPromptStore.
     * Must already have agent-mcp migrations applied.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentMcpDb: any;
}

/**
 * Build a {@link PromptResolverDeps} from a registry DB path and the agent-mcp
 * DB handle.
 *
 * - When `registryDbPath` is provided, opens the SQLite file in WAL mode, wraps
 *   it with Drizzle, and wires {@link compileAgent} from @adhd/agent-compiler.
 * - When `registryDbPath` is absent (undefined / empty string), returns
 *   `undefined` — the legacy flat-systemPrompt path is used unchanged.
 *
 * This function has no observable side-effects beyond opening the SQLite file
 * when a path is supplied, so it is safe to call in tests with a real on-disk
 * DB path.
 *
 * @param opts.registryDbPath  - Path to the agent-registry SQLite file.
 * @param opts.agentMcpDb      - Drizzle handle for the agent-mcp DB.
 * @returns Wired {@link PromptResolverDeps} or `undefined`.
 */
export function buildPromptResolver(opts: BuildPromptResolverOpts): PromptResolverDeps | undefined {
    const { registryDbPath, agentMcpDb } = opts;

    if (!registryDbPath) {
        return undefined;
    }

    // Graceful degradation: the registry DB at the default path
    // (~/.adhd/agent-mcp/registry.db) will be absent or unmigrated until Plan 7
    // imports the corpus.  Opening a nonexistent directory throws; an empty /
    // unmigrated DB produces empty tables that cause compileAgent to throw, which
    // resolveComposedPrompt already catches and converts to a null (flat-prompt
    // fallback).  We catch the open failure here so the server still starts and
    // every flat-systemPrompt agent continues to work unchanged.
    let registrySqlite: Database.Database;
    try {
        logger.info({ registryDbPath }, "Opening registry DB for compiler integration");
        registrySqlite = new Database(registryDbPath, { fileMustExist: true });
        registrySqlite.pragma("journal_mode = WAL");
        registrySqlite.pragma("foreign_keys = ON");
    } catch (err) {
        logger.info(
            { registryDbPath, err },
            "Registry DB not available — falling back to flat systemPrompt for all agents"
        );
        return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registryDb = drizzle(registrySqlite) as any;

    const composedPromptStore = new ComposedPromptStore(agentMcpDb);

    return {
        composedPromptStore,
        compileAgentFn: compileAgent,
        registryDb,
    };
}

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

// ── Startup env-ref verification (§4) ────────────────────────────────────────
// Harvest every ADHD_AGENT_* env-var name referenced across all agent env blocks,
// then call config.verifyEnvRefs to surface missing / disallowed names as
// structured warnings. Never crashes — one misconfigured agent must not block the
// rest of a mixed deployment.

function verifyAgentEnvRefs(agents: AgentDefinition[]): void {
    const names: string[] = [];
    for (const agent of agents) {
        const p = agent.provider;
        if (p.type === "openai" || p.type === "anthropic") {
            const env = p.env;
            if (env?.secret)   names.push(env.secret);
            if (env?.base_url) names.push(env.base_url);
            if (env?.model)    names.push(env.model);
        }
    }

    if (names.length === 0) return;

    const { missing, disallowed } = config.verifyEnvRefs(names);

    if (missing.length > 0) {
        logger.warn(
            { missingEnvVars: missing },
            "Startup warning: the following env vars are referenced in agent configs but are not set. " +
            "Tasks using those agents will fail at credential resolution. " +
            "Set them in ~/.adhd/.env."
        );
    }
    if (disallowed.length > 0) {
        logger.warn(
            { disallowedEnvVars: disallowed },
            "Startup warning: the following env-var names in agent configs violate the ADHD_AGENT_- prefix guard. " +
            "Add them to ADHD_AGENT_ENV_ALLOWLIST if they are intentional."
        );
    }
}

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

    // External plugins: loaded from config.plugins.entries (ADHD_AGENT_PLUGINS env var).
    // Each entry is a module specifier (absolute path or npm package name) that
    // exports a createPlugin(ctx) factory. Failures are logged and skipped.
    await loadExternalPlugins(hooks, dbAny);

    // Instantiate engine components
    const queue = new BackgroundQueue();
    const orchestrator = new Orchestrator();
    const policy = new PolicyEngine({
        serverMaxDepth:      config.server.maxDepth,
        serverMaxToolLoops:  config.server.maxToolLoops,
        serverAllowedAgents: config.server.allowedAgents as string[] | undefined,
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

    // ── Prompt resolver (compiler integration) ────────────────────────────
    //
    // Delegates to buildPromptResolver() — the exported factory that is also
    // exercised directly by index-wiring.test.ts (Plan 6 gap F-P6-8b).
    //
    // When ADHD_AGENT_REGISTRY_DB_PATH is set, buildPromptResolver opens the
    // SQLite file and wires compileAgent from @adhd/agent-compiler.  Every
    // `agent` tool call then resolves the system-prompt via the compiler (with
    // a composed_prompts cache look-up) before creating the session.
    //
    // When absent, buildPromptResolver returns undefined and the server falls
    // back to the stored flat systemPrompt — existing callers and all legacy-agent
    // tests continue to work unchanged.
    const promptResolver = buildPromptResolver({
        registryDbPath: config.server.registryDbPath,
        agentMcpDb: dbAny,
    });

    // ── Startup env-ref verification (§4) ─────────────────────────────────
    // Must run after store init so we can list all agents.
    try {
        const allAgents = agentStore.list() as AgentDefinition[];
        verifyAgentEnvRefs(allAgents);
    } catch (err) {
        logger.warn({ err }, "Startup env-ref verification failed — continuing");
    }

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
        promptResolver,
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
