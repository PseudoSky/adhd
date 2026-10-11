/**
 * ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC1 / AC3 / AC4 / AC5 (bucket B2, G3): the claudecli loopback
 * bridge shares the engine's per-task tool-call limiter (`EngineConfig.toolCallConcurrency`).
 *
 * Driven through the REAL `Orchestrator.run`. Only the external boundaries are stubbed: the LLM
 * provider (a stand-in for the `claude` CLI that fires its `tools/call`s through the engine-supplied
 * `executeTool` seam, exactly as the real bridge does) and the MCP client. Latch/barrier proofs, no
 * sleeps.
 *
 *  - AC1: same-message bridged calls never exceed N in flight.
 *  - AC3 (D6): with N=1 a bridged `task` call that spawns a child task completes (no deadlock).
 *  - AC4: a permission-denied bridge call does not hold a slot.
 *  - AC5 (teeth): the AC1 assertion goes red if the bridge acquisition is reverted (see the
 *    negative-control note on the test; verified by reverting `toolLimiter.run` in orchestrator.ts).
 */
import { describe, expect, it } from "vitest";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import type { PolicyEngine } from "../engine/policy.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse, ToolDefinition } from "../providers/types.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";

const policy = { check: () => {} } as unknown as PolicyEngine;
const silentLogger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;
const taskStore: OrchestratorTaskStore = { updateStatus: () => {}, appendEvent: () => {}, unregisterCancellation: () => {} };
const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
const tool = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: "object", properties: {} } });

function makeCtx(): ExecutionContext {
    return {
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
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
}

const done = (): ProviderChatResponse =>
    ({
        message: { id: generateId(), sessionId: generateId(), role: "assistant", content: "done", createdAt: nowIso() },
        stopReason: "completed",
    }) as ProviderChatResponse;

/** A provider standing in for the CLI: `fire(executeTool)` issues its bridged calls. */
function cliProvider(fire: (exec: NonNullable<ProviderChatRequest["executeTool"]>) => Promise<void>): LLMProvider {
    return {
        chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
            await fire(req.executeTool!);
            return done();
        },
    } as unknown as LLMProvider;
}

async function runBridged(opts: {
    provider: LLMProvider;
    callTool: (toolName: string, args: unknown) => Promise<unknown>;
    tools?: ToolDefinition[];
    config?: Partial<EngineConfig>;
}) {
    const ctx = makeCtx();
    const registry = {
        listAllTools: async () => opts.tools ?? [tool("lat__work")],
        closeAll: async () => {},
        getClient: async () => ({ callTool: async (t: string, a: unknown) => opts.callTool(t, a) }),
    } as unknown as McpClientRegistry;
    const user: Message = { id: generateId(), sessionId: ctx.sessionId, role: "user", content: "go", createdAt: nowIso() };
    return new Orchestrator().run({
        executionContext: ctx, messages: [user], registry, provider: opts.provider, policy, taskStore, sessionStore,
        signal: new AbortController().signal, taskId: ctx.taskId, logger: silentLogger,
        config: { server: { contextLimit: 0, defaultMaxTokens: 8192 }, ...opts.config } as EngineConfig,
    });
}

describe("ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC1: bridged calls obey toolCallConcurrency", () => {
    it("ea8f6f92 AC1: 5 same-message bridged calls under limit 2 peak at exactly 2 in flight", async () => {
        let inFlight = 0;
        let peak = 0;
        const started: number[] = [];
        const gates = Array.from({ length: 5 }, () => deferred());
        const run = runBridged({
            config: { toolCallConcurrency: 2 },
            provider: cliProvider(async (exec) => {
                await Promise.all(Array.from({ length: 5 }, (_, i) => exec("lat", "work", { i })));
            }),
            callTool: async (_t, a) => {
                const i = (a as { i: number }).i;
                started.push(i);
                inFlight++;
                peak = Math.max(peak, inFlight);
                await gates[i].promise;
                inFlight--;
                return [{ type: "text", text: `r${i}` }];
            },
        });
        await settle();
        expect(started).toEqual([0, 1]); // calls 2..4 are queued behind the limiter, not started
        gates[0].resolve();
        await settle();
        expect(started).toEqual([0, 1, 2]);
        for (const g of gates) g.resolve();
        expect((await run).result).toBe("done");
        expect(peak).toBe(2);
    });

    it("ea8f6f92 AC1: the default limit (8) still lets 3 bridged calls run together", async () => {
        const started = new Set<number>();
        const release = deferred();
        const all = deferred();
        const run = runBridged({
            provider: cliProvider(async (exec) => {
                await Promise.all([0, 1, 2].map((i) => exec("lat", "work", { i })));
            }),
            callTool: async (_t, a) => {
                started.add((a as { i: number }).i);
                if (started.size === 3) all.resolve();
                await release.promise;
                return [{ type: "text", text: "ok" }];
            },
        });
        await all.promise;
        release.resolve();
        await run;
    });
});

describe("ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC3: no deadlock when a bridged task spawns a child (D6)", () => {
    it("ea8f6f92 AC3: with toolCallConcurrency=1 a bridged `task` call that runs a child task completes", async () => {
        // The child is a separate Orchestrator.run with its OWN per-task limiter, exactly as the
        // real `task` tool's child is; the parent holds the only slot while it runs.
        let childRan = false;
        const childProvider = cliProvider(async (exec) => {
            await exec("lat", "work", { i: 0 }); // the child also uses a bridged call under limit 1
        });
        const run = runBridged({
            config: { toolCallConcurrency: 1 },
            tools: [tool("agent__task"), tool("lat__work")],
            provider: cliProvider(async (exec) => {
                await exec("agent", "task", {});
            }),
            callTool: async (toolName) => {
                if (toolName === "task") {
                    await runBridged({ provider: childProvider, config: { toolCallConcurrency: 1 }, callTool: async () => [{ type: "text", text: "leaf" }] });
                    childRan = true;
                }
                return [{ type: "text", text: "ok" }];
            },
        });
        const deadline = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("deadlock: bridged task+child did not complete")), 10_000));
        expect((await Promise.race([run, deadline])).result).toBe("done");
        expect(childRan).toBe(true);
    });
});

describe("ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC4: refused bridge calls hold no slot", () => {
    it("ea8f6f92 AC4: with limit 1 a permission-denied call returns while another call holds the only slot", async () => {
        const hold = deferred();
        const holding = deferred();
        let deniedReturned = false;
        const run = runBridged({
            config: {
                toolCallConcurrency: 1,
                permissionGate: ({ tool: t }: { tool: string }) => (t === "forbidden" ? "deny" : "allow"),
            } as Partial<EngineConfig>,
            tools: [tool("lat__work"), tool("lat__forbidden")],
            provider: cliProvider(async (exec) => {
                const slow = exec("lat", "work", { i: 0 });
                await holding.promise; // `work` now owns the only slot
                const denied = await exec("lat", "forbidden", {});
                deniedReturned = true;
                expect(denied.isError).toBe(true);
                hold.resolve();
                await slow;
            }),
            callTool: async (t) => {
                if (t === "work") {
                    holding.resolve();
                    await hold.promise; // released only AFTER the denied call has returned
                }
                return [{ type: "text", text: "ok" }];
            },
        });
        const deadline = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("denied call waited on a slot")), 10_000));
        expect((await Promise.race([run, deadline])).result).toBe("done");
        expect(deniedReturned).toBe(true);
    });
});
