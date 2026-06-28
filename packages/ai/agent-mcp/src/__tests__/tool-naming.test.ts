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
import { normalizeToolName, resolveToolCallName } from "../clients/tool-naming.js";
import { OpenAIProvider } from "../providers/openai.js";
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

/**
 * BACKLOG DEBT-004: a model that emits a BARE tool name (`agent` / `task`) instead
 * of the advertised `agent-mcp__agent` used to hard-fail the whole task with
 * "Invalid tool name (missing server prefix)". Capable models (sonnet-4.6, haiku,
 * qwen3-coder) do this readily — it broke recursive orchestration. A bare name that
 * maps to exactly one advertised tool must now resolve deterministically.
 */
describe("resolveToolCallName (DEBT-004 bare-name resolution)", () => {
    const advertised = ["agent-mcp__agent", "agent-mcp__task", "agent-mcp__result"];

    it("splits a qualified <server>__<tool> name (prior behavior)", () => {
        expect(resolveToolCallName("agent-mcp__task", advertised)).toEqual({ server: "agent-mcp", tool: "task" });
    });

    it("resolves a BARE name to the single advertised tool that matches", () => {
        // The exact failure: sonnet/haiku leads emitted bare `agent` / `task`.
        expect(resolveToolCallName("agent", advertised)).toEqual({ server: "agent-mcp", tool: "agent" });
        expect(resolveToolCallName("task", advertised)).toEqual({ server: "agent-mcp", tool: "task" });
    });

    it("resolves a bare name even when the model normalized '-'→'_' in the advertised set", () => {
        expect(resolveToolCallName("agent", ["agent_mcp__agent"])).toEqual({ server: "agent_mcp", tool: "agent" });
    });

    it("throws an ACTIONABLE error when a bare name is ambiguous across servers", () => {
        const two = ["server-a__run", "server-b__run"];
        expect(() => resolveToolCallName("run", two)).toThrowError(/ambiguous tool name 'run'/i);
        // and the message names the qualified candidates so the model can retry
        expect(() => resolveToolCallName("run", two)).toThrowError(/server-a__run.*server-b__run/);
    });

    it("falls back to a literal split for an unknown bare name (downstream surfaces 'unknown')", () => {
        expect(resolveToolCallName("nope", advertised)).toEqual({ server: "nope", tool: "nope" });
    });
});

/**
 * Consumer-level proof: drive the REAL OpenAIProvider with a mocked SDK client that
 * returns a BARE tool call. Pre-fix the provider threw "missing server prefix";
 * it must now return the resolved {server, tool}. Reverting the provider wiring
 * turns this red.
 */
describe("OpenAIProvider resolves a bare tool call (DEBT-004 consumer)", () => {
    function providerReturning(toolName: string): OpenAIProvider {
        const p = new OpenAIProvider({ type: "openai", model: "test", baseURL: "http://localhost:1234/v1" } as never);
        // override the protected SDK client with a stub
        (p as unknown as { client: unknown }).client = {
            chat: { completions: { create: async () => ({
                choices: [{ message: { content: null, tool_calls: [
                    { id: "call_1", type: "function", function: { name: toolName, arguments: "{}" } },
                ] }, finish_reason: "tool_calls" }],
                usage: undefined,
            }) } },
        };
        return p;
    }
    const tools = [{ name: "agent-mcp__task", description: "run a task", inputSchema: { type: "object", properties: {} } }];

    it("resolves a bare `task` against the advertised tools instead of throwing", async () => {
        const res = await providerReturning("task").chat({ messages: [], tools } as never);
        expect(res.message.toolCalls).toEqual([
            { id: "call_1", server: "agent-mcp", tool: "task", arguments: {} },
        ]);
    });

    it("still splits a qualified name normally", async () => {
        const res = await providerReturning("agent-mcp__task").chat({ messages: [], tools } as never);
        expect(res.message.toolCalls?.[0]).toMatchObject({ server: "agent-mcp", tool: "task" });
    });
});
