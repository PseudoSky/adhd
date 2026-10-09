/**
 * ae62e6b0 (BK3, plan 9ed453c1-b113-473d-8c35-fc6dc2541306) AC3.1 / AC3.2 / AC3.3 — E2E lane
 * (docs/decisions/0009-test-lanes-unit-vs-e2e.md): a real HTTP server is bound.
 *
 * Real components end to end: real `AnthropicProvider` + `@anthropic-ai/sdk` over real HTTP to a
 * LOOPBACK Anthropic-compatible server, real `Orchestrator` tool loop, real `UsagePlugin`, real
 * migrated SQLite (`task_usage`). The loopback server is the only fake: it plays the cache the
 * way the API does (a prefix ending at a `cache_control` breakpoint is written on first sight and
 * read afterwards) and reports `cache_creation_input_tokens` / `cache_read_input_tokens`.
 *
 * NO live model calls and NO traffic to api.anthropic.com: the provider's fetch seam
 * (`EngineConfig.wire.fetch`) rewrites every request's origin to the loopback server and throws on
 * anything else, so even a misconfigured SDK base URL cannot egress. A paid real-API check of
 * AC3.2 (>=6k-token prefix against the live API) is deliberately not part of this file.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encode } from "gpt-tokenizer";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";
import { anthropicSseBody, distinctFiller, type ISseUsage } from "./fixtures/anthropic-sse.js";

const MODEL = "claude-haiku-4-5";
const T0 = "2026-10-01T00:00:00.000Z";
const SYSTEM_PROMPT = distinctFiller(2400, "sys");
const USER_PROMPT = distinctFiller(2400, "usr");

// claude-haiku-4-5 rate card ($/M tokens): the 5-minute write rate is 1.25x input.
const RATE = { input: 1, cacheRead: 0.1, write5m: 1.25, write1h: 2, output: 5 };
const costOf = (u: ISseUsage): number =>
  ((u.input_tokens * RATE.input) +
    ((u.cache_read_input_tokens ?? 0) * RATE.cacheRead) +
    (((u.cache_creation_input_tokens ?? 0) - (u.cache_creation?.ephemeral_1h_input_tokens ?? 0)) * RATE.write5m) +
    ((u.cache_creation?.ephemeral_1h_input_tokens ?? 0) * RATE.write1h) +
    (u.output_tokens * RATE.output)) / 1e6;

interface IRecordedRequest {
  body: IWireBody;
  usage: ISseUsage;
}

type Json = Record<string, unknown>;

/** A content / tool / system block as it appears on the wire. */
interface IBlock {
  type?: string;
  text?: string;
  cache_control?: unknown;
  [k: string]: unknown;
}
interface IWireMessage {
  role: string;
  content: string | IBlock[];
}
/** The parts of the outgoing request body these tests read. */
interface IWireBody {
  tools?: IBlock[];
  system?: string | IBlock[];
  messages: IWireMessage[];
}
interface IUsageRow {
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_status: string;
  est_cost_usd: number;
}

/** The ordered prompt segments of a request body in API render order (tools, system, messages). */
function segments(body: IWireBody): Array<{ text: string; breakpoint: boolean }> {
  const out: Array<{ text: string; breakpoint: boolean }> = [];
  const strip = (b: IBlock): Json => {
    const { cache_control: _c, ...rest } = b;
    return rest;
  };
  for (const t of body.tools ?? []) {
    out.push({ text: JSON.stringify(strip(t)), breakpoint: t.cache_control !== undefined });
  }
  const system = body.system;
  if (typeof system === "string") out.push({ text: JSON.stringify({ type: "text", text: system }), breakpoint: false });
  else for (const b of system ?? []) out.push({ text: JSON.stringify(strip(b)), breakpoint: b.cache_control !== undefined });
  for (const m of body.messages) {
    const content = m.content;
    // the API renders a string and a single text block identically
    if (typeof content === "string") out.push({ text: `${m.role}:${JSON.stringify({ type: "text", text: content })}`, breakpoint: false });
    else for (const b of content) out.push({ text: `${m.role}:${JSON.stringify(strip(b))}`, breakpoint: b.cache_control !== undefined });
  }
  return out;
}

/**
 * Loopback Anthropic-compatible server with API-faithful prefix caching: for each breakpoint the
 * cumulative prefix is looked up; the longest already-written prefix is a cache READ, the span up
 * to the last breakpoint beyond it is a cache WRITE, the remainder is uncached input.
 */
