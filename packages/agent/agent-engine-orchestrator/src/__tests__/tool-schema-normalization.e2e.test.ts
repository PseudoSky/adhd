/**
 * 020307a5 AC3 / AC4 — E2E lane (docs/decisions/0009-test-lanes-unit-vs-e2e.md): a real stdio MCP
 * server is spawned and a real loopback HTTP server is bound. Not env-gated, no paid call.
 *
 * ONE scaffold (spawned once in `beforeAll`): the real `McpClientRegistry` spawning
 * `fixtures/root-oneof-mcp-server.mjs`, which publishes a tool (`pick`) whose input schema has a
 * top-level `oneOf`, the shape that killed parity run R11 (`tools.43` = `backlog__batch_action`).
 * Its tools reach each adapter through the same step the engine uses (`canonicalizeToolDefinitions`).
 *
 *  - AC4: real `Orchestrator.run` -> real `AnthropicProvider` + `@anthropic-ai/sdk` over real HTTP ->
 *    a loopback that rejects ANY request whose `tools[i].input_schema` has a root combinator with the
 *    R11 400 body. The model "calls" `pick`; the call executes on the real server through the real
 *    registry; its result is in the second request. Green only if the first request was accepted.
 *  - AC3 openai-compatible: the same run through `OpenAIProvider` against the loopback's
 *    `/v1/chat/completions`, which rejects a root combinator the way OpenAI-hosted endpoints report.
 *  - AC3 claudecli: the real `startToolBridge` (the request the `claude` CLI makes: `tools/list` over
 *    Streamable HTTP, by the real MCP client) advertises `pick` already flat, and `tools/call` on it
 *    reaches the real server.
 *
 * Negative controls (the loopback has teeth): the un-normalised definitions POSTed straight at it are
 * answered 400 with the R11 text, for both API shapes. The per-adapter "revert the fix, see red" runs
 * are recorded in the 020307a5 return (each adapter's call to `normalizeToolForWire` stubbed out
 * turns exactly that adapter's tests red).
 *
 * guards: a tool whose input schema has a top-level oneOf, anyOf or allOf (R11 backlog__batch_action) reaches the Anthropic API, an OpenAI-compatible endpoint or the claudecli bridge unflattened, so the whole request is rejected with HTTP 400, or the call no longer executes on the real server.
 * tier: P
 * gap: This cannot be observed at tier S because the root-oneOf tool comes from a spawned stdio MCP server and the rejecting API and the claudecli bridge are bound loopback sockets, none of which exist at tier S.
 * cites: 020307a5 AC3, AC4.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpClientRegistry } from "../clients/registry.js";
import type { InProcessToolHandler } from "../clients/in-process.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import type { PolicyEngine } from "../engine/policy.js";
import { canonicalizeToolDefinitions } from "../engine/tool-schema-compact.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { startToolBridge } from "../providers/claudecli-tool-bridge.js";
import { OpenAIProvider } from "../providers/openai.js";
import type { LLMProvider, ToolDefinition } from "../providers/types.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { ExecutionContext, Message, McpServerConfig } from "../validation/index.js";
import { anthropicSseBody } from "./fixtures/anthropic-sse.js";
import { anthropicRootCombinatorRejection, openaiRootCombinatorRejection, rootCombinatorOf } from "./fixtures/root-combinator-api.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/root-oneof-mcp-server.mjs", import.meta.url));
const MODEL = "claude-haiku-5-5";
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const noopHandler: InProcessToolHandler = (async () => ({})) as unknown as InProcessToolHandler;
const NOTE = "Input constraint: Provide parameters for exactly one of: (id) or (name).";

interface IRecorded { path: string; status: number; body: Record<string, unknown> }

/** Loopback API: Anthropic `/v1/messages` (SSE) and OpenAI `/v1/chat/completions`, each scripted as "call `rootone__pick`, then say done". */
function startApi(): Promise<{ server: Server; origin: string; requests: IRecorded[] }> {
  const requests: IRecorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const path = req.url ?? "";
      const anthropic = path.startsWith("/v1/messages");
      const rejection = anthropic
        ? anthropicRootCombinatorRejection(body as never)
        : openaiRootCombinatorRejection(body as never);
      const nth = requests.filter((r) => r.path === path && r.status === 200).length;
      const recorded: IRecorded = { path, status: rejection ? rejection.status : 200, body };
      requests.push(recorded);
      if (rejection) {
        res.writeHead(rejection.status, { "content-type": "application/json" });
        res.end(JSON.stringify(rejection.body));
        return;
      }
      if (anthropic) {
        const reply = nth === 0 ? { toolUse: { id: "toolu_1", name: "rootone__pick", input: { id: "x1" } } } : { text: "done" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(anthropicSseBody({ model: MODEL, usage: { input_tokens: 10, output_tokens: 5 }, ...reply }));
        return;
      }
      const message = nth === 0
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "rootone__pick", arguments: JSON.stringify({ id: "x1" }) } }] }
        : { role: "assistant", content: "done" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "c", object: "chat.completion", created: 0, model: "m",
        choices: [{ index: 0, finish_reason: nth === 0 ? "tool_calls" : "stop", message }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }));
  });
}

