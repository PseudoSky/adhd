/**
 * guards: task_events payloads differ from what the model saw or was offered (tool result cap, advertised tools, system prompt hash, compacted event type)
 * tier: S
 * cites: facd4aaa AC2, AC3, AC4
 *
 * facd4aaa AC2 / AC3 / AC4 — the payloads the orchestrator writes to `task_events` describe what the model
 * actually saw and was offered.
 *
 * AC2 (TOOL_RESULT): `result` is the capped model-visible text, and `result_sha256` is its sha256.
 *   Failure modes: (a) the stored text is a 500-char slice instead of the head+tail cap; (b) the stored text
 *   is the uncapped result while the model saw the capped one; (c) the hash does not match the stored text;
 *   (d) with the cap disabled the stored text is truncated anyway; (e) with spill enabled the stored stub
 *   is not the stub the model read, or the spilled file is missing its full text.
 * AC3 (MODEL_REQUEST): `advertisedToolNames` equals the tool names the provider was called with, and
 *   `systemPromptSha256` is the sha256 of the composed system prompt before model-request enforcement and
 *   windowing (null when none).
 *   Failure modes: (f) names drawn from the registry instead of the request; (g) a hash of the wrong text
 *   (history[0] vs the tool-doc system message); (h) a hash of a non-null value when no system message exists.
 * AC4 (CONTEXT_COMPACTED): the type parses through `taskEventTypeSchema` and survives a round trip through
 *   the drizzle `task_events.type` enum column and back through `taskEventSchema`.
 *   Failure mode: (i) the enum or validation list omits the type, so the row is written but readers reject it.
 *
 * Tier: S. Real `Orchestrator`, real `TaskStore`, real drizzle handle on the shipped migrations
 * (`createMigratedSqlite`). Only the LLM provider boundary is scripted: it records each request and answers
 * with one tool call, then a completion. No sleeps; no wall-clock assertions.
 *
 * Decision (AC2, unbounded storage): `maxChars: 0` disables the model-visible cap, and the stored TOOL_RESULT
 * text is then the full result. This is the documented behaviour of `agent.toolResult.maxChars = 0`
 * (interfaces.ts). The env var `ADHD_AGENT_TOOL_RESULT_MAX_CHARS=0` is mapped to that config key by the
 * agent-mcp environment cascade; that mapping is NOT exercised here (see the e2e lane for the consumer path).
 *
 * Assumption (AC2, cap size): the capped text is asserted within a band around the 6000-char budget
 * (5000 to 7000), because the marker that separates head and tail is not part of the contract this file
 * pins. If the marker grows past 1000 chars, widen the band here and record why.
 *
 * Red evidence: pending; tests cannot run until the hold is released. Expected red at facd4aaa^ for every
 * case (the TOOL_RESULT stores a 500-char slice; no `result_sha256`, `advertisedToolNames` or
 * `systemPromptSha256` are written; `CONTEXT_COMPACTED` is not in `taskEventTypeSchema`).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore, taskEventsTable } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorTaskStore, OrchestratorSessionStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import type { ToolResultSpillConfig } from "../engine/tool-result-spill.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { EngineConfig } from "../interfaces.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { taskEventSchema, taskEventTypeSchema } from "../validation/task.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** Repository `tmp/` root: `src/__tests__` is five levels below the worktree root. */
const SCRATCH_ROOT = resolve(HERE, "../../../../..", "tmp", "agent-engine-orchestrator", "task-events-payloads");

const TOOL_NAME = "test-server__echo";
const CAP = 6000;

const scratch: string[] = [];
afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

interface DriveOptions {
    /** Text the scripted tool returns on its one call. */
    toolText: string;
    /** Agent system prompt; empty string means no system content. */
    systemPrompt?: string;
    /** `agent.toolResult.maxChars` for the run; omitted means the default cap. */
    maxChars?: number;
    spill?: ToolResultSpillConfig;
    /** Names of the tools the registry lists. */
    toolNames?: string[];
}

interface DriveOutcome {
    taskId: string;
    /** Each provider call's request, snapshotted at call time. */
    requests: ProviderChatRequest[];
    /** Every task_events row for the task, in emit order, with the payload parsed. */
    events: Array<{ id: string; type: string; createdAt: string; payload: Record<string, unknown> | null }>;
}

