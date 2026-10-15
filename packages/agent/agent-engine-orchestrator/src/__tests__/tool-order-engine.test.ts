/**
 * R10 S2 / S3: same-turn tool-call ordering and the trace signals, through the REAL engine
 * `Orchestrator.run` with the real `HookRegistry`. Only the LLM provider and the MCP client
 * boundary are stubbed (an in-memory "fs"). Latches, never sleeps.
 *
 *  - R10 S2 AC1: [edit, read] in one turn: the read observes the edit; [create_directory, write]
 *    into the new directory succeeds.
 *  - R10 S2 AC2: two reads and a delegation call overlap; a delegation call neither waits for nor
 *    holds up a write.
 *  - R10 S2 AC3: results are returned in call order; a failed barrier still leaves every later call
 *    with a paired, executed result.
 *  - R10 S2 AC6: the new `pre:tool_call` / `post:tool_call` fields for a mixed turn.
 *  - R10 S3 AC4: `task:startup` is emitted once per task, with the timing fields, before the
 *    first model call.
 *
 * guards: through the real engine a read in the same turn does not observe the edit before it, a delegation call serialises with writes, a failed barrier orphans later calls, the pre:tool_call and post:tool_call trace fields are wrong, or task:startup is not emitted exactly once before the first model call.
 * tier: S
 * cites: R10 S2 AC1, AC2, AC3, AC6; R10 S3 AC4 (every test title carries its AC); variance hardening cites qa-variance (dispatch-1014).
 * red: pending (qa-variance edit made without running tests, per user). qa-variance: the fixed 50-turn
 * `setImmediate` loop is replaced by `settleUntilStable` (state-probe quiescence, no clock); each negative
 * assertion is still taken only after the probed state is unchanged across consecutive turns.
 */
import { HookRegistry } from "@adhd/agent-base-types";
import type { PostToolCallPayload, PreToolCallPayload, TaskStartupPayload } from "@adhd/agent-base-types";
import { describe, expect, it } from "vitest";

import type { McpClientRegistry } from "../clients/registry.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { PolicyEngine } from "../engine/policy.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { LLMProvider, ProviderChatResponse, ToolDefinition } from "../providers/types.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { ToolError } from "../validation/errors.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import { settleUntilStable } from "./fixtures/settle.js";

const policy = { check: () => {} } as unknown as PolicyEngine;
const silentLogger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;
const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };

const schema = { type: "object", properties: {} };
const FS_TOOLS: ToolDefinition[] = [
    { name: "fs__read_text_file", description: "read", inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: "fs__edit_file", description: "edit", inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: "fs__write_file", description: "write", inputSchema: schema, annotations: { readOnlyHint: false } },
    { name: "fs__create_directory", description: "mkdir", inputSchema: schema, annotations: { readOnlyHint: false } },
    {
        name: "fs__run_array",
        description: "needs an array",
        inputSchema: { type: "object", properties: { command: { type: "array", items: { type: "string" } } } },
        annotations: { readOnlyHint: true },
    },
    { name: "agent-mcp__task", description: "delegate", inputSchema: schema },
];

function makeCtx(): ExecutionContext {
    return {
        taskId: generateId(),
        sessionId: generateId(),
        agentName: "test-agent",
        agentDefinition: {
            name: "test-agent",
            version: 1,
            provider: { type: "openai", model: "gpt-4o-mini" },
            systemPrompt: "x",
            mcpServers: {},
            permissions: {},
            createdAt: nowIso(),
            updatedAt: nowIso(),
        } as ExecutionContext["agentDefinition"],
        recursionDepth: 0,
        toolCallCount: 0,
    };
}

function latch() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

interface ICallSpec {
    id: string;
    server: string;
    tool: string;
    args?: unknown;
}

