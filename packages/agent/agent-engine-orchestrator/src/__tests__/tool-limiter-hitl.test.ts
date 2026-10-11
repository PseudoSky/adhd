/**
 * ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC4 (review B2-M3): HITL calls bypass the tool-call limiter.
 *
 * Driven through the REAL `Orchestrator.run` at `toolCallConcurrency: 1`. The real limiter is wrapped
 * only to RECORD what is routed through `map`/`run` (behaviour unchanged). A `request_human_input`
 * call suspends the task in the governance phase, before the pool; it must (a) never be handed to the
 * limiter, and (b) never leave the run deadlocked at limit 1 with sibling calls queued. Teeth: removing
 * the HITL filter at the `toolLimiter.map` call site routes `request_human_input` into the recorded
 * items and turns the first assertion red (verified, review B2-M3).
 */
import { describe, expect, it, vi } from "vitest";

const mapped: string[][] = [];
vi.mock("../engine/tool-limiter.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../engine/tool-limiter.js")>();
    return {
        ...actual,
        createToolLimiter: (limit: number | undefined) => {
            const real = actual.createToolLimiter(limit);
            return {
                ...real,
                map: (items: readonly { tool: string }[], fn: (i: never) => Promise<unknown>) => {
                    mapped.push(items.map((i) => i.tool));
                    return real.map(items, fn as never);
                },
            };
        },
    };
});

import { Orchestrator, resolveHitl } from "../engine/orchestrator.js";
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
const tool = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: "object", properties: {} } });

function ctx(): ExecutionContext {
    return {
        taskId: generateId(), sessionId: generateId(), agentName: "hitl-agent",
        agentDefinition: {
            name: "hitl-agent", version: 1, provider: { type: "openai", model: "gpt-4o-mini" },
            systemPrompt: "x", mcpServers: {}, permissions: {}, createdAt: nowIso(), updatedAt: nowIso(),
        } as ExecutionContext["agentDefinition"],
        recursionDepth: 0, toolCallCount: 0,
    };
}

/** Turn 1: the given calls in one message; turn 2: done. */
function scripted(calls: Array<{ server: string; tool: string }>): LLMProvider {
    let turn = 0;
    return {
        chat: async (_req: ProviderChatRequest): Promise<ProviderChatResponse> => {
            turn++;
            const base = { id: generateId(), sessionId: generateId(), role: "assistant", createdAt: nowIso() };
            return turn === 1
                ? ({ message: { ...base, content: "", toolCalls: calls.map((c) => ({ id: generateId(), ...c, arguments: {} })) }, stopReason: "tool_calls" } as ProviderChatResponse)
                : ({ message: { ...base, content: "done" }, stopReason: "completed" } as ProviderChatResponse);
        },
    } as unknown as LLMProvider;
}

async function drive(opts: {
    calls: Array<{ server: string; tool: string }>;
    permissionGate?: EngineConfig["permissionGate"];
}) {
    const c = ctx();
    const executed: string[] = [];
    let suspensions = 0;
    const taskStore: OrchestratorTaskStore = {
        updateStatus: (tid, status) => {
            if (status === "awaiting_input") {
                suspensions++;
                resolveHitl(tid, "allow");
            }
        },
        appendEvent: () => {}, unregisterCancellation: () => {},
    };
    const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
    const registry = {
        listAllTools: async () => [tool("lat__work"), tool("lat__gated")],
        closeAll: async () => {},
        getClient: async (server: string) => ({
            callTool: async (t: string) => { executed.push(`${server}__${t}`); return { ok: true }; },
        }),
    } as unknown as McpClientRegistry;
    const user: Message = { id: generateId(), sessionId: c.sessionId, role: "user", content: "go", createdAt: nowIso() };
    mapped.length = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("deadlock: HITL + sibling at limit 1")), 10_000); });
    try {
        const out = await Promise.race([
            new Orchestrator().run({
                executionContext: c, messages: [user], registry, provider: scripted(opts.calls), policy, taskStore, sessionStore,
                signal: new AbortController().signal, taskId: c.taskId, logger: silentLogger,
                config: {
                    server: { contextLimit: 0, defaultMaxTokens: 8192 }, toolCallConcurrency: 1,
                    ...(opts.permissionGate ? { permissionGate: opts.permissionGate } : {}),
                } as EngineConfig,
            }),
            deadline,
        ]);
        return { out, executed, suspensions };
    } finally {
        clearTimeout(timer);
    }
}

describe("ea8f6f92 AC4 (review B2-M3): HITL-gated calls never wait on, or occupy, a limiter slot", () => {
    it("ea8f6f92 AC4: request_human_input beside two sibling calls at limit 1 suspends outside the pool and the run completes", async () => {
        const { out, executed, suspensions } = await drive({
            calls: [{ server: "builtin", tool: "request_human_input" }, { server: "lat", tool: "work" }, { server: "lat", tool: "work" }],
        });
        expect(out.result).toBe("done");
        expect(suspensions).toBe(1); // it really suspended (awaiting_input) and was answered
        expect(mapped).toEqual([["work", "work"]]); // HITL never entered the limiter
        expect(executed).toEqual(["lat__work", "lat__work"]);
    });

    it("ea8f6f92 AC4: a permission 'ask' (HITL suspend) on one call beside a sibling at limit 1 completes both", async () => {
        const { out, executed, suspensions } = await drive({
            calls: [{ server: "lat", tool: "gated" }, { server: "lat", tool: "work" }],
            permissionGate: ({ tool: t }: { tool: string }) => (t === "gated" ? "ask" : "allow"),
        });
        expect(out.result).toBe("done");
        expect(suspensions).toBe(1);
        expect(executed.sort()).toEqual(["lat__gated", "lat__work"]);
    });
});
