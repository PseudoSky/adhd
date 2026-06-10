#!/usr/bin/env node
import "dotenv/config";

import { db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./logger.js";
import { AgentStore, SessionStore, TaskStore } from "./store/index.js";
import { BackgroundQueue } from "./engine/queue.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { HookRegistry } from "./engine/hooks.js";
import { PolicyEngine } from "./engine/policy.js";
import { UsagePlugin } from "./plugins/index.js";
import { startServer } from "./server.js";

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

    // Instantiate engine components
    const queue = new BackgroundQueue();
    const orchestrator = new Orchestrator();
    const policy = new PolicyEngine({
        serverMaxDepth: parseInt(process.env["MAX_DEPTH"] ?? "5", 10),
        serverMaxToolLoops: parseInt(process.env["MAX_TOOL_LOOPS"] ?? "10", 10),
        serverAllowedAgents: process.env["ALLOWED_AGENTS"]
            ?.split(",")
            .map(s => s.trim())
            .filter(Boolean),
    });

    const { close } = await startServer({
        agentStore,
        sessionStore,
        taskStore,
        queue,
        orchestrator,
        policy,
        hooks,
    });

    const shutdown = async (signal: string) => {
        logger.info({ signal }, "Server shutdown");
        await close();
        process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(err => {
    logger.fatal({ err }, "Fatal startup error");
    process.exit(1);
});