let dir: string;
let registry: McpClientRegistry;
let tools: ToolDefinition[];
let api: Awaited<ReturnType<typeof startApi>>;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "adhd-rootoneof-")));
  const cfg = { transport: "stdio", command: process.execPath, args: [FIXTURE] } as McpServerConfig;
  const engine = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 }, queue: { concurrency: 1 }, sse: { baseUrl: "" }, plugins: { entries: [] },
    cwd: dir, getProviderConfig: () => ({}), subprocessEnv: () => ({}), resolveEnvName: () => undefined, isEnvNameAllowed: () => true,
  } as unknown as EngineConfig;
  registry = new McpClientRegistry({ rootone: cfg }, undefined, [], noopHandler, {} as ExecutionContext, engine, logger);
  tools = canonicalizeToolDefinitions(await registry.listAllTools());
  api = await startApi();
});

afterAll(async () => {
  await registry?.closeAll();
  await new Promise<void>((r) => (api ? api.server.close(() => r()) : r()));
  rmSync(dir, { recursive: true, force: true });
});

const pick = (): ToolDefinition => tools.find((t) => t.name === "rootone__pick")!;

/** One real task: the real engine loop over the real registry, driving `provider`. */
async function runTask(provider: LLMProvider): Promise<string> {
  const taskId = generateId();
  const sessionId = generateId();
  const ctx: ExecutionContext = {
    taskId, sessionId, agentName: "rootoneof-agent", recursionDepth: 0, toolCallCount: 0,
    agentDefinition: {
      name: "rootoneof-agent", version: 1, provider: { type: "anthropic", model: MODEL }, systemPrompt: "x",
      mcpServers: {}, permissions: {}, createdAt: nowIso(), updatedAt: nowIso(),
    } as ExecutionContext["agentDefinition"],
  };
  const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
  const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
  const user: Message = { id: generateId(), sessionId, role: "user", content: "pick x1", createdAt: nowIso() };
  const out = await new Orchestrator().run({
    executionContext: ctx, messages: [user], registry, provider,
    policy: { check: () => {} } as unknown as PolicyEngine,
    taskStore, sessionStore, signal: new AbortController().signal, taskId, logger,
    config: { server: { contextLimit: 0, defaultMaxTokens: 8192 } } as EngineConfig,
  });
  return out.result ?? "";
}

describe("020307a5 premise: the real server really publishes a root oneOf, and the loopback API really rejects it", () => {
  it("020307a5 AC4: the tool reaches the engine with a top-level oneOf (so the fix has something to do)", () => {
    expect(rootCombinatorOf(pick().inputSchema)).toBe("oneOf");
  });

  it("020307a5 AC4 negative control: the un-normalised definition POSTed at the loopback is answered with the R11 400 (anthropic) and the OpenAI-style 400", async () => {
    const a = await fetch(`${api.origin}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ tools: [{ name: "p", description: "d", input_schema: pick().inputSchema }] }),
    });
    expect(a.status).toBe(400);
    expect(await a.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "tools.0.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level" },
    });
    const o = await fetch(`${api.origin}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ tools: [{ type: "function", function: { name: "p", parameters: pick().inputSchema } }] }),
    });
    expect(o.status).toBe(400);
  });
});

