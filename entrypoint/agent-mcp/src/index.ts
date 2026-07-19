#!/usr/bin/env node

import { db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./logger.js";
import { env, toEngineConfig } from "./config.js";
import { AgentStore } from "./store/agent-store.js";

import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import { ComposedPromptStore } from "@adhd/agent-store-prompts";

import type { CompileAgentFn, PromptResolverDeps } from "@adhd/agent-engine-orchestrator";
import {
  BackgroundQueue,
  DagEngine,
  Orchestrator,
  HookRegistry,
  PolicyEngine,
  UsagePlugin,
  loadExternalPlugins,
  enqueueExistingTask,
} from "@adhd/agent-engine-orchestrator";

import { startServer } from "./server.js";
import { startSseServer } from "./streaming/sse-server.js";
import type { GatewayDepsRef } from "./streaming/chat-gateway.js";
import { emitTaskEvent } from "./streaming/event-bus.js";

import { tasksTable } from "@adhd/agent-store-runtime";
import { eq } from "drizzle-orm";
import { ToolError } from "@adhd/agent-engine-orchestrator";
import type { AgentDefinition } from "@adhd/agent-engine-orchestrator";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

export { HookRegistry } from "@adhd/agent-engine-orchestrator";
export { ComposedPromptStore } from "@adhd/agent-store-prompts";

export interface BuildPromptResolverOpts {
    registryDbPath?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentMcpDb: any;
    compileAgentFn?: CompileAgentFn;
}

export function buildPromptResolver(opts: BuildPromptResolverOpts): PromptResolverDeps | undefined {
    const { registryDbPath, agentMcpDb, compileAgentFn } = opts;

    if (!registryDbPath) {
        return undefined;
    }

    if (!compileAgentFn) {
        logger.info(
            "@adhd/agent-engine-compiler not available — registry/compiler integration disabled; using flat system-prompts"
        );
        return undefined;
    }

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
        compileAgentFn,
        registryDb,
    };
}

process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — exiting");
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled promise rejection — exiting");
    process.exit(1);
});

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

    const uniqueNames = [...new Set(names)];
    const missing: string[] = [];
    const disallowed: string[] = [];
    for (const n of uniqueNames) {
      if (!env.isEnvNameAllowed(n)) disallowed.push(n);
      else if (!env.resolveEnvName(n)) missing.push(n);
    }

    if (missing.length > 0) {
        logger.warn(
            { missingEnvVars: missing },
            "Startup warning: the following env vars are referenced in agent configs but are not set. " +
            "Tasks using those agents will fail at credential resolution. " +
            "Set them in ~/.adhd/agent-mcp/production/config.local.yaml or the environment directly."
        );
    }
    if (disallowed.length > 0) {
        logger.warn(
            { disallowedEnvVars: disallowed },
            "Startup warning: the following env-var names in agent configs violate the ADHD_AGENT_- prefix guard " +
            "and will never resolve — only ADHD_AGENT_*-prefixed env vars are permitted as agent env refs."
        );
    }
}

async function main() {
    runMigrations();

    const hooks = new HookRegistry();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    const agentStore = new AgentStore(dbAny, hooks);
    const sessionStore = new SessionStore(dbAny, hooks);
    const taskStore = new TaskStore(dbAny);

    const usagePlugin = new UsagePlugin(dbAny);
    await usagePlugin.install(hooks);

    await loadExternalPlugins(hooks, dbAny, undefined, env.config.plugins.configPath, env.config.plugins.entries as string[], logger);

    const queue = new BackgroundQueue(env.config.queue.concurrency, logger);
    const orchestrator = new Orchestrator();
    const policy = new PolicyEngine({
        serverMaxDepth:      env.config.server.maxDepth,
        serverMaxToolLoops:  env.config.server.maxToolLoops,
        serverAllowedAgents: env.config.server.allowedAgents as string[] | undefined,
    });

    const taskDepsRef: { value: Parameters<typeof enqueueExistingTask>[1] | undefined } = { value: undefined };

    const dispatchFn = async (taskId: string): Promise<void> => {
        if (!taskDepsRef.value) {
            throw new Error(`DagEngine.dispatchFn called before server initialised (taskId=${taskId})`);
        }
        await enqueueExistingTask(taskId, taskDepsRef.value);
    };

    const dagEngine = new DagEngine(dbAny as import("drizzle-orm/better-sqlite3").BetterSQLite3Database<Record<string, never>>, queue, taskStore, dispatchFn, logger);

    let compileAgentFn: CompileAgentFn | undefined;
    try {
        ({ compileAgent: compileAgentFn } = await import("@adhd/agent-engine-compiler"));
    } catch {
        logger.info(
            "@adhd/agent-engine-compiler not installed — registry/compiler integration disabled; using flat system-prompts"
        );
    }

    const promptResolver = buildPromptResolver({
        registryDbPath: env.config.server.registryDbPath,
        agentMcpDb: dbAny,
        compileAgentFn,
    });

    try {
        const allAgents = agentStore.list() as AgentDefinition[];
        verifyAgentEnvRefs(allAgents);
    } catch (err) {
        logger.warn({ err }, "Startup env-ref verification failed — continuing");
    }

    const gatewayDepsRef: GatewayDepsRef = { value: undefined };
    const sseServer = startSseServer(taskStore, env.config.sse.port, env.config.sse.host, gatewayDepsRef);

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

    taskDepsRef.value = {
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
        config: toEngineConfig(),
        logger,
        emitTaskEvent: emitTaskEvent as NonNullable<Parameters<typeof enqueueExistingTask>[1]>["emitTaskEvent"],
    } as Parameters<typeof enqueueExistingTask>[1];

    const taskDeps = taskDepsRef.value;

    gatewayDepsRef.value = {
        agentStore,
        sessionStore,
        taskStore,
        taskDeps,
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
