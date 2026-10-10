/**
 * 9ed453c1 BLIND F6b — a tool call that reaches an MCP server through the claudecli loopback bridge
 * gets the SAME observable treatment as an engine-native (API-path) call:
 *   - TOOL_CALL / TOOL_RESULT task events (same payload shape, `bridge-<n>` call ids),
 *   - BK2 argument coercion (stringified array -> array, TOOL_ARG_COERCED event),
 *   - BK1/CTX model-visible result cap (head+tail, `truncated` flag on TOOL_RESULT).
 *
 * Real components end to end: the real `taskTool` -> `Orchestrator` -> `ClaudeCliProvider` -> real
 * loopback bridge -> `McpClientRegistry` -> real stdio MCP server (fixtures/counting-mcp-server.mjs),
 * against a real better-sqlite3 TaskStore/SessionStore. The ONLY stub is the `claude` executable
 * (fixtures/fake-claude-mcp.mjs, which behaves like the CLI w.r.t. MCP). Spawns subprocesses and binds
 * a port => e2e lane (ADR-0009); not env-gated.
 *
 * Teeth (run during development against the pre-change orchestrator): with the bridge `executeTool`
 * lacking event emission/coercion, the TOOL_CALL/TOOL_RESULT/TOOL_ARG_COERCED assertions are red
 * (no events, `n=-1`). Setting `toolArgCoercion.enabled=false` reproduces the `n=-1` outcome (NC below).
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition } from "@adhd/agent-base-types";

import { taskTool } from "../tools/task.js";
import type { TaskDeps } from "../tools/task.js";
import type { AgentStore } from "../tools/agent-crud.js";
import type { SessionStoreForTool } from "../tools/session.js";
import { PolicyEngine } from "../engine/policy.js";
import { HookRegistry } from "../engine/hooks.js";
import { BackgroundQueue } from "../engine/queue.js";
import { DagEngine } from "../engine/dag-engine.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { nowIso } from "../utils/timestamps.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude-mcp.mjs", import.meta.url));
const SERVER_FIXTURE = fileURLToPath(new URL("./fixtures/counting-mcp-server.mjs", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../../../../entrypoint/agent-mcp/drizzle", import.meta.url));

const silentLogger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface IEnv {
  deps: TaskDeps;
  events: (taskId: string, type: string) => Array<Record<string, unknown>>;
  modelSaw: () => Array<{ id: string; text: string; isError: boolean }>;
}

function makeEnv(opts: { maxChars?: number; coercion?: boolean } = {}): IEnv {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  migrate(db, { migrationsFolder: MIGRATIONS });
  sqlite
    .prepare("INSERT INTO agents (name, version, data, created_at, updated_at) VALUES ('parity-agent', 1, '{}', ?, ?)")
    .run(nowIso(), nowIso());
  chmodSync(FAKE_CLAUDE, 0o755);

  const work = freshDir("adhd-bridge-parity-");
  const selfOut = join(work, "claude-self.json");
  const hooks = new HookRegistry();
  const sessionStore = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const definition: AgentDefinition = {
    name: "parity-agent",
    version: 1,
    provider: { type: "claudecli", claudePath: FAKE_CLAUDE, model: "claude-haiku-4-5" } as AgentDefinition["provider"],
    systemPrompt: "You are a test agent.",
    mcpServers: {
      counter: {
        transport: "stdio",
        command: process.execPath,
        args: [SERVER_FIXTURE],
        env: { COUNTING_COUNTER_FILE: join(work, "counter.txt"), COUNTING_PID_FILE: join(work, "pids.txt") },
      },
    },
    permissions: {},
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
  const policy = new PolicyEngine({ serverMaxDepth: 5, serverMaxToolLoops: 5 });
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
    subprocessEnv: () => ({ ADHD_FAKE_CLAUDE_OUT: selfOut }),
    isEnvNameAllowed: () => true,
    resolveEnvName: () => undefined,
    wire: {
      fetch: globalThis.fetch,
      spawn: nodeSpawn,
      wrapTransport: (t: unknown) => t,
      withContext: (_ctx: unknown, fn: () => unknown) => fn(),
      tempDir: freshDir("adhd-bridge-parity-tmp-"),
    },
    ...(opts.maxChars !== undefined ? { toolResult: { maxChars: opts.maxChars } } : {}),
    ...(opts.coercion === false ? { toolArgCoercion: { enabled: false } } : {}),
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
    deps,
    events: (taskId, type) =>
      (
        sqlite
          .prepare("SELECT payload FROM task_events WHERE task_id = ? AND type = ? ORDER BY created_at, rowid")
          .all(taskId, type) as Array<{ payload: string | null }>
      ).map((r) => JSON.parse(r.payload ?? "{}") as Record<string, unknown>),
    modelSaw: () => (JSON.parse(readFileSync(selfOut, "utf8")) as { results: Array<{ id: string; text: string; isError: boolean }> }).results,
  };
}

const prompt = (calls: Array<{ server: string; tool: string; args?: unknown }>): string => JSON.stringify({ calls });

describe("9ed453c1 BLIND F6b: bridged tool calls are observable like engine-native calls", () => {
  it("9ed453c1 BLIND F6b: a bridged call records TOOL_CALL then TOOL_RESULT with a shared bridge-<n> call id", async () => {
    const env = makeEnv();
    const out = await taskTool(
      { agent_name: "parity-agent", prompt: prompt([{ server: "counter", tool: "echo", args: { text: "hello-bridge" } }]) },
      env.deps
    );
    expect(out.status).toBe("completed");
    const calls = env.events(out.task_id, "TOOL_CALL");
    const results = env.events(out.task_id, "TOOL_RESULT");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: "counter__echo", callId: "bridge-1" });
    expect(String(calls[0]!["arguments"])).toContain("hello-bridge");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool: "counter__echo", callId: "bridge-1", isError: false });
    expect(String(results[0]!["result"])).toContain("hello-bridge");
    expect(env.modelSaw()).toEqual([{ id: "toolu_1", text: "hello-bridge", isError: false }]);
  }, 60_000);

  it("9ed453c1 BLIND F6b: a bridged call with a stringified array argument is coerced (BK2) and TOOL_ARG_COERCED is recorded", async () => {
    const env = makeEnv();
    const out = await taskTool(
      { agent_name: "parity-agent", prompt: prompt([{ server: "counter", tool: "count_items", args: { items: '["a","b","c"]' } }]) },
      env.deps
    );
    expect(out.status).toBe("completed");
    expect(env.modelSaw()[0]).toMatchObject({ text: "n=3", isError: false });
    const coerced = env.events(out.task_id, "TOOL_ARG_COERCED");
    expect(coerced).toHaveLength(1);
    expect(coerced[0]).toMatchObject({ tool: "counter__count_items", property: "items" });
  }, 60_000);

  it("9ed453c1 BLIND F6b NC: with coercion disabled the same call reaches the server uncoerced (n=-1) and records no TOOL_ARG_COERCED", async () => {
    const env = makeEnv({ coercion: false });
    const out = await taskTool(
      { agent_name: "parity-agent", prompt: prompt([{ server: "counter", tool: "count_items", args: { items: '["a","b","c"]' } }]) },
      env.deps
    );
    expect(out.status).toBe("completed");
    expect(env.modelSaw()[0]).toMatchObject({ text: "n=-1" });
    expect(env.events(out.task_id, "TOOL_ARG_COERCED")).toHaveLength(0);
  }, 60_000);

  it("9ed453c1 BLIND F6b: an over-cap bridged result is head+tail capped for the model and TOOL_RESULT is flagged truncated (CTX)", async () => {
    const env = makeEnv({ maxChars: 200 });
    const big = "x".repeat(5000);
    const out = await taskTool(
      { agent_name: "parity-agent", prompt: prompt([{ server: "counter", tool: "echo", args: { text: big } }]) },
      env.deps
    );
    expect(out.status).toBe("completed");
    const seen = env.modelSaw()[0]!;
    expect(seen.text.length).toBeLessThan(1000);
    expect(seen.text.length).toBeLessThan(big.length);
    const [result] = env.events(out.task_id, "TOOL_RESULT");
    expect(result).toMatchObject({ truncated: true });
    expect(result!["original_chars"]).toBeGreaterThanOrEqual(5000);
  }, 60_000);
});