describe("020307a5 AC4: anthropic path, real tool path end to end", () => {
  it("020307a5 AC4: the model calls the root-oneOf tool; the API accepts the request, the call executes on the real server, its result comes back", async () => {
    const from = api.requests.length;
    const config = {
      server: { contextLimit: 0, defaultMaxTokens: 8192 },
      wire: {
        fetch: (async (input, init) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
          return fetch(new URL(`${url.pathname}${url.search}`, api.origin), init);
        }) as typeof fetch,
      },
      getProviderConfig: () => ({ secret: "sk-ant-api-loopback", model: MODEL }),
    } as unknown as EngineConfig;

    const result = await runTask(new AnthropicProvider({ type: "anthropic", model: MODEL }, config, logger));

    const mine = api.requests.slice(from).filter((r) => r.path.startsWith("/v1/messages"));
    expect(mine.map((r) => r.status)).toEqual([200, 200]); // a root combinator on the wire would be a 400 here
    expect(result).toBe("done");
    const wireTool = (mine[0]!.body["tools"] as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>).find((t) => t.name === "rootone__pick")!;
    expect(rootCombinatorOf(wireTool.input_schema)).toBeUndefined();
    expect(Object.keys(wireTool.input_schema["properties"] as object)).toEqual(["id", "name"]);
    expect(wireTool.description).toBe(`Pick an item by id or by name.\n\n${NOTE}`);
    // executed on the real server with the model's arguments, result visible to the model
    expect(JSON.stringify(mine[1]!.body["messages"])).toContain('picked:{\\"id\\":\\"x1\\"}');
    // the engine's registered definition keeps its oneOf
    expect(rootCombinatorOf(pick().inputSchema)).toBe("oneOf");
  });
});

describe("020307a5 AC3: openai-compatible path, real tool path end to end", () => {
  it("020307a5 AC3: same run through OpenAIProvider: accepted, flat function.parameters, tool executed", async () => {
    const from = api.requests.length;
    const config = {
      server: { contextLimit: 0, defaultMaxTokens: 8192 },
      getProviderConfig: () => ({ secret: "sk-test", model: "m", baseURL: `${api.origin}/v1` }),
    } as unknown as EngineConfig;

    const result = await runTask(new OpenAIProvider({ type: "openai", model: "m" } as never, config));

    const mine = api.requests.slice(from).filter((r) => r.path.startsWith("/v1/chat/completions"));
    expect(mine.map((r) => r.status)).toEqual([200, 200]);
    expect(result).toBe("done");
    const wireTool = (mine[0]!.body["tools"] as Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>)
      .find((t) => t.function.name === "rootone__pick")!;
    expect(rootCombinatorOf(wireTool.function.parameters)).toBeUndefined();
    expect(wireTool.function.description).toBe(`Pick an item by id or by name.\n\n${NOTE}`);
    expect(JSON.stringify(mine[1]!.body["messages"])).toContain('picked:{\\"id\\":\\"x1\\"}');
  });
});

describe("020307a5 AC3: claudecli bridge, the request the claude CLI makes", () => {
  it("020307a5 AC3: tools/list over the real loopback bridge advertises the root-oneOf tool already flat with the note; tools/call reaches the real server", async () => {
    const bridge = await startToolBridge({
      tools,
      logger,
      executeTool: async (server, tool, args) => {
        const client = await registry.getClient(server);
        return { result: await client.callTool(tool, args as Record<string, unknown>), isError: false };
      },
    });
    const client = new Client({ name: "t", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp/rootone`), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }));
      const listed = (await client.listTools()).tools;
      const advertised = listed.find((t) => t.name === "pick")!;
      expect(rootCombinatorOf(advertised.inputSchema)).toBeUndefined();
      expect(Object.keys(advertised.inputSchema.properties as object)).toEqual(["id", "name"]);
      expect(advertised.description).toBe(`Pick an item by id or by name.\n\n${NOTE}`);
      // the neighbour with an ordinary schema is advertised exactly as the server published it
      const plain = listed.find((t) => t.name === "plain")!;
      expect(plain.description).toBe("A tool with an ordinary schema.");
      expect(plain.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } } });

      const called = await client.callTool({ name: "pick", arguments: { name: "n1" } });
      expect(JSON.stringify(called.content)).toContain('picked:{\\"name\\":\\"n1\\"}');
      expect(bridge.calls()).toBe(1);
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});
