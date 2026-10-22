/**
 * R10 S5b: the engine side of the trace signals, through the REAL `Orchestrator.run` and the real
 * `HookRegistry`. Only the LLM provider and the MCP client boundary are scripted; the per-adapter proof
 * through the REAL Anthropic and OpenAI adapters over loopback HTTP, joined to the real tracing plugin, is in
 * `agent-plugin-tracing/src/lib/r10-s5b-engine-trace.e2e.test.ts`. Latches, never sleeps.
 *
 *  - R10 S5b AC1: `post:model_response` carries turnIndex / thinkingConfig / thinkingBlocks /
 *    toolResultBytesIn from real data, per provider family; absent (never 0) where a family cannot supply it.
 *  - R10 S5b AC2: `task:startup` is a typed payload with no cast; queueWaitMs / sessionMs are absent.
 *  - R10 S5b AC3: each tool call (native and claudecli-bridged) runs under its own call-id scope, so two
 *    concurrent dispatching calls on one parent are told apart exactly.
 *  - R10 S5b AC4: a `result` wait emits `dispatch:completed` (kind result, waitMs) when the host wires hooks.
 *
 * guards: the engine's trace signals are wrong: post:model_response zero-fills or omits turnIndex, thinkingConfig, thinkingBlocks or toolResultBytesIn per provider family, task:startup carries unmeasured figures, two concurrent tool calls on one parent observe each other's call id, or a result wait emits no dispatch:completed.
 * tier: S
 * cites: R10 S5b AC1-AC4 (every test title carries its AC).
 */
import { HookRegistry } from "@adhd/agent-base-types";
import type {
    DispatchCompletedPayload,
    PostModelResponsePayload,
    TaskStartupPayload,
} from "@adhd/agent-base-types";
import { describe, expect, it } from "vitest";

import type { McpClientRegistry } from "../clients/registry.js";
import { currentToolCallId, runInToolCallScope } from "../engine/dispatch-call-scope.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { PolicyEngine } from "../engine/policy.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse, ToolDefinition } from "../providers/types.js";
import { toOpenAIToolContent } from "../providers/openai.js";
import { resultToolWait } from "../tools/task.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { ExecutionContext, Message } from "../validation/index.js";

const policy = { check: () => {} } as unknown as PolicyEngine;
const silentLogger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;
const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };

const schema = { type: "object", properties: {} };
const TOOLS: ToolDefinition[] = [
    { name: "fs__read_text_file", description: "read", inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: "agent-mcp__task", description: "delegate", inputSchema: schema },
];

type Family = "anthropic" | "openai" | "claudecli";

function ctxFor(family: Family): ExecutionContext {
    const providers = {
        anthropic: { type: "anthropic", model: "claude-haiku-5-5", thinking: { type: "adaptive", display: "summarized" } },
        openai: { type: "openai", model: "deepseek-chat" },
        claudecli: { type: "claudecli", model: "sonnet" },
    };
    const provider = providers[family];
    return {
        taskId: generateId(),
        sessionId: generateId(),
        agentName: "test-agent",
        agentDefinition: {
            name: "test-agent",
            version: 1,
            provider,
            systemPrompt: "x",
            mcpServers: {},
            permissions: {},
            createdAt: nowIso(),
            updatedAt: nowIso(),
        } as unknown as ExecutionContext["agentDefinition"],
        recursionDepth: 0,
        toolCallCount: 0,
    };
}

const latch = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
};

/** A provider that requests `calls` on turn 1 (native) and completes on turn 2; the response carries `echo`. */
function twoTurnProvider(calls: Array<{ id: string; server: string; tool: string; args?: unknown }>, echo?: ProviderChatResponse["echo"]): LLMProvider {
    let turn = 0;
    return {
        chat: async (): Promise<ProviderChatResponse> => {
            turn++;
            const base = { id: generateId(), sessionId: "s", createdAt: nowIso() };
            return turn === 1
                ? ({
                      message: { ...base, role: "assistant", content: "", toolCalls: calls.map((c) => ({ id: c.id, server: c.server, tool: c.tool, arguments: c.args ?? {} })) },
                      stopReason: "tool_calls",
                      ...(echo ? { echo } : {}),
                  } as ProviderChatResponse)
                : ({ message: { ...base, role: "assistant", content: "done" }, stopReason: "completed" } as ProviderChatResponse);
        },
    };
}