/** Turn 1 emits `calls`; turn 2 (optional) emits `second`; then a completed turn. */
function scriptedProvider(turns: ICallSpec[][]) {
    let call = 0;
    const toolMessages: Array<{ id: string; content: unknown; isError?: boolean }> = [];
    const chatOrder: string[] = [];
    const provider = {
        chat: async (req: { messages?: Array<Record<string, unknown>> }): Promise<ProviderChatResponse> => {
            chatOrder.push(`chat${call}`);
            const sessionId = generateId();
            if (call >= turns.length) {
                toolMessages.length = 0;
                for (const m of req.messages ?? []) {
                    if (m["role"] !== "tool") continue;
                    for (const r of (m["toolResults"] as Array<{ toolCallId: string; result: unknown; isError?: boolean }>) ?? []) {
                        toolMessages.push({ id: r.toolCallId, content: r.result, isError: r.isError });
                    }
                }
                call++;
                return { message: { id: generateId(), sessionId, role: "assistant", content: "done", createdAt: nowIso() }, stopReason: "completed" };
            }
            const specs = turns[call++];
            return {
                message: {
                    id: generateId(),
                    sessionId,
                    role: "assistant",
                    content: "",
                    toolCalls: specs.map((c) => ({ id: c.id, server: c.server, tool: c.tool, arguments: c.args ?? {} })),
                    createdAt: nowIso(),
                },
                stopReason: "tool_calls",
            };
        },
    } as unknown as LLMProvider;
    return { provider, toolMessages, chatOrder };
}

interface IRunOpts {
    turns: ICallSpec[][];
    callTool: (server: string, tool: string, args: unknown) => Promise<unknown>;
    tools?: ToolDefinition[];
    /** Provide `registry.toolClass` too (the production registry has it). */
    registryToolClass?: boolean;
    startupTimings?: { connectMs: Record<string, number>; toolsReadyMs: number } | null;
    config?: Partial<EngineConfig>;
    hooks?: HookRegistry;
}

async function run(opts: IRunOpts) {
    const ctx = makeCtx();
    const { provider, toolMessages, chatOrder } = scriptedProvider(opts.turns);
    const advertised = opts.tools ?? FS_TOOLS;
    const registry: Record<string, unknown> = {
        listAllTools: async () => advertised.map((t) => ({ ...t })),
        closeAll: async () => {},
        getClient: async (server: string) => ({
            callTool: async (tool: string, args: unknown) => opts.callTool(server, tool, args),
        }),
    };
    if (opts.registryToolClass) {
        registry["toolClass"] = (server: string, tool: string) =>
            advertised.find((t) => t.name === `${server}__${tool}`)?.annotations?.readOnlyHint === false ? "barrier" : "safe";
    }
    if (opts.startupTimings !== null) {
        registry["startupTimings"] = () => opts.startupTimings ?? { connectMs: { fs: 12, shell: 7 }, toolsReadyMs: 15 };
    }
    const user: Message = { id: generateId(), sessionId: ctx.sessionId, role: "user", content: "go", createdAt: nowIso() };
    const out = await new Orchestrator().run({
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
        hooks: opts.hooks,
        config: { server: { contextLimit: 0, defaultMaxTokens: 8192 }, ...opts.config } as EngineConfig,
    });
    return { result: out.result, toolMessages, chatOrder };
}

const text = (s: string) => [{ type: "text", text: s }];