function makeContext(taskId: string, systemPrompt: string): ExecutionContext {
    const def: AgentDefinition = {
        name: "task-events-agent",
        version: 1,
        provider: { type: "anthropic", model: "claude_sonnet_4_6" },
        // Provider-native web tools are on by default for anthropic; this suite pins the CLIENT tool list.
        nativeWebTools: false,
        systemPrompt,
        mcpServers: {},
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
    return {
        taskId,
        sessionId: generateId(),
        agentName: def.name,
        agentDefinition: def,
        recursionDepth: 0,
        toolCallCount: 0,
    };
}

async function drive(opts: DriveOptions): Promise<DriveOutcome> {
    const sqlite = createMigratedSqlite();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sqlite, { schema }) as any;
    const taskId = generateId();
    const systemPrompt = opts.systemPrompt ?? "";
    const ctx = makeContext(taskId, systemPrompt);
    const taskStore = new TaskStore(db);
    taskStore.create({ sessionId: ctx.sessionId, prompt: "p", id: taskId });

    const requests: ProviderChatRequest[] = [];
    let calls = 0;
    const provider: LLMProvider = {
        chat: async (request: ProviderChatRequest): Promise<ProviderChatResponse> => {
            requests.push({ ...request, messages: [...request.messages], tools: request.tools ? [...request.tools] : undefined });
            calls++;
            return calls === 1
                ? {
                      message: {
                          id: generateId(),
                          sessionId: ctx.sessionId,
                          role: "assistant",
                          toolCalls: [{ id: generateId(), server: "test-server", tool: "echo", arguments: {} }],
                          createdAt: nowIso(),
                      },
                      stopReason: "tool_calls",
                  }
                : {
                      message: { id: generateId(), sessionId: ctx.sessionId, role: "assistant", content: "done", createdAt: nowIso() },
                      stopReason: "completed",
                  };
        },
    };
    const toolNames = opts.toolNames ?? [TOOL_NAME];
    const registry = {
        listAllTools: async () => toolNames.map((name) => ({ name, description: "", inputSchema: { type: "object", properties: {} } })),
        getClient: async () => ({ callTool: async () => opts.toolText }),
        closeAll: async () => {
            /* no-op */
        },
    } as unknown as McpClientRegistry;
    const user: Message = { id: generateId(), sessionId: ctx.sessionId, role: "user", content: "hello", createdAt: nowIso() };
    const sessionStore: OrchestratorSessionStore = {
        appendMessage: async () => {
            /* no-op */
        },
        close: () => {
            /* no-op */
        },
    };
    const config = {
        server: { contextLimit: 0, defaultMaxTokens: 8192 },
        toolResult: { maxChars: opts.maxChars ?? CAP, ...(opts.spill ? { spill: opts.spill } : {}) },
    } as unknown as EngineConfig;

    await new Orchestrator().run({
        executionContext: ctx,
        // The orchestrator reads the system prompt from history[0]; the definition's systemPrompt alone is not sent.
        messages: systemPrompt === "" ? [user] : [{ id: generateId(), sessionId: ctx.sessionId, role: "system", content: systemPrompt, createdAt: nowIso() } as Message, user],
        registry,
        provider,
        policy: { check: () => undefined } as unknown as PolicyEngine,
        taskStore: taskStore as unknown as OrchestratorTaskStore,
        sessionStore,
        signal: new AbortController().signal,
        taskId,
        hooks: new HookRegistry(),
        config,
    });

    const rows = sqlite
        .prepare("SELECT id, type, payload, created_at AS createdAt FROM task_events WHERE task_id = ? ORDER BY created_at, rowid")
        .all(taskId) as Array<{ id: string; type: string; payload: string | null; createdAt: string }>;
    const events = rows.map((row) => ({
        id: row.id,
        type: row.type,
        createdAt: row.createdAt,
        payload: row.payload === null ? null : (JSON.parse(row.payload) as Record<string, unknown>),
    }));
    sqlite.close();
    return { taskId, requests, events };
}

/** The text the model read for the scripted tool call: the tool message sent on the second provider call. */
function modelReadToolText(outcome: DriveOutcome): string {
    const second = outcome.requests[1];
    expect(second, "the orchestrator must make a second provider call carrying the tool result").toBeDefined();
    const toolMessage = second!.messages.find((m) => m.role === "tool");
    expect(toolMessage, "the second provider call must carry a tool message").toBeDefined();
    const result = toolMessage!.toolResults?.[0]?.result;
    expect(typeof result).toBe("string");
    return result as string;
}

function toolResultOf(outcome: DriveOutcome): Record<string, unknown> {
    const rows = outcome.events.filter((e) => e.type === "TOOL_RESULT");
    expect(rows, "exactly one TOOL_RESULT is written for the one tool call").toHaveLength(1);
    return rows[0]!.payload as Record<string, unknown>;
}

