/**
 * BUG-002: delegation-opened sessions orphaned on task failure.
 *
 * When an orchestrating task calls the `agent` tool (opening a session for a
 * sub-agent) and then fails, the sub-agent's session was left `active` forever.
 * Because AgentStore.delete() hard-refuses while any session is active
 * (AGENT_HAS_ACTIVE_SESSIONS), the sub-agent became permanently undeletable.
 *
 * Fix (orchestrator): track session IDs returned by `agent-mcp__agent` tool calls
 * during a task; on failure or cancellation, close them in the `finally` block.
 * Fix (agent_delete): add `force: true` as a recovery escape hatch that closes
 * active sessions before deleting.
 *
 * Teeth checks:
 *   1. Reverting the `delegationSessions` tracking / close-in-finally → the
 *      mock sessionStore.close() is never called and the test asserting it was
 *      called goes red.
 *   2. Removing the force-delete path in agentDelete → force: true no longer
 *      closes sessions, agentStore.delete() receives an agent with an active
 *      session and (in the real store) throws AGENT_HAS_ACTIVE_SESSIONS.
 */
import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../engine/orchestrator.js";
import { agentDelete } from "../tools/agent-crud.js";
import { ToolError } from "../validation/errors.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";
import type { LLMProvider, ProviderChatResponse } from "../providers/types.js";
import type { ExecutionContext, Message } from "../validation/index.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { TaskStore } from "../store/task-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { AgentStore } from "../store/agent-store.js";
import { PolicyEngine } from "../engine/policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): ExecutionContext {
    return {
        taskId: generateId(),
        sessionId: generateId(),
        agentName: "lead",
        agentDefinition: {
            name: "lead",
            version: 1,
            provider: { type: "openai", model: "gpt-4o-mini", timeoutMs: 5_000 },
            systemPrompt: "You are a lead agent.",
            mcpServers: {},
            permissions: {},
            createdAt: nowIso(),
            updatedAt: nowIso(),
        },
        recursionDepth: 0,
        toolCallCount: 0,
    };
}

function makeUserMessage(sessionId: string): Message {
    return { id: generateId(), sessionId, role: "user", content: "run", createdAt: nowIso() };
}

const policy = { check: () => { /* no-op: test stub — policy always permits */ } } as unknown as PolicyEngine;

const baseTaskStore = {
    updateStatus: () => { /* no-op: test stub */ },
    appendEvent: () => { /* no-op: test stub */ },
    unregisterCancellation: () => { /* no-op: test stub */ },
} as unknown as TaskStore;

// ---------------------------------------------------------------------------
// BUG-002 Part A: orchestrator closes delegation sessions on task failure
// ---------------------------------------------------------------------------