describe("R10 S2 AC1: the read observes the edit (real engine)", () => {
    for (const withRegistryClass of [false, true]) {
        const via = withRegistryClass ? "registry.toolClass" : "advertised annotations";
        it(`R10 S2 AC1: [edit_file, read_text_file] in one turn: the read starts after the edit settles and returns the new text (${via})`, async () => {
            const files = new Map<string, string>([["a.txt", "OLD"]]);
            const editGate = latch();
            const editStarted = latch();
            const order: string[] = [];
            const running = run({
                registryToolClass: withRegistryClass,
                turns: [
                    [
                        { id: "e", server: "fs", tool: "edit_file", args: { path: "a.txt", text: "NEW" } },
                        { id: "r", server: "fs", tool: "read_text_file", args: { path: "a.txt" } },
                    ],
                ],
                callTool: async (_s, tool, args) => {
                    const a = args as { path: string; text?: string };
                    order.push(`${tool}:start`);
                    if (tool === "edit_file") {
                        editStarted.resolve();
                        await editGate.promise; // the edit takes a while to land
                        files.set(a.path, a.text!);
                        order.push("edit_file:landed");
                        return text("edited");
                    }
                    return text(files.get(a.path) ?? "");
                },
            });
            await editStarted.promise;
            await settleUntilStable(() => order);
            expect(order).toEqual(["edit_file:start"]); // the read has NOT started: it waits for the barrier
            editGate.resolve();
            const { toolMessages } = await running;
            expect(order).toEqual(["edit_file:start", "edit_file:landed", "read_text_file:start"]);
            expect(JSON.stringify(toolMessages.find((m) => m.id === "r")!.content)).toContain("NEW");
            expect(JSON.stringify(toolMessages.find((m) => m.id === "r")!.content)).not.toContain("OLD");
        });
    }

    it("R10 S2 AC1: [create_directory, write_file into the new directory] in one turn succeeds", async () => {
        const dirs = new Set<string>();
        const written: string[] = [];
        const { toolMessages } = await run({
            turns: [
                [
                    { id: "m", server: "fs", tool: "create_directory", args: { path: "out" } },
                    { id: "w", server: "fs", tool: "write_file", args: { path: "out/x.txt" } },
                ],
            ],
            callTool: async (_s, tool, args) => {
                const a = args as { path: string };
                if (tool === "create_directory") {
                    await Promise.resolve();
                    dirs.add(a.path);
                    return text("created");
                }
                if (!dirs.has(a.path.split("/")[0])) throw new Error("ENOENT: parent directory missing");
                written.push(a.path);
                return text("wrote");
            },
        });
        expect(written).toEqual(["out/x.txt"]);
        expect(toolMessages.map((m) => m.isError ?? false)).toEqual([false, false]);
    });
});

describe("R10 S2 AC2: reads and delegation stay parallel (real engine)", () => {
    it("R10 S2 AC2: two reads and a delegation call are all in flight before any settles", async () => {
        const started: string[] = [];
        const release = latch();
        const allStarted = latch();
        const running = run({
            turns: [
                [
                    { id: "r1", server: "fs", tool: "read_text_file" },
                    { id: "t", server: "agent-mcp", tool: "task" },
                    { id: "r2", server: "fs", tool: "read_text_file" },
                ],
            ],
            callTool: async (s, t) => {
                started.push(`${s}__${t}`);
                if (started.length === 3) allStarted.resolve();
                await release.promise;
                return text("ok");
            },
        });
        await allStarted.promise; // would hang (test timeout) if any of the three were gated
        expect(started.slice().sort()).toEqual(["agent-mcp__task", "fs__read_text_file", "fs__read_text_file"]);
        release.resolve();
        expect((await running).result).toBe("done");
    });

    it("R10 S2 AC2: a long-running delegation call neither waits for a write nor holds up the next one", async () => {
        const started: string[] = [];
        const taskGate = latch();
        const editGate = latch();
        const taskStarted = latch();
        const running = run({
            turns: [
                [
                    { id: "e1", server: "fs", tool: "edit_file" },
                    { id: "t", server: "agent-mcp", tool: "task" },
                    { id: "e2", server: "fs", tool: "write_file" },
                ],
            ],
            callTool: async (s, t) => {
                started.push(`${s}__${t}`);
                if (t === "task") {
                    taskStarted.resolve();
                    await taskGate.promise;
                } else if (t === "edit_file") {
                    await editGate.promise;
                }
                return text("ok");
            },
        });
        await taskStarted.promise;
        await settleUntilStable(() => started);
        expect(started).toEqual(["fs__edit_file", "agent-mcp__task"]); // the task started beside the first edit
        editGate.resolve();
        await settleUntilStable(() => started);
        expect(started).toEqual(["fs__edit_file", "agent-mcp__task", "fs__write_file"]); // second write did not wait for the task
        taskGate.resolve();
        expect((await running).result).toBe("done");
    });
});

