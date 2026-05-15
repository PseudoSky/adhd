import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../engine/policy.js";
import type { ExecutionContext } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";

const makeCtx = (
    overrides: Partial<ExecutionContext> = {}
): ExecutionContext => ({
    taskId: generateId(),
    sessionId: generateId(),
    agentName: "agent-a",
    agentDefinition: {
        name: "agent-a",
        version: 1,
        provider: { type: "openai", model: "gpt-4o-mini" },
        systemPrompt: "You are a helpful assistant.",
        mcpServers: {},
        permissions: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
    },
    recursionDepth: 0,
    toolCallCount: 0,
    ...overrides,
});

describe("PolicyEngine", () => {
    describe("Check 1: recursion depth", () => {
        it("allows calls at depth 0 when max is 5", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
            });
            expect(() =>
                policy.check({ executionContext: makeCtx({ recursionDepth: 0 }), targetTool: "some__tool" })
            ).not.toThrow();
        });

        it("allows calls at depth 4 (below max 5)", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
            });
            expect(() =>
                policy.check({ executionContext: makeCtx({ recursionDepth: 4 }), targetTool: "some__tool" })
            ).not.toThrow();
        });

        it("throws MAX_DEPTH_EXCEEDED at exactly the limit", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
            });
            expect(() =>
                policy.check({ executionContext: makeCtx({ recursionDepth: 5 }), targetTool: "some__tool" })
            ).toThrow(ToolError);

            try {
                policy.check({ executionContext: makeCtx({ recursionDepth: 5 }), targetTool: "some__tool" });
            } catch (e) {
                expect((e as ToolError).code).toBe("MAX_DEPTH_EXCEEDED");
            }
        });
    });

    describe("Check 2: tool call loop limit", () => {
        it("allows calls when toolCallCount is below limit", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
            });
            expect(() =>
                policy.check({ executionContext: makeCtx({ toolCallCount: 9 }), targetTool: "some__tool" })
            ).not.toThrow();
        });

        it("throws MAX_TOOL_LOOPS_EXCEEDED at exactly the limit", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
            });
            let caught: ToolError | null = null;
            try {
                policy.check({ executionContext: makeCtx({ toolCallCount: 10 }), targetTool: "some__tool" });
            } catch (e) {
                caught = e as ToolError;
            }
            expect(caught).not.toBeNull();
            expect(caught?.code).toBe("MAX_TOOL_LOOPS_EXCEEDED");
        });
    });

    describe("Check 3: allowedAgents", () => {
        const targetTool = "agent-mcp__agent";

        it("allows delegation when both agent and server allowedAgents are undefined (unrestricted)", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
                serverAllowedAgents: undefined, // unrestricted
            });
            const ctx = makeCtx();
            ctx.agentDefinition.permissions.allowedAgents = undefined; // also unrestricted

            expect(() =>
                policy.check({ executionContext: ctx, targetTool, targetAgentName: "any-agent" })
            ).not.toThrow();
        });

        it("allows delegation when agent allowedAgents is undefined and server allows it", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
                serverAllowedAgents: ["agent-b"],
            });
            const ctx = makeCtx();
            ctx.agentDefinition.permissions.allowedAgents = undefined; // falls through to server default

            expect(() =>
                policy.check({ executionContext: ctx, targetTool, targetAgentName: "agent-b" })
            ).not.toThrow();
        });

        it("blocks when agent allowedAgents is empty array (block all)", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
                serverAllowedAgents: undefined, // server unrestricted
            });
            const ctx = makeCtx();
            ctx.agentDefinition.permissions.allowedAgents = []; // per-agent: block all

            let caught: ToolError | null = null;
            try {
                policy.check({ executionContext: ctx, targetTool, targetAgentName: "agent-b" });
            } catch (e) {
                caught = e as ToolError;
            }
            expect(caught?.code).toBe("DELEGATION_NOT_ALLOWED");
        });

        it("allows delegation when target is in per-agent allowedAgents", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
                serverAllowedAgents: [], // server blocks all
            });
            const ctx = makeCtx();
            ctx.agentDefinition.permissions.allowedAgents = ["agent-b"]; // per-agent wins

            expect(() =>
                policy.check({ executionContext: ctx, targetTool, targetAgentName: "agent-b" })
            ).not.toThrow();
        });

        it("blocks when target is NOT in per-agent allowedAgents (overrides server)", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
                serverAllowedAgents: undefined, // server would allow all
            });
            const ctx = makeCtx();
            ctx.agentDefinition.permissions.allowedAgents = ["agent-b"]; // per-agent restricts

            let caught: ToolError | null = null;
            try {
                policy.check({ executionContext: ctx, targetTool, targetAgentName: "agent-c" });
            } catch (e) {
                caught = e as ToolError;
            }
            expect(caught?.code).toBe("DELEGATION_NOT_ALLOWED");
        });

        it("does not apply allowedAgents check for non-delegation tools", () => {
            const policy = new PolicyEngine({
                serverMaxDepth: 5,
                serverMaxToolLoops: 10,
                serverAllowedAgents: [],
            });
            const ctx = makeCtx();
            ctx.agentDefinition.permissions.allowedAgents = [];

            // Not an agent-mcp__agent call — should not trigger allowedAgents check
            expect(() =>
                policy.check({ executionContext: ctx, targetTool: "some-server__some-tool" })
            ).not.toThrow();
        });
    });
});
