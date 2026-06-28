/**
 * live-dag.e2e.test.ts
 *
 * AUTHOR ONLY — gated behind AGENT_MCP_LIVE=1. Skipped in CI/unit runs.
 *
 * Codifies the complex recursive multi-agent DAG that was verified live by hand:
 *
 *     dag-coordinator  (multiply_set)
 *        └─ delegates the whole op list ──▶ dag-fanout
 *                                              └─ delegates EACH op ──▶ dag-worker × N
 *                                                                          └─ calls the `calculate` tool
 *        └─ multiplies the returned results with a final `calculate` call
 *
 * It drives a REAL model (LM Studio or Anthropic) through the REAL production
 * recursion path: agents whose `mcpServers` include `"agent-mcp"` route tool
 * calls in-process (InProcessMcpClient) via the wired inProcessHandler, exactly
 * as server.ts does; the worker's `calc` tool is a real stdio MCP server
 * (fixtures/calc-server.mjs).
 *
 * Asserts only MODEL-INDEPENDENT invariants (robust to how many ops the model
 * chooses to delegate):
 *   - the root task completes;
 *   - 3-level recursion actually happened (a worker task exists at recursion
 *     depth 2, child of a fanout task, child of the coordinator);
 *   - EVERY worker task that ran invoked the `calc__calculate` tool (i.e. no
 *     worker computed arithmetic in-model) — TOOL_CALL + TOOL_RESULT persisted;
 *   - those worker tasks are OBSERVABLE even though they run ephemerally
 *     (tasks row + task_events persisted; the ephemeral-observability feature).
 *
 * Run: AGENT_MCP_LIVE=1 AGENT_MCP_LIVE_PROVIDER=lmstudio npx nx test agent-mcp
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const isLive = process.env["AGENT_MCP_LIVE"] === "1";

// Keep the calc fixture's log out of the repo (it defaults to writing next to
// itself); send it to a temp file the test doesn't assert on.
const CALC_LOG = path.join(os.tmpdir(), "agent-mcp-dag-calc.log");

// Provider reliability (observed, not assumed): with the default Anthropic
// provider this test passed 100% of runs; with a local lmstudio 14B it passed
// ~5/6 — the occasional miss was one delegation call where the model dropped
// `prompt` from the agent-mcp__task args (the in-process handler logs the raw
// payload on such a validation failure). The recursion wiring + tool schemas
// are identical across providers, so the difference is the model's tool-call
// formatting, not the harness. Default to Anthropic for a stable signal.

const LIVE_PROVIDER =
    process.env["AGENT_MCP_LIVE_PROVIDER"] === "lmstudio"
        ? {
              type: "openai" as const,
              model:
                  process.env["AGENT_MCP_LIVE_MODEL"] ?? "qwen2.5-14b-instruct",
              baseURL: process.env["LMSTUDIO_BASE_URL"] ?? "http://localhost:1234/v1",
              timeoutMs: 240_000,
          }
        : {
              type: "anthropic" as const,
              model: "claude-sonnet-4-6",
              env: { secret: "ADHD_AGENT_ANTHROPIC_SECRET" },
              timeoutMs: 60_000,
          };

const CALC_SERVER = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/calc-server.mjs"
);

describe.skipIf(!isLive)(
    `live-dag.e2e – recursive multi-agent DAG, real ${LIVE_PROVIDER.type} (AGENT_MCP_LIVE=1 only)`,
    () => {
        it("coordinator → fanout → workers: every worker uses the calc tool, recursion + ephemeral rows observable", async () => {
            if (!isLive) return;

            const { buildHarness } = await import("./harness.js");
            const { agentTool } = await import("../../tools/session.js");
            const { taskTool, resultTool } = await import("../../tools/task.js");
            const {
                agentToolInputSchema,
                taskToolInputSchema,
                resultInputSchema,
            } = await import("../../validation/index.js");
            const { toMcpInputSchema } = await import("../../server.js");
            const { taskEventsTable, tasksTable } = await import("../../db/schema.js");
            const { eq } = await import("drizzle-orm");

            const harness = await buildHarness();

            // ── Wire the production in-process recursion path ──────────────────
            // Same shape as server.ts: a self-referential inProcessHandler so a
            // delegated agent-mcp__task recurses with the same wiring.
            // Real schemas (same conversion server.ts uses) so the model knows
            // each tool's parameters — an empty schema makes the model guess and
            // produce malformed agent-mcp__task args (Zod union failure), which
            // silently breaks delegation.
            const inProcessDescriptors = [
                { name: "agent", description: "Instantiate a session for a named agent", inputSchema: toMcpInputSchema(agentToolInputSchema) },
                { name: "task", description: "Run a prompt against a session or a one-shot agent_name task", inputSchema: toMcpInputSchema(taskToolInputSchema) },
                { name: "result", description: "Get the result of a task", inputSchema: toMcpInputSchema(resultInputSchema) },
            ];

            // eslint-disable-next-line prefer-const
            let recursiveDeps: Parameters<typeof taskTool>[1];

            const inProcessHandler = async (
                toolName: string,
                args: unknown,
                ctx: Parameters<typeof taskTool>[2]
            ): Promise<unknown> => {
                switch (toolName) {
                    case "agent":
                        return agentTool(
                            agentToolInputSchema.parse(args),
                            {
                                agentStore: harness.agentStore,
                                sessionStore: harness.sessionStore,
                                policy: harness.policy,
                            },
                            ctx
                        );
                    case "task": {
                        let parsed;
                        try {
                            parsed = taskToolInputSchema.parse(args);
                        } catch (e) {
                            // Surface the raw model-sent args on a delegation
                            // validation failure. Evidence from captured runs:
                            // the model's normal emission is well-formed —
                            // {session_id:""|null, agent_name, prompt} (accepted
                            // by the agent_name union branch) — but a small model
                            // occasionally drops `prompt` from one call, which
                            // fails validation and aborts that delegation. This
                            // log makes the exact payload visible if it recurs.
                            // eslint-disable-next-line no-console
                            console.error(
                                "agent-mcp__task validation failed; raw args=" +
                                    JSON.stringify(args)
                            );
                            throw e;
                        }
                        return taskTool(parsed, recursiveDeps, ctx);
                    }
                    case "result":
                        return resultTool(resultInputSchema.parse(args), {
                            taskStore: harness.taskStore,
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            db: harness.taskDeps.db as any,
                        });
                    default:
                        throw new Error(`unexpected in-process tool: ${toolName}`);
                }
            };

            recursiveDeps = {
                ...harness.taskDeps,
                selfUrl: undefined,
                inProcessDescriptors,
                inProcessHandler,
            };

            try {
                // ── Agents ─────────────────────────────────────────────────────
                harness.agentStore.create({
                    name: "dag-worker",
                    provider: LIVE_PROVIDER,
                    systemPrompt:
                        "You are a math worker. You receive a SINGLE arithmetic operation as text " +
                        '(e.g. "12 * 12"). You MUST call the `calculate` tool with that exact ' +
                        "expression — never compute it yourself. Reply with ONLY the numeric result.",
                    mcpServers: {
                        calc: { transport: "stdio", command: "node", args: [CALC_SERVER], env: { CALC_LOG } },
                    },
                    permissions: {},
                });

                harness.agentStore.create({
                    name: "dag-fanout",
                    provider: LIVE_PROVIDER,
                    systemPrompt:
                        "You are a fan-out coordinator. You receive a JSON array of arithmetic " +
                        "operations. For EACH operation, delegate it to the dag-worker agent: call " +
                        'agent-mcp__task with {"agent_name":"dag-worker","prompt":"<operation>"}. One ' +
                        "call per operation. Never compute any operation yourself. When all are done, " +
                        "reply with ONLY a JSON array of the numeric results in order.",
                    mcpServers: { "agent-mcp": { transport: "stdio", command: "node", args: ["noop"] } },
                    permissions: { allowedAgents: ["dag-worker"] },
                });

                harness.agentStore.create({
                    name: "dag-coordinator",
                    provider: LIVE_PROVIDER,
                    systemPrompt:
                        "You multiply the results of a set of arithmetic operations. Step 1: delegate " +
                        'the ENTIRE list to the dag-fanout agent — call agent-mcp__task with ' +
                        '{"agent_name":"dag-fanout","prompt":"<the JSON list>"}. It returns a JSON array ' +
                        "of results. Step 2: call the `calculate` tool ONCE to multiply all those results " +
                        "together. Reply with the final product.",
                    mcpServers: {
                        "agent-mcp": { transport: "stdio", command: "node", args: ["noop"] },
                        calc: { transport: "stdio", command: "node", args: [CALC_SERVER], env: { CALC_LOG } },
                    },
                    permissions: { allowedAgents: ["dag-fanout"] },
                });

                const coordDef = harness.agentStore.read("dag-coordinator");
                const session = harness.sessionStore.create({
                    agentName: "dag-coordinator",
                    agentDefinition: coordDef,
                });

                // ── Run the DAG ─────────────────────────────────────────────────
                const out = await taskTool(
                    {
                        session_id: session.id,
                        prompt:
                            'Multiply the results of these operations together: ["12 * 12", "5 + 7", "9 * 3"]. ' +
                            "Delegate the whole list to dag-fanout first, then multiply the returned results " +
                            "with a single calculate call.",
                        background: false,
                    },
                    recursiveDeps
                );

                // ── Model-independent invariants ────────────────────────────────
                expect(out.status).toBe("completed");

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const db = harness.taskDeps.db as any;
                // drizzle .select() returns SCHEMA property names (camelCase),
                // not DB column names — recursionDepth, not recursion_depth.
                const allTasks = db.select().from(tasksTable).all() as Array<{
                    id: string;
                    parentTaskId: string | null;
                    recursionDepth: number;
                    isEphemeral: boolean;
                    prompt: string;
                }>;

                // 3-level recursion: at least one task at recursion depth 2 (a worker).
                const depth2 = allTasks.filter((t) => t.recursionDepth === 2);
                expect(depth2.length).toBeGreaterThanOrEqual(1);

                // Identify worker tasks = depth-2 tasks (children of a fanout task).
                // Every worker that ran MUST have invoked calc__calculate (no in-model math).
                for (const worker of depth2) {
                    const events = db
                        .select()
                        .from(taskEventsTable)
                        .where(eq(taskEventsTable.taskId, worker.id))
                        .all() as Array<{ type: string; payload: string | null }>;
                    const toolCalls = events.filter((e) => e.type === "TOOL_CALL");
                    const calcCalls = toolCalls.filter(
                        (e) => (e.payload ?? "").includes("calc__calculate")
                    );
                    expect(
                        calcCalls.length,
                        `worker task ${worker.id} ("${worker.prompt}") must call calc__calculate, not compute in-model`
                    ).toBeGreaterThanOrEqual(1);
                    // The worker ran ephemerally (agent_name mode) yet is observable:
                    // it has a persisted tasks row (already in allTasks) AND events.
                    expect(events.some((e) => e.type === "TOOL_RESULT")).toBe(true);
                }

                // Recursion chain: each depth-2 worker's parent is a depth-1 fanout task,
                // whose parent is the depth-0 coordinator (the root task).
                const byId = new Map(allTasks.map((t) => [t.id, t]));
                const sampleWorker = depth2[0];
                const parent = sampleWorker.parentTaskId ? byId.get(sampleWorker.parentTaskId) : undefined;
                expect(parent, "worker must have a fanout parent").toBeDefined();
                expect(parent!.recursionDepth).toBe(1);
                const grandparent = parent!.parentTaskId ? byId.get(parent!.parentTaskId) : undefined;
                expect(grandparent, "fanout must have a coordinator parent").toBeDefined();
                expect(grandparent!.recursionDepth).toBe(0);
            } finally {
                await harness.teardown();
            }
        }, 300_000);
    }
);
