/**
 * R10 S2: the same-turn ordering lives in the ENGINE, so it must hold unchanged for every
 * provider's wire shape. The REAL `Orchestrator.run` loop is driven with the REAL
 * `AnthropicProvider` (tool_use / tool_result blocks) and the REAL `OpenAIProvider` (the shape
 * DeepSeek also uses: `tool_calls` in one assistant message, `role: "tool"` replies keyed by
 * `tool_call_id`) against a scripted `wire.fetch` seam: no socket, no real model call.
 *
 *  - R10 S2 AC1 [anthropic|openai]: [edit, read] in one assistant message: the read observes the edit.
 *  - R10 S2 AC3 [anthropic|openai]: a failed barrier leaves every later tool call with exactly one
 *    paired result (same tool_call_id / tool_use_id), in call order, on the wire of the next request.
 *  - R10 S2 AC5 [anthropic|openai]: the whole first request body (tools array, hence any hash or cache key
 *    derived from it) is byte-equal with and without annotations and never contains an annotation key.
 *  - R10 S2 AC6 [anthropic|openai]: the new pre:tool_call / post:tool_call fields for the turn.
 *
 * guards: same-turn ordering holds on the engine but breaks on one provider's wire shape: the read does not see the edit, a failed barrier leaves a tool_use or tool_call without exactly one paired result, trace fields differ, or the request body changes with annotations.
 * tier: S
 * cites: R10 S2 AC1, AC3, AC5, AC6 over the anthropic and openai wires; variance hardening cites qa-variance (dispatch-1014).
 * red: pending (qa-variance edit made without running tests, per user). qa-variance: the fixed 50-turn
 * `setImmediate` loop is replaced by `settleUntilStable` (state-probe quiescence, no clock); each negative
 * assertion is still taken only after the probed state is unchanged across consecutive turns.
 */
import { HookRegistry } from "@adhd/agent-base-types";
import type { PostToolCallPayload, PreToolCallPayload } from "@adhd/agent-base-types";
import { describe, expect, it } from "vitest";

import type { McpClientRegistry } from "../clients/registry.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import type { LLMProvider, ToolDefinition } from "../providers/types.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import { anthropicSseBody } from "./fixtures/anthropic-sse.js";
import { settleUntilStable } from "./fixtures/settle.js";

const logger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;
const policy = { check: () => {} } as unknown as PolicyEngine;
const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };

const schema = { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } };
const TOOLS: ToolDefinition[] = [
    { name: "fs__read_text_file", description: "read", inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: "fs__edit_file", description: "edit", inputSchema: schema, annotations: { readOnlyHint: false } },
    { name: "fs__write_file", description: "write", inputSchema: schema, annotations: { readOnlyHint: false } },
];

interface ICall {
    id: string;
    name: string; // advertised server__tool
    input: Record<string, unknown>;
}
interface IWireResult {
    id: string;
    text: string;
    isError?: boolean;
}

type Adapter = "anthropic" | "openai";

const MODEL = "claude-haiku-5-5";

function latch() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}
const text = (s: string) => [{ type: "text", text: s }];

/** Builds the model's reply (one assistant message carrying all `calls`) in the adapter's wire shape. */
function toolTurnResponse(adapter: Adapter, calls: ICall[]): Response {
    if (adapter === "anthropic") {
        return new Response(
            anthropicSseBody({
                model: MODEL,
                usage: { input_tokens: 10, output_tokens: 5 },
                blocks: calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } }
        );
    }
    return new Response(
        JSON.stringify({
            id: "cmpl-1",
            object: "chat.completion",
            created: 0,
            model: "deepseek-chat",
            choices: [
                {
                    index: 0,
                    finish_reason: "tool_calls",
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })),
                    },
                },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
    );
}

