/**
 * cafe9a17 AC1 / AC3: the native-tool guidance describes the EFFECTIVE shell and fs servers of the task, not the
 * catalog defaults.
 *
 * Driven the way a consumer sees it: the agent's `mcpServers` come from the REAL resolver
 * (`resolveNativeToolingMap`, the producer the host mounts), the guidance runs inside the REAL `Orchestrator.run`,
 * and the bytes asserted are the tool descriptions each REAL provider adapter puts on its wire (Anthropic and the
 * OpenAI-compatible adapter that DeepSeek uses, both through the engine's `wire.fetch` seam: no network). The
 * claudecli bridge leg is in `cafe9a17-guidance-claudecli.e2e.test.ts` (it needs a loopback server).
 */
import { resolveNativeToolingMap, DEFAULT_SHELL_ALLOW_COMMANDS } from "@adhd/agent-core-native-tooling";
import type { McpServerConfig, NativeToolingConfig } from "@adhd/agent-base-types";
import { describe, expect, it } from "vitest";

import type { McpClientRegistry } from "../clients/registry.js";
import { nativeGuidanceContextOf, withNativeToolGuidance } from "../engine/native-tool-guidance.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import type { LLMProvider } from "../providers/types.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { ExecutionContext, Message } from "../validation/index.js";

const schema = { type: "object", properties: {} } as const;
const logger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;
const policy = { check: () => {} } as unknown as PolicyEngine;
const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };

const ORDERING = "Shell calls in one turn run one after another;";
const EXIT_STATUS = "[exit status: N]";
const FS_PARENT_NOTE = "NOT create missing parent directories";

/** The `mcpServers` map the host mounts for `cfg`, produced by the real resolver. */
function resolved(cfg: NativeToolingConfig, withShim: boolean): Record<string, McpServerConfig> {
  return resolveNativeToolingMap(cfg, {
    cwd: "/w",
    ...(withShim ? { exitShim: { dir: "/shim/abc", origPath: "/usr/bin:/bin" } } : {}),
  });
}

const customShell: McpServerConfig = { transport: "stdio", command: "my-shell-server", args: ["--stdio"] };
const customFs: McpServerConfig = { transport: "stdio", command: "my-fs-server", args: ["/w"] };

// -- the adapters under test (each through the engine's wire.fetch seam) -------------------------------------------

type Body = { tools?: Array<Record<string, unknown>> };
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const sse = (events: Array<[string, unknown]>): Response =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const msgStart = {
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
};

function anthropicProvider(bodies: Body[]): LLMProvider {
  const fetchSeam: typeof fetch = async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return sse([
      ["message_start", msgStart],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
  };
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fetchSeam },
    getProviderConfig: () => ({ secret: "sk-ant-api-test", model: "claude-haiku-5-5" }),
  };
  return new AnthropicProvider({ type: "anthropic", model: "claude-haiku-5-5" } as never, config as never, logger as never);
}

