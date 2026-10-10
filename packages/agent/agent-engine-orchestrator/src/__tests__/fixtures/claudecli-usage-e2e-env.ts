/**
 * Shared e2e scaffold (ADR-0009 lane) for the r2-measure bucket (debd934d / afa37093 / 8333f755).
 *
 * Real components: `taskTool` -> `Orchestrator` -> `ClaudeCliProvider` -> a REAL child process (a fake `claude`
 * fixture: fake-claude-usage.mjs / fake-claude-mcp.mjs) -> the real loopback bridge -> `McpClientRegistry` -> a
 * real stdio MCP server, against a real better-sqlite3 database built from the shipped migrations, with the
 * real `UsagePlugin` installed. The ONLY stub is the model: the `claude` executable.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as schema from "@adhd/agent-store-runtime";
import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition } from "@adhd/agent-base-types";

import type { TaskDeps } from "../../tools/task.js";
import type { AgentStore } from "../../tools/agent-crud.js";
import type { SessionStoreForTool } from "../../tools/session.js";
import { PolicyEngine } from "../../engine/policy.js";
import { HookRegistry } from "../../engine/hooks.js";
import { BackgroundQueue } from "../../engine/queue.js";
import { DagEngine } from "../../engine/dag-engine.js";
import { Orchestrator } from "../../engine/orchestrator.js";
import { UsagePlugin } from "../../plugins/usage-plugin.js";
import type { EngineConfig, EngineLogger } from "../../interfaces.js";
import { nowIso } from "../../utils/timestamps.js";

export const FAKE_USAGE_CLAUDE = fileURLToPath(new URL("./fake-claude-usage.mjs", import.meta.url));
export const FAKE_MCP_CLAUDE = fileURLToPath(new URL("./fake-claude-mcp.mjs", import.meta.url));
const SERVER_FIXTURE = fileURLToPath(new URL("./counting-mcp-server.mjs", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../../../../../entrypoint/agent-mcp/drizzle", import.meta.url));


const dirs: string[] = [];
export function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
/** Call from `afterEach`. */
export function cleanupE2eDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface IUsageE2eOptions {
  /** Which fake `claude` to spawn. */
  claude: string;
  /** Extra environment for the child (ADHD_FAKE_CLAUDE_MODE etc.). */
  childEnv?: Record<string, string>;
  /** Provider `timeoutMs` (the engine's per-call deadline). */
  timeoutMs?: number;
  maxLoops?: number;
  /** Give the agent the counting MCP server (needed for bridged calls). */
  withCounterServer?: boolean;
}

export interface IUsageE2eEnv {
  /** Messages the engine/provider logged at warn level (the provider logs each usage-window warning it reads). */
  warnings: string[];
  deps: TaskDeps;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  sqlite: Database.Database;
  startedFile: string;
  /** Lines the fake `claude` has appended to its started file. */
  started: () => string[];
  taskStatus: (taskId: string) => string | undefined;
  /** A fresh session for the agent (needed for `background:true` tasks, which `agent_name` one-shots ignore). */
  newSession: () => string;
  close: () => void;
}

/** Bounded wait on a condition, yielding to the event loop (no sleeps). */
export async function until(cond: () => boolean, what: string, maxTurns = 200_000): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`deadline: ${what}`);
}

export function makeUsageE2eEnv(opts: IUsageE2eOptions): IUsageE2eEnv {
  const warnings: string[] = [];
  const silentLogger = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (...args: unknown[]) => {
      warnings.push(args.filter((a): a is string => typeof a === "string").join(" "));
    },
  } as unknown as EngineLogger;
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  migrate(db, { migrationsFolder: MIGRATIONS });
  sqlite
    .prepare("INSERT INTO agents (name, version, data, created_at, updated_at) VALUES ('r2-agent', 1, '{}', ?, ?)")
    .run(nowIso(), nowIso());
  chmodSync(opts.claude, 0o755);

  const work = freshDir("adhd-r2-usage-");
  const startedFile = join(work, "started.txt");
  const selfOut = join(work, "claude-self.json");
  const hooks = new HookRegistry();
  new UsagePlugin(db, silentLogger).install(hooks);
  const sessionStore = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const definition = {
    name: "r2-agent",
    version: 1,
    provider: {
      type: "claudecli",
      claudePath: opts.claude,
      model: "claude-haiku-4-5",
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
    systemPrompt: "You are a test agent.",
    mcpServers: opts.withCounterServer
      ? {
          counter: {
            transport: "stdio",
            command: process.execPath,
            args: [SERVER_FIXTURE],
            env: { COUNTING_COUNTER_FILE: join(work, "counter.txt"), COUNTING_PID_FILE: join(work, "pids.txt") },
          },
        }
      : {},
    permissions: {},
    maxToolLoops: opts.maxLoops ?? 5,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  } as unknown as AgentDefinition;
  const agentStore: AgentStore = {
    create: () => definition,
    read: () => definition,
    update: () => definition,
    delete: () => undefined,
    list: () => [definition],
  };
  const queue = new BackgroundQueue(5, silentLogger);
  const policy = new PolicyEngine({ serverMaxDepth: 5, serverMaxToolLoops: opts.maxLoops ?? 5 });
  const dagEngine = new DagEngine(
    db,
    queue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore as any,
    async () => {
      throw new Error("no DAG dispatch in this test");
    },
    silentLogger
  );
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 1024 },
    queue: { concurrency: 5 },
    sse: { baseUrl: "http://localhost:0" },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({ ADHD_FAKE_CLAUDE_OUT: selfOut, ADHD_FAKE_CLAUDE_STARTED_FILE: startedFile, ...(opts.childEnv ?? {}) }),
    isEnvNameAllowed: () => true,
    resolveEnvName: () => undefined,
    wire: {
      fetch: globalThis.fetch,
      spawn: nodeSpawn,
      wrapTransport: (t: unknown) => t,
      withContext: (_ctx: unknown, fn: () => unknown) => fn(),
      tempDir: freshDir("adhd-r2-usage-tmp-"),
    },
  } as unknown as EngineConfig;

  const deps: TaskDeps = {
    agentStore,
    sessionStore: sessionStore as unknown as SessionStoreForTool,
    taskStore,
    orchestrator: new Orchestrator(),
    queue,
    policy,
    hooks,
    selfUrl: undefined,
    inProcessDescriptors: [],
    inProcessHandler: async () => {
      throw new Error("no in-process tools registered in this test");
    },
    db,
    dagEngine,
    config,
    logger: silentLogger,
  };
  return {
    warnings,
    deps,
    db,
    sqlite,
    startedFile,
    started: () => (existsSync(startedFile) ? readFileSync(startedFile, "utf8").split("\n").filter(Boolean) : []),
    newSession: () => sessionStore.create({ agentName: "r2-agent", agentDefinition: definition }).id,
    taskStatus: (taskId) => (sqlite.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined)?.status,
    close: () => sqlite.close(),
  };
}
