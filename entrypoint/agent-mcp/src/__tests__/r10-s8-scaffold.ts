/**
 * R10 S8 - the ONE shared scaffold for the end-to-end consumer proof (not a test file).
 *
 * It wires, once per run, exactly what a host drives:
 *   - the REAL `createServer` (all MCP tools) over the SDK's in-memory transport, driven by a real MCP `Client`;
 *   - the real stores / queue / policy / orchestrator (`buildHarness`, no `defaultProvider`), the production host
 *     hooks (ops log, CRLF preservation, the R10 S4 model-visible notes, typed task events) and the default
 *     tracing plugin writing its file sink under the scaffold's tmp dir;
 *   - the REAL `AnthropicProvider` and `OpenAIProvider` (and their SDKs) talking over HTTP to ONE loopback model
 *     server that this file scripts per scenario;
 *   - the REAL adopted fs (`@modelcontextprotocol/server-filesystem`) and shell (`mcp-shell-server`) children.
 *
 * The only scripted boundary is the model. Nothing leaves 127.0.0.1 (a guard `fetch` fails the run loudly on any
 * other host, and uv runs offline). The agent-mcp `env` singleton is imported AFTER `HOME` points at a scratch dir,
 * so no host state is read or written (ADR-0008:32); the fs/shell children run with `sandbox:false` because the
 * `srt` OS wrapper adds nothing to what is proven here (wire text, ordering, notes, delegation text, trace).
 *
 * Modules that import `../config.js` are loaded with `await import()` inside {@link startScaffold} for that reason;
 * a test file must not import them statically.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";

import { resolveNativeToolingMap } from "@adhd/agent-core-native-tooling";
import { registerTaskEventHooks } from "@adhd/agent-engine-orchestrator";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** Sentinels the leak scan hunts for in the trace sink: one in prompts, one in model replies, one in tool arguments. */
export const SENTINELS = {
  prompt: "S8LEAK-PROMPT-91c4e7",
  reply: "S8LEAK-REPLY-5be21d",
  arg: "S8LEAK-ARG-d07a93",
} as const;

export type AdapterKind = "anthropic" | "openai";
export const ADAPTERS: readonly AdapterKind[] = ["anthropic", "openai"] as const;

// -- the scripted model ---------------------------------------------------------------------------------------

/** What one model request carried, normalized across the two wire formats. */
export interface IModelRequest {
  adapter: AdapterKind;
  scenario: string;
  /** Number of assistant messages already in the history (0 on the first request of a task). */
  turn: number;
  /** The exact request body text the provider sent. */
  raw: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed provider request body
  body: any;
  tools: Array<{ name: string; description: string }>;
  /** Tool results delivered in the LAST turn of the history, in wire order. `content` is the wire value. */
  toolResults: Array<{ id: string; content: unknown; isError?: boolean }>;
}

export interface IScriptCall {
  name: string;
  input: Record<string, unknown>;
}
export interface IScriptStep {
  text?: string;
  calls?: IScriptCall[];
}
export type Script = (req: IModelRequest) => IScriptStep;

const TAG = /\[\[r10s8:([a-z0-9-]+)\]\]/;

/** The tag a scenario's system prompt carries; the model server routes by it. */
export const tagFor = (scenario: string): string => `[[r10s8:${scenario}]]`;

