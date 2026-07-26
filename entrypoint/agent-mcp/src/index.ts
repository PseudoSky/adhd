#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { db } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { logger } from "./logger.js";
import { env, toEngineConfig, resolveInitialSsePort, setSseBoundPort } from "./config.js";
import { AgentStore } from "./store/agent-store.js";

import { resolveRegistryDbPath, openRegistryDb } from "@adhd/agent-core-env";
import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import {
    ComposedPromptStore,
    runMigrationsOn as runPromptsMigrationsOn,
    MIGRATIONS_FOLDER as PROMPTS_MIGRATIONS_FOLDER,
} from "@adhd/agent-store-prompts";
import {
    runMigrationsOn as runProviderMigrationsOn,
    MIGRATIONS_FOLDER as PROVIDER_MIGRATIONS_FOLDER,
} from "@adhd/agent-core-provider";
import {
    runMigrationsOn as runToolsMigrationsOn,
    MIGRATIONS_FOLDER as TOOLS_MIGRATIONS_FOLDER,
} from "@adhd/agent-store-tools";
import {
    runMigrationsOn as runPolicyMigrationsOn,
    MIGRATIONS_FOLDER as POLICY_MIGRATIONS_FOLDER,
} from "@adhd/agent-core-policy";
// NOTE: @adhd/agent-engine-compiler is deliberately NOT statically imported
// here — it is lazy-loaded (`await import(...)`) in main() below so the
// server can still boot with flat system-prompts if the package is ever
// absent, and @nx/enforce-module-boundaries forbids mixing a static import
// of a lazy-loaded library in the same project. Its runMigrationsOn/
// MIGRATIONS_FOLDER are obtained from that same dynamic import and threaded
// through BuildPromptResolverOpts instead (see main()).

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

// Structural type for @adhd/agent-engine-compiler's runMigrationsOn — identical
// signature to the other four registry-family packages' runMigrationsOn
// (all generated from the same @adhd/agent-nx registry-package template), so
// it's safe to reuse this type without a static import of agent-engine-compiler.
type RegistryMigrationsOnFn = typeof runProviderMigrationsOn;

export interface BuildPromptResolverOpts {
    registryDbPath?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentMcpDb: any;
    compileAgentFn?: CompileAgentFn;
    /** From the same lazy `await import("@adhd/agent-engine-compiler")` as compileAgentFn. */
    compilerMigrationsOn?: RegistryMigrationsOnFn;
    /** From the same lazy `await import("@adhd/agent-engine-compiler")` as compileAgentFn. */
    compilerMigrationsFolder?: string;
}

