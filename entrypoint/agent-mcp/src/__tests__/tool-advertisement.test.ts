import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
    ExecutionContext,
    LLMProvider,
    McpClientRegistry,
    Message,
    OrchestratorSessionStore,
    OrchestratorTaskStore,
    ProviderChatRequest,
    ToolDefinition,
} from "@adhd/agent-engine-orchestrator";
import {
    Orchestrator,
    PolicyEngine,
    renderToolPromptDoc,
    toNameOnlyTools,
} from "@adhd/agent-engine-orchestrator";

const generateId = () => randomUUID();
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Distinctive marker that must NEVER appear in name-only wire tools. */
const SECRET = "THE_SECRET_PARAM_DOC";

const RICH_TOOL: ToolDefinition = {
    name: "filesystem__read_text_file",
    description:
        "Read the complete contents of a file.\nLong second line with operational detail that belongs in the prompt doc, not the slim wire description.",
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: `Absolute path ${SECRET} to read` },
            head: { type: "number" },
            mode: { enum: ["preview", "full"] },
            tags: { type: "array", items: { type: "string" } },
        },
        required: ["path"],
    },
};

function makeRegistry(tools: ToolDefinition[]): McpClientRegistry {
    return {
        listAllTools: async () => tools.map(t => ({ ...t })),
        closeAll: async () => { /* no-op: test stub */ },
        getClient: async () => ({
            callTool: async () => ({ ok: true }),
        }),
    } as unknown as McpClientRegistry;
}

const policy = {
    check: () => { /* no-op: test stub — policy always permits */ },
} as unknown as PolicyEngine;

/** OrchestratorTaskStore stub that records every appended event for assertions. */
function makeTaskStore() {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const store = {
        updateStatus: () => { /* no-op */ },
        appendEvent: (e: { taskId: string; type: string; payload?: unknown }) => {
            events.push({ type: e.type, payload: (e.payload ?? {}) as Record<string, unknown> });
        },
        unregisterCancellation: () => { /* no-op */ },
    } as unknown as OrchestratorTaskStore;
    return { store, events };
}

const sessionStore = {
    appendMessage: () => { /* no-op */ },
    close: () => { /* no-op */ },
} as unknown as OrchestratorSessionStore;

function makeCtx(
    defOverrides: Partial<ExecutionContext["agentDefinition"]> = {}
): ExecutionContext {
    return {
        taskId: generateId(),
        sessionId: generateId(),
        agentName: "test-agent",
        agentDefinition: {
            name: "test-agent",
            version: 1,
            provider: { type: "openai", model: "gpt-4o-mini" },
            systemPrompt: "You are helpful.",
            mcpServers: {},
            permissions: {},
            ...defOverrides,
        },
        recursionDepth: 0,
        toolCallCount: 0,
    } as ExecutionContext;
}

function systemMessage(sessionId: string): Message {
    return {
        id: generateId(),
        sessionId,
        role: "system",
        content: "You are helpful.",
        createdAt: nowIso(),
    };
}

function userMessage(sessionId: string): Message {
    return {
        id: generateId(),
        sessionId,
        role: "user",
        content: "hello",
        createdAt: nowIso(),
    };
}

/** Provider that captures every chat request; scripted responses in order. */
function capturingProvider(
    responses: Array<"completed" | "tool_call">,
    rawUsage?: unknown
) {
    const requests: ProviderChatRequest[] = [];
    let call = 0;
    const provider: LLMProvider = {
        chat: async request => {
            requests.push(request);
            const kind = responses[Math.min(call, responses.length - 1)];
            call++;
            if (kind === "tool_call") {
                return {
                    message: {
                        id: generateId(),
                        sessionId: generateId(),
                        role: "assistant" as const,
                        content: "",
                        toolCalls: [
                            {
                                id: `call-${call}`,
                                server: "filesystem",
                                tool: "read_text_file",
                                arguments: { path: "/x" },
                            },
                        ],
                        createdAt: nowIso(),
                    },
                    stopReason: "tool_calls" as const,
                    usage: { inputTokens: 100 * call, outputTokens: 10 },
                    rawUsage,
                };
            }
            return {
                message: {
                    id: generateId(),
                    sessionId: generateId(),
                    role: "assistant" as const,
                    content: "done",
                    createdAt: nowIso(),
                },
                stopReason: "completed" as const,
                usage: { inputTokens: 100 * call, outputTokens: 10 },
                rawUsage,
            };
        },
    };
    return { provider, requests };
}

