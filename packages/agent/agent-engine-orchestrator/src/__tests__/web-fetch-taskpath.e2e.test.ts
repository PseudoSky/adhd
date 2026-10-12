/**
 * R6B-web AC4 (task path) - the client-side `web_fetch` through the REAL engine path a live arm B uses:
 * `taskTool` -> `Orchestrator` -> tool advertisement (withNativeToolGuidance -> canonicalize -> compact)
 * -> `ClaudeCliProvider` -> real loopback bridge -> `governToolCall` (permission gate) -> `McpClientRegistry`
 * -> `WebFetchClient` -> a real local HTTP server. The ONLY stub is the `claude` executable
 * (fixtures/fake-claude-mcp.mjs). ADR-0009 e2e lane; not env-gated.
 *
 * Why this exists beyond web-fetch-bridge.e2e.test.ts: that test hand-wires `executeTool` and passes the raw
 * registry list; this one proves the advertised definition survives the orchestrator's rewriting, and that the
 * permission gate / egress policy actually govern the call.
 *
 * Negative control (recorded when authored): removing the registration in clients/registry.ts turns every case
 * red; denying `web_fetch` in the gate turns the allow case red.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
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
import { WEB_FETCH_TOOL } from "../tools/web-fetch.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude-mcp.mjs", import.meta.url));
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
  toolListing: () => Record<string, Array<{ name: string; description: string; inputSchema: unknown }>>;
  hookCounts: { pre: number; post: number; transform: number };
}

function makeEnv(opts: { gate?: (c: { server: string; tool: string }) => "allow" | "deny" | "ask"; maxLoops?: number; webFetch?: { allowedDomains: string[] } } = {}): IEnv {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  migrate(db, { migrationsFolder: MIGRATIONS });
  sqlite
    .prepare("INSERT INTO agents (name, version, data, created_at, updated_at) VALUES ('web-agent', 1, '{}', ?, ?)")
    .run(nowIso(), nowIso());
  chmodSync(FAKE_CLAUDE, 0o755);

  const work = freshDir("adhd-r6b-web-task-");
  const selfOut = join(work, "claude-self.json");
  const hooks = new HookRegistry();
  const hookCounts = { pre: 0, post: 0, transform: 0 };
  hooks.register("pre:tool_call" as never, (async () => { hookCounts.pre++; }) as never);
  hooks.register("post:tool_call" as never, (async () => { hookCounts.post++; }) as never);
  hooks.register("transform:tool_result" as never, (async () => { hookCounts.transform++; }) as never);
  const sessionStore = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const definition: AgentDefinition = {
    name: "web-agent",
    version: 1,
    provider: { type: "claudecli", claudePath: FAKE_CLAUDE, model: "claude-haiku-4-5" } as AgentDefinition["provider"],
    systemPrompt: "You are a test agent.",
    mcpServers: {},
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
      tempDir: freshDir("adhd-r6b-web-task-tmp-"),
    },
    ...(opts.webFetch ? { webFetch: opts.webFetch } : {}),
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
    hookCounts,
    modelSaw: () => (JSON.parse(readFileSync(selfOut, "utf8")) as { results: Array<{ id: string; text: string; isError: boolean }> }).results,
    toolListing: () => (JSON.parse(readFileSync(selfOut, "utf8")) as { toolListing: Record<string, Array<{ name: string; description: string; inputSchema: unknown }>> }).toolListing,
  };
}


const PAGE =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Task Path Title R6B</title></head><body><h1>Heading</h1><p>Task path body text.</p></body></html>";

let fixture: HttpServer | undefined;
async function fixtureUrl(): Promise<string> {
  fixture = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => fixture!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/page`;
}
afterEach(async () => {
  if (fixture) await new Promise<void>((r) => fixture!.close(() => r()));
  fixture = undefined;
});

const call = (url: string): string => JSON.stringify({ calls: [{ server: "web", tool: "web_fetch", args: { url } }] });

describe("R6B-web AC4: web_fetch through the orchestrator task path (claudecli)", () => {
  it("R6B-web AC4: the bridge lists web_fetch byte-identical to the shared definition AFTER advertisement rewriting, and the fetch returns the fixture title and text", async () => {
    const url = await fixtureUrl();
    const env = makeEnv({ gate: () => "allow" });
    const out = await taskTool({ agent_name: "web-agent", prompt: call(url) }, env.deps);
    expect(out.status).toBe("completed");
    const listed = env.toolListing()["web"]![0]!;
    expect(JSON.stringify({ name: listed.name, description: listed.description, inputSchema: listed.inputSchema })).toBe(
      JSON.stringify({ name: WEB_FETCH_TOOL.name, description: WEB_FETCH_TOOL.description, inputSchema: WEB_FETCH_TOOL.inputSchema })
    );
    const [seen] = env.modelSaw();
    expect(seen!.isError).toBe(false);
    const parsed = JSON.parse(seen!.text) as { content: { title: string; source: { data: string } } };
    expect(parsed.content.title).toBe("Task Path Title R6B");
    expect(parsed.content.source.data).toContain("Task path body text.");
  }, 60_000);

  it("R6B-web AC4: the permission gate governs web_fetch (deny -> PERMISSION_DENIED, nothing fetched)", async () => {
    const url = await fixtureUrl();
    let hits = 0;
    fixture!.on("request", () => { hits += 1; });
    const env = makeEnv({ gate: (c) => (c.tool === "web_fetch" ? "deny" : "allow") });
    const out = await taskTool({ agent_name: "web-agent", prompt: call(url) }, env.deps);
    expect(out.status).toBe("completed");
    const [seen] = env.modelSaw();
    expect(seen).toMatchObject({ isError: true });
    expect(seen!.text).toContain("PERMISSION_DENIED");
    expect(hits).toBe(0);
  }, 60_000);

  it("R6B-web AC4: the configured egress allow-list is enforced on the task path", async () => {
    const url = await fixtureUrl();
    const env = makeEnv({ gate: () => "allow", webFetch: { allowedDomains: ["example.com"] } });
    const out = await taskTool({ agent_name: "web-agent", prompt: call(url) }, env.deps);
    expect(out.status).toBe("completed");
    const [seen] = env.modelSaw();
    expect(seen).toMatchObject({ isError: true });
    expect(seen!.text).toContain("egress denied");
  }, 60_000);
});