export function buildPromptResolver(opts: BuildPromptResolverOpts): PromptResolverDeps | undefined {
    // `agentMcpDb` (opts.agentMcpDb) is intentionally NOT used below: it is the
    // OPERATIONAL db connection, but ComposedPromptStore's schema
    // (`registry_composed_prompts`, agent-store-prompts/src/db/schema.ts) is a
    // registry-family table created only by that package's own migrations —
    // which this function now runs against `registryDb`, not `agentMcpDb`.
    // Constructing the store against `agentMcpDb` would throw "no such table:
    // registry_composed_prompts" on first use (a second, real bug found while
    // fixing BUG-AGENTMCP-REGISTRY-DB-CANTOPEN-001 — the crash this fixes
    // always happened before this code path could ever be reached, so it was
    // never exercised in production). Kept in the public opts type for
    // backward compatibility.
    const { registryDbPath, compileAgentFn, compilerMigrationsOn, compilerMigrationsFolder } = opts;

    if (!registryDbPath) {
        return undefined;
    }

    if (!compileAgentFn || !compilerMigrationsOn || !compilerMigrationsFolder) {
        logger.info(
            "@adhd/agent-engine-compiler not available — registry/compiler integration disabled; using flat system-prompts"
        );
        return undefined;
    }

    let registrySqlite: Database.Database;
    try {
        // Zero-config default: `registryDbPath` (via @adhd/agent-core-env's
        // resolveRegistryDbPath(), ~/.adhd/agent-registry/production/data/
        // registry.db) has never been written by anything on a fresh
        // machine. openRegistryDb() mkdir's the parent dir, opens WITHOUT
        // `fileMustExist`, and sets the same pragmas the pre-migration
        // singleton did (journal_mode=WAL, foreign_keys=ON) — then we run
        // the full registry-family migration set so the file is
        // schema-current before any compiler store queries it
        // (BUG-AGENTMCP-REGISTRY-DB-CANTOPEN-001). `runMigrationsOn` itself
        // toggles `foreign_keys` OFF/ON around each migration run
        // regardless of the connection's current setting, so opening with
        // foreign_keys already ON here is safe (see migrate-runner.ts).
        logger.info({ registryDbPath }, "Opening registry DB for compiler integration");
        registrySqlite = openRegistryDb({ registryDbPath }).sqlite;

        // The registry is a five-package shared-SQLite-file family (see
        // packages/agent/agent-engine-compiler/CLAUDE.md "One shared SQLite
        // file"): agent-core-provider (provider_*), agent-store-prompts
        // (registry_*), agent-store-tools (tool_*), agent-core-policy
        // (policy_*), agent-engine-compiler (compiler_*). All five migration
        // sets must be applied, in this exact ascending-timestamp order, to
        // this same connection before compileAgent()'s stores can query it —
        // mirrors agent-engine-compiler/src/cli/compile.ts's proven openDb().
        const registryMigrationDb = drizzle(registrySqlite);
        runProviderMigrationsOn(registrySqlite, registryMigrationDb, PROVIDER_MIGRATIONS_FOLDER);
        runPromptsMigrationsOn(registrySqlite, registryMigrationDb, PROMPTS_MIGRATIONS_FOLDER);
        runToolsMigrationsOn(registrySqlite, registryMigrationDb, TOOLS_MIGRATIONS_FOLDER);
        runPolicyMigrationsOn(registrySqlite, registryMigrationDb, POLICY_MIGRATIONS_FOLDER);
        compilerMigrationsOn(registrySqlite, registryMigrationDb, compilerMigrationsFolder);
    } catch (err) {
        logger.info(
            { registryDbPath, err },
            "Registry DB not available — falling back to flat systemPrompt for all agents"
        );
        return undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registryDb = drizzle(registrySqlite) as any;

    const composedPromptStore = new ComposedPromptStore(registryDb);

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
        // BUG-MCP-CREDENTIALS-001: these are raw env-var-NAME references
        // (provider.env.secret/base_url/model), resolved only via
        // `Environment#resolveEnvName` (a live process.env read) — never via
        // the `config.local.yaml` FieldSpec cascade, which only covers this
        // spec's declared dot-path config fields (`transport.port`, etc.).
        // The previous remediation text ("Set them in
        // ~/.adhd/agent-mcp/production/config.local.yaml") was misleading:
        // that file is real, but it has no mechanism to set an arbitrary
        // env-var-name entry — only declared config fields. Point at the
        // actual mechanism instead (utils/load-env.ts's `.env` hierarchy).
        logger.warn(
            { missingEnvVars: missing },
            "Startup warning: the following env vars are referenced in agent configs but are not set. " +
            "Tasks using those agents will fail at credential resolution. " +
            "Set them in ~/.adhd/.env (or <project>/.adhd/.env, <project>/.env), or export them in the environment directly."
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
    let compilerMigrationsOn: RegistryMigrationsOnFn | undefined;
    let compilerMigrationsFolder: string | undefined;
    try {
        const compilerModule = await import("@adhd/agent-engine-compiler");
        compileAgentFn = compilerModule.compileAgent;
        compilerMigrationsOn = compilerModule.runMigrationsOn;
        compilerMigrationsFolder = compilerModule.MIGRATIONS_FOLDER;
    } catch {
        logger.info(
            "@adhd/agent-engine-compiler not installed — registry/compiler integration disabled; using flat system-prompts"
        );
    }

    const promptResolver = buildPromptResolver({
        // env.config.server.registryDbPath is unset by default (config.ts) —
        // resolveRegistryDbPath() supplies the canonical fallback so this
        // entrypoint and the 5 registry-family packages always agree on ONE
        // path. An explicit ADHD_AGENT_REGISTRY_DB_PATH (or a config-file
        // layer) still wins, exactly as before this migration.
        registryDbPath: env.config.server.registryDbPath ?? resolveRegistryDbPath(),
        agentMcpDb: dbAny,
        compileAgentFn,
        compilerMigrationsOn,
        compilerMigrationsFolder,
    });

    try {
        const allAgents = agentStore.list() as AgentDefinition[];
        verifyAgentEnvRefs(allAgents);
    } catch (err) {
        logger.warn({ err }, "Startup env-ref verification failed — continuing");
    }

    const gatewayDepsRef: GatewayDepsRef = { value: undefined };

    // BUG-AGENTMCP-SSE-PORT-CONTENTION-001: agent-mcp is a stdio-transport
    // server — every host connection is its own OS process, so N instances
    // run concurrently and would otherwise all race for the same fixed SSE
    // port. `sse.enabled=false` lets an operator skip the bind entirely
    // (see config.ts); otherwise resolve a per-instance/explicit-pin
    // candidate port and let startSseServer's EADDRINUSE→ephemeral
    // fallback guarantee it always succeeds. Awaited here — BEFORE
    // toEngineConfig() is ever called below — so setSseBoundPort() lands
    // ahead of every consumer, including the one snapshot of it cached
    // into taskDepsRef.value at startup.
    let sseServer: Awaited<ReturnType<typeof startSseServer>>["server"] | undefined;
    if (env.config.sse.enabled) {
        const { port: initialPort, explicit } = resolveInitialSsePort();
        logger.info(
            { port: initialPort, explicit },
            "Starting SSE/gateway HTTP server"
        );
        const result = await startSseServer(taskStore, initialPort, env.config.sse.host, gatewayDepsRef);
        sseServer = result.server;
        setSseBoundPort(result.port);
        if (result.port === undefined) {
            logger.warn(
                "SSE/gateway HTTP server could not bind on this instance — stream_url links and the OpenAI-compat gateway are unavailable; the MCP server continues normally"
            );
        }
    } else {
        logger.info("SSE/gateway HTTP server disabled (ADHD_AGENT_SSE_ENABLED=false) — skipping bind");
        setSseBoundPort(undefined);
    }

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
        const activeSseServer = sseServer;
        if (activeSseServer) {
            await new Promise<void>(resolve => activeSseServer.close(() => resolve()));
        }
        process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Only run the server when this module is the process entrypoint (`node
// dist/src/index.js`, or the `agent-mcp` bin) — NOT when something else
// imports it (e.g. a test importing `buildPromptResolver`). Without this
// guard, `main()` fires as an unconditional import-time side effect: it
// opens the REAL user's `~/.adhd/agent-mcp/*.db` files, binds the real SSE
// port, and starts background queues/plugins — surfaced while adding the
// teeth test for BUG-AGENTMCP-REGISTRY-DB-CANTOPEN-001 (importing `./index.js`
// for its one exported function silently ran a full production server).
const isMainModule =
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
    main().catch(err => {
        logger.fatal({ err }, "Fatal startup error");
        process.exit(1);
    });
}
