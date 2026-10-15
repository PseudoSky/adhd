/**
 * guards: a tool result longer than the stored-event bound reaches task_events whole (an unbounded row), loses the hash of its full text, or the task_events tool returns it over budget
 * tier: S
 * cites: plan discovery-sweep-1014 blind-review A2 TEB-I1
 *
 * plan discovery-sweep-1014 blind-review A2 TEB-I1 — real-component integration, unit lane, in process: a real
 * `Orchestrator` runs a real `TaskStore` on a real file-backed SQLite built from the shipped migrations; the only
 * scripted boundary is the LLM provider and the tool server it calls. With the model cap disabled (`maxChars: 0`)
 * the tool returns 100,000 chars. The real `taskEvents()` then reads the same database.
 *
 * Failure modes: (a) the writer stores the 100,000 chars whole (no storage bound); (b) the stored hash is of the
 * clipped text, so the full text's identity is lost; (c) the reader returns a page over budget or re-clips a row the
 * writer already bounded; (d) the model is shown less than the full text because the storage clip leaked into the
 * model-visible path.
 *
 * Red run (negative control: the writer's `clipForStorage` replaced by an identity, so the 100,000 chars are stored
 * whole): the case fails on `expect(payload["result_stored_clipped"]).toBe(true)` (`expected undefined to be true`).
 * The reader's own field clip still bounds the returned length, which is why the failing assertion is the writer flag
 * and not the length. A seeded fault in the reader alone leaves this case green (the writer already bounded the row);
 * the reader is pinned by task-events-bounds.test.ts (TEB-B1) and the stdio case (TEB-I2).
 *
 * Tier: S, not a higher tier: nothing here needs a spawned process or a real model; the stdio path is TEB-I2
 * (task-events-stdio.e2e.test.ts). No sleeps, no wall clock.
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { HookRegistry, Orchestrator, TOOL_RESULT_EVENT_MAX_CHARS } from "@adhd/agent-engine-orchestrator";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "@adhd/agent-engine-orchestrator";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { taskEvents, TASK_EVENTS_MAX_PAGE_BYTES, toWireText } from "../tools/task-events.js";
import { createTaskEventsFixture, type TaskEventsFixture } from "./fixtures/task-events-db.js";

const fixtures: TaskEventsFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const now = (): string => new Date().toISOString();

const FULL_TEXT = `BEGIN-${"0123456789".repeat(9_999)}-END`;

describe("plan discovery-sweep-1014 blind-review A2 TEB-I1 a 100,000-char tool result, cap 0, real orchestrator -> real task_events tool", () => {
  it("plan discovery-sweep-1014 blind-review A2 TEB-I1: the TOOL_RESULT event is clipped, hashes the full text, the model read all of it, and the page is under budget", async () => {
    expect(FULL_TEXT).toHaveLength(100_000);
    const fx = createTaskEventsFixture();
    fixtures.push(fx);
    const taskId = fx.createTask();
    const sessionId = "session-i1";
    const def: AgentDefinition = {
      name: "i1-agent",
      version: 1,
      provider: { type: "anthropic", model: "claude_sonnet_4_6" },
      systemPrompt: "",
      mcpServers: {},
      permissions: {},
      createdAt: now(),
      updatedAt: now(),
    };
    const ctx: ExecutionContext = { taskId, sessionId, agentName: def.name, agentDefinition: def, recursionDepth: 0, toolCallCount: 0 };

    const toolMessages: string[] = [];
    let calls = 0;
    const provider = {
      chat: async (request: { messages: Message[] }) => {
        calls += 1;
        if (calls === 1) {
          return {
            message: {
              id: "m-call",
              sessionId,
              role: "assistant" as const,
              toolCalls: [{ id: "call-1", server: "test-server", tool: "big", arguments: {} }],
              createdAt: now(),
            },
            stopReason: "tool_calls" as const,
          };
        }
        for (const m of request.messages) {
          if (m.role === "tool") for (const r of m.toolResults ?? []) toolMessages.push(String(r.result));
        }
        return {
          message: { id: "m-done", sessionId, role: "assistant" as const, content: "done", createdAt: now() },
          stopReason: "completed" as const,
        };
      },
    };
    const registry = {
      listAllTools: async () => [{ name: "test-server__big", description: "", inputSchema: { type: "object", properties: {} } }],
      getClient: async () => ({ callTool: async () => FULL_TEXT }),
      closeAll: async () => undefined,
    };
    const sessionStore: OrchestratorSessionStore = { appendMessage: async () => undefined, close: () => undefined };

    await new Orchestrator().run({
      executionContext: ctx,
      messages: [{ id: "u1", sessionId, role: "user", content: "go", createdAt: now() }],
      registry: registry as never,
      provider: provider as never,
      policy: { check: () => undefined } as never,
      taskStore: fx.taskStore as unknown as OrchestratorTaskStore,
      sessionStore,
      signal: new AbortController().signal,
      taskId,
      hooks: new HookRegistry(),
      config: { server: { contextLimit: 0, defaultMaxTokens: 8192 }, toolResult: { maxChars: 0 } } as never,
    });

    // The model was shown the whole text (cap 0): the storage bound did not leak into the model-visible path.
    expect(toolMessages).toEqual([FULL_TEXT]);

    const page = taskEvents({ task_id: taskId, limit: 500 }, { taskStore: fx.taskStore, db: fx.db });
    const toolResults = page.events.filter((e) => e.type === "TOOL_RESULT");
    expect(toolResults).toHaveLength(1);
    const event = toolResults[0]!;
    const payload = event.payload as Record<string, unknown>;
    const stored = payload["result"] as string;

    expect(stored.length).toBeLessThanOrEqual(TOOL_RESULT_EVENT_MAX_CHARS);
    expect(stored.startsWith("BEGIN-")).toBe(true);
    expect(stored.endsWith("-END")).toBe(true);
    expect(payload["result_stored_clipped"]).toBe(true);
    expect(payload["result_model_visible_chars"]).toBe(100_000);
    expect(payload["result_sha256"]).toBe(sha256(FULL_TEXT));
    // The writer already bounded the row, so the reader has nothing to clip.
    expect(event.payload_clipped).toBeUndefined();
    expect(event.payload_error).toBeUndefined();
    expect(page.truncated_by_bytes).toBeUndefined();
    expect(Buffer.byteLength(toWireText(page), "utf8")).toBeLessThanOrEqual(TASK_EVENTS_MAX_PAGE_BYTES);
  });
});
