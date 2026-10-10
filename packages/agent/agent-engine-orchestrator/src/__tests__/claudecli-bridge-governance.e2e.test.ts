/**
 * f9dadeaa — claudecli bridge governance bypass, END TO END (ADR-0009 e2e lane; not env-gated).
 *
 * Real components: the real `taskTool` -> `Orchestrator` -> `ClaudeCliProvider` -> real loopback bridge ->
 * `McpClientRegistry` -> real stdio MCP server (fixtures/counting-mcp-server.mjs, whose `bump` appends a
 * line to a counter file per EXECUTION) against a real better-sqlite3 TaskStore/SessionStore. The ONLY stub
 * is the `claude` executable (fixtures/fake-claude-mcp.mjs), which calls the tools the prompt asks for
 * through the `--mcp-config` bridge exactly as the CLI would and records what the "model" saw.
 *
 * Teeth (negative control run when authored): with `governToolCall` removed from the bridge `executeTool`
 * in engine/orchestrator.ts, GOV-AC1..AC4 below are red (handler runs > 0, no PERMISSION_DENIED, hooks 0).
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
  handlerRuns: () => number;
  hookCounts: { pre: number; post: number; transform: number };
}

function makeEnv(opts: { gate?: (c: { server: string; tool: string }) => "allow" | "deny" | "ask"; maxLoops?: number } = {}): IEnv {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  migrate(db, { migrationsFolder: MIGRATIONS });
  sqlite
    .prepare("INSERT INTO agents (name, version, data, created_at, updated_at) VALUES ('gov-agent', 1, '{}', ?, ?)")
    .run(nowIso(), nowIso());
  chmodSync(FAKE_CLAUDE, 0o755);

  const work = freshDir("adhd-bridge-gov-");
  const selfOut = join(work, "claude-self.json");
  const counterFile = join(work, "counter.txt");
  const hooks = new HookRegistry();
  const hookCounts = { pre: 0, post: 0, transform: 0 };
  hooks.register("pre:tool_call" as never, (async () => { hookCounts.pre++; }) as never);
  hooks.register("post:tool_call" as never, (async () => { hookCounts.post++; }) as never);
  hooks.register("transform:tool_result" as never, (async () => { hookCounts.transform++; }) as never);
  const sessionStore = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const definition: AgentDefinition = {
    name: "gov-agent",
    version: 1,
    provider: { type: "claudecli", claudePath: FAKE_CLAUDE, model: "claude-haiku-4-5" } as AgentDefinition["provider"],
    systemPrompt: "You are a test agent.",
    mcpServers: {
      counter: {
        transport: "stdio",
        command: process.execPath,
        args: [SERVER_FIXTURE],
        env: { COUNTING_COUNTER_FILE: counterFile, COUNTING_PID_FILE: join(work, "pids.txt") },
      },
    },
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
    subprocessEnv: () => ({ ADHD_FAKE_CLAUDE_OUT: selfOut }),
    isEnvNameAllowed: () => true,
    resolveEnvName: () => undefined,
    wire: {
      fetch: globalThis.fetch,
      spawn: nodeSpawn,
      wrapTransport: (t: unknown) => t,
      withContext: (_ctx: unknown, fn: () => unknown) => fn(),
      tempDir: freshDir("adhd-bridge-gov-tmp-"),
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
    handlerRuns: () => (existsSync(counterFile) ? readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0),
    hookCounts,
    modelSaw: () => (JSON.parse(readFileSync(selfOut, "utf8")) as { results: Array<{ id: string; text: string; isError: boolean }> }).results,
  };
}

const prompt = (calls: Array<{ server: string; tool: string; args?: unknown }>): string => JSON.stringify({ calls });
const bump = { server: "counter", tool: "bump" };

describe("f9dadeaa: claudecli bridged tool calls are governed like engine-native calls", () => {
  it("f9dadeaa GOV-AC1: a permission-denied tool is NOT executed over the bridge; the model sees PERMISSION_DENIED", async () => {
    const env = makeEnv({ gate: (c) => (c.tool === "bump" ? "deny" : "allow") });
    const out = await taskTool({ agent_name: "gov-agent", prompt: prompt([bump]) }, env.deps);
    expect(out.status).toBe("completed");
    expect(env.handlerRuns()).toBe(0);
    const [seen] = env.modelSaw();
    expect(seen).toMatchObject({ isError: true });
    expect(seen!.text).toContain("PERMISSION_DENIED");
  }, 60_000);

  it("f9dadeaa GOV-AC2: an ask verdict fails closed on the bridge (no execution, error names the missing HITL suspend)", async () => {
    const env = makeEnv({ gate: (c) => (c.tool === "bump" ? "ask" : "allow") });
    const out = await taskTool({ agent_name: "gov-agent", prompt: prompt([bump]) }, env.deps);
    expect(out.status).toBe("completed");
    expect(env.handlerRuns()).toBe(0);
    const [seen] = env.modelSaw();
    expect(seen).toMatchObject({ isError: true });
    expect(seen!.text).toContain("PERMISSION_ASK_DENIED");
    expect(seen!.text).toContain("HITL suspend is not supported over the claudecli tool bridge");
  }, 60_000);

  it("f9dadeaa GOV-AC3: maxToolLoops=1 with 3 bridged calls executes exactly 1; the rest return the native cap error and the task fails with it", async () => {
    const env = makeEnv({ maxLoops: 1 });
    const out = await taskTool({ agent_name: "gov-agent", prompt: prompt([bump, bump, bump]) }, env.deps);
    expect(env.handlerRuns()).toBe(1);
    const seen = env.modelSaw();
    expect(seen).toHaveLength(3);
    expect(seen[0]!.isError).toBe(false);
    for (const r of seen.slice(1)) {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("MAX_TOOL_LOOPS_EXCEEDED");
    }
    expect(out.status).toBe("failed");
    const [failed] = env.events(out.task_id, "TASK_FAILED");
    expect(String(failed?.["error"])).toContain("[MAX_TOOL_LOOPS_EXCEEDED]");
  }, 60_000);

  it("f9dadeaa GOV-AC4: pre:tool_call, post:tool_call and transform:tool_result fire once per executed bridged call", async () => {
    const env = makeEnv();
    const out = await taskTool({ agent_name: "gov-agent", prompt: prompt([bump, bump]) }, env.deps);
    expect(out.status).toBe("completed");
    expect(env.handlerRuns()).toBe(2);
    expect(env.hookCounts).toEqual({ pre: 2, post: 2, transform: 2 });
  }, 60_000);

  it("f9dadeaa GOV-AC6: an allowed bridged call still executes and its result reaches the model unchanged", async () => {
    const env = makeEnv({ gate: () => "allow" });
    const out = await taskTool({ agent_name: "gov-agent", prompt: prompt([{ server: "counter", tool: "echo", args: { text: "hello-gov" } }]) }, env.deps);
    expect(out.status).toBe("completed");
    expect(env.modelSaw()).toEqual([{ id: "toolu_1", text: "hello-gov", isError: false }]);
  }, 60_000);
});