async function run(
    ctx: ExecutionContext,
    provider: LLMProvider,
    messages: Message[],
    tools: ToolDefinition[] = [RICH_TOOL],
    taskStore = makeTaskStore().store
) {
    return new Orchestrator().run({
        executionContext: ctx,
        messages,
        registry: makeRegistry(tools),
        provider,
        policy,
        taskStore,
        sessionStore,
        signal: new AbortController().signal,
        taskId: generateId(),
    });
}

// ---------------------------------------------------------------------------
// Unit: doc rendering + slim conversion
// ---------------------------------------------------------------------------

describe("renderToolPromptDoc", () => {
    it("documents name, description, and typed parameters with required markers", () => {
        const doc = renderToolPromptDoc([RICH_TOOL]);
        expect(doc).toContain("## Available Tools");
        expect(doc).toContain("### filesystem__read_text_file");
        expect(doc).toContain("Read the complete contents of a file.");
        expect(doc).toContain(`- \`path\` (string, required) — Absolute path ${SECRET} to read`);
        expect(doc).toContain("- `head` (number)");
        expect(doc).toContain('- `mode` (enum("preview" | "full"))');
        expect(doc).toContain("- `tags` (string[])");
    });

    it("sorts tools by name for a byte-stable, cache-friendly block", () => {
        const doc = renderToolPromptDoc([
            { ...RICH_TOOL, name: "zeta__tool" },
            { ...RICH_TOOL, name: "alpha__tool" },
        ]);
        expect(doc.indexOf("### alpha__tool")).toBeLessThan(doc.indexOf("### zeta__tool"));
    });

    it("renders schema-less tools without crashing", () => {
        const doc = renderToolPromptDoc([
            { name: "bare__tool", description: "", inputSchema: {} },
        ]);
        expect(doc).toContain("### bare__tool");
        expect(doc).toContain("Parameters: none");
    });
});

