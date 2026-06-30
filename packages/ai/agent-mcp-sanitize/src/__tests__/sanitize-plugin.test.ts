import { describe, it, expect } from "vitest";
import { HookRegistry } from "@adhd/agent-mcp-types";
import type { PostToolCallPayload, ExecutionContext } from "@adhd/agent-mcp-types";
import createPlugin from "../index.js";

const stubCtx = { taskId: "", sessionId: "", agentName: "", agentDefinition: {} as never, recursionDepth: 0, toolCallCount: 0 };

function makePayload(overrides: Partial<PostToolCallPayload> = {}): PostToolCallPayload {
    return {
        executionContext: stubCtx as ExecutionContext,
        toolName: "agent-mcp__task",
        callId: "call-1",
        toolInput: { agent_name: "researcher" },
        result: "hello world",
        isError: false,
        ...overrides,
    };
}

describe("SanitizePlugin", () => {
    it("prefix strategy prepends a boundary label", () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: undefined as never, config: { defaultStrategy: "prefix" } });
        plugin.install(hooks);

        const payload = makePayload();
        hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe('[Sub-agent output from "researcher"]\nhello world');
    });

    it("wrap strategy surrounds with delimiters", () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: undefined as never, config: { defaultStrategy: "wrap" } });
        plugin.install(hooks);

        const payload = makePayload();
        hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe(
            '── Agent "researcher" output ──\nhello world\n── End agent output ──'
        );
    });

    it("none strategy passes through unchanged", () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: undefined as never, config: { defaultStrategy: "none" } });
        plugin.install(hooks);

        const payload = makePayload();
        hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe("hello world");
    });

    it("skips non-delegation tools when delegationOnly is true", () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: undefined as never, config: { defaultStrategy: "prefix" } });
        plugin.install(hooks);

        const payload = makePayload({ toolName: "filesystem__write_file" });
        hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe("hello world");
    });

    it("sanitizes non-delegation tools when delegationOnly is false", () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: undefined as never, config: { defaultStrategy: "prefix", delegationOnly: false } });
        plugin.install(hooks);

        const payload = makePayload({ toolName: "filesystem__write_file", toolInput: {} });
        hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe("[Sub-agent output]\nhello world");
    });

    it("per-agent override takes precedence over default", () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({
            db: undefined as never,
            config: {
                defaultStrategy: "wrap",
                agents: { researcher: "none" },
            },
        });
        plugin.install(hooks);

        const payload = makePayload();
        hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe("hello world");
    });

    it("skips error results", () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: undefined as never, config: { defaultStrategy: "prefix" } });
        plugin.install(hooks);

        const payload = makePayload({ isError: true });
        hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe("hello world");
    });

    it("gets agent_name from agent-mcp__agent calls", () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: undefined as never, config: { defaultStrategy: "prefix" } });
        plugin.install(hooks);

        const payload = makePayload({ toolName: "agent-mcp__agent", toolInput: { name: "coder" } });
        hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe('[Sub-agent output from "coder"]\nhello world');
    });

    it("no agent name falls back to generic label", () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: undefined as never, config: { defaultStrategy: "prefix" } });
        plugin.install(hooks);

        const payload = makePayload({ toolInput: {} });
        hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe("[Sub-agent output]\nhello world");
    });

    it("multiple transform handlers chain (second sees first's mutation)", async () => {
        const hooks = new HookRegistry();
        const plugin = createPlugin({ db: undefined as never, config: { defaultStrategy: "prefix" } });
        plugin.install(hooks);

        hooks.register("transform:tool_result", (p: PostToolCallPayload) => {
            if (typeof p.result === "string") {
                p.result = p.result.toUpperCase();
            }
        });

        const payload = makePayload();
        await hooks.emit("transform:tool_result", payload);

        expect(payload.result).toBe('[SUB-AGENT OUTPUT FROM "RESEARCHER"]\nHELLO WORLD');
    });
});