describe("R10 S2 AC3: results in call order; a failed barrier orphans nothing (real engine)", () => {
    it("R10 S2 AC3: [write fails, read, write] — every call has its own executed, paired result, in call order", async () => {
        const executed: string[] = [];
        const { toolMessages, result } = await run({
            turns: [
                [
                    { id: "w1", server: "fs", tool: "write_file" },
                    { id: "r", server: "fs", tool: "read_text_file" },
                    { id: "w2", server: "fs", tool: "edit_file" },
                ],
            ],
            callTool: async (_s, tool) => {
                executed.push(tool);
                if (tool === "write_file") throw new Error("EACCES: permission denied");
                return text(`ok:${tool}`);
            },
        });
        expect(result).toBe("done");
        expect(executed).toEqual(["write_file", "read_text_file", "edit_file"]); // later calls still ran, in order
        expect(toolMessages.map((m) => m.id)).toEqual(["w1", "r", "w2"]); // one paired result per tool_use, call order
        expect(toolMessages.map((m) => m.isError ?? false)).toEqual([true, false, false]);
        expect(JSON.stringify(toolMessages[0].content)).toContain("EACCES");
        expect(JSON.stringify(toolMessages[1].content)).toContain("ok:read_text_file");
    });

    it("R10 S2 AC3: results keep call order when the calls settle in the opposite order", async () => {
        const gates = { a: latch(), b: latch(), t: latch() };
        const allStarted = latch();
        let n = 0;
        const running = run({
            turns: [
                [
                    { id: "a", server: "fs", tool: "read_text_file", args: { k: "a" } },
                    { id: "b", server: "fs", tool: "read_text_file", args: { k: "b" } },
                    { id: "t", server: "agent-mcp", tool: "task", args: { k: "t" } },
                ],
            ],
            callTool: async (_s, _t, args) => {
                const k = (args as { k: "a" | "b" | "t" }).k;
                if (++n === 3) allStarted.resolve();
                await gates[k].promise;
                return text(`res-${k}`);
            },
        });
        await allStarted.promise;
        gates.t.resolve();
        gates.b.resolve();
        gates.a.resolve();
        const { toolMessages } = await running;
        expect(toolMessages.map((m) => m.id)).toEqual(["a", "b", "t"]);
        expect(toolMessages.map((m) => JSON.stringify(m.content))).toEqual([
            expect.stringContaining("res-a"),
            expect.stringContaining("res-b"),
            expect.stringContaining("res-t"),
        ]);
    });
});

