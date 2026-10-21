/**
 * R10 W1 x claudecli: the shell ordering sentence reaches the model a claudecli agent drives.
 *
 * The `claude` CLI never sees the engine's request messages, but it does read tool descriptions: the engine hands
 * the SAME guided, canonicalised tool list (`request.tools`) to every provider, and the claudecli loopback bridge
 * serves `def.description` from it in `tools/list` (`claudecli-tool-bridge.ts`). Proven here through the REAL
 * `Orchestrator.run` (a stand-in for the CLI captures `request.tools`) and the REAL loopback bridge over HTTP with a
 * real MCP client: the sentence is in the description the CLI would read. The Anthropic and OpenAI wires are in
 * `entrypoint/agent-mcp/src/__tests__/r10-s4-adapter-wire.test.ts` ("R10 W1 AC3").
 *
 * guards: the shell ordering sentence is lost between the engine's guided tool list and the description the claudecli loopback bridge serves in tools/list, so a claudecli agent never reads it.
 * tier: P (e2e lane, ADR 0009: binds a loopback HTTP socket; backlog 132547e7, f3683008)
 * gap: This cannot be observed at tier S because the description the claude CLI reads is served by the bridge over a bound loopback HTTP socket to a real MCP client, and tier S allows no sockets.
 * cites: R10 W1 AC3.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import type { McpClientRegistry } from "../clients/registry.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { startToolBridge } from "../providers/claudecli-tool-bridge.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse, ToolDefinition } from "../providers/types.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { ExecutionContext, Message } from "../validation/index.js";

const SENTENCE =
    "Shell calls in one turn run one after another; to overlap independent long commands use one command that does it (e.g. `make -j2 test lint`) or a tasks_batch.";

const policy = { check: () => {} } as unknown as PolicyEngine;
const logger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;
const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
const schema = { type: "object", properties: {} } as const;

describe("R10 W1 x claudecli: the ordering sentence is in the shell description the CLI reads", () => {
    it("R10 W1 AC3 [claudecli]: request.tools carries it, and the real bridge serves it in tools/list for mcp__shell__shell_execute", async () => {
        const ctx: ExecutionContext = {
            taskId: generateId(),
            sessionId: generateId(),
            agentName: "test-agent",
            agentDefinition: {
                name: "test-agent", version: 1, provider: { type: "claudecli", model: "sonnet" },
                systemPrompt: "x", mcpServers: {}, permissions: {}, createdAt: nowIso(), updatedAt: nowIso(),
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

        const shell = captured.find((t) => t.name === "shell__shell_execute");
        expect(shell?.description).toContain(SENTENCE);
        expect(captured.find((t) => t.name === "fs__write_file")?.description ?? "").not.toContain(SENTENCE);

        // what the claude CLI itself reads: the loopback bridge's tools/list for the `shell` route
        const bridge = await startToolBridge({
            tools: captured,
            executeTool: (async () => ({ content: [], isError: false })) as unknown as NonNullable<ProviderChatRequest["executeTool"]>,
            logger,
        });
        const client = new Client({ name: "claude-stand-in", version: "0.0.0" });
        try {
            await client.connect(
                new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp/shell`), {
                    requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
                })
            );
            const listed = (await client.listTools()).tools.find((t) => t.name === "shell_execute");
            expect(listed?.description).toContain(SENTENCE);
        } finally {
            await client.close().catch(() => undefined);
            await bridge.close();
        }
    });
});