function normalize(adapter: AdapterKind, raw: string): IModelRequest {
  const body = JSON.parse(raw);
  const scenario = TAG.exec(raw)?.[1] ?? "unknown";
  const messages: Array<Record<string, unknown>> = body.messages ?? [];
  const turn = messages.filter((m) => m["role"] === "assistant").length;
  let toolResults: IModelRequest["toolResults"] = [];
  let tools: IModelRequest["tools"] = [];
  if (adapter === "anthropic") {
    // The adapter sends one user message per tool result (the API merges consecutive user turns): take the whole
    // trailing run of tool_result messages, in wire order.
    for (let i = messages.length - 1; i >= 0 && messages[i]["role"] === "user" && Array.isArray(messages[i]["content"]); i--) {
      const blocks = (messages[i]["content"] as Array<Record<string, unknown>>).filter((b) => b["type"] === "tool_result");
      if (blocks.length === 0) break;
      toolResults = [
        ...blocks.map((b) => ({ id: String(b["tool_use_id"]), content: b["content"], isError: b["is_error"] as boolean | undefined })),
        ...toolResults,
      ];
    }
    tools = (body.tools ?? []).map((t: Record<string, unknown>) => ({ name: String(t["name"]), description: String(t["description"] ?? "") }));
  } else {
    const tail: Array<Record<string, unknown>> = [];
    for (let i = messages.length - 1; i >= 0 && messages[i]["role"] === "tool"; i--) tail.unshift(messages[i]);
    toolResults = tail.map((m) => ({ id: String(m["tool_call_id"]), content: m["content"] }));
    tools = (body.tools ?? []).map((t: { function: Record<string, unknown> }) => ({
      name: String(t.function["name"]),
      description: String(t.function["description"] ?? ""),
    }));
  }
  return { adapter, scenario, turn, raw, body, tools, toolResults };
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** One streamed Anthropic message: optional text block then `tool_use` blocks (shapes as the real API streams them). */
function anthropicSse(step: IScriptStep, ids: string[]): string {
  const parts = [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_r10s8", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
  ];
  let index = 0;
  if (step.text !== undefined) {
    parts.push(
      sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: step.text } }),
      sse("content_block_stop", { type: "content_block_stop", index })
    );
    index++;
  }
  (step.calls ?? []).forEach((c, i) => {
    parts.push(
      sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: ids[i], name: c.name, input: {} } }),
      sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } }),
      sse("content_block_stop", { type: "content_block_stop", index })
    );
    index++;
  });
  parts.push(
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: step.calls?.length ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    sse("message_stop", { type: "message_stop" })
  );
  return parts.join("");
}