describe("R10 S2 AC6: trace fields on pre:tool_call / post:tool_call (real engine)", () => {
    function recordingHooks() {
        const hooks = new HookRegistry();
        const pre: PreToolCallPayload[] = [];
        const post: PostToolCallPayload[] = [];
        hooks.register("pre:tool_call", (p) => {
            pre.push(p);
        });
        hooks.register("post:tool_call", (p) => {
            post.push(p);
        });
        return { hooks, pre, post };
    }

    it("R10 S2 AC6: a mixed turn carries concurrencyClass, turnIndex, groupIndex and queuedMs on pre, errorClass and resultBytes on post", async () => {
        const { hooks, pre, post } = recordingHooks();
        await run({
            hooks,
            turns: [
                [
                    { id: "ra", server: "fs", tool: "read_text_file" },
                    { id: "rb", server: "fs", tool: "read_text_file" },
                    { id: "w", server: "fs", tool: "edit_file" },
                    { id: "t", server: "agent-mcp", tool: "task" },
                    { id: "rc", server: "fs", tool: "read_text_file" },
                ],
                [{ id: "r2", server: "fs", tool: "read_text_file" }],
            ],
            callTool: async (_s, tool) => text(tool === "edit_file" ? "ok" : "héllo"), // é is 2 bytes in UTF-8
        });
        const p = (id: string) => pre.find((x) => x.callId === id)!;
        expect(pre.map((x) => x.callId)).toEqual(["ra", "rb", "w", "t", "rc", "r2"]);
        expect(["ra", "rb", "w", "t", "rc", "r2"].map((id) => p(id).concurrencyClass)).toEqual([
            "safe",
            "safe",
            "barrier",
            "unordered",
            "safe",
            "safe",
        ]);
        expect(["ra", "rb", "w", "t", "rc", "r2"].map((id) => p(id).turnIndex)).toEqual([0, 0, 0, 0, 0, 1]);
        // reads share group 0, the edit is group 1, the task sits beside the edit, the read after the edit is group 2.
        expect(["ra", "rb", "w", "t", "rc", "r2"].map((id) => p(id).groupIndex)).toEqual([0, 0, 1, 1, 2, 0]);
        for (const x of pre) {
            expect(Number.isInteger(x.queuedMs)).toBe(true);
            expect(x.queuedMs).toBeGreaterThanOrEqual(0);
        }
        const q = post.find((x) => x.callId === "ra")!;
        expect(q.errorClass).toBe("none");
        expect(q.resultBytes).toBe(Buffer.byteLength("héllo", "utf8")); // text bytes, not the JSON encoding
        expect(post.find((x) => x.callId === "w")!.resultBytes).toBe(2);
        expect(post.every((x) => x.noteAppended === undefined)).toBe(true); // notes are a later hook's business
    });

    it("R10 S2 AC6: queuedMs shows the barrier wait on the retained pre payload (completed when the call starts)", async () => {
        const { hooks, pre } = recordingHooks();
        const gate = latch();
        const editStarted = latch();
        const running = run({
            hooks,
            turns: [
                [
                    { id: "w", server: "fs", tool: "edit_file" },
                    { id: "r", server: "fs", tool: "read_text_file" },
                ],
            ],
            callTool: async (_s, tool) => {
                if (tool === "edit_file") {
                    editStarted.resolve();
                    await gate.promise;
                }
                return text("ok");
            },
        });
        await editStarted.promise;
        await settleUntilStable(() => pre.map((x) => [x.callId, x.queuedMs]));
        const read = pre.find((x) => x.callId === "r")!;
        expect(read.concurrencyClass).toBe("safe");
        expect(read.queuedMs).toBeUndefined(); // still waiting for the barrier: not started
        gate.resolve();
        await running;
        expect(Number.isInteger(read.queuedMs)).toBe(true);
        expect(read.groupIndex).toBe(1);
    });

    it("R10 S2 AC6: the final groupIndex reflects the calls that actually ran when an earlier call was refused", async () => {
        const { hooks, pre } = recordingHooks();
        await run({
            hooks,
            config: { permissionGate: ({ tool }: { tool: string }) => (tool === "write_file" ? "deny" : "allow") } as Partial<EngineConfig>,
            turns: [
                [
                    { id: "r1", server: "fs", tool: "read_text_file" },
                    { id: "denied", server: "fs", tool: "write_file" },
                    { id: "r2", server: "fs", tool: "read_text_file" },
                ],
            ],
            callTool: async () => text("ok"),
        });
        const g = (id: string) => pre.find((x) => x.callId === id)!.groupIndex;
        // Planned over all three calls: r1=0, denied=1, r2=2. The denied write never ran, so the two reads
        // ran in ONE group: the retained payload says so.
        expect([g("r1"), g("r2")]).toEqual([0, 0]);
        expect(pre.map((x) => x.callId)).toEqual(["r1", "r2"]); // a call refused by the permission gate fires no pre:tool_call
    });

    it("R10 S2 AC6: errorClass for a tool error, a policy refusal, a shell policy rejection, an argument mismatch and a coerced argument", async () => {
        const { hooks, post } = recordingHooks();
        await run({
            hooks,
            turns: [
                [
                    { id: "err", server: "fs", tool: "read_text_file", args: { mode: "err" } },
                    { id: "deny", server: "fs", tool: "read_text_file", args: { mode: "deny" } },
                    { id: "shell", server: "fs", tool: "read_text_file", args: { mode: "shell" } },
                    { id: "mismatch", server: "fs", tool: "run_array", args: { command: "cat /etc/hosts" } },
                    { id: "coerced", server: "fs", tool: "run_array", args: { command: '["ls","-l"]' } },
                ],
            ],
            callTool: async (_s, _t, args) => {
                const a = args as { mode?: string };
                if (a.mode === "err") throw new Error("disk on fire");
                if (a.mode === "deny") throw new ToolError("MCP_CLIENT_ERROR", "Command not allowed: rm");
                if (a.mode === "shell") {
                    throw new ToolError("MCP_CLIENT_ERROR", "Tool 'shell_execute' returned an error: Command rejected by default security policy: node");
                }
                return text("fine");
            },
        });
        const cls = Object.fromEntries(post.map((x) => [x.callId, x.errorClass]));
        expect(cls).toEqual({
            err: "tool_error",
            deny: "policy_rejected",
            shell: "policy_rejected",
            mismatch: "arg_mismatch",
            coerced: "arg_coerced",
        });
    });
});