function finalResponse(adapter: Adapter): Response {
    if (adapter === "anthropic") {
        return new Response(anthropicSseBody({ model: MODEL, text: "done", usage: { input_tokens: 10, output_tokens: 5 } }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        });
    }
    return new Response(
        JSON.stringify({
            id: "cmpl-2",
            object: "chat.completion",
            created: 0,
            model: "deepseek-chat",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
    );
}

/** Reads the tool results the provider put on the wire in the follow-up request, in wire order. */
function wireToolResults(adapter: Adapter, body: { messages: Array<Record<string, unknown>> }): IWireResult[] {
    const out: IWireResult[] = [];
    if (adapter === "openai") {
        for (const m of body.messages) {
            if (m["role"] === "tool") out.push({ id: String(m["tool_call_id"]), text: String(m["content"]) });
        }
        return out;
    }
    for (const m of body.messages) {
        if (m["role"] !== "user" || !Array.isArray(m["content"])) continue;
        for (const b of m["content"] as Array<Record<string, unknown>>) {
            if (b["type"] === "tool_result") {
                out.push({ id: String(b["tool_use_id"]), text: JSON.stringify(b["content"]), isError: b["is_error"] === true });
            }
        }
    }
    return out;
}

async function run(adapter: Adapter, calls: ICall[], callTool: (tool: string, args: Record<string, unknown>) => Promise<unknown>, hooks?: HookRegistry, advertised: ToolDefinition[] = TOOLS) {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const fetchSeam: typeof fetch = async (_u, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return bodies.length === 1 ? toolTurnResponse(adapter, calls) : finalResponse(adapter);
    };
    const engineConfig = {
        server: { contextLimit: 0, defaultMaxTokens: 8192 },
        wire: { fetch: fetchSeam, withContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn() },
        getProviderConfig: () =>
            adapter === "anthropic"
                ? { secret: "sk-ant-api-test", model: MODEL }
                : { secret: "sk-test", model: "deepseek-chat", baseURL: "http://localhost:1/v1" },
    } as unknown as EngineConfig;
    const provider: LLMProvider =
        adapter === "anthropic"
            ? new AnthropicProvider({ type: "anthropic", model: MODEL }, engineConfig, logger)
            : new OpenAIProvider({ type: "openai", model: "deepseek-chat" } as never, engineConfig);
    const ctx = {
        taskId: generateId(),
        sessionId: generateId(),
        agentName: "test-agent",
        agentDefinition: {
            name: "test-agent",
            version: 1,
            provider: adapter === "anthropic" ? { type: "anthropic", model: MODEL } : { type: "openai", model: "deepseek-chat" },
            systemPrompt: "x",
            mcpServers: {},
            permissions: {},
            createdAt: nowIso(),
            updatedAt: nowIso(),
        } as unknown as ExecutionContext["agentDefinition"],
        recursionDepth: 0,
        toolCallCount: 0,
    } as ExecutionContext;
    const registry = {
        listAllTools: async () => advertised.map((t) => ({ ...t })),
        closeAll: async () => {},
        getClient: async () => ({ callTool: async (tool: string, args: unknown) => callTool(tool, args as Record<string, unknown>) }),
    } as unknown as McpClientRegistry;
    const user: Message = { id: generateId(), sessionId: ctx.sessionId, role: "user", content: "go", createdAt: nowIso() };
    const out = await new Orchestrator().run({
        executionContext: ctx,
        messages: [user],
        registry,
        provider,
        policy,
        taskStore,
        sessionStore,
        signal: new AbortController().signal,
        taskId: ctx.taskId,
        logger,
        hooks,
        config: engineConfig,
    });
    return { result: out.result, bodies, wire: bodies[1] ? wireToolResults(adapter, bodies[1]) : [] };
}

describe.each(["anthropic", "openai"] as const)("R10 S2 same-turn ordering over the %s wire shape (real engine, real provider)", (adapter) => {
    it(`R10 S2 AC1 [${adapter}]: [edit_file, read_text_file] in one assistant message: the read starts after the edit settles and sees the new text`, async () => {
        const files = new Map([["a.txt", "OLD"]]);
        const gate = latch();
        const editStarted = latch();
        const order: string[] = [];
        const running = run(
            adapter,
            [
                { id: "call_edit", name: "fs__edit_file", input: { path: "a.txt", text: "NEW" } },
                { id: "call_read", name: "fs__read_text_file", input: { path: "a.txt" } },
            ],
            async (tool, args) => {
                order.push(`${tool}:start`);
                if (tool === "edit_file") {
                    editStarted.resolve();
                    await gate.promise;
                    files.set(String(args["path"]), String(args["text"]));
                    order.push("edit_file:landed");
                    return text("edited");
                }
                return text(files.get(String(args["path"])) ?? "");
            }
        );
        await editStarted.promise;
        await settleUntilStable(() => order);
        expect(order).toEqual(["edit_file:start"]); // the read waits for the barrier
        gate.resolve();
        const { wire, result } = await running;
        expect(result).toBe("done");
        expect(order).toEqual(["edit_file:start", "edit_file:landed", "read_text_file:start"]);
        const read = wire.find((r) => r.id === "call_read")!;
        expect(read.text).toContain("NEW");
        expect(read.text).not.toContain("OLD");
    });

    it(`R10 S2 AC3 [${adapter}]: a failed barrier leaves every later call with exactly one paired result, in call order, on the wire`, async () => {
        const executed: string[] = [];
        const { wire, result } = await run(
            adapter,
            [
                { id: "call_1", name: "fs__write_file", input: { path: "x" } },
                { id: "call_2", name: "fs__read_text_file", input: { path: "x" } },
                { id: "call_3", name: "fs__edit_file", input: { path: "x" } },
            ],
            async (tool) => {
                executed.push(tool);
                if (tool === "write_file") throw new Error("EACCES: permission denied");
                return text(`ok:${tool}`);
            }
        );
        expect(result).toBe("done");
        expect(executed).toEqual(["write_file", "read_text_file", "edit_file"]);
        expect(wire.map((r) => r.id)).toEqual(["call_1", "call_2", "call_3"]); // one result per id, call order
        expect(wire[0].text).toContain("EACCES");
        expect(wire[1].text).toContain("ok:read_text_file");
        expect(wire[2].text).toContain("ok:edit_file");
        if (adapter === "anthropic") expect(wire.map((r) => r.isError)).toEqual([true, false, false]);
    });

    it(`R10 S2 AC6 [${adapter}]: the pre:tool_call / post:tool_call fields of the turn`, async () => {
        const hooks = new HookRegistry();
        const pre: PreToolCallPayload[] = [];
        const post: PostToolCallPayload[] = [];
        hooks.register("pre:tool_call", (p) => {
            pre.push(p);
        });
        hooks.register("post:tool_call", (p) => {
            post.push(p);
        });
        await run(
            adapter,
            [
                { id: "c1", name: "fs__read_text_file", input: { path: "a" } },
                { id: "c2", name: "fs__edit_file", input: { path: "a" } },
                { id: "c3", name: "fs__read_text_file", input: { path: "a" } },
            ],
            async () => text("héllo"),
            hooks
        );
        expect(pre.map((p) => [p.callId, p.concurrencyClass, p.turnIndex, p.groupIndex])).toEqual([
            ["c1", "safe", 0, 0],
            ["c2", "barrier", 0, 1],
            ["c3", "safe", 0, 2],
        ]);
        for (const p of pre) expect(Number.isInteger(p.queuedMs)).toBe(true);
        expect(post.map((p) => [p.callId, p.errorClass, p.resultBytes])).toEqual([
            ["c1", "none", Buffer.byteLength("héllo")],
            ["c2", "none", Buffer.byteLength("héllo")],
            ["c3", "none", Buffer.byteLength("héllo")],
        ]);
    });

    it(`R10 S2 AC5 [${adapter}]: the request body is byte-equal with and without annotations and carries no annotation key`, async () => {
        const calls: ICall[] = [{ id: "c1", name: "fs__read_text_file", input: { path: "a" } }];
        const bare = TOOLS.map(({ annotations: _dropped, ...rest }) => rest as ToolDefinition);
        const withAnnotations = await run(adapter, calls, async () => text("ok"), undefined, TOOLS);
        const without = await run(adapter, calls, async () => text("ok"), undefined, bare);
        const body = (r: { bodies: unknown[] }) => JSON.stringify(r.bodies[0]);
        expect(body(withAnnotations)).toBe(body(without));
        expect(body(withAnnotations)).not.toMatch(/annotations|readOnlyHint|destructiveHint|idempotentHint/);
    });
});
