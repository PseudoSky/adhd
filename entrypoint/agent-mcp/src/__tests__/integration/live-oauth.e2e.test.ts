/**
 * live-oauth.e2e.test.ts
 *
 * AUTHOR ONLY — DO NOT RUN in the CI/unit test suite.
 *
 * Gated behind AGENT_MCP_LIVE=1 environment variable.
 * Uses the real Anthropic provider with Claude OAuth (useClaudeOauth: true).
 * Drives the full orchestrator loop with real model responses.
 *
 * Asserts only model-independent invariants:
 *  - Task completes (status === "completed")
 *  - Two tool_call events fired (for the "call both tools" prompt)
 *  - request_human_input suspends task and taskResume completes it
 *
 * To run: AGENT_MCP_LIVE=1 npx nx test agent-mcp
 */

import { describe, it, expect } from "vitest";
import { taskTool, taskResume, createProvider } from "@adhd/agent-engine-orchestrator";

const isLive = process.env["AGENT_MCP_LIVE"] === "1";

const LIVE_PROVIDER =
    process.env["AGENT_MCP_LIVE_PROVIDER"] === "lmstudio"
        ? {
              type: "openai" as const,
              model:
                  process.env["AGENT_MCP_LIVE_MODEL"] ??
                  "qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8",
              baseURL: process.env["LMSTUDIO_BASE_URL"] ?? "http://localhost:1234/v1",
              env: { secret: "ADHD_AGENT_OPENAI_SECRET" },
              timeoutMs: 120_000,
          }
        : {
              type: "anthropic" as const,
              model: "claude-sonnet-4-6",
              env: { secret: "ADHD_AGENT_ANTHROPIC_SECRET" },
              timeoutMs: 30_000,
          };

describe.skipIf(!isLive)(`live-oauth.e2e – real ${LIVE_PROVIDER.type} provider (AGENT_MCP_LIVE=1 only)`, () => {
    it("two echo tools called in one turn via real model", async () => {
        if (!isLive) return;

        const { buildHarness } = await import("./harness.js");

        const harness = await buildHarness({ withSse: true });

        try {
            const agentName = "e2e-live-agent";
            harness.agentStore.create({
                name: agentName,
                provider: LIVE_PROVIDER,
                systemPrompt: "You are a test agent. When asked to call both tools, call them in one turn.",
                mcpServers: {},
                permissions: {},
            });

            const agentDef = harness.agentStore.read(agentName);
            const session = harness.sessionStore.create({ agentName, agentDefinition: agentDef });

            // Real provider from the factory
            const provider = createProvider(agentDef.provider, agentDef.mcpServers);

            // Two echo tools as in-process stubs
            const echoCallLog: string[] = [];

            const patchedDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<typeof harness.orchestrator.run>[0]) => {
                        const stubRegistry = {
                            listAllTools: async () => [
                                { name: "test-server__echo-a", description: "echo a", inputSchema: { type: "object", properties: {} } },
                                { name: "test-server__echo-b", description: "echo b", inputSchema: { type: "object", properties: {} } },
                            ],
                            getClient: async (_name: string) => ({
                                listTools: async () => [
                                    { name: "echo-a", description: "echo a", inputSchema: {} },
                                    { name: "echo-b", description: "echo b", inputSchema: {} },
                                ],
                                callTool: async (tool: string, args: unknown) => {
                                    echoCallLog.push(tool);
                                    return `echo:${tool}:${JSON.stringify(args)}`;
                                },
                                close: async () => { /* no-op: test stub */ },
                            }),
                            closeAll: async () => { /* no-op: test stub */ },
                        };

                        return harness.orchestrator.run({
                            ...input,
                            provider,
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            registry: stubRegistry as any,
                        });
                    },
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any;

            const taskOut = await taskTool(
                {
                    session_id: session.id,
                    prompt: "Please call both echo-a and echo-b tools now in a single turn. Call them both at once.",
                    background: false,
                },
                patchedDeps
            );

            // Model-independent invariants only
            expect(taskOut.status).toBe("completed");
            expect(echoCallLog).toContain("echo-a");
            expect(echoCallLog).toContain("echo-b");
        } finally {
            await harness.teardown();
        }
    }, 60_000);

    it("request_human_input + taskResume via real model (allowHumanInput=true → model must suspend)", async () => {
        if (!isLive) return;

        const { buildHarness, drainQueue } = await import("./harness.js");

        const harness = await buildHarness();

        try {
            const agentName = "e2e-live-hitl-agent";
            // allowHumanInput: true → builtin__request_human_input is advertised to the model
            harness.agentStore.create({
                name: agentName,
                provider: LIVE_PROVIDER,
                systemPrompt:
                    "You are a test agent. When the user asks you to call request_human_input, " +
                    "you MUST call the builtin__request_human_input tool before responding. " +
                    "Do not answer without calling that tool first.",
                mcpServers: {},
                permissions: {},
                allowHumanInput: true,
            });

            const agentDef = harness.agentStore.read(agentName);
            const session = harness.sessionStore.create({ agentName, agentDefinition: agentDef });
            const provider = createProvider(agentDef.provider, agentDef.mcpServers);

            const patchedDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<typeof harness.orchestrator.run>[0]) =>
                        harness.orchestrator.run({
                            ...input,
                            provider,
                            registry: {
                                listAllTools: async () => [],
                                getClient: async () => { throw new Error("no tools"); },
                                closeAll: async () => { /* no-op: test stub */ },
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            } as any,
                        }),
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any;

            // Launch background so we can intercept the suspension
            const taskOut = await taskTool(
                {
                    session_id: session.id,
                    prompt:
                        "Please call request_human_input to ask me 'do you confirm?' before you respond. " +
                        "You must call it — do not skip it.",
                    background: true,
                },
                patchedDeps
            );

            const taskId = taskOut.task_id;

            // Wait for awaiting_input — no lenient fallback
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
                const row = harness.taskStore.read(taskId);
                if (row.status === "awaiting_input") break;
                if (["completed", "failed", "cancelled"].includes(row.status)) break;
                await new Promise((r) => setTimeout(r, 200));
            }

            const suspended = harness.taskStore.read(taskId);
            expect(suspended.status).toBe("awaiting_input");
            expect(suspended.resumeToken).toBeTruthy();

            // Resume with human answer
            const resumeToken = suspended.resumeToken;
            if (!resumeToken) throw new Error("expected resumeToken to be defined");
            await taskResume(
                {
                    taskId,
                    resumeToken,
                    userInput: "yes, confirmed",
                },
                { taskStore: harness.taskStore }
            );

            await drainQueue(harness.queue, 30_000);

            const final = harness.taskStore.read(taskId);
            expect(final.status).toBe("completed");
        } finally {
            await harness.teardown();
        }
    }, 120_000);
});