describe("R10 S3 AC4: task:startup", () => {
    function startupHooks() {
        const hooks = new HookRegistry();
        const events: TaskStartupPayload[] = [];
        const order: string[] = [];
        hooks.register("task:startup", (p) => {
            events.push(p);
            order.push("task:startup");
        });
        return { hooks, events, order };
    }

    it("R10 S3 AC4: emitted exactly once per task (not per turn), before the first model call, with the registry's timings and the advertised tool count", async () => {
        const { hooks, events } = startupHooks();
        const { chatOrder } = await run({
            hooks,
            turns: [
                [{ id: "a", server: "fs", tool: "read_text_file" }],
                [{ id: "b", server: "fs", tool: "read_text_file" }],
            ],
            callTool: async () => text("ok"),
        });
        expect(chatOrder).toEqual(["chat0", "chat1", "chat2"]); // three model calls...
        expect(events).toHaveLength(1); // ...one startup event
        const e = events[0];
        expect(e.mcpConnectMs).toEqual({ fs: 12, shell: 7 });
        expect(e.toolsReadyMs).toBe(15);
        expect(e.toolCount).toBe(FS_TOOLS.length + 1); // + the engine's request_human_input tool (HITL on by default)
        expect(e.executionContext.agentName).toBe("test-agent");
        // queueWaitMs and sessionMs are not computable inside the engine: omitted, never guessed.
        expect(Object.keys(e)).not.toContain("queueWaitMs");
        expect(Object.keys(e)).not.toContain("sessionMs");
    });

    it("R10 S3 AC4: fires before the first model call", async () => {
        const hooks = new HookRegistry();
        const seen: string[] = [];
        hooks.register("task:startup", () => {
            seen.push("startup");
        });
        const { provider } = scriptedProvider([]);
        const origChat = provider.chat.bind(provider);
        provider.chat = (async (...args: Parameters<typeof provider.chat>) => {
            seen.push("chat");
            return origChat(...args);
        }) as typeof provider.chat;
        const ctx = makeCtx();
        await new Orchestrator().run({
            executionContext: ctx,
            messages: [{ id: generateId(), sessionId: ctx.sessionId, role: "user", content: "go", createdAt: nowIso() }],
            registry: { listAllTools: async () => [], closeAll: async () => {}, startupTimings: () => ({ connectMs: {}, toolsReadyMs: 0 }) } as unknown as McpClientRegistry,
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
        expect(seen.slice(0, 2)).toEqual(["startup", "chat"]);
    });

    it("R10 S3 AC4: a registry without startupTimings still yields a measured toolsReadyMs and an empty per-server record", async () => {
        const { hooks, events } = startupHooks();
        await run({ hooks, startupTimings: null, turns: [], callTool: async () => text("ok") });
        expect(events).toHaveLength(1);
        expect(events[0].mcpConnectMs).toEqual({});
        expect(Number.isInteger(events[0].toolsReadyMs)).toBe(true);
        expect(events[0].toolsReadyMs).toBeGreaterThanOrEqual(0);
    });

    it("R10 S3 AC4: a throwing task:startup handler never fails the task", async () => {
        const hooks = new HookRegistry();
        hooks.register("task:startup", () => {
            throw new Error("exporter down");
        });
        const { result } = await run({ hooks, turns: [], callTool: async () => text("ok") });
        expect(result).toBe("done");
    });
});