async function drive(ctx: ExecutionContext, provider: LLMProvider, callTool: (server: string, tool: string, args: unknown) => Promise<unknown>, hooks = new HookRegistry()) {
    const registry = {
        listAllTools: async () => TOOLS.map((t) => ({ ...t })),
        closeAll: async () => {},
        startupTimings: () => ({ connectMs: { fs: 3 }, toolsReadyMs: 5 }),
        getClient: async (server: string) => ({ callTool: async (tool: string, args: unknown) => callTool(server, tool, args) }),
    };
    const user: Message = { id: generateId(), sessionId: ctx.sessionId, role: "user", content: "go", createdAt: nowIso() };
    await new Orchestrator().run({
        executionContext: ctx,
        messages: [user],
        registry: registry as unknown as McpClientRegistry,
        provider,
        policy,
        taskStore,
        sessionStore,
        signal: new AbortController().signal,
        taskId: ctx.taskId,
        logger: silentLogger,
        hooks,
        config: { server: { contextLimit: 0, defaultMaxTokens: 8192 } } as EngineConfig,
    });
}

const textResult = (s: string) => [{ type: "text", text: s }];
const RESULT_TEXT = "héllo wörld"; // multi-byte on purpose: bytes != characters

function collectResponses(hooks: HookRegistry): PostModelResponsePayload[] {
    const out: PostModelResponsePayload[] = [];
    hooks.register("post:model_response", (p) => {
        out.push(p);
    });
    return out;
}

const ECHO_WITH_THINKING = {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    blocks: [
        { type: "thinking", thinking: "SENTINEL-THINKING", signature: "SENTINEL-SIG" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "" },
        { type: "tool_use", id: "c1", name: "fs__read_text_file", input: {} },
    ],
} as unknown as ProviderChatResponse["echo"];

describe("R10 S5b AC1: post:model_response is populated from real data, per provider family", () => {
    it("R10 S5b AC1 [anthropic]: turnIndex 0 then 1, thinkingConfig = configured type, thinkingBlocks counted from the response, toolResultBytesIn = the model-visible tool-result bytes", async () => {
        const hooks = new HookRegistry();
        const responses = collectResponses(hooks);
        await drive(ctxFor("anthropic"), twoTurnProvider([{ id: "c1", server: "fs", tool: "read_text_file" }], ECHO_WITH_THINKING), async () => textResult(RESULT_TEXT), hooks);
        expect(responses).toHaveLength(2);
        expect(responses.map((r) => r.turnIndex)).toEqual([0, 1]);
        expect(responses.map((r) => r.thinkingConfig)).toEqual(["adaptive", "adaptive"]);
        // turn 1's response held two thinking-class blocks; turn 2's held none (a true 0 for Anthropic).
        expect(responses.map((r) => r.thinkingBlocks)).toEqual([2, 0]);
        // turn 1 carried no tool result yet; turn 2 carried the one result, as the adapter sends it (UTF-8 bytes).
        expect(responses.map((r) => r.toolResultBytesIn)).toEqual([0, Buffer.byteLength(RESULT_TEXT)]);
        expect(Buffer.byteLength(RESULT_TEXT)).toBeGreaterThan(RESULT_TEXT.length);
    });

    it("R10 S5b AC1 [anthropic]: a request that sends no thinking field reports thinkingConfig 'none'", async () => {
        const ctx = ctxFor("anthropic");
        delete (ctx.agentDefinition.provider as { thinking?: unknown }).thinking;
        const hooks = new HookRegistry();
        const responses = collectResponses(hooks);
        await drive(ctx, twoTurnProvider([{ id: "c1", server: "fs", tool: "read_text_file" }]), async () => textResult("x"), hooks);
        expect(responses.map((r) => r.thinkingConfig)).toEqual(["none", "none"]);
        expect(responses.map((r) => r.thinkingBlocks)).toEqual([0, 0]);
    });

    it("R10 S5b AC1 [openai/deepseek]: turnIndex and toolResultBytesIn only; thinkingConfig / thinkingBlocks are ABSENT (never 0), even if the response carried an echo", async () => {
        const hooks = new HookRegistry();
        const responses = collectResponses(hooks);
        const callTool = async () => [textResult("a"), { type: "image", mimeType: "image/png", data: "QUJD" }].flat();
        await drive(ctxFor("openai"), twoTurnProvider([{ id: "c1", server: "fs", tool: "read_text_file" }], ECHO_WITH_THINKING), callTool, hooks);
        expect(responses.map((r) => r.turnIndex)).toEqual([0, 1]);
        // the OpenAI adapter sends a mixed MCP array as raw text + the non-text block's JSON, one per line
        expect(responses.map((r) => r.toolResultBytesIn)).toEqual([0, Buffer.byteLength(toOpenAIToolContent(await callTool()))]);
        for (const r of responses) {
            expect("thinkingConfig" in r).toBe(false);
            expect("thinkingBlocks" in r).toBe(false);
        }
    });

    it("R10 S5b AC1 [claudecli]: turnIndex only; thinkingConfig / thinkingBlocks / toolResultBytesIn are absent (the CLI owns its history)", async () => {
        const hooks = new HookRegistry();
        const responses = collectResponses(hooks);
        await drive(ctxFor("claudecli"), twoTurnProvider([{ id: "c1", server: "fs", tool: "read_text_file" }]), async () => textResult("x"), hooks);
        expect(responses.map((r) => r.turnIndex)).toEqual([0, 1]);
        for (const r of responses) {
            expect(["thinkingConfig", "thinkingBlocks", "toolResultBytesIn"].filter((k) => k in r)).toEqual([]);
        }
    });

    it("R10 S5b AC1: the failed-call emission (provider threw after spending tokens) carries the request-side signals too", async () => {
        const { attachPartialUsage } = await import("../providers/partial-usage.js");
        const hooks = new HookRegistry();
        const responses = collectResponses(hooks);
        let turn = 0;
        const provider: LLMProvider = {
            chat: async (req: ProviderChatRequest) => {
                turn++;
                if (turn === 1) return twoTurnProvider([{ id: "c1", server: "fs", tool: "read_text_file" }]).chat(req);
                throw attachPartialUsage(new Error("boom"), { usage: { inputTokens: 5, outputTokens: 1 } });
            },
        };
        await expect(drive(ctxFor("openai"), provider, async () => textResult(RESULT_TEXT), hooks)).rejects.toBeDefined();
        const failed = responses.find((r) => r.stopReason === "error");
        expect(failed).toMatchObject({ turnIndex: 1, toolResultBytesIn: Buffer.byteLength(RESULT_TEXT) });
        expect("thinkingBlocks" in (failed ?? {})).toBe(false);
    });

    it("R10 S5b AC1: ttfbMs is forwarded only when the adapter measured it (absent for a response without one, never 0)", async () => {
        const hooks = new HookRegistry();
        const responses = collectResponses(hooks);
        await drive(ctxFor("openai"), twoTurnProvider([{ id: "c1", server: "fs", tool: "read_text_file" }]), async () => textResult("x"), hooks);
        for (const r of responses) expect("ttfbMs" in r).toBe(false);
    });
});