// ── AC2 ─────────────────────────────────────────────────────────────────────────────────────────────

describe("facd4aaa AC2 TOOL_RESULT stores the model-visible text, not a 500-char slice", () => {
    // Failure modes (a), (c). Head and tail are distinct sentinels so a stored slice cannot match both.
    it("facd4aaa AC2: an over-cap result stores the capped text the model read, with result_sha256 of that text", async () => {
        const text = `BEGIN${"m".repeat(20_000)}END`;
        const outcome = await drive({ toolText: text });
        const payload = toolResultOf(outcome);
        const seen = modelReadToolText(outcome);

        expect(payload["result"]).toBe(seen);
        expect(payload["result_sha256"]).toBe(sha256(seen));
        expect(seen.length).toBeGreaterThan(500);
        expect(seen.length).toBeGreaterThanOrEqual(5_000);
        expect(seen.length).toBeLessThanOrEqual(7_000);
        expect(seen.startsWith("BEGIN")).toBe(true);
        expect(seen.endsWith("END")).toBe(true);
    });

    // Failure mode (b). An under-cap result is stored whole; the hash still describes the stored text.
    it("facd4aaa AC2: an under-cap result is stored whole, equal to what the model read", async () => {
        const text = Array.from({ length: 80 }, (_, i) => `tool output line ${i}: varied ${i * 7}`).join("\n");
        const outcome = await drive({ toolText: text });
        const payload = toolResultOf(outcome);

        expect(modelReadToolText(outcome)).toBe(text);
        expect(payload["result"]).toBe(text);
        expect(payload["result_sha256"]).toBe(sha256(text));
    });

    // Failure mode (d). maxChars 0 disables the cap; the stored text must be the full result.
    it("facd4aaa AC2: maxChars 0 (cap disabled) stores the full result unbounded and the model reads all of it", async () => {
        const text = `BEGIN${"n".repeat(20_000)}END`;
        const outcome = await drive({ toolText: text, maxChars: 0 });
        const payload = toolResultOf(outcome);

        expect(modelReadToolText(outcome)).toBe(text);
        expect(payload["result"]).toBe(text);
        expect(payload["result_sha256"]).toBe(sha256(text));
    });

    // Failure mode (e). With spill on, the model reads the stub; the stored result must be that stub, and the
    // spilled file must hold the full text.
    it("facd4aaa AC2: with spill enabled the stored result is the stub the model read, and the spill file holds the full text", async () => {
        mkdirSync(SCRATCH_ROOT, { recursive: true });
        const dir = mkdtempSync(`${SCRATCH_ROOT}/spill-`);
        scratch.push(dir);
        const text = `BEGIN${"s".repeat(20_000)}END`;
        const outcome = await drive({ toolText: text, spill: { enabled: true, dir, ttlMs: 60_000 } });
        const payload = toolResultOf(outcome);
        const seen = modelReadToolText(outcome);

        expect(payload["spilled"]).toBe(true);
        expect(typeof payload["spill_path"]).toBe("string");
        const spillPath = payload["spill_path"] as string;
        expect(existsSync(spillPath)).toBe(true);
        expect(readFileSync(spillPath, "utf8")).toBe(text);
        expect(payload["result"]).toBe(seen);
        expect(seen).toContain(spillPath);
        expect(payload["result_sha256"]).toBe(sha256(seen));
    });

    // Failure mode (a), negative control. The stored text must not equal the uncapped result when the cap is on.
    it("facd4aaa AC2 NEGATIVE CONTROL: with the default cap an over-cap result is not stored whole", async () => {
        const text = `BEGIN${"c".repeat(20_000)}END`;
        const outcome = await drive({ toolText: text });
        expect(toolResultOf(outcome)["result"]).not.toBe(text);
    });
});

// ── AC3 ─────────────────────────────────────────────────────────────────────────────────────────────

