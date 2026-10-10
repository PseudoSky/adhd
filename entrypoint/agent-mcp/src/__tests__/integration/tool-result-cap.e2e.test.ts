/**
 * tool-result-cap.e2e.test.ts — backlog 3ad735bb (BK1), plan 9ed453c1, AC1.5.
 *
 * Drives the REAL orchestrator + real task/event stores + a REAL stdio MCP
 * server (`fixtures/big-result-server.mjs`) that returns a 100,000-char result.
 * The only stub is the LLM (a capturing provider; no live model, no env gate).
 *
 * Asserted through the consumer-visible seam — the messages the provider
 * receives on its SECOND request, and the persisted session history:
 *   - the oversize result is bounded to cap + marker (head/tail intact);
 *   - telemetry saw the FULL result (`post:tool_call` estResultTokens/result,
 *     TOOL_RESULT `tool_call_est_result_tokens`, `truncated`, `original_chars`);
 *   - negative control: with the cap disabled (`maxChars: 0`) the full 100,000
 *     chars reach the model, so the size assertion has teeth.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "@adhd/agent-engine-orchestrator";
import type { Message } from "@adhd/agent-base-types";
import { generateId, nowIso, taskEventsTable } from "@adhd/agent-store-runtime";

const BIG_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "big-result-server.mjs");
const TOTAL = 100_000;

/** Turn 1 calls big__emit; turn 2 records the tool result it was shown and completes. */
class CapturingProvider implements LLMProvider {
    private calls = 0;
    readonly requests: Message[][] = [];
    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        this.requests.push(request.messages.map((m) => ({ ...m })));
        const idx = this.calls++;
        if (idx === 0) {
            return {
                stopReason: "tool_calls",
                message: {
                    id: generateId(),
                    sessionId: generateId(),
                    role: "assistant",
                    toolCalls: [{ id: "call-big-1", server: "big", tool: "emit", arguments: { chars: TOTAL } }],
                    createdAt: nowIso(),
                },
            };
        }
        return {
            stopReason: "completed",
            message: { id: generateId(), sessionId: generateId(), role: "assistant", content: "done", createdAt: nowIso() },
        };
    }
}

interface Run {
    seenByModel: string;
    hookResultChars: number;
    hookEstTokens: number;
    toolResultEvent: Record<string, unknown>;
    persistedChars: number;
    firstRequestMessageCount: number;
}

const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

async function runOnce(toolResult?: { maxChars: number }): Promise<Run> {
    const { buildHarness, createSessionAndAgent, enqueueTaskWithProvider, drainQueue } = await import("./harness.js");
    const provider = new CapturingProvider();
    const harness = await buildHarness({ defaultProvider: provider, skipOrphanScan: true, ...(toolResult ? { toolResult } : {}) });
    try {
        let hookResultChars = -1;
        let hookEstTokens = -1;
        harness.hooks.register("post:tool_call", (p: { toolName: string; result: unknown; estResultTokens?: number }) => {
            if (p.toolName === "big__emit") {
                hookResultChars = asText(p.result).length;
                hookEstTokens = p.estResultTokens ?? -1;
            }
        });
        const { sessionId } = await createSessionAndAgent(harness, provider, {
            mcpServers: { big: { transport: "stdio", command: "node", args: [BIG_SERVER] } },
        });
        const out = await enqueueTaskWithProvider(harness, sessionId, "emit a big result", provider);
        await drainQueue(harness.queue, 30_000);
        const task = harness.taskStore.read(out.task_id);
        expect(task.status, `task error: ${String(task.error)}`).toBe("completed");

        expect(provider.requests.length).toBe(2);
        const second = provider.requests[1] ?? [];
        const toolMsg = second.find((m) => m.role === "tool");
        const first = toolMsg?.toolResults?.[0];
        expect(first?.toolCallId).toBe("call-big-1");
        expect(first?.isError).toBeFalsy();

        const events = harness.db
            .select()
            .from(taskEventsTable)
            .where(eq(taskEventsTable.taskId, out.task_id))
            .all() as Array<{ type: string; payload: string | null }>;
        const tr = events.find((e) => e.type === "TOOL_RESULT");
        const toolResultEvent = JSON.parse(tr?.payload ?? "{}") as Record<string, unknown>;

        const persisted = harness.sessionStore.getMessages(sessionId);
        const persistedTool = persisted.find((m) => m.role === "tool");
        return {
            seenByModel: asText(first?.result),
            hookResultChars,
            hookEstTokens,
            toolResultEvent,
            persistedChars: persistedTool ? asText(persistedTool.toolResults?.[0]?.result).length : -1,
            firstRequestMessageCount: (provider.requests[0] ?? []).length,
        };
    } finally {
        await harness.teardown();
    }
}

describe("3ad735bb AC1.5 tool-result cap through the real orchestrator + real stdio MCP server (plan 9ed453c1)", () => {
    it("default cap: the model sees head+marker+tail (<= cap + marker); telemetry saw the full result", async () => {
        const r = await runOnce();
        const marker = r.seenByModel.match(/\[tool result truncated: showing first (\d+) and last (\d+) of (\d+) chars; re-run with a narrower command \(e\.g\. grep, head, sed -n 'a,bp'\)\]/);
        expect(marker, "marker must be present with the exact format").not.toBeNull();
        expect(Number(marker?.[1])).toBe(4_500);
        expect(Number(marker?.[2])).toBe(1_500);
        // The MCP client returns the content array ([{type:'text',text}]); the cap measures its
        // JSON serialization, which is what the model is shown.
        expect(Number(marker?.[3])).toBe(r.hookResultChars);
        expect(r.hookResultChars).toBeGreaterThanOrEqual(TOTAL);
        // bounded: cap (6000) + marker + 2 joining newlines
        expect(r.seenByModel.length).toBeLessThanOrEqual(6_000 + (marker?.[0].length ?? 0) + 2);
        expect(r.seenByModel.length).toBeLessThan(r.hookResultChars / 4);
        // head and tail of the original survive
        expect(r.seenByModel).toContain("L000001:");
        expect(r.seenByModel.slice(-30)).toMatch(/x"\}\]$/); // tail of the serialized original
        // telemetry measured the FULL result
        expect(r.hookEstTokens).toBeGreaterThan(5_000);
        expect(r.toolResultEvent["tool_call_est_result_tokens"]).toBe(r.hookEstTokens);
        expect(r.toolResultEvent["truncated"]).toBe(true);
        expect(r.toolResultEvent["original_chars"]).toBe(r.hookResultChars);
        // persisted history stores what the model saw
        expect(r.persistedChars).toBe(r.seenByModel.length);
    }, 60_000);

    it("negative control: cap disabled (maxChars 0) => the full 100000+ chars reach the model", async () => {
        const r = await runOnce({ maxChars: 0 });
        expect(r.seenByModel.length).toBe(r.hookResultChars);
        expect(r.seenByModel.length).toBeGreaterThanOrEqual(TOTAL);
        expect(r.seenByModel).not.toContain("[tool result truncated");
        expect(r.toolResultEvent["truncated"]).toBeUndefined();
        expect(r.toolResultEvent["original_chars"]).toBeUndefined();
    }, 60_000);

    it("a result under the configured cap is delivered byte-identical", async () => {
        const r = await runOnce({ maxChars: 200_000 });
        expect(r.seenByModel.length).toBe(r.hookResultChars);
        expect(r.seenByModel.length).toBeGreaterThanOrEqual(TOTAL);
        expect(r.toolResultEvent["truncated"]).toBeUndefined();
    }, 60_000);
});