describe("R10 S5b AC2: task:startup is a typed payload; unmeasured figures are absent", () => {
    it("R10 S5b AC2: the emitted payload has no queueWaitMs / sessionMs keys and satisfies TaskStartupPayload without a cast", async () => {
        const hooks = new HookRegistry();
        const seen: TaskStartupPayload[] = [];
        hooks.register("task:startup", (p) => {
            seen.push(p);
        });
        await drive(ctxFor("openai"), twoTurnProvider([]), async () => textResult("x"), hooks);
        expect(seen).toHaveLength(1);
        const [p] = seen;
        expect(p).toMatchObject({ mcpConnectMs: { fs: 3 }, toolsReadyMs: 5 });
        expect(typeof p?.toolCount).toBe("number");
        expect(["queueWaitMs", "sessionMs"].filter((k) => k in (p ?? {}))).toEqual([]);
        // The contract: both figures are optional, so this literal type-checks (typecheck-spec) with no cast.
        const contract: TaskStartupPayload = { executionContext: ctxFor("openai"), mcpConnectMs: {}, toolsReadyMs: 1, toolCount: 0 };
        expect(contract.queueWaitMs).toBeUndefined();
    });
});

describe("R10 S5b AC3: every tool call runs under its own call-id scope", () => {
    it("R10 S5b AC3: two concurrent calls on one parent each observe THEIR OWN id (both are in flight together; a heuristic could not tell them apart)", async () => {
        const ctx = ctxFor("openai");
        const bothInFlight = latch();
        let inFlight = 0;
        const observed: Array<{ prompt: string; id: string | undefined }> = [];
        const callTool = async (_s: string, _t: string, args: unknown) => {
            if (++inFlight === 2) bothInFlight.resolve();
            await bothInFlight.promise; // neither returns until BOTH are running
            observed.push({ prompt: (args as { prompt: string }).prompt, id: currentToolCallId(ctx.taskId) });
            return textResult("ok");
        };
        await drive(
            ctx,
            twoTurnProvider([
                { id: "call-A", server: "agent-mcp", tool: "task", args: { prompt: "A" } },
                { id: "call-B", server: "agent-mcp", tool: "task", args: { prompt: "B" } },
            ]),
            callTool
        );
        expect(Object.fromEntries(observed.map((o) => [o.prompt, o.id]))).toEqual({ A: "call-A", B: "call-B" });
    });

    it("R10 S5b AC3: claudecli-bridged concurrent calls are scoped to their bridge-N ids, the same ids their pre:tool_call carries", async () => {
        const ctx = ctxFor("claudecli");
        const hooks = new HookRegistry();
        const pre: string[] = [];
        hooks.register("pre:tool_call", (p) => {
            pre.push(p.callId);
        });
        const bothInFlight = latch();
        let inFlight = 0;
        const observed: Array<{ prompt: string; id: string | undefined }> = [];
        const callTool = async (_s: string, _t: string, args: unknown) => {
            if (++inFlight === 2) bothInFlight.resolve();
            await bothInFlight.promise;
            observed.push({ prompt: (args as { prompt: string }).prompt, id: currentToolCallId(ctx.taskId) });
            return textResult("ok");
        };
        const provider: LLMProvider = {
            chat: async (req: ProviderChatRequest) => {
                await Promise.all([
                    req.executeTool!("agent-mcp", "task", { prompt: "A" }),
                    req.executeTool!("agent-mcp", "task", { prompt: "B" }),
                ]);
                return { message: { id: generateId(), sessionId: "s", role: "assistant", content: "done", createdAt: nowIso() }, stopReason: "completed" } as ProviderChatResponse;
            },
        };
        await drive(ctx, provider, callTool, hooks);
        const byPrompt = Object.fromEntries(observed.map((o) => [o.prompt, o.id]));
        expect(new Set(Object.values(byPrompt))).toEqual(new Set(["bridge-1", "bridge-2"]));
        expect([...pre].sort()).toEqual(["bridge-1", "bridge-2"]);
    });

    it("R10 S5b AC3: the scope is per task - another task's id, or no scope at all (a direct REST call), yields no id", async () => {
        expect(currentToolCallId("t1")).toBeUndefined();
        await runInToolCallScope("t1", "call-x", async () => {
            expect(currentToolCallId("t1")).toBe("call-x");
            expect(currentToolCallId("someone-else")).toBeUndefined();
        });
        expect(currentToolCallId("t1")).toBeUndefined();
    });
});

