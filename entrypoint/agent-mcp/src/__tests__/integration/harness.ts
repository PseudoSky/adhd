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

import * as entrypointSchema from "../../db/schema.js";
import {
  sessionsTable,
  messagesTable,
  tasksTable,
  taskEventsTable,
  SessionStore,
  TaskStore,
  generateId,
} from "@adhd/agent-store-runtime";
import {
  BackgroundQueue,
  DagEngine,
  Orchestrator,
  HookRegistry,
  PolicyEngine,
  enqueueExistingTask,
  taskTool,
  taskCancel,
  taskResume,
  type TaskDeps,
  type LLMProvider,
} from "@adhd/agent-engine-orchestrator";
import { AgentStore } from "../../store/agent-store.js";
import { runMigrationsOn, MIGRATIONS_FOLDER } from "../../db/migrate-runner.js";
import { startSseServer } from "../../streaming/sse-server.js";
import { emitTaskEvent } from "../../streaming/event-bus.js";
import { eq } from "drizzle-orm";
import type { EngineConfig, EngineLogger } from "@adhd/agent-engine-orchestrator";
import type { AgentCreateInput } from "@adhd/agent-engine-orchestrator";

/** Combined drizzle schema for harness-level direct table access */
const combinedSchema = {
  ...entrypointSchema,
  sessionsTable,
  messagesTable,
  tasksTable,
  taskEventsTable,
};

export type TestDb = ReturnType<typeof drizzle<typeof combinedSchema>>;

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
   */
  defaultProvider?: LLMProvider;
}

/** Build a test EngineLogger that is silent by default */
function testLogger(level: "silent" | "warn" = "silent"): EngineLogger {
  if (level === "silent") {
    return {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      info: () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      warn: () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      error: () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      debug: () => {},
    };
  }
  return {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    info: () => {},
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    debug: () => {},
  };
}

/**
 * Build a test EngineConfig with defaults suitable for integration tests.
 *
 * Deliberately self-contained (does NOT import the real `env` singleton
 * from `../../config.js`, which resolves against the real machine's
 * `~/.adhd` / `process.env` cascade) — mirrors `agentMcpEnvironmentSpec`'s
 * `server.defaultMaxTokens` (8192) and `sse.port` (3001) spec defaults as
 * plain literals so this harness never touches real host state.
 */
function testConfig(_opts: {
  serverMaxToolLoops?: number;
} = {}): EngineConfig {
  return {
    server: {
      contextLimit: 0,
      defaultMaxTokens: 8192,
    },
    queue: { concurrency: 5 },
    sse: { baseUrl: `http://localhost:3001` },
    plugins: { entries: [] },
    getProviderConfig(opts) {
      return { secret: opts.secret ? process.env[opts.secret] : undefined, baseURL: opts.inlineBaseURL, model: opts.inlineModel };
    },
    subprocessEnv() {
      return {};
    },
    resolveEnvName(name: string) {
      return this.isEnvNameAllowed(name) ? process.env[name] : undefined;
    },
    isEnvNameAllowed(name: string) {
      return name.startsWith("ADHD_AGENT_") || name.startsWith("LMSTUDIO_");
    },
  };
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

  const db = drizzle(rawSqlite, { schema: combinedSchema }) as unknown as TestDb;

  // Run migrations — same folder + FK-safe runner as production
  runMigrationsOn(rawSqlite, db as Parameters<typeof runMigrationsOn>[1], MIGRATIONS_FOLDER);

  const hooks = new HookRegistry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;

  const agentStore = new AgentStore(dbAny, hooks);
  const sessionStore = new SessionStore(dbAny, hooks);
  const taskStore = new TaskStore(dbAny);

  const config = testConfig({ serverMaxToolLoops: opts.serverMaxToolLoops });
  const logger = testLogger("silent");

  const queue = new BackgroundQueue(5, logger);
  const orchestrator = new Orchestrator();
  const policy = new PolicyEngine({
    serverMaxDepth: 5,
    serverMaxToolLoops: opts.serverMaxToolLoops ?? 50,
  });

  // Mirror dispatchFn wiring from index.ts.
  const taskDepsRef: { value: TaskDeps | undefined } = { value: undefined };

  const dispatchFn = async (taskId: string): Promise<void> => {
    if (!taskDepsRef.value) throw new Error("dispatchFn called before harness initialized");
    await enqueueExistingTask(taskId, taskDepsRef.value);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dagEngine = new DagEngine(dbAny, queue, taskStore as any, dispatchFn, logger);

  // SSE server (optional)
  let sseServer: http.Server | undefined;
  let ssePort: number | undefined;

  if (opts.withSse) {
    sseServer = startSseServer(taskStore, 0, "127.0.0.1");
    await new Promise<void>((resolve) => {
      const readPort = () => {
        if (!sseServer) throw new Error("sseServer not started");
        const addr = sseServer.address() as { port: number } | null;
        ssePort = addr?.port;
        resolve();
      };
      const svr = sseServer;
      if (!svr) throw new Error('sseServer not initialized');
      if (svr.listening) readPort();
      else svr.once("listening", readPort);
    });
  }

  // Build taskDeps — same shape as index.ts.
  const effectiveOrchestrator: Orchestrator = opts.defaultProvider
    ? ({
        run: (input: Parameters<Orchestrator["run"]>[0]) => {
          const provider = opts.defaultProvider;
          if (!provider) throw new Error("Harness: defaultProvider unexpectedly null");
          return orchestrator.run({ ...input, provider });
        },
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
    config,
    logger,
    emitTaskEvent: emitTaskEvent as NonNullable<TaskDeps["emitTaskEvent"]>,
  };

  // Re-enqueue orphaned pending tasks
  if (!opts.skipOrphanScan) {
    const orphanedPending = dbAny
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.status, "pending"))
      .all() as Array<{ id: string }>;

    for (const row of orphanedPending) {
      try {
        if (!taskDepsRef.value) throw new Error("Harness: taskDepsRef.value not initialized");
        await enqueueExistingTask(row.id, taskDepsRef.value);
      } catch {
        // ignore failures in teardown
      }
    }
  }

  const teardown = async (): Promise<void> => {
    if (sseServer) {
      const srv = sseServer;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }

    await Promise.race([
      queue.onIdle(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("teardown: queue.onIdle() timed out after 15s")), 15_000)
      ),
    ]).catch(() => {
      // Log but don't rethrow — we still need to close the DB.
    });

    await new Promise<void>((r) => setImmediate(r));

    if (rawSqlite.open) {
      try {
        rawSqlite.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // checkpoint is best-effort
      }
      try {
        rawSqlite.close();
      } catch {
        // already closed
      }
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore — file may not exist
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
 */
export async function rebuildHarness(dbPath: string, opts: Omit<HarnessOptions, "dbPath"> = {}): Promise<Harness> {
  return buildHarness({ ...opts, dbPath });
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Wait for the queue to drain (all enqueued tasks finished).
 */
export async function drainQueue(queue: BackgroundQueue, timeoutMs = 10_000): Promise<void> {
  await Promise.race([
    queue.onIdle(),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`drainQueue timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
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

  harness.agentStore.create({
    name: agentName,
    provider: { type: "openai", model: "test-model", baseURL: "http://localhost:1234/v1" },
    systemPrompt: "You are a test assistant.",
    mcpServers: {},
    permissions: {},
    ...agentOverrides,
  } as AgentCreateInput);

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
 */
export async function runTaskViaToolWithProvider(
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
                // ignore parse errors
              }
            }
            if (line === "") {
              currentEventType = "";
            }
          }
        });

        res.on("error", (err) => {
          clearTimeout(timer);
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
