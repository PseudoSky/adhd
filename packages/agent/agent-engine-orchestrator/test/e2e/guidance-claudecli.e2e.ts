/**
 * cafe9a17 AC1 / AC3 x claudecli: the guidance a claudecli agent's CLI reads describes the EFFECTIVE servers.
 *
 * E2E lane: the claudecli adapter hands its tools to the `claude` CLI only through the loopback MCP bridge, so the
 * request builder under test is a real HTTP server read by a real MCP client. The guided tool list comes from the REAL
 * `Orchestrator.run` over `mcpServers` produced by the REAL resolver; the CLI itself (a paid third-party binary) is
 * stood in for by a provider that captures `request.tools`, exactly as `r10-w1-shell-guidance-claudecli.e2e.ts` does.
 * One scaffold, no sleeps, no timing assertions.
 *
 * guards: the tool descriptions a claudecli agent's CLI reads through the loopback MCP bridge describe the catalog defaults (default allowlist, exit-status promise, fs notes) instead of the task's effective shell and fs servers.
 * tier: P (e2e lane)
 * gap: This cannot be observed at tier S because the claudecli adapter hands its tools to the CLI only through a real loopback HTTP MCP server read by a real MCP client, and tier S allows no sockets.
 * cites: cafe9a17 AC1, cafe9a17 AC3 (cited in the test titles).
 */
import { resolveNativeToolingMap, DEFAULT_SHELL_ALLOW_COMMANDS } from "@adhd/agent-core-native-tooling";
import type { McpServerConfig, NativeToolingConfig } from "@adhd/agent-base-types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import type { McpClientRegistry } from "../../src/clients/registry.js";
import { Orchestrator } from "../../src/engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../../src/engine/orchestrator.js";
import type { PolicyEngine } from "../../src/engine/policy.js";
import type { EngineConfig, EngineLogger } from "../../src/interfaces.js";
import { startToolBridge } from "../../src/providers/claudecli-tool-bridge.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse, ToolDefinition } from "../../src/providers/types.js";
import { generateId } from "../../src/utils/ids.js";
import { nowIso } from "../../src/utils/timestamps.js";
import type { ExecutionContext, Message } from "../../src/validation/index.js";

const schema = { type: "object", properties: {} } as const;
const logger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;
const policy = { check: () => {} } as unknown as PolicyEngine;
const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };

/** Run one claudecli task and return what the CLI reads from the bridge: `server -> tool -> description`. */
async function bridgeDescriptions(mcpServers: Record<string, McpServerConfig>): Promise<Record<string, string>> {
  const ctx: ExecutionContext = {
    taskId: generateId(),
    sessionId: generateId(),
    agentName: "test-agent",
    agentDefinition: {
      name: "test-agent", version: 1, provider: { type: "claudecli", model: "sonnet" },
      systemPrompt: "x", mcpServers, permissions: {}, createdAt: nowIso(), updatedAt: nowIso(),
    } as ExecutionContext["agentDefinition"],
    recursionDepth: 0,
    toolCallCount: 0,
  };
  let captured: ToolDefinition[] = [];
  const provider = {
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
      captured = [...(req.tools ?? [])];
      return {
        message: { id: generateId(), sessionId: ctx.sessionId, role: "assistant", content: "done", createdAt: nowIso() },
        stopReason: "completed",
      } as ProviderChatResponse;
    },
  } as unknown as LLMProvider;
  const registry = {
    listAllTools: async () => [
      { name: "shell__shell_execute", description: "Execute a command", inputSchema: schema },
      { name: "fs__write_file", description: "Write a file", inputSchema: schema },
    ],
    closeAll: async () => {},
    getClient: async () => ({ callTool: async () => [] }),
  } as unknown as McpClientRegistry;
  const user: Message = { id: generateId(), sessionId: ctx.sessionId, role: "user", content: "go", createdAt: nowIso() };
  await new Orchestrator().run({
    executionContext: ctx, messages: [user], registry, provider, policy, taskStore, sessionStore,
    signal: new AbortController().signal, taskId: ctx.taskId, logger,
    config: { server: { contextLimit: 0, defaultMaxTokens: 8192 } } as EngineConfig,
  });

  const bridge = await startToolBridge({
    tools: captured,
    executeTool: (async () => ({ content: [], isError: false })) as unknown as NonNullable<ProviderChatRequest["executeTool"]>,
    logger,
  });
  const out: Record<string, string> = {};
  try {
    for (const [server, tool] of [["shell", "shell_execute"], ["fs", "write_file"]] as const) {
      const client = new Client({ name: "claude-stand-in", version: "0.0.0" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp/${server}`), {
            requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
          })
        );
        out[`${server}__${tool}`] = (await client.listTools()).tools.find((t) => t.name === tool)?.description ?? "";
      } finally {
        await client.close().catch(() => undefined);
      }
    }
  } finally {
    await bridge.close();
  }
  return out;
}

const resolved = (cfg: NativeToolingConfig, shim: boolean): Record<string, McpServerConfig> =>
  resolveNativeToolingMap(cfg, { cwd: "/w", ...(shim ? { exitShim: { dir: "/shim/abc", origPath: "/usr/bin:/bin" } } : {}) });

describe("cafe9a17 AC1/AC3 [claudecli bridge]: the description the CLI reads matches the effective servers", () => {
  it("cafe9a17 AC1, cafe9a17 AC3 [claudecli]: default catalog + shim => default allowlist, exit-status promise, fs note", async () => {
    const d = await bridgeDescriptions(resolved({}, true));
    expect(d["shell__shell_execute"]).toContain(`Available commands: ${DEFAULT_SHELL_ALLOW_COMMANDS.join(" ")}.`);
    expect(d["shell__shell_execute"]).toContain("[exit status: N]");
    expect(d["fs__write_file"]).toContain("NOT create missing parent directories");
  });

  it("cafe9a17 AC1, cafe9a17 AC3 [claudecli]: allowCommands override without a shim => only those commands, no exit-status promise", async () => {
    const d = await bridgeDescriptions(resolved({ shell: { allowCommands: ["cat", "ls"] } }, false));
    expect(d["shell__shell_execute"]).toContain("Available commands: cat ls.");
    expect(d["shell__shell_execute"]).not.toMatch(/curl|\[exit status: N\]/);
  });

  it("cafe9a17 AC1, cafe9a17 AC3 [claudecli]: custom shell and fs servers => no catalog claims and no fs notes", async () => {
    const d = await bridgeDescriptions({
      shell: { transport: "stdio", command: "my-shell-server" },
      fs: { transport: "stdio", command: "my-fs-server" },
    });
    expect(d["shell__shell_execute"]).not.toMatch(/Available commands|NOT available|exit status/);
    expect(d["shell__shell_execute"]).toContain("Shell calls in one turn run one after another;");
    expect(d["fs__write_file"]).toBe("Write a file");
  });
});