function openaiProvider(bodies: Body[]): LLMProvider {
  const fetchSeam: typeof fetch = async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return json({
      id: "x", object: "chat.completion", created: 0, model: "deepseek-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fetchSeam },
    getProviderConfig: () => ({ secret: "sk-test", model: "deepseek-flash", baseURL: "http://localhost:1/v1" }),
  };
  return new OpenAIProvider({ type: "openai", model: "deepseek-flash" } as never, config as never);
}

const ADAPTERS: Array<["anthropic" | "openai-compatible (DeepSeek)", (b: Body[]) => LLMProvider]> = [
  ["anthropic", anthropicProvider],
  ["openai-compatible (DeepSeek)", openaiProvider],
];

/** Run one task through the real Orchestrator and return the tool descriptions the adapter put on the wire. */
async function wireDescriptions(
  makeProvider: (b: Body[]) => LLMProvider,
  mcpServers: Record<string, McpServerConfig>
): Promise<Record<string, string>> {
  const bodies: Body[] = [];
  const ctx: ExecutionContext = {
    taskId: generateId(),
    sessionId: generateId(),
    agentName: "test-agent",
    agentDefinition: {
      name: "test-agent", version: 1, provider: { type: "anthropic", model: "claude-haiku-5-5" },
      systemPrompt: "x", mcpServers, permissions: {}, createdAt: nowIso(), updatedAt: nowIso(),
    } as ExecutionContext["agentDefinition"],
    recursionDepth: 0,
    toolCallCount: 0,
  };
  const registry = {
    listAllTools: async () => [
      { name: "shell__shell_execute", description: "Execute a command", inputSchema: schema },
      { name: "fs__write_file", description: "Write a file", inputSchema: schema },
      { name: "fs__edit_file", description: "Edit a file", inputSchema: schema },
      { name: "fs__read_text_file", description: "Read a file", inputSchema: schema },
    ],
    closeAll: async () => {},
    getClient: async () => ({ callTool: async () => [] }),
  } as unknown as McpClientRegistry;
  const user: Message = { id: generateId(), sessionId: ctx.sessionId, role: "user", content: "go", createdAt: nowIso() };
  await new Orchestrator().run({
    executionContext: ctx, messages: [user], registry, provider: makeProvider(bodies), policy, taskStore, sessionStore,
    signal: new AbortController().signal, taskId: ctx.taskId, logger,
    config: { server: { contextLimit: 0, defaultMaxTokens: 8192 } } as EngineConfig,
  });
  expect(bodies).toHaveLength(1);
  const out: Record<string, string> = {};
  for (const t of bodies[0].tools ?? []) {
    const fn = (t["function"] as { name: string; description?: string } | undefined) ?? (t as { name: string; description?: string });
    out[fn.name] = fn.description ?? "";
  }
  return out;
}

const CAT_LS: NativeToolingConfig = { shell: { allowCommands: ["cat", "ls"] } };

// -- the pure derivation ------------------------------------------------------------------------------------------

describe("cafe9a17 AC1: nativeGuidanceContextOf reads the effective servers from the resolved mcpServers", () => {
  it("cafe9a17 AC1: the default catalog shell lists exactly the default allowlist; the shim is detected from the resolved env, with or without the srt wrapper", () => {
    for (const sandbox of [true, false]) {
      const noShim = nativeGuidanceContextOf(resolveNativeToolingMap({}, { cwd: "/w", sandbox }));
      expect(noShim.shell).toEqual({ catalog: true, allow: [...DEFAULT_SHELL_ALLOW_COMMANDS], hasPatterns: false, exitStatus: false });
      expect(noShim.fsCatalog).toBe(true);
      const shim = nativeGuidanceContextOf(resolveNativeToolingMap({}, { cwd: "/w", sandbox, exitShim: { dir: "/s", origPath: "/usr/bin" } }));
      expect(shim.shell.exitStatus).toBe(true);
    }
  });

  it("cafe9a17 AC1: an allowCommands override, an allowPatterns-only agent and an empty override are reflected, never the defaults", () => {
    expect(nativeGuidanceContextOf(resolved(CAT_LS, false)).shell.allow).toEqual(["cat", "ls"]);
    const patterns = nativeGuidanceContextOf(resolved({ shell: { allowPatterns: ["git.*"] } }, false)).shell;
    expect(patterns).toMatchObject({ catalog: true, allow: [], hasPatterns: true });
    expect(nativeGuidanceContextOf(resolved({ shell: { allowCommands: [] } }, false)).shell.allow).toEqual([]);
  });

  it("cafe9a17 AC1: custom shell and fs servers, a missing map and a non-stdio server are not the catalog servers (fail closed)", () => {
    const custom = nativeGuidanceContextOf({ shell: customShell, fs: customFs });
    expect(custom.shell.catalog).toBe(false);
    expect(custom.fsCatalog).toBe(false);
    expect(nativeGuidanceContextOf(undefined)).toEqual({ shell: { catalog: false, allow: [], hasPatterns: false, exitStatus: false }, fsCatalog: false });
    expect(nativeGuidanceContextOf({ shell: { transport: "http", url: "http://x" } as McpServerConfig }).shell.catalog).toBe(false);
  });
});

describe("cafe9a17 AC1: withNativeToolGuidance output per effective configuration", () => {
  const tools = [
    { name: "shell__shell_execute", description: "Run", inputSchema: schema },
    { name: "fs__write_file", description: "Write", inputSchema: schema },
  ];
  const text = (map: Record<string, McpServerConfig> | undefined) => {
    const out = withNativeToolGuidance(tools, nativeGuidanceContextOf(map));
    return { shell: out[0].description ?? "", fs: out[1].description ?? "" };
  };

  it("cafe9a17 AC1: with no context at all (config unknown) the guidance promises no command list, no exit status and no fs note", () => {
    const out = withNativeToolGuidance(tools);
    expect(out[0].description).toContain(ORDERING);
    expect(out[0].description).not.toMatch(/Available commands|NOT available|exit status|curl/);
    expect(out[1].description).toBe("Write");
  });

  it("cafe9a17 AC1: recipes are emitted only when the commands they pipe through are allowed", () => {
    const { shell } = text(resolved({ shell: { allowCommands: ["curl", "grep"] } }, false));
    expect(shell).toContain("curl -fsSL");
    expect(shell).toContain('"grep","-o","<title>[^<]*"');
    expect(shell).not.toContain('"cut"');
    expect(shell).not.toContain('"head"');
    const curlOnly = text(resolved({ shell: { allowCommands: ["curl"] } }, false)).shell;
    expect(curlOnly).toContain("curl -fsSL");
    expect(curlOnly).not.toMatch(/"grep"|A grep with no match/);
    expect(text(resolved({ shell: { allowCommands: ["cat"] } }, false)).shell).not.toContain("curl");
  });

  it("cafe9a17 AC1: allow patterns are named as such, and an agent with neither list gets no command list", () => {
    const { shell } = text(resolved({ shell: { allowCommands: ["cat"], allowPatterns: ["git.*"] } }, false));
    expect(shell).toContain("Available commands: cat.");
    expect(shell).toContain("allow patterns");
    expect(text(resolved({ shell: { allowPatterns: ["git.*"] } }, false)).shell).not.toContain("Available commands");
  });

  it("cafe9a17 AC1: the exit-status sentence is present iff the shim is active, with or without curl", () => {
    expect(text(resolved({}, true)).shell).toContain(EXIT_STATUS);
    expect(text(resolved({}, false)).shell).not.toContain(EXIT_STATUS);
    expect(text(resolved({ shell: { allowCommands: ["cat"] } }, true)).shell).toContain(EXIT_STATUS);
    expect(text(resolved({ shell: { allowCommands: ["cat"] } }, false)).shell).not.toContain(EXIT_STATUS);
  });
});

// -- both adapters, through the real Orchestrator ------------------------------------------------------------------

describe.each(ADAPTERS)("cafe9a17 AC1/AC3 adapter wire: %s", (_name, makeProvider) => {
  it("cafe9a17 AC1 [default catalog + shim]: lists the default allowlist, promises exit status, carries the fs notes", async () => {
    const d = await wireDescriptions(makeProvider, resolved({}, true));
    expect(d["shell__shell_execute"]).toContain(`Available commands: ${DEFAULT_SHELL_ALLOW_COMMANDS.join(" ")}.`);
    expect(d["shell__shell_execute"]).toContain(EXIT_STATUS);
    expect(d["fs__write_file"]).toContain(FS_PARENT_NOTE);
    expect(d["fs__edit_file"]).toContain("CRLF and LF");
    expect(d["fs__read_text_file"]).toContain("Line endings");
  });

  it("cafe9a17 AC1 [allowCommands override, no shim]: lists only the overridden commands, no recipes for unlisted ones, no exit-status promise", async () => {
    const d = await wireDescriptions(makeProvider, resolved(CAT_LS, false));
    const shell = d["shell__shell_execute"];
    expect(shell).toContain("Available commands: cat ls.");
    for (const c of ["curl", "git", "npm", "grep"]) expect(shell, c).not.toMatch(new RegExp(`\\b${c}\\b`));
    expect(shell).not.toContain(EXIT_STATUS);
    expect(shell).not.toContain("RAW HTML");
    expect(shell).toContain(ORDERING);
  });

  it("cafe9a17 AC1 [custom shell server]: no command list, no catalog policy claims, no exit-status promise; the engine ordering rule stays", async () => {
    const d = await wireDescriptions(makeProvider, { ...resolved({}, true), shell: customShell });
    const shell = d["shell__shell_execute"];
    expect(shell).not.toMatch(/Available commands|NOT available|curl|argv list/);
    expect(shell).not.toContain(EXIT_STATUS);
    expect(shell).toContain(ORDERING);
  });

  it("cafe9a17 AC1 [custom fs server]: none of the fs notes; the catalog fs server keeps them", async () => {
    const d = await wireDescriptions(makeProvider, { ...resolved({}, true), fs: customFs });
    expect(d["fs__write_file"]).toBe("Write a file");
    expect(d["fs__edit_file"]).toBe("Edit a file");
    expect(d["fs__read_text_file"]).toBe("Read a file");
    expect(d["shell__shell_execute"]).toContain("Available commands:"); // the shell side is unaffected by the fs server
  });

  it("cafe9a17 AC1 [config unknown: no mcpServers]: fails closed on this wire too", async () => {
    const d = await wireDescriptions(makeProvider, {});
    expect(d["shell__shell_execute"]).not.toMatch(/Available commands|exit status/);
    expect(d["fs__write_file"]).toBe("Write a file");
  });
});
