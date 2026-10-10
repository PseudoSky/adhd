/**
 * Shared real-component harness for the claudecli bridge e2e suites that need a claude executable
 * (real or fake) driven through the real taskTool -> Orchestrator -> ClaudeCliProvider -> loopback
 * bridge -> McpClientRegistry -> stdio MCP server chain over a real migrated better-sqlite3 store.
 * (424b6362 AC5/AC6; the f9dadeaa governance suite carries its own copy of this wiring.)
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
import type { EngineConfig, EngineLogger } from "../../interfaces.js";
import { nowIso } from "../../utils/timestamps.js";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude-mcp.mjs", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../../../../../entrypoint/agent-mcp/drizzle", import.meta.url));
const silentLogger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

export interface IBridgeEnvOptions {
  /** Absent: the real `claude` on PATH. */
  claudePath?: string;
  /** Stdio MCP servers the agent may use (bridged to claude through the loopback bridge). */
  mcpServers: Record<string, { transport: "stdio"; command: string; args: string[]; env?: Record<string, string> }>;
  gate?: (c: { server: string; tool: string }) => "allow" | "deny" | "ask";
  maxLoops?: number;
  /** Extra env for the claude subprocess. */
  subprocessEnv?: Record<string, string>;
}

export interface IBridgeEnv {
  deps: TaskDeps;
  events: (taskId: string, type: string) => Array<Record<string, unknown>>;
  hookCounts: { pre: number; post: number; transform: number };
  /** Removes every scratch directory this env created. */
  dispose: () => void;
}

/** Build the harness; the caller drives `taskTool({agent_name:'bridge-agent', prompt}, env.deps)`. */
export function makeBridgeEnv(opts: IBridgeEnvOptions): IBridgeEnv {
  const dirs: string[] = [];
  const freshDir = (prefix: string): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  migrate(db, { migrationsFolder: MIGRATIONS });
  sqlite
    .prepare("INSERT INTO agents (name, version, data, created_at, updated_at) VALUES ('bridge-agent', 1, '{}', ?, ?)")
    .run(nowIso(), nowIso());
  if (opts.claudePath) chmodSync(opts.claudePath, 0o755);

  const hooks = new HookRegistry();
  const hookCounts = { pre: 0, post: 0, transform: 0 };
  hooks.register("pre:tool_call" as never, (async () => { hookCounts.pre++; }) as never);
  hooks.register("post:tool_call" as never, (async () => { hookCounts.post++; }) as never);
  hooks.register("transform:tool_result" as never, (async () => { hookCounts.transform++; }) as never);
  const sessionStore = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const maxLoops = opts.maxLoops ?? 5;
  const definition = {
    name: "bridge-agent",
    version: 1,
    provider: { type: "claudecli", ...(opts.claudePath ? { claudePath: opts.claudePath } : {}), model: "claude-haiku-4-5" },
    systemPrompt: "You are a test agent.",
    mcpServers: opts.mcpServers,
    permissions: {},
    maxToolLoops: maxLoops,
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
  const policy = new PolicyEngine({ serverMaxDepth: 5, serverMaxToolLoops: maxLoops });
  const dagEngine = new DagEngine(
    db,
    queue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore as any,
    async () => { throw new Error("no DAG dispatch in this test"); },
    silentLogger
  );
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 1024 },
    queue: { concurrency: 5 },
    sse: { baseUrl: "http://localhost:0" },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({ ...(opts.subprocessEnv ?? {}) }),
    isEnvNameAllowed: () => true,
    resolveEnvName: () => undefined,
    wire: {
      fetch: globalThis.fetch,
      spawn: nodeSpawn,
      wrapTransport: (t: unknown) => t,
      withContext: (_ctx: unknown, fn: () => unknown) => fn(),
      tempDir: freshDir("adhd-bridge-env-tmp-"),
    },
    ...(opts.gate ? { permissionGate: (c: { server: string; tool: string }) => opts.gate!(c) } : {}),
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
    inProcessHandler: async () => { throw new Error("no in-process tools registered in this test"); },
    db,
    dagEngine,
    config,
    logger: silentLogger,
  };
  return {
    deps,
    hookCounts,
    events: (taskId, type) =>
      (
        sqlite
          .prepare("SELECT payload FROM task_events WHERE task_id = ? AND type = ? ORDER BY created_at, rowid")
          .all(taskId, type) as Array<{ payload: string | null }>
      ).map((r) => JSON.parse(r.payload ?? "{}") as Record<string, unknown>),
    dispose: () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); sqlite.close(); },
  };
}
