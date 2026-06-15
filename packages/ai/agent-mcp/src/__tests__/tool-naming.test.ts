/**
 * tool-naming.test.ts
 *
 * Guards the cross-provider tool-name round-trip. OpenAI-compatible/local models
 * (LM Studio / qwen) rewrite '-' → '_' in tool names, so an advertised
 * `agent-mcp__agent` comes back as `agent_mcp__agent`. Pre-fix this split to the
 * server `agent_mcp`, which the registry could not find ("No MCP server config
 * found for server: 'agent_mcp'") — breaking recursion and any hyphenated server.
 */
import { describe, it, expect, vi } from "vitest";
import { normalizeToolName } from "../clients/tool-naming.js";
import { McpClientRegistry } from "../clients/registry.js";
import type { ExecutionContext } from "../validation/index.js";
import type { InProcessToolHandler } from "../clients/in-process.js";

const ctx = {} as ExecutionContext; // registry only threads it to InProcessMcpClient

function makeRegistry(handler: InProcessToolHandler): McpClientRegistry {
    return new McpClientRegistry(
        // "agent-mcp" key → in-process; the stdio config is never spawned.
        { "agent-mcp": { transport: "stdio", command: "noop" } } as never,
        undefined,
        [{ name: "agent", description: "open a session", inputSchema: { type: "object", properties: {} } }],
        handler,
        ctx
    );
}

describe("tool-naming", () => {
    it("normalizeToolName rewrites '-' and other non-[A-Za-z0-9_] chars to '_'", () => {
        expect(normalizeToolName("agent-mcp__agent")).toBe("agent_mcp__agent");
        expect(normalizeToolName("a.b-c__do")).toBe("a_b_c__do");
        expect(normalizeToolName("calc__add")).toBe("calc__add");
    });

    describe("registry resolveToolName round-trip", () => {
        it("resolves a model-normalized name back to the real {server,tool} (guards the '-'→'_' bug)", async () => {
            const reg = makeRegistry(async () => "ok");
            await reg.listAllTools(); // advertises 'agent-mcp__agent' and indexes its normalized form
            // The exact failure observed live: model returns 'agent_mcp__agent'.
            expect(reg.resolveToolName("agent_mcp__agent")).toEqual({ server: "agent-mcp", tool: "agent" });
            // Exact advertised name resolves too.
            expect(reg.resolveToolName("agent-mcp__agent")).toEqual({ server: "agent-mcp", tool: "agent" });
        });

        it("falls back to a literal split for names the registry never advertised", async () => {
            const reg = makeRegistry(async () => "ok");
            await reg.listAllTools();
            expect(reg.resolveToolName("calc__add")).toEqual({ server: "calc", tool: "add" });
        });

        it("getClient resolves a normalized server name and dispatches (guards in-process recursion)", async () => {
            const handler = vi.fn(async () => "dispatched");
            const reg = makeRegistry(handler);
            await reg.listAllTools();
            // 'agent_mcp' (normalized) must still reach the configured 'agent-mcp' in-process client.
            const client = await reg.getClient("agent_mcp");
            const result = await client.callTool("agent", {});
            expect(result).toBe("dispatched");
            expect(handler).toHaveBeenCalledWith("agent", {}, ctx);
        });
    });
});