describe("toNameOnlyTools", () => {
    it("strips schemas to a permissive object and keeps the first description line", () => {
        const [slim] = toNameOnlyTools([RICH_TOOL]);
        expect(slim.name).toBe(RICH_TOOL.name);
        expect(slim.description).toBe("Read the complete contents of a file.");
        expect(slim.inputSchema).toEqual({
            type: "object",
            properties: {},
            additionalProperties: true,
        });
        expect(JSON.stringify(slim)).not.toContain(SECRET);
    });

    it("truncates over-long single-line descriptions with an ellipsis", () => {
        const [slim] = toNameOnlyTools([
            { name: "t", description: "x".repeat(300), inputSchema: {} },
        ]);
        expect(slim.description).toBeDefined();
        if (!slim.description) throw new Error("expected description");
        expect(slim.description.length).toBeLessThanOrEqual(140);
        expect(slim.description.endsWith("…")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Behavioral: orchestrator wire contract
// ---------------------------------------------------------------------------

describe("Orchestrator tool advertisement", () => {
    it("default mode is 'names': slim tools on the wire, full doc prepended to the system message", async () => {
        const ctx = makeCtx();
        const { provider, requests } = capturingProvider(["completed"]);
        await run(ctx, provider, [systemMessage(ctx.sessionId), userMessage(ctx.sessionId)]);

        expect(requests).toHaveLength(1);
        const [request] = requests;

        // Wire tools are name-only — the rich schema must NOT be serialized.
        expect(request.tools).toHaveLength(1);
        if (!request.tools) throw new Error("expected tools");
        expect(request.tools[0].inputSchema).toEqual({
            type: "object",
            properties: {},
            additionalProperties: true,
        });
        expect(JSON.stringify(request.tools)).not.toContain(SECRET);

        // Full documentation rides in the system message, BEFORE the original prompt.
        const system = request.messages[0];
        expect(system.role).toBe("system");
        expect(system.content).toContain("## Available Tools");
        expect(system.content).toContain(SECRET);
        expect(system.content.indexOf("## Available Tools")).toBeLessThan(
            system.content.indexOf("You are helpful.")
        );
    });

    it("'full' mode passes complete schemas through and leaves the system message untouched", async () => {
        const ctx = makeCtx({ toolAdvertisement: "full" });
        const { provider, requests } = capturingProvider(["completed"]);
        await run(ctx, provider, [systemMessage(ctx.sessionId), userMessage(ctx.sessionId)]);

        const [request] = requests;
        expect(JSON.stringify(request.tools)).toContain(SECRET);
        expect(request.messages[0].content).toBe("You are helpful.");
        expect(request.messages[0].content).not.toContain("## Available Tools");
    });

    it("synthesizes a system message carrying the doc when the task has none", async () => {
        const ctx = makeCtx();
        const { provider, requests } = capturingProvider(["completed"]);
        await run(ctx, provider, [userMessage(ctx.sessionId)]);

        const [request] = requests;
        expect(request.messages[0].role).toBe("system");
        expect(request.messages[0].content).toContain("## Available Tools");
        expect(request.messages[1].role).toBe("user");
    });

    it("does not persist the doc: input messages are left unmodified", async () => {
        const ctx = makeCtx();
        const input = [systemMessage(ctx.sessionId), userMessage(ctx.sessionId)];
        const { provider } = capturingProvider(["completed"]);
        await run(ctx, provider, input);
        expect(input[0].content).toBe("You are helpful.");
    });

    it("keeps the doc-carrying system message byte-identical across turns (cache-stable prefix)", async () => {
        const ctx = makeCtx();
        const { provider, requests } = capturingProvider(["tool_call", "completed"]);
        await run(ctx, provider, [systemMessage(ctx.sessionId), userMessage(ctx.sessionId)]);

        expect(requests).toHaveLength(2);
        expect(requests[0].messages[0].content).toBe(requests[1].messages[0].content);
        expect(requests[1].messages[0].content).toContain("## Available Tools");
    });

    it("sends no tools field when the registry has no tools", async () => {
        const ctx = makeCtx();
        const { provider, requests } = capturingProvider(["completed"]);
        await run(ctx, provider, [systemMessage(ctx.sessionId), userMessage(ctx.sessionId)], []);

        const [request] = requests;
        expect(request.tools).toBeUndefined();
        expect(request.messages[0].content).toBe("You are helpful.");
    });
});

// ---------------------------------------------------------------------------
// Behavioral: raw usage + advertisement mode persisted per turn
// ---------------------------------------------------------------------------

describe("Orchestrator per-turn event payloads", () => {
    it("persists the provider's raw usage verbatim on MODEL_RESPONSE events", async () => {
        const ctx = makeCtx();
        const raw = { prompt_cache_hit_tokens: 123, provider_specific: "kept" };
        const { provider } = capturingProvider(["completed"], raw);
        const { store, events } = makeTaskStore();
        await run(ctx, provider, [systemMessage(ctx.sessionId), userMessage(ctx.sessionId)], [RICH_TOOL], store);

        const responses = events.filter(e => e.type === "MODEL_RESPONSE");
        expect(responses).toHaveLength(1);
        expect(responses[0].payload.rawUsage).toEqual(raw);
        expect(responses[0].payload.inputTokens).toBe(100);
    });

    it("records the advertisement mode on MODEL_REQUEST events", async () => {
        const ctx = makeCtx();
        const { provider } = capturingProvider(["completed"]);
        const { store, events } = makeTaskStore();
        await run(ctx, provider, [systemMessage(ctx.sessionId), userMessage(ctx.sessionId)], [RICH_TOOL], store);

        const requests = events.filter(e => e.type === "MODEL_REQUEST");
        expect(requests).toHaveLength(1);
        expect(requests[0].payload.toolAdvertisement).toBe("names");
    });
});