function startLoopback(script: Array<(n: number) => { text?: string; toolUse?: { id: string; name: string; input: Json } }>) {
  const requests: IRecordedRequest[] = [];
  const written = new Set<string>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as IWireBody;
      const segs = segments(body);
      const tokenCum: number[] = [];
      const prefixes: string[] = [];
      let text = "";
      let acc = 0;
      for (const s of segs) {
        text += `\u0000${s.text}`;
        acc += encode(s.text).length;
        tokenCum.push(acc);
        prefixes.push(text);
      }
      const total = acc;
      const prior = new Set(written); // writes made by THIS request are not readable by it
      let read = 0;
      let writeTo = 0;
      // API semantics: at each breakpoint look for a cached prefix ending at that block, else walk
      // back over up to 20 earlier block boundaries (the lookback window); a miss writes the prefix.
      segs.forEach((s, i) => {
        if (!s.breakpoint) return;
        let hit = -1;
        for (let j = i; j >= Math.max(0, i - 20); j--) {
          if (prior.has(prefixes[j])) { hit = j; break; }
        }
        if (hit >= 0) read = Math.max(read, tokenCum[hit]);
        if (hit !== i) writeTo = tokenCum[i];
        written.add(prefixes[i]);
      });
      const creation = Math.max(0, writeTo - read);
      const usage: ISseUsage = {
        input_tokens: total - read - creation,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: creation,
        output_tokens: 20,
      };
      requests.push({ body, usage });
      const reply = script[Math.min(requests.length - 1, script.length - 1)](requests.length);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(anthropicSseBody({ model: MODEL, usage, ...reply }));
    });
  });
  return new Promise<{ server: Server; origin: string; requests: IRecordedRequest[] }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests });
    });
  });
}

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Runs one real task through Orchestrator + AnthropicProvider + UsagePlugin against `origin`. */
async function runTask(
  sqlite: Database.Database,
  origin: string,
  options: { promptCaching?: boolean; secret?: string } = {}
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const loopbackFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const target = new URL(`${url.pathname}${url.search}`, origin);
    if (target.hostname !== "127.0.0.1") throw new Error(`egress guard: refusing non-loopback host ${target.hostname}`);
    return fetch(target, init);
  };
  const engineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: loopbackFetch },
    getProviderConfig: () => ({ secret: options.secret ?? "sk-ant-api-loopback", model: MODEL }),
  } as unknown as EngineConfig;
  const provider = new AnthropicProvider({ type: "anthropic", model: MODEL }, engineConfig, logger, {
    promptCaching: options.promptCaching,
  });

  const taskId = generateId();
  const sessionId = generateId();
  const agentDefinition: AgentDefinition = {
    name: "bk3-agent", version: 1, provider: { type: "anthropic", model: MODEL },
    systemPrompt: SYSTEM_PROMPT, mcpServers: {}, permissions: {}, createdAt: nowIso(), updatedAt: nowIso(),
  };
  const ctx: ExecutionContext = { taskId, sessionId, agentName: "bk3-agent", agentDefinition, recursionDepth: 0, toolCallCount: 0 };
  const taskStore = new TaskStore(db);
  taskStore.create({ sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  new UsagePlugin(db, undefined, { now: () => T0 }).install(hooks);

  const registry = {
    listAllTools: async () => [
      { name: "test-server__lookup", description: distinctFiller(1800, "tool"), inputSchema: { type: "object", properties: {} } },
    ],
    getClient: async () => ({ callTool: async () => "found" }),
    closeAll: async () => {},
  } as unknown as McpClientRegistry;
  const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
  const messages: Message[] = [
    { id: generateId(), sessionId, role: "system", content: SYSTEM_PROMPT, createdAt: nowIso() },
    { id: generateId(), sessionId, role: "user", content: USER_PROMPT, createdAt: nowIso() },
  ];
  await new Orchestrator().run({
    executionContext: ctx, messages, registry, provider,
    policy: { check: () => {} } as unknown as PolicyEngine,
    taskStore: taskStore as unknown as OrchestratorTaskStore,
    sessionStore, signal: new AbortController().signal, taskId, hooks,
  });
  return taskId;
}

const twoTurnScript = [
  () => ({ toolUse: { id: "toolu_1", name: "test-server__lookup", input: {} } }),
  () => ({ text: "done" }),
];

const countCacheControls = (v: unknown): number => (JSON.stringify(v).match(/"cache_control"/g) ?? []).length;

let loop: Awaited<ReturnType<typeof startLoopback>>;
let sqlite: Database.Database;

beforeEach(async () => {
  sqlite = createMigratedSqlite();
  loop = await startLoopback(twoTurnScript);
});
afterEach(async () => {
  await new Promise<void>((r) => loop.server.close(() => r()));
  sqlite.close();
});

/** Every consumer-visible BK3 assertion; the negative control re-runs it against caching-off and expects it to THROW. */
function assertCachingWorked(taskId: string): void {
  expect(loop.requests).toHaveLength(2);
  const [t1, t2] = loop.requests;

  // AC3.1: real outgoing request bodies carry the breakpoints (<=3, last tools entry / last system block / final message).
  for (const r of [t1, t2]) {
    expect(countCacheControls(r.body)).toBeGreaterThanOrEqual(2);
    expect(countCacheControls(r.body)).toBeLessThanOrEqual(3);
    expect(JSON.stringify(r.body)).not.toContain('"ttl"');
  }
  const tools = t1.body.tools ?? [];
  expect(tools[tools.length - 1]).toHaveProperty("cache_control", { type: "ephemeral" });
  expect(tools.slice(0, -1).every((t) => t.cache_control === undefined)).toBe(true);
  const sys = t1.body.system as IBlock[];
  expect(sys[sys.length - 1]).toHaveProperty("cache_control", { type: "ephemeral" });
  // moving breakpoint: turn-2's marked message block is the tool_result, turn-1's user block is no longer marked.
  const m2 = t2.body.messages;
  expect(m2).toHaveLength(3);
  expect(countCacheControls(m2)).toBe(1);
  expect(JSON.stringify(m2[2])).toContain("cache_control");

  // AC3.2 (loopback): turn 1 writes the cache, turn 2 reads >= 90% of what turn 1 wrote.
  expect(t1.usage.cache_creation_input_tokens).toBeGreaterThan(5000);
  expect(t1.usage.cache_read_input_tokens).toBe(0);
  expect(t2.usage.cache_read_input_tokens).toBeGreaterThanOrEqual(0.9 * (t1.usage.cache_creation_input_tokens as number));

  // ...and flows to task_usage with the rate-card cost (5m write rate, read rate, uncached tail).
  const row = sqlite.prepare("SELECT * FROM task_usage WHERE task_id = ?").get(taskId) as IUsageRow;
  expect(row.cache_read_input_tokens).toBe(t2.usage.cache_read_input_tokens);
  expect(row.cache_creation_input_tokens).toBe((t1.usage.cache_creation_input_tokens as number) + (t2.usage.cache_creation_input_tokens as number));
  expect(row.cost_status).toBe("priced");
  expect(row.est_cost_usd).toBeCloseTo(costOf(t1.usage) + costOf(t2.usage), 9);
}

describe("ae62e6b0 BK3 loopback E2E: cache breakpoints reach the wire and the stored cost", () => {
  it("ae62e6b0 AC3.1 AC3.2: >=6k-token prefix on claude-haiku-4-5: breakpoints on the real request body, cache_read/creation reach task_usage at the rate-card cost", async () => {
    const taskId = await runTask(sqlite, loop.origin);
    const first = loop.requests[0];
    expect(encode(JSON.stringify(first.body)).length).toBeGreaterThan(6000);
    // every breakpoint's cumulative prefix is above haiku-4-5's 4096 minimum (the tools prefix alone is)
    expect(encode(JSON.stringify(first.body.tools ?? [])).length).toBeGreaterThan(4096);
    assertCachingWorked(taskId);
  });

  it("ae62e6b0 AC3.1: OAuth credential: the identity block stays first and unchanged on the wire", async () => {
    await runTask(sqlite, loop.origin, { secret: "sk-ant-oat-loopback" });
    for (const r of loop.requests) {
      const system = r.body.system as IBlock[];
      expect(system[0]).toEqual({ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." });
      expect(system[1]).toHaveProperty("cache_control", { type: "ephemeral" });
    }
  });

  it("ae62e6b0 AC3.3: negative control: with breakpoints off the same assertions go RED (no cache_control, no cache_read, full uncached cost)", async () => {
    const taskId = await runTask(sqlite, loop.origin, { promptCaching: false });
    for (const r of loop.requests) expect(countCacheControls(r.body)).toBe(0);
    expect(loop.requests[1].usage.cache_read_input_tokens).toBe(0);
    expect(() => assertCachingWorked(taskId)).toThrow();
    const row = sqlite.prepare("SELECT cache_read_input_tokens AS r, cache_creation_input_tokens AS c FROM task_usage WHERE task_id = ?").get(taskId) as { r: number; c: number };
    expect(row.r).toBe(0);
    expect(row.c).toBe(0);
  });

  it("ae62e6b0 AC3.2: a reply carrying ephemeral_1h tokens is priced at the 1h tier (the shipped cacheCreation1hTokens path)", async () => {
    await new Promise<void>((r) => loop.server.close(() => r()));
    // A server that reports the whole write as 1h-tier on turn 1.
    const requests: IRecordedRequest[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const usage: ISseUsage = {
          input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 6000, cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 6000 },
        };
        requests.push({ body: { messages: [] }, usage });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(anthropicSseBody({ model: MODEL, usage, text: "done" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    loop = { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
    const taskId = await runTask(sqlite, loop.origin);
    const row = sqlite.prepare("SELECT est_cost_usd FROM task_usage WHERE task_id = ?").get(taskId) as { est_cost_usd: number };
    expect(requests).toHaveLength(1);
    expect(row.est_cost_usd).toBeCloseTo(costOf(requests[0].usage), 9);
    expect(row.est_cost_usd).toBeGreaterThan((10 + 6000 * 1.25 + 20 * 5) / 1e6); // strictly above the 5m-rate price
  });
});