function openaiJson(step: IScriptStep, ids: string[]): string {
  return JSON.stringify({
    id: "chatcmpl-r10s8",
    object: "chat.completion",
    created: 0,
    model: "r10s8-model",
    choices: [
      {
        index: 0,
        finish_reason: step.calls?.length ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: step.text ?? null,
          ...(step.calls?.length
            ? { tool_calls: step.calls.map((c, i) => ({ id: ids[i], type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

/** The tool-call id the scripted model gives call `i` of turn `turn` (characters every provider accepts). */
export const callId = (scenario: string, turn: number, i: number): string => `call_${scenario.replace(/[^a-z0-9]/g, "")}_${turn}_${i}`;

// -- scaffold ---------------------------------------------------------------------------------------------------

/** Directories the host makes read-only on purpose (the exit-status shim dir) must be writable before removal. */
function makeDirsWritable(dir: string): void {
  let entries: import("node:fs").Dirent[];
  try {
    chmodSync(dir, 0o755);
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) makeDirsWritable(join(dir, e.name));
}

export type Rec = Record<string, unknown> & { event: string };

export interface IMcpResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}
export const textOf = (r: IMcpResult): string => (r.content ?? []).map((c) => c.text ?? "").join("\n");

export interface IScaffold {
  /** Scratch root (real path) holding the per-scenario work dirs and the trace sink. */
  root: string;
  workDir(scenario: string): string;
  client: Client;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the harness type lives behind the dynamic import
  harness: any;
  /** Every request the loopback model received, in arrival order. */
  requests: IModelRequest[];
  requestsFor(scenario: string): IModelRequest[];
  setScript(scenario: string, script: Script): void;
  /** Real MCP tool call; the raw result (never throws on an `isError` result). */
  call(name: string, args: Record<string, unknown>): Promise<IMcpResult>;
  /** `agent_create` for a model agent (provider points at the loopback); returns the raw tool result. */
  createAgent(spec: {
    name: string;
    adapter: AdapterKind;
    scenario: string;
    thinking?: Record<string, unknown>;
    fsShell?: { cwd: string };
    dispatch?: boolean;
  }): Promise<IMcpResult>;
  /** `agent` + `task` (session mode, sync): returns the ids and the task result. */
  runTask(agentName: string, prompt: string, cwd: string): Promise<{ sessionId: string; taskId: string; status: string; result: string; raw: string }>;
  /** Every JSONL record of the tracing sink, in file order. */
  sinkRecords(): Rec[];
  /** The raw text of every file under the sink (for the leak scan). */
  sinkText(): string;
  /** Polls `pred` against the sink until true or `ms` elapses (event-yielding, no sleeps). */
  waitForSink(pred: (recs: Rec[]) => boolean, ms?: number): Promise<Rec[]>;
  /** Non-loopback requests the guard fetch saw (must stay empty). */
  leaks: string[];
  dispose(): Promise<void>;
}

/** Builds the scaffold. Call once (in `beforeAll`); `dispose()` in `afterAll`. */
export async function startScaffold(): Promise<IScaffold> {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  const realHome = homedir();
  const base = join(REPO_ROOT, "tmp", "agent-mcp");
  mkdirSync(base, { recursive: true });
  const root = realpathSync(mkdtempSync(join(base, "r10-s8-")));
  const fakeHome = join(root, "home");
  mkdirSync(fakeHome, { recursive: true });
  // uv must keep finding its (already populated) cache and must never reach the network.
  setEnv("UV_CACHE_DIR", process.env["UV_CACHE_DIR"] ?? join(realHome, ".cache", "uv"));
  setEnv("UV_OFFLINE", "1");
  setEnv("HOME", fakeHome);
  setEnv("ADHD_AGENT_R10S8_KEY", ["sk-ant-api03-", "r10s8", "loopback0123456789"].join(""));

  const realFetch = globalThis.fetch;
  const leaks: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      leaks.push(url.href);
      throw new Error(`NON-LOOPBACK EGRESS BLOCKED: ${url.href}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;

  // -- the loopback model -------------------------------------------------------------------------------------
  const scripts = new Map<string, Script>();
  const requests: IModelRequest[] = [];
  const http: Server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const adapter: AdapterKind = req.url?.startsWith("/anthropic/") ? "anthropic" : "openai";
        const m = normalize(adapter, Buffer.concat(chunks).toString("utf8"));
        requests.push(m);
        const script = scripts.get(m.scenario);
        if (!script) throw new Error(`no script for scenario "${m.scenario}" (url ${req.url})`);
        const step = script(m);
        const ids = (step.calls ?? []).map((_c, i) => callId(m.scenario, m.turn, i));
        if (adapter === "anthropic") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(anthropicSse(step, ids));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(openaiJson(step, ids));
        }
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(err), type: "server_error" } }));
      }
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  setEnv("ANTHROPIC_BASE_URL", `${origin}/anthropic`);

  // -- the real host, loaded after HOME moved ----------------------------------------------------------------------
  const { buildHarness } = await import("./integration/harness.js");
  const { createServer } = await import("../server.js");
  const { defaultPluginEntries } = await import("../config.js");
  const { loadDefaultPluginsOrFail } = await import("./plugin-prereq.js");
  const { registerEolPreserve } = await import("../eol-hook.js");
  const { registerOpsLog } = await import("../ops-log.js");
  const { registerToolResultNotes } = await import("../tool-result-notes.js");

  const harness = await buildHarness();
  // The same always-on registrations `createHostHooks` (host-hooks.ts) performs; `buildHarness` owns its own
  // registry, so they are applied to it here. The ops channel is a no-op sink (ops logging is not under test).
  registerOpsLog(harness.hooks, { logEvent: () => undefined } as never);
  registerEolPreserve(harness.hooks);
  registerToolResultNotes(harness.hooks);
  registerTaskEventHooks(harness.hooks, harness.taskStore);

  const sinkDir = join(root, "sink");
  await loadDefaultPluginsOrFail(harness.hooks, harness.db, {
    configPath: join(root, "no-such-config.json"),
    defaultEntries: defaultPluginEntries({} as NodeJS.ProcessEnv, {
      service: "agent-mcp-r10s8",
      logSink: "file",
      logDir: sinkDir,
      captureArgs: false,
    }),
  });

  const server: McpServer = createServer({
    agentStore: harness.agentStore,
    sessionStore: harness.sessionStore,
    taskStore: harness.taskStore,
    queue: harness.queue,
    policy: harness.policy,
    orchestrator: harness.orchestrator,
    hooks: harness.hooks,
    db: harness.db,
    dagEngine: harness.dagEngine,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "r10-s8", version: "0.0.1" }, { capabilities: {} });
  await client.connect(ct);

  const call: IScaffold["call"] = async (name, args) => (await client.callTool({ name, arguments: args })) as IMcpResult;

  const readSink = (): { recs: Rec[]; text: string } => {
    const recs: Rec[] = [];
    let text = "";
    const walk = (d: string): void => {
      for (const n of readdirSync(d).sort()) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (n.endsWith(".jsonl")) {
          const body = readFileSync(f, "utf8");
          text += body;
          for (const line of body.split("\n")) if (line.trim()) recs.push(JSON.parse(line) as Rec);
        }
      }
    };
    try {
      walk(sinkDir);
    } catch {
      /* sink not created yet */
    }
    return { recs, text };
  };

  return {
    root,
    workDir(scenario) {
      const d = join(root, "work", scenario);
      mkdirSync(d, { recursive: true });
      return d;
    },
    client,
    harness,
    requests,
    requestsFor: (scenario) => requests.filter((r) => r.scenario === scenario),
    setScript: (scenario, script) => void scripts.set(scenario, script),
    call,
    async createAgent(spec) {
      const provider =
        spec.adapter === "anthropic"
          ? {
              type: "anthropic",
              model: "claude-haiku-5-5",
              // no baseURL on an anthropic provider: the SDK client takes ANTHROPIC_BASE_URL (set below)
              env: { secret: "ADHD_AGENT_R10S8_KEY" },
              maxTokens: 4096,
              ...(spec.thinking ? { thinking: spec.thinking } : {}),
            }
          : {
              type: "openai",
              model: "r10s8-model",
              baseURL: `${origin}/openai/v1`,
              env: { secret: "ADHD_AGENT_R10S8_KEY" },
              ...(spec.thinking ? { thinking: spec.thinking } : {}),
            };
      // fs/shell are the REAL adopted servers, resolved by the catalog for the scenario's work dir (default shell
      // allowlist, no srt wrapper); an explicit `mcpServers` entry wins over `nativeTooling` (ADR-0008 D1/D4).
      const mcpServers = spec.fsShell
        ? resolveNativeToolingMap({ fs: true, shell: true, dispatch: false }, { cwd: spec.fsShell.cwd, sandbox: false })
        : {};
      return call("agent_create", {
        name: spec.name,
        provider,
        systemPrompt: `You are a scripted test agent. ${tagFor(spec.scenario)}`,
        mcpServers,
        permissions: {},
        nativeTooling: { fs: false, shell: false, dispatch: spec.dispatch === true },
      });
    },
    async runTask(agentName, prompt, cwd) {
      const ag = await call("agent", { name: agentName, cwd });
      const sessionId = (JSON.parse(textOf(ag)) as { session_id: string }).session_id;
      const t = await call("task", { session_id: sessionId, prompt, cwd, background: false });
      const raw = textOf(t);
      if (t.isError) throw new Error(`task failed for ${agentName}: ${raw}`);
      const parsed = JSON.parse(raw) as { task_id: string; status: string; result?: string };
      return { sessionId, taskId: parsed.task_id, status: parsed.status, result: parsed.result ?? "", raw };
    },
    sinkRecords: () => readSink().recs,
    sinkText: () => readSink().text,
    async waitForSink(pred, ms = 15_000) {
      const deadline = Date.now() + ms;
      let recs = readSink().recs;
      while (!pred(recs) && Date.now() < deadline) {
        await new Promise<void>((r) => setImmediate(r));
        recs = readSink().recs;
      }
      return recs;
    },
    leaks,
    async dispose() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await harness.teardown();
      await new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      });
      globalThis.fetch = realFetch;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      makeDirsWritable(fakeHome);
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** Writes `content` to `file` (creating its directory) with the given bytes: used to seed the pre-existing file. */
export function seed(file: string, content: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}
