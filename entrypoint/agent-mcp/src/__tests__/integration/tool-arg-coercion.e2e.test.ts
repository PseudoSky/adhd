/**
 * tool-arg-coercion.e2e.test.ts — backlog 114e014c (BK2), plan 9ed453c1, AC2.4.
 *
 * Drives the REAL orchestrator + real task/event stores + a REAL stdio MCP
 * server (`fixtures/shell-like-server.mjs`, whose `shell_execute` declares
 * `command` as array-of-string and rejects anything else with isError, like
 * the real shell server). The only stub is the LLM (a scripted provider; no
 * live model, no env gate). The provider emits the REAL captured failing
 * payload shape: the argv stringified (`"command": "[\"adhd-backlog\", ...]"`).
 *
 * Consumer-visible assertions: the call succeeds on the first attempt and the
 * server received the real array; a `TOOL_ARG_COERCED` event is recorded.
 * Negative control: with coercion disabled the same payload yields the
 * server's original error on every attempt (three in a row, the observed
 * failure mode that exhausts the consecutiveErrors budget) and no event.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "@adhd/agent-engine-orchestrator";
import type { Message } from "@adhd/agent-base-types";
import { generateId, nowIso, taskEventsTable } from "@adhd/agent-store-runtime";

const SHELL_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "shell-like-server.mjs");

const ARGV = ["adhd-backlog", "backlog", "get", "--input", '{"uid":"00000000-0000-4000-8000-000000000001"}'];
/** Exactly the shape Haiku sent: the argv array serialized into a string. */
const STRINGIFIED = JSON.stringify(ARGV);

/** Emits `attempts` shell calls (one per turn) with the given arguments, then completes. */
class StringifyingProvider implements LLMProvider {
    private calls = 0;
    readonly requests: Message[][] = [];
    constructor(private readonly args: unknown, private readonly attempts: number) {}
    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        this.requests.push(request.messages.map((m) => ({ ...m })));
        const idx = this.calls++;
        if (idx < this.attempts) {
            return {
                stopReason: "tool_calls",
                message: {
                    id: generateId(),
                    sessionId: generateId(),
                    role: "assistant",
                    toolCalls: [{ id: `call-${idx}`, server: "shell", tool: "shell_execute", arguments: this.args }],
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
    results: Array<{ isError: boolean; text: string }>;
    coercedEvents: Array<Record<string, unknown>>;
}

const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

async function runOnce(args: unknown, attempts: number, toolArgCoercion?: { enabled: boolean }): Promise<Run> {
    const { buildHarness, createSessionAndAgent, enqueueTaskWithProvider, drainQueue } = await import("./harness.js");
    const provider = new StringifyingProvider(args, attempts);
    const harness = await buildHarness({ defaultProvider: provider, skipOrphanScan: true, ...(toolArgCoercion ? { toolArgCoercion } : {}) });
    try {
        const { sessionId } = await createSessionAndAgent(harness, provider, {
            mcpServers: { shell: { transport: "stdio", command: "node", args: [SHELL_SERVER] } },
        });
        const out = await enqueueTaskWithProvider(harness, sessionId, "get the backlog item", provider);
        await drainQueue(harness.queue, 30_000);
        const task = harness.taskStore.read(out.task_id);
        expect(task.status, `task error: ${String(task.error)}`).toBe("completed");

        const results = provider.requests
            .slice(1)
            .map((req) => req.filter((m) => m.role === "tool").at(-1)?.toolResults?.[0])
            .map((r) => ({ isError: r?.isError === true, text: asText(r?.result) }));

        const events = harness.db
            .select()
            .from(taskEventsTable)
            .where(eq(taskEventsTable.taskId, out.task_id))
            .all() as Array<{ type: string; payload: string | null }>;
        const coercedEvents = events
            .filter((e) => e.type === "TOOL_ARG_COERCED")
            .map((e) => JSON.parse(e.payload ?? "{}") as Record<string, unknown>);
        return { results, coercedEvents };
    } finally {
        await harness.teardown();
    }
}

describe("114e014c AC2.4 stringified argv through the real orchestrator + real stdio MCP server (plan 9ed453c1)", () => {
    it("coercion on: the stringified argv succeeds on the first attempt and TOOL_ARG_COERCED is recorded", async () => {
        const r = await runOnce({ command: STRINGIFIED }, 1);
        expect(r.results).toHaveLength(1);
        expect(r.results[0]?.isError).toBe(false);
        // The real server only returns ok when it received an actual array of strings.
        expect(r.results[0]?.text).toContain('\\"ok\\":true');
        expect(r.results[0]?.text).toContain("adhd-backlog");
        expect(r.coercedEvents).toEqual([
            expect.objectContaining({ tool: "shell__shell_execute", property: "command", from: "string", to: "array" }),
        ]);
        expect(typeof r.coercedEvents[0]?.["taskId"]).toBe("string");
    }, 60_000);

    it("negative control: coercion off => the server's original error on every one of three attempts, no event", async () => {
        const r = await runOnce({ command: STRINGIFIED }, 3, { enabled: false });
        expect(r.results).toHaveLength(3);
        for (const res of r.results) {
            expect(res.isError).toBe(true);
            expect(res.text).toContain("command must be an array of strings, got string");
        }
        expect(r.coercedEvents).toEqual([]);
    }, 60_000);

    it("a non-coercible string is rejected before the tool runs, with property, type and a worked example", async () => {
        const r = await runOnce({ command: "cat /etc/hosts" }, 1);
        expect(r.results[0]?.isError).toBe(true);
        expect(r.results[0]?.text).toContain('"command"');
        expect(r.results[0]?.text).toContain("array of string");
        expect(r.results[0]?.text).toContain('Example: {"command": ["first", "second"]}');
        expect(r.results[0]?.text).not.toContain("got string");
        expect(r.coercedEvents).toEqual([]);
    }, 60_000);

    it("an already-correct array is passed through untouched with no event", async () => {
        const r = await runOnce({ command: ARGV }, 1);
        expect(r.results[0]?.isError).toBe(false);
        expect(r.coercedEvents).toEqual([]);
    }, 60_000);
});
