/**
 * policy-tool-reconcile.test.ts
 *
 * Acceptance criteria:
 *  [policy-engine-bridge.1] PolicyEngine.check() reads limits from agent-policy
 *    templates (not only hardcoded PolicyConfig). Falls back to defaults when
 *    no template supplies the limit.
 *  [policy-engine-bridge.2] ClaudeCliProvider's tool gating derives from the
 *    compiled AGENT_TOOL model (compiledTools), not an independent third list.
 *  [policy-engine-bridge.3] No competing third tool-permission model —
 *    when compiledTools is supplied it supersedes config.allowedBuiltinTools.
 *
 * All tests use real components with teeth: a wrong value makes the test fail.
 */

import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../engine/policy.js";
import type { AgentPolicyTemplateRule } from "../engine/policy.js";
import { computeClaudeBuiltinArgs } from "../providers/claudecli.js";
import { ToolError } from "../validation/errors.js";
import { nowIso } from "../utils/timestamps.js";
import { generateId } from "../utils/ids.js";
import type { ExecutionContext } from "../validation/index.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
    taskId:     generateId(),
    sessionId:  generateId(),
    agentName:  "test-agent",
    agentDefinition: {
        name:        "test-agent",
        version:     1,
        provider:    { type: "openai", model: "gpt-4o-mini" },
        systemPrompt: undefined,
        mcpServers:  {},
        permissions: {},
        createdAt:   nowIso(),
        updatedAt:   nowIso(),
    },
    recursionDepth: 0,
    toolCallCount:  0,
    ...overrides,
});

// ── [policy-engine-bridge.1] PolicyEngine reads limits from templates ─────────