describe("R10 S5b AC4: a result wait emits a dispatch-class event with wait_ms", () => {
    const parent = { taskId: "parent-1", sessionId: "s", agentName: "p", agentDefinition: {}, recursionDepth: 0, toolCallCount: 0 } as unknown as ExecutionContext;
    const deps = (status: () => string) => ({
        taskStore: { read: () => ({ id: "child-1", status: status(), prompt: "p", recursionDepth: 1 }) },
        db: undefined,
    });

    it("R10 S5b AC4: a wait that outlasts its first poll emits kind 'result', mode 'sync', the child id, waitMs > 0 and the engine tool-call id", async () => {
        const hooks = new HookRegistry();
        const events: DispatchCompletedPayload[] = [];
        hooks.register("dispatch:completed", (p) => {
            events.push(p);
        });
        let reads = 0;
        const clock = { t: 0 };
        await runInToolCallScope(parent.taskId, "call-r", () =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            resultToolWait({ task_id: "child-1", wait_ms: 1000 } as any, { ...(deps(() => (++reads < 3 ? "running" : "completed")) as any), hooks, callerContext: parent }, async (ms) => { clock.t += ms; await new Promise<void>((r) => setImmediate(r)); }, () => clock.t).catch(() => undefined)
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: "result", mode: "sync", childTaskIds: ["child-1"], toolCallId: "call-r" });
        expect(events[0]?.executionContext).toBe(parent);
        expect(events[0]?.waitMs).toBeGreaterThan(0);
    });

    it("R10 S5b AC4: no wait (wait_ms unset) or no wired hooks emits nothing", async () => {
        const hooks = new HookRegistry();
        const events: DispatchCompletedPayload[] = [];
        hooks.register("dispatch:completed", (p) => {
            events.push(p);
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = deps(() => "completed") as any;
        await resultToolWait({ task_id: "child-1" } as never, { ...d, hooks, callerContext: parent }).catch(() => undefined);
        await resultToolWait({ task_id: "child-1", wait_ms: 100 } as never, d).catch(() => undefined);
        expect(events).toEqual([]);
    });
});