describe("BUG-002 — orchestrator closes delegation sessions on failure", () => {
    it("calls sessionStore.close() for a session opened via agent-mcp__agent when the task fails", async () => {
        const subSessionId = generateId();
        const closeSpy = vi.fn();

        // Provider: first turn returns an `agent-mcp__agent` tool call,
        // second turn throws to simulate task failure.
        let callCount = 0;
        const provider: LLMProvider = {
            chat: async (): Promise<ProviderChatResponse> => {
                callCount++;
                if (callCount === 1) {
                    // First call: model calls the agent tool
                    return {
                        message: {
                            id: generateId(),
                            sessionId: "",
                            role: "assistant",
                            toolCalls: [{
                                id: "call-1",
                                server: "agent-mcp",
                                tool: "agent",
                                arguments: { name: "synth-coder" },
                            }],
                            createdAt: nowIso(),
                        },
                        stopReason: "tool_calls",
                    };
                }
                // Second call: provider fails (e.g. PROVIDER_ERROR)
                throw new ToolError("PROVIDER_ERROR", "provider blew up");
            },
        };

        // Registry: `agent-mcp__agent` returns a session_id; any other client
        // is fine to throw since we only care about the agent tool call.
        const registry = {
            listAllTools: async () => [{ name: "agent-mcp__agent", description: "", inputSchema: {} }],
            closeAll: async () => { /* no-op: test stub */ },
            resolveToolName: undefined,
            getClient: async (server: string) => ({
                callTool: async (tool: string) => {
                    if (server === "agent-mcp" && tool === "agent") {
                        return { session_id: subSessionId };
                    }
                    throw new Error("unexpected tool call");
                },
            }),
        } as unknown as McpClientRegistry;

        const sessionStore = {
            appendMessage: () => { /* no-op: test stub */ },
            close: closeSpy,
        } as unknown as SessionStore;

        const orch = new Orchestrator();
        await expect(
            orch.run({
                executionContext: makeCtx(),
                messages: [makeUserMessage(generateId())],
                registry,
                provider,
                policy,
                taskStore: baseTaskStore,
                sessionStore,
                signal: new AbortController().signal,
                taskId: generateId(),
            })
        ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

        // The orchestrator must have closed the delegation-opened session
        expect(closeSpy).toHaveBeenCalledWith(subSessionId);
    });

    it("does NOT close delegation sessions when the task succeeds", async () => {
        const subSessionId = generateId();
        const closeSpy = vi.fn();

        let callCount = 0;
        const provider: LLMProvider = {
            chat: async (): Promise<ProviderChatResponse> => {
                callCount++;
                if (callCount === 1) {
                    return {
                        message: {
                            id: generateId(),
                            sessionId: "",
                            role: "assistant",
                            toolCalls: [{
                                id: "call-1",
                                server: "agent-mcp",
                                tool: "agent",
                                arguments: { name: "synth-coder" },
                            }],
                            createdAt: nowIso(),
                        },
                        stopReason: "tool_calls",
                    };
                }
                // Second call: task completes normally
                return {
                    message: {
                        id: generateId(),
                        sessionId: "",
                        role: "assistant",
                        content: "done",
                        createdAt: nowIso(),
                    },
                    stopReason: "completed",
                };
            },
        };

        const registry = {
            listAllTools: async () => [{ name: "agent-mcp__agent", description: "", inputSchema: {} }],
            closeAll: async () => { /* no-op: test stub */ },
            resolveToolName: undefined,
            getClient: async (server: string) => ({
                callTool: async (tool: string) => {
                    if (server === "agent-mcp" && tool === "agent") {
                        return { session_id: subSessionId };
                    }
                    throw new Error("unexpected tool call");
                },
            }),
        } as unknown as McpClientRegistry;

        const sessionStore = {
            appendMessage: () => { /* no-op: test stub */ },
            close: closeSpy,
        } as unknown as SessionStore;

        const orch = new Orchestrator();
        const result = await orch.run({
            executionContext: makeCtx(),
            messages: [makeUserMessage(generateId())],
            registry,
            provider,
            policy,
            taskStore: baseTaskStore,
            sessionStore,
            signal: new AbortController().signal,
            taskId: generateId(),
        });

        expect(result.result).toBe("done");
        // Session must NOT be auto-closed on success — caller keeps it for reuse
        expect(closeSpy).not.toHaveBeenCalled();
    });

    it("closes delegation sessions when the task is cancelled", async () => {
        const subSessionId = generateId();
        const closeSpy = vi.fn();
        const abortController = new AbortController();

        let callCount = 0;
        const provider: LLMProvider = {
            chat: async (): Promise<ProviderChatResponse> => {
                callCount++;
                if (callCount === 1) {
                    return {
                        message: {
                            id: generateId(),
                            sessionId: "",
                            role: "assistant",
                            toolCalls: [{
                                id: "call-1",
                                server: "agent-mcp",
                                tool: "agent",
                                arguments: { name: "synth-coder" },
                            }],
                            createdAt: nowIso(),
                        },
                        stopReason: "tool_calls",
                    };
                }
                // Cancel mid-execution
                abortController.abort();
                throw new ToolError("PROVIDER_ERROR", "Task was cancelled");
            },
        };

        const registry = {
            listAllTools: async () => [{ name: "agent-mcp__agent", description: "", inputSchema: {} }],
            closeAll: async () => { /* no-op: test stub */ },
            resolveToolName: undefined,
            getClient: async (server: string) => ({
                callTool: async (tool: string) => {
                    if (server === "agent-mcp" && tool === "agent") return { session_id: subSessionId };
                    throw new Error("unexpected");
                },
            }),
        } as unknown as McpClientRegistry;

        const sessionStore = {
            appendMessage: () => { /* no-op: test stub */ },
            close: closeSpy,
        } as unknown as SessionStore;

        const orch = new Orchestrator();
        await expect(
            orch.run({
                executionContext: makeCtx(),
                messages: [makeUserMessage(generateId())],
                registry,
                provider,
                policy,
                taskStore: baseTaskStore,
                sessionStore,
                signal: abortController.signal,
                taskId: generateId(),
            })
        ).rejects.toBeDefined();

        expect(closeSpy).toHaveBeenCalledWith(subSessionId);
    });
});

// ---------------------------------------------------------------------------
// BUG-002 Part B: agent_delete force flag
// ---------------------------------------------------------------------------

describe("BUG-002 — agent_delete force closes active sessions before deleting", () => {
    it("with force: true closes active sessions then deletes the agent", () => {
        const closeSpy = vi.fn();
        const deleteSpy = vi.fn();

        const sessionStore = {
            list: vi.fn().mockReturnValue([
                { id: "sess-1", status: "active" },
                { id: "sess-2", status: "active" },
            ]),
            close: closeSpy,
        } as unknown as SessionStore;

        const agentStore = {
            delete: deleteSpy,
        } as unknown as AgentStore;

        agentDelete({ name: "synth-coder", force: true }, { agentStore, sessionStore });

        expect(sessionStore.list).toHaveBeenCalledWith({ agentName: "synth-coder", status: "active" });
        expect(closeSpy).toHaveBeenCalledWith("sess-1");
        expect(closeSpy).toHaveBeenCalledWith("sess-2");
        expect(deleteSpy).toHaveBeenCalledWith("synth-coder");
    });

    it("without force: true does NOT call sessionStore.list or close", () => {
        const closeSpy = vi.fn();
        const listSpy = vi.fn();
        const deleteSpy = vi.fn();

        const sessionStore = {
            list: listSpy,
            close: closeSpy,
        } as unknown as SessionStore;

        const agentStore = {
            delete: deleteSpy,
        } as unknown as AgentStore;

        agentDelete({ name: "synth-coder" }, { agentStore, sessionStore });

        expect(listSpy).not.toHaveBeenCalled();
        expect(closeSpy).not.toHaveBeenCalled();
        expect(deleteSpy).toHaveBeenCalledWith("synth-coder");
    });

    it("with force: true, swallows SESSION_CLOSED errors (race between close and force)", () => {
        const closeSpy = vi.fn().mockImplementation(() => {
            throw new ToolError("SESSION_CLOSED", "already closed");
        });

        const sessionStore = {
            list: vi.fn().mockReturnValue([{ id: "sess-1", status: "active" }]),
            close: closeSpy,
        } as unknown as SessionStore;

        const agentStore = { delete: vi.fn() } as unknown as AgentStore;

        // Must not throw even if close() errors
        expect(() => agentDelete({ name: "x", force: true }, { agentStore, sessionStore })).not.toThrow();
        expect(agentStore.delete).toHaveBeenCalledWith("x");
    });
});

// ---------------------------------------------------------------------------
// DEBT-001 Part: BackgroundQueue swallows task errors (error boundary)
// ---------------------------------------------------------------------------

describe("DEBT-001 — BackgroundQueue swallows task errors", () => {
    it("resolves onIdle() even when a task throws", async () => {
        const { BackgroundQueue } = await import("../engine/queue.js");
        const queue = new BackgroundQueue(1);

        queue.enqueue("task-1", async () => {
            throw new Error("task blew up");
        });

        // If the queue propagated the error, onIdle() would reject or hang
        await expect(queue.onIdle()).resolves.toBeUndefined();
    });

    it("continues processing subsequent tasks after one fails", async () => {
        const { BackgroundQueue } = await import("../engine/queue.js");
        const queue = new BackgroundQueue(1);

        const results: string[] = [];

        queue.enqueue("task-1", async () => { throw new Error("boom"); });
        queue.enqueue("task-2", async () => { results.push("task-2-ran"); });

        await queue.onIdle();

        expect(results).toContain("task-2-ran");
    });
});
