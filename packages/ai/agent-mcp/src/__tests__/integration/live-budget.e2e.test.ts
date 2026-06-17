/**
 * live-budget.e2e.test.ts
 *
 * LIVE ONLY — gated behind AGENT_MCP_BUDGET_LIVE=1. Skipped in CI/unit runs.
 *
 * Verifies budget enforcement against a real LLM (LM Studio by default).
 *
 * Scenario: an agent with a calc tool is given a prompt that will require the
 * model to call the tool (turn 1 = tool_calls). Budget is set to maxModelCalls: 1.
 * After the tool result is returned, the orchestrator fires pre:model_request
 * for turn 2. The BudgetPlugin's enforcement handler fires: modelCalls=1 >= 1
 * → throws IEnforcementError → task fails with BUDGET_EXCEEDED.
 *
 * Asserts MODEL-INDEPENDENT invariants:
 *  - task.status === "failed"
 *  - task.error contains "BUDGET_EXCEEDED"
 *  - task_events contains a TASK_FAILED event
 *
 * Run:
 *   AGENT_MCP_BUDGET_LIVE=1 npx nx test agent-mcp --reporter=verbose
 *
 * Uses LM Studio by default. Override:
 *   AGENT_MCP_LIVE_PROVIDER=anthropic AGENT_MCP_BUDGET_LIVE=1 npx nx test agent-mcp
 */

import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isLive = process.env["AGENT_MCP_BUDGET_LIVE"] === "1";

const LIVE_PROVIDER =
    process.env["AGENT_MCP_LIVE_PROVIDER"] === "anthropic"
        ? {
              type: "anthropic" as const,
              model: "claude-haiku-4-5-20251001",
              authTokenEnv: "ANTHROPIC_AUTH_TOKEN",
              maxTokens: 256,
              timeoutMs: 30_000,
          }
        : {
              type: "lmstudio" as const,
              model: process.env["AGENT_MCP_LIVE_MODEL"] ?? "qwen2.5-14b-instruct",
              maxTokens: 256,
              // 180s — matches the known-working math_worker config for qwen2.5-14b-instruct
              // on this machine (model may need to load from cold start)
              timeoutMs: 180_000,
          };

const CALC_SERVER = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/calc-server.mjs"
);

describe.skipIf(!isLive)(
    `live-budget.e2e — budget enforcement against real ${LIVE_PROVIDER.type} (AGENT_MCP_BUDGET_LIVE=1 only)`,
    () => {
        it("task fails with BUDGET_EXCEEDED when maxModelCalls:1 and tool forces second model call", async () => {
            const { buildHarness, drainQueue } = await import("./harness.js");
            const { agentTool } = await import("../../tools/session.js");
            const { taskTool, resultTool } = await import("../../tools/task.js");
            const { createPlugin, configSchema } = await import("@adhd/agent-mcp-budget");
            const { generateId } = await import("../../utils/ids.js");
            const { tasksTable, taskEventsTable } = await import("../../db/schema.js");
            const { eq } = await import("drizzle-orm");

            const harness = await buildHarness({ skipOrphanScan: true });

            try {
                // Install budget plugin: 1 model call max
                const plugin = createPlugin({
                    db: harness.rawSqlite,
                    config: configSchema.parse({ scope: "task", maxModelCalls: 1 }),
                });
                await plugin.install(harness.hooks);

                // Create agent with the calc tool wired in
                const agentName = `budget-live-${generateId()}`;
                harness.agentStore.create({
                    name: agentName,
                    provider: LIVE_PROVIDER,
                    systemPrompt:
                        "You are a calculator assistant. When asked to calculate something, " +
                        "you MUST use the calculate tool — never compute in your head.",
                    mcpServers: {
                        calc: {
                            transport: "stdio",
                            command: "node",
                            args: [CALC_SERVER],
                            env: { CALC_LOG: "/dev/null" },
                        },
                    },
                    permissions: {},
                });

                // Open a session
                const sessionResult = await agentTool(
                    { name: agentName },
                    harness.taskDeps,
                );
                const sessionId = (sessionResult as { session_id: string }).session_id;

                // Submit task in background — model will use calc tool (turn 1),
                // then budget enforcement blocks the follow-up completion call (turn 2).
                // Must be background so drainQueue can observe the terminal status.
                await taskTool(
                    {
                        session_id: sessionId,
                        prompt: "What is 17 + 25? Use the calculate tool.",
                        background: true,
                    },
                    harness.taskDeps,
                );

                // Allow up to 90s for the live model to complete both turns
                await drainQueue(harness.queue, 90_000);

                // Fetch the task for this session
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const db = harness.db as any;
                const tasks = db
                    .select()
                    .from(tasksTable)
                    .where(eq(tasksTable.sessionId, sessionId))
                    .all() as Array<{ id: string; status: string; error: string | null }>;

                expect(tasks.length).toBeGreaterThan(0);

                const task = tasks[0]!;

                // Primary assertion: task failed due to budget enforcement
                expect(task.status).toBe("failed");
                expect(task.error).toContain("BUDGET_EXCEEDED");

                // Secondary: TASK_FAILED event written to task_events
                const events = db
                    .select()
                    .from(taskEventsTable)
                    .where(eq(taskEventsTable.taskId, task.id))
                    .all() as Array<{ type: string }>;

                const failedEvent = events.find((e) => e.type === "TASK_FAILED");
                expect(failedEvent).toBeDefined();

                console.log(
                    `[live-budget] task ${task.id} failed as expected: ${task.error}`
                );
            } finally {
                await harness.teardown();
            }
        }, 300_000); // 5 minutes — allows 180s model timeout + tool execution + drain
    }
);
