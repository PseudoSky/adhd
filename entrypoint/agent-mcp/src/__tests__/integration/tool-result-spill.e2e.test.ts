/**
 * tool-result-spill.e2e.test.ts — plan 9ed453c1 / backlog 3ad735bb, bucket BK9 (optional spill mode).
 *
 * Drives the REAL orchestrator + real task/event stores + a REAL stdio MCP server
 * (`fixtures/big-result-server.mjs`, 100,000-char result). The only stub is the LLM (a capturing
 * provider; no live model, no env gate). Asserted through the consumer-visible seam: the messages the
 * provider receives on its SECOND request, the persisted TOOL_RESULT event, and the file on disk.
 *
 *   BK9 AC9.1  default off: the model still sees head+marker+tail, no file is written.
 *   BK9 AC9.2  enabled: the model sees a short stub naming path+size+preview; the file holds the full text;
 *              a REAL `sed -n 1000p <path>` (the stub's own instruction) returns line 1000.
 *   BK9 AC9.3  spill dir unwritable: the task still completes with the head+tail cap.
 *   BK9 AC9.5  file 0600, dirs 0700.
 *   Telemetry still measures the FULL result; TOOL_RESULT gains spilled:true + spill_path.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "@adhd/agent-engine-orchestrator";
import type { Message } from "@adhd/agent-base-types";
import { generateId, nowIso, taskEventsTable } from "@adhd/agent-store-runtime";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIG_SERVER = path.resolve(HERE, "fixtures", "big-result-server.mjs");
const SCRATCH = path.resolve(HERE, "..", "..", "..", "..", "..", "tmp", "agent-mcp");
const TOTAL = 100_000;

class CapturingProvider implements LLMProvider {
    private calls = 0;
    readonly requests: Message[][] = [];
    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        this.requests.push(request.messages.map((m) => ({ ...m })));
        if (this.calls++ === 0) {
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
    toolResultEvent: Record<string, unknown>;
    status: string;
    taskId: string;
}

const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

async function runOnce(spill?: { enabled: boolean; dir: string; ttlMs: number }): Promise<Run> {
    const { buildHarness, createSessionAndAgent, enqueueTaskWithProvider, drainQueue } = await import("./harness.js");
    const provider = new CapturingProvider();
    const harness = await buildHarness({
        defaultProvider: provider,
        skipOrphanScan: true,
        ...(spill ? { toolResult: { maxChars: 20_000, spill } } : {}),
    });
    try {
        let hookResultChars = -1;
        harness.hooks.register("post:tool_call", (p: { toolName: string; result: unknown }) => {
            if (p.toolName === "big__emit") hookResultChars = asText(p.result).length;
        });
        const { sessionId } = await createSessionAndAgent(harness, provider, {
            mcpServers: { big: { transport: "stdio", command: "node", args: [BIG_SERVER] } },
        });
        const out = await enqueueTaskWithProvider(harness, sessionId, "emit a big result", provider);
        await drainQueue(harness.queue, 30_000);
        const task = harness.taskStore.read(out.task_id);
        const toolMsg = (provider.requests[1] ?? []).find((m) => m.role === "tool");
        const events = harness.db
            .select()
            .from(taskEventsTable)
            .where(eq(taskEventsTable.taskId, out.task_id))
            .all() as Array<{ type: string; payload: string | null }>;
        const tr = events.find((e) => e.type === "TOOL_RESULT");
        return {
            seenByModel: asText(toolMsg?.toolResults?.[0]?.result),
            hookResultChars,
            toolResultEvent: JSON.parse(tr?.payload ?? "{}") as Record<string, unknown>,
            status: String(task.status),
            taskId: out.task_id,
        };
    } finally {
        await harness.teardown();
    }
}

let root = "";
let dir = "";
beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
    root = mkdtempSync(path.join(SCRATCH, "spill-e2e-"));
    dir = path.join(root, "tool-results");
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("9ed453c1 BK9 optional tool-result spill through the real orchestrator + real stdio MCP server", () => {
    it("AC9.1 default off: head+marker+tail, no spill fields, nothing on disk", async () => {
        const r = await runOnce();
        expect(r.seenByModel).toMatch(/\[tool result truncated: showing first 4500 and last 1500 of \d+ chars/);
        expect(r.toolResultEvent["spilled"]).toBeUndefined();
        expect(r.toolResultEvent["spill_path"]).toBeUndefined();
        expect(() => lstatSync(dir)).toThrow();
    }, 60_000);

    it("AC9.2/AC9.5 enabled: stub (path+size+preview), exact full text on disk, 0700/0600, line 1000 via the stub's own sed", async () => {
        const r = await runOnce({ enabled: true, dir, ttlMs: 3_600_000 });
        expect(r.status).toBe("completed");
        const expectedPath = path.join(dir, r.taskId, "call-big-1.txt");
        // the model sees the short stub, not 100k chars and not head+tail
        expect(r.seenByModel).toContain(expectedPath);
        expect(r.seenByModel).toContain("full output saved to");
        expect(r.seenByModel).not.toContain("[tool result truncated");
        expect(r.seenByModel.length).toBeLessThan(3_000);
        expect(r.seenByModel).toContain("L000001:"); // preview
        // the file holds the exact full text the tool returned (text blocks, as real lines)
        const onDisk = readFileSync(expectedPath, "utf8");
        expect(onDisk.length).toBeGreaterThanOrEqual(TOTAL);
        expect(onDisk.startsWith("L000001:")).toBe(true);
        expect(r.seenByModel).toContain(`${onDisk.length} chars`);
        // telemetry measured the FULL result; payload gains spilled + spill_path
        expect(r.toolResultEvent["spilled"]).toBe(true);
        expect(r.toolResultEvent["spill_path"]).toBe(expectedPath);
        expect(r.toolResultEvent["original_chars"]).toBe(r.hookResultChars);
        expect(Number(r.toolResultEvent["tool_call_est_result_tokens"])).toBeGreaterThan(5_000);
        // permissions
        expect(lstatSync(dir).mode & 0o777).toBe(0o700);
        expect(lstatSync(path.join(dir, r.taskId)).mode & 0o777).toBe(0o700);
        expect(lstatSync(expectedPath).mode & 0o777).toBe(0o600);
        // retrieval using ONLY the stub's instruction (sed -n 'A,Bp' <path>)
        const sed = spawnSync("sed", ["-n", "1000,1000p", expectedPath], { encoding: "utf8" });
        expect(sed.status).toBe(0);
        expect(sed.stdout.startsWith("L001000:")).toBe(true);
    }, 60_000);

    it("AC9.3 spill dir unwritable: the task still completes and the model gets head+tail + marker", async () => {
        writeFileSync(dir, "a regular file where the spill dir should be");
        const r = await runOnce({ enabled: true, dir, ttlMs: 3_600_000 });
        expect(r.status).toBe("completed");
        expect(r.seenByModel).toMatch(/\[tool result truncated: showing first 15000 and last 5000 of \d+ chars/);
        expect(r.toolResultEvent["spilled"]).toBeUndefined();
        expect(r.toolResultEvent["truncated"]).toBe(true);
        expect(r.seenByModel.length).toBeLessThan(21_000);
    }, 60_000);

    it("AC9.6 enabled with a relative dir fails the task loud instead of spilling somewhere unintended", async () => {
        const r = await runOnce({ enabled: true, dir: "relative/spill", ttlMs: 3_600_000 });
        expect(r.status).not.toBe("completed");
    }, 60_000);
});