describe("facd4aaa AC3 MODEL_REQUEST records the tools advertised and the system prompt actually sent", () => {
    // Failure mode (f). The names are compared with the names the provider was called with, in order.
    it("facd4aaa AC3: advertisedToolNames equals the tool names of each provider call, and no server-side tools are sent", async () => {
        const outcome = await drive({ toolText: "ok", toolNames: ["test-server__echo", "test-server__ping"] });
        const modelRequests = outcome.events.filter((e) => e.type === "MODEL_REQUEST");

        expect(modelRequests).toHaveLength(outcome.requests.length);
        modelRequests.forEach((event, i) => {
            const request = outcome.requests[i]!;
            expect(request.serverSideTools ?? []).toHaveLength(0);
            const sentNames = (request.tools ?? []).map((t) => t.name);
            // The engine adds its own built-in tools (human input); the registry tools must be present, in order.
            expect(sentNames.filter((n) => n.startsWith("test-server__"))).toEqual(["test-server__echo", "test-server__ping"]);
            expect(event.payload?.["advertisedToolNames"]).toEqual(sentNames);
        });
    });

    // Failure mode (g). The hash is of the composed system prompt (taken before pre:model_request enforcement and
    // windowing); with no enforcement hook registered here that equals the system message the provider received.
    it("facd4aaa AC3: systemPromptSha256 equals the sha256 of the composed system prompt before model-request enforcement and windowing", async () => {
        const systemPrompt = "SYSTEM ALPHA: answer in one word.";
        const outcome = await drive({ toolText: "ok", systemPrompt });
        const modelRequests = outcome.events.filter((e) => e.type === "MODEL_REQUEST");
        const sentSystem = outcome.requests[0]!.messages.find((m) => m.role === "system");

        expect(sentSystem, "the provider must be sent a system message for this case").toBeDefined();
        const sentText = typeof sentSystem!.content === "string" ? sentSystem!.content : JSON.stringify(sentSystem!.content);
        expect(sentText).toContain("SYSTEM ALPHA");
        expect(modelRequests[0]!.payload?.["systemPromptSha256"]).toBe(sha256(sentText));
    });

    // Failure mode (h). No system message sent means the hash is null, not the hash of an empty string.
    it("facd4aaa AC3: with no system message sent, systemPromptSha256 is null", async () => {
        const outcome = await drive({ toolText: "ok", systemPrompt: "" });
        const modelRequests = outcome.events.filter((e) => e.type === "MODEL_REQUEST");
        const sentSystem = outcome.requests[0]!.messages.find((m) => m.role === "system");

        // Precondition: the case is only meaningful when no system message reached the provider.
        expect(sentSystem, "precondition: this case sends no system message").toBeUndefined();
        expect(modelRequests[0]!.payload?.["systemPromptSha256"]).toBeNull();
    });
});

// ── AC4 ─────────────────────────────────────────────────────────────────────────────────────────────

describe("facd4aaa AC4 CONTEXT_COMPACTED parses and round-trips through the task_events enum column", () => {
    // Failure mode (i). The row is written through the drizzle table, read back, and must parse through the
    // schema the readers use. A missing enum member fails the parse, not a source-text check.
    it("facd4aaa AC4: a CONTEXT_COMPACTED row written through taskEventsTable reads back and parses through taskEventSchema", () => {
        const sqlite = createMigratedSqlite();
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const db = drizzle(sqlite, { schema }) as any;
            const taskStore = new TaskStore(db);
            const taskId = randomUUID();
            taskStore.create({ sessionId: generateId(), prompt: "compaction", id: taskId });
            const eventId = "5c1f0b7e-7a1d-4c53-9b8e-2f1f7c1a0d11";
            const createdAt = "2026-01-01T00:00:00.000Z";
            db.insert(taskEventsTable)
                .values({
                    id: eventId,
                    taskId,
                    type: "CONTEXT_COMPACTED",
                    payload: JSON.stringify({ droppedMessages: 3, keptMessages: 7 }),
                    createdAt,
                })
                .run();

            const [row] = db.select().from(taskEventsTable).all() as Array<{ id: string; taskId: string; type: string; payload: string; createdAt: string }>;
            expect(row).toBeDefined();
            const parsed = taskEventSchema.parse({
                id: row!.id,
                taskId: row!.taskId,
                type: row!.type,
                payload: JSON.parse(row!.payload),
                createdAt: row!.createdAt,
            });
            expect(parsed.type).toBe("CONTEXT_COMPACTED");
            expect(parsed.payload).toEqual({ droppedMessages: 3, keptMessages: 7 });
        } finally {
            sqlite.close();
        }
    });

    it("facd4aaa AC4: taskEventTypeSchema accepts CONTEXT_COMPACTED and rejects a near-miss spelling", () => {
        expect(taskEventTypeSchema.safeParse("CONTEXT_COMPACTED").success).toBe(true);
        expect(taskEventTypeSchema.safeParse("CONTEXT_COMPACTED_X").success).toBe(false);
    });
});