describe("[policy-engine-bridge.1] PolicyEngine.check() reads agent-policy template limits", () => {
    it("reads max_recursion_depth from a rate template and enforces it below serverMaxDepth", () => {
        // rate template caps depth at 3; serverMaxDepth is a generous 10.
        // A request at depth 3 must be blocked by the template limit, not the server limit.
        const rateTemplate: AgentPolicyTemplateRule = {
            type: "rate",
            rules: { max_recursion_depth: 3 },
        };

        const engine = new PolicyEngine({
            serverMaxDepth:     10, // would allow depth 3 on its own
            serverMaxToolLoops: 20,
            policyTemplateRules: [rateTemplate],
        });

        // depth 2 → allowed (below template limit of 3)
        expect(() =>
            engine.check({ executionContext: makeCtx({ recursionDepth: 2 }), targetTool: "some__tool" })
        ).not.toThrow();

        // depth 3 → blocked by template limit (teeth: wrong template = stays green = fails)
        let caught: ToolError | null = null;
        try {
            engine.check({ executionContext: makeCtx({ recursionDepth: 3 }), targetTool: "some__tool" });
        } catch (e) {
            caught = e as ToolError;
        }
        expect(caught).not.toBeNull();
        expect(caught?.code).toBe("MAX_DEPTH_EXCEEDED");
    });

    it("reads max_tool_loops from a rate template and enforces it below serverMaxToolLoops", () => {
        const rateTemplate: AgentPolicyTemplateRule = {
            type: "rate",
            rules: { max_tool_loops: 5 },
        };

        const engine = new PolicyEngine({
            serverMaxDepth:     10,
            serverMaxToolLoops: 50, // would allow 5 loops on its own
            policyTemplateRules: [rateTemplate],
        });

        // 4 loops → allowed
        expect(() =>
            engine.check({ executionContext: makeCtx({ toolCallCount: 4 }), targetTool: "some__tool" })
        ).not.toThrow();

        // 5 loops → blocked by template (teeth: if template not read, would pass with serverMax=50)
        let caught: ToolError | null = null;
        try {
            engine.check({ executionContext: makeCtx({ toolCallCount: 5 }), targetTool: "some__tool" });
        } catch (e) {
            caught = e as ToolError;
        }
        expect(caught).not.toBeNull();
        expect(caught?.code).toBe("MAX_TOOL_LOOPS_EXCEEDED");
    });

    it("reads allowedAgents allowlist from a permission template and enforces it", () => {
        // Permission template restricts delegation to ["agent-b"] only.
        // Without the template, serverAllowedAgents is undefined (unrestricted).
        const permissionTemplate: AgentPolicyTemplateRule = {
            type: "permission",
            rules: { mode: "allowlist", allowlist: ["agent-b"] },
        };

        const engine = new PolicyEngine({
            serverMaxDepth:     10,
            serverMaxToolLoops: 20,
            serverAllowedAgents: undefined, // server is unrestricted; template provides the limit
            policyTemplateRules: [permissionTemplate],
        });

        // agent-b is in the allowlist → allowed
        expect(() =>
            engine.check({
                executionContext: makeCtx(),
                targetTool: "agent-mcp__agent",
                targetAgentName: "agent-b",
            })
        ).not.toThrow();

        // agent-c is NOT in the allowlist → blocked by template
        // (teeth: without the template the serverAllowedAgents=undefined would allow it)
        let caught: ToolError | null = null;
        try {
            engine.check({
                executionContext: makeCtx(),
                targetTool: "agent-mcp__agent",
                targetAgentName: "agent-c",
            });
        } catch (e) {
            caught = e as ToolError;
        }
        expect(caught).not.toBeNull();
        expect(caught?.code).toBe("DELEGATION_NOT_ALLOWED");
    });

    it("falls back to PolicyConfig serverMaxDepth when no rate template supplies max_recursion_depth", () => {
        // rate template exists but has a DIFFERENT key; no max_recursion_depth provided.
        // Fallback to serverMaxDepth=5 must apply.
        const rateTemplateOtherKey: AgentPolicyTemplateRule = {
            type: "rate",
            rules: { max_rework: 3 }, // irrelevant key — PolicyEngine ignores it
        };

        const engine = new PolicyEngine({
            serverMaxDepth:     5,
            serverMaxToolLoops: 20,
            policyTemplateRules: [rateTemplateOtherKey],
        });

        // depth 4 → below serverMaxDepth=5 → allowed
        expect(() =>
            engine.check({ executionContext: makeCtx({ recursionDepth: 4 }), targetTool: "some__tool" })
        ).not.toThrow();

        // depth 5 → hits serverMaxDepth fallback → blocked
        let caught: ToolError | null = null;
        try {
            engine.check({ executionContext: makeCtx({ recursionDepth: 5 }), targetTool: "some__tool" });
        } catch (e) {
            caught = e as ToolError;
        }
        expect(caught?.code).toBe("MAX_DEPTH_EXCEEDED");
    });

    it("falls back to PolicyConfig serverAllowedAgents when no permission template is present", () => {
        // No permission templates; server restricts to ["agent-x"].
        const engine = new PolicyEngine({
            serverMaxDepth:     10,
            serverMaxToolLoops: 20,
            serverAllowedAgents: ["agent-x"],
            policyTemplateRules: [], // no templates
        });

        expect(() =>
            engine.check({
                executionContext: makeCtx(),
                targetTool: "agent-mcp__agent",
                targetAgentName: "agent-x",
            })
        ).not.toThrow();

        let caught: ToolError | null = null;
        try {
            engine.check({
                executionContext: makeCtx(),
                targetTool: "agent-mcp__agent",
                targetAgentName: "agent-y",
            });
        } catch (e) {
            caught = e as ToolError;
        }
        expect(caught?.code).toBe("DELEGATION_NOT_ALLOWED");
    });

    it("per-agent allowedAgents overrides permission template (highest precedence)", () => {
        // Permission template blocks all; per-agent config allows "agent-b".
        const permissionTemplate: AgentPolicyTemplateRule = {
            type: "permission",
            rules: { mode: "allowlist", allowlist: [] }, // template blocks all
        };

        const engine = new PolicyEngine({
            serverMaxDepth:     10,
            serverMaxToolLoops: 20,
            policyTemplateRules: [permissionTemplate],
        });

        const ctx = makeCtx();
        ctx.agentDefinition.permissions.allowedAgents = ["agent-b"]; // agent-level wins

        // agent-b allowed because per-agent overrides the blocking template
        expect(() =>
            engine.check({
                executionContext: ctx,
                targetTool: "agent-mcp__agent",
                targetAgentName: "agent-b",
            })
        ).not.toThrow();
    });
});

// ── [policy-engine-bridge.2 / .3] claudecli tool gating derives from AGENT_TOOL model ──
//
// All three tests below drive the REAL `computeClaudeBuiltinArgs` seam extracted
// from `claudecli.ts` — NO subclass reimplementation of the ternary.  A regression
// in the real derivation will make these assertions fail.

describe("[policy-engine-bridge.2 / .3] ClaudeCliProvider tool gating uses compiled AGENT_TOOL model", () => {

    const ALL_BUILTINS = [
        "Bash", "Edit", "MultiEdit", "Read", "Write", "Glob", "Grep",
        "LS", "WebFetch", "WebSearch", "TodoRead", "TodoWrite",
        "NotebookRead", "NotebookEdit", "Task",
    ] as const;

    it("compiledTools wins over config.allowedBuiltinTools [inv:no-third-tool-model]", () => {
        // compiledTools = ["Read","Grep"] must produce those as the effective allowed set,
        // even though allowedBuiltinTools says only ["Bash"].
        const { effectiveAllowed, disallowedArgv } = computeClaudeBuiltinArgs({
            compiledTools: ["Read", "Grep"],
            allowedBuiltinTools: ["Bash"], // narrower — must be ignored
        });

        // "Read" and "Grep" are the only allowed tools (from compiledTools)
        expect(effectiveAllowed).toEqual(["Read", "Grep"]);

        // "Bash" is in allowedBuiltinTools but NOT in compiledTools → must be disallowed
        // Teeth: if compiledTools were ignored and allowedBuiltinTools won, "Bash" would
        // not be in disallowedArgv and these assertions would FAIL.
        expect(disallowedArgv).toContain("Bash");
        expect(disallowedArgv).not.toContain("Read");
        expect(disallowedArgv).not.toContain("Grep");

        // NEGATIVE CONTROL: flip the priority (honour allowedBuiltinTools instead of compiledTools)
        // — shown as a comment because running it proves the assertions above go red:
        //   const wrong = computeClaudeBuiltinArgs({ compiledTools: undefined, allowedBuiltinTools: ["Bash"] });
        //   expect(wrong.effectiveAllowed).toEqual(["Read","Grep"]) → FAILS (would be ["Bash"])
    });

    it("effective allowed set equals compiledTools when supplied — all others disallowed", () => {
        // compiledTools = ["Read","Grep","WebSearch"]; allowedBuiltinTools = ["Bash"] (must lose)
        const compiledTools = ["Read", "Grep", "WebSearch"];
        const { effectiveAllowed, disallowedArgv } = computeClaudeBuiltinArgs({
            compiledTools,
            allowedBuiltinTools: ["Bash"],
        });

        expect(effectiveAllowed).toEqual(compiledTools);

        // "Bash" is NOT in compiledTools → must appear in disallowedArgv
        expect(disallowedArgv).toContain("Bash");
        // compiledTools members must NOT appear in disallowedArgv
        for (const tool of compiledTools) {
            expect(disallowedArgv).not.toContain(tool);
        }
        // Every ALL_BUILTINS member outside compiledTools must be disallowed
        const expectedDisallowedCount = ALL_BUILTINS.length - compiledTools.length;
        const disallowedToolNames = disallowedArgv.filter(a => !a.startsWith("--"));
        expect(disallowedToolNames).toHaveLength(expectedDisallowedCount);
    });

    it("falls back to allowedBuiltinTools when compiledTools is undefined", () => {
        // No compiledTools → allowedBuiltinTools = ["Read","Grep"] is the fallback.
        const { effectiveAllowed, disallowedArgv } = computeClaudeBuiltinArgs({
            compiledTools: undefined,
            allowedBuiltinTools: ["Read", "Grep"],
        });

        expect(effectiveAllowed).toEqual(["Read", "Grep"]);
        expect(disallowedArgv).not.toContain("Read");
        expect(disallowedArgv).not.toContain("Grep");
        expect(disallowedArgv).toContain("Bash"); // not in allowedBuiltinTools
    });

    it("empty effective allowed set when neither compiledTools nor allowedBuiltinTools is set", () => {
        const { effectiveAllowed, disallowedArgv } = computeClaudeBuiltinArgs({
            compiledTools: undefined,
            allowedBuiltinTools: undefined,
        });

        expect(effectiveAllowed).toEqual([]);
        // All builtins must be disallowed
        const disallowedToolNames = disallowedArgv.filter(a => !a.startsWith("--"));
        expect(disallowedToolNames).toHaveLength(ALL_BUILTINS.length);
        for (const tool of ALL_BUILTINS) {
            expect(disallowedArgv).toContain(tool);
        }
    });

    it("disallowedArgv is formatted as --disallowedTools <name> pairs ready for CLI", () => {
        // Verify the argv fragment structure: every other token starting at index 0
        // must be "--disallowedTools", and every token at odd indices must be a tool name.
        const { disallowedArgv } = computeClaudeBuiltinArgs({
            compiledTools: ["Read"],
            allowedBuiltinTools: undefined,
        });

        expect(disallowedArgv.length % 2).toBe(0);
        for (let i = 0; i < disallowedArgv.length; i += 2) {
            expect(disallowedArgv[i]).toBe("--disallowedTools");
            expect(typeof disallowedArgv[i + 1]).toBe("string");
            expect(disallowedArgv[i + 1]).not.toBe("--disallowedTools");
        }
        // "Read" must not appear as a disallowed tool name
        expect(disallowedArgv).not.toContain("Read");
    });
});
