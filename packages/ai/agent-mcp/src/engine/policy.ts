import type { ExecutionContext } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";

// ── agent-policy template shapes consumed by PolicyEngine ────────────────────
//
// PolicyEngine reads `rate` and `permission` templates from @adhd/agent-policy
// when they are provided, falling back to the hardcoded `PolicyConfig` defaults
// when absent. agent-mcp does NOT re-implement policy semantics — it consumes
// the template SHAPE defined by @adhd/agent-policy (PolicyTemplate.rules).
//
// Rate template rules (type === "rate"):
//   max_recursion_depth?: number  — overrides serverMaxDepth
//   max_tool_loops?: number       — overrides serverMaxToolLoops
//
// Permission template rules (type === "permission"):
//   mode?: "allowlist"            — must be "allowlist" to be applied
//   allowlist?: string[]          — allowed agent slugs; empty = block all
//
// These keys are the stable contract between agent-policy templates and this
// engine. If @adhd/agent-policy changes its rule key names, update here too.

/** Minimal PolicyTemplate shape consumed from @adhd/agent-policy. */
export interface AgentPolicyTemplateRule {
    /** Policy type slug — "rate" | "permission" (others are ignored here). */
    type: string;
    /** Structured rule parameters deserialized from the JSON column. */
    rules: Record<string, unknown>;
}

export interface PolicyConfig {
    /** Absolute maximum recursion depth. Agent definitions cannot exceed this. */
    serverMaxDepth: number;
    /** Absolute maximum tool call loops per task. Agent definitions cannot exceed this. */
    serverMaxToolLoops: number;
    /**
     * Server-level allowed agents allowlist.
     * - undefined → unrestricted (any agent may be called)
     * - string[]  → only agents in this list may be called
     * Per-agent allowedAgents takes full precedence over this when defined.
     */
    serverAllowedAgents?: string[];
    /**
     * Agent-policy template rules resolved for the current agent.
     *
     * When present, PolicyEngine reads rate/permission limits from these
     * templates and falls back to the serverMax* defaults only when no
     * matching template rule supplies the limit. Consuming the @adhd/agent-policy
     * template SHAPE here keeps policy semantics in one place.
     *
     * Pass the output of `AgentPolicyStore.resolveForAgent(agentSlug)` merged
     * with `PolicyTemplateStore.read(policySlug)` to supply template rules.
     */
    policyTemplateRules?: AgentPolicyTemplateRule[];
}

export interface PolicyCheckInput {
    executionContext: ExecutionContext;
    /**
     * The fully-qualified tool name being invoked: "<server>__<tool>".
     * The allowedAgents check only applies when this is "agent-mcp__agent".
     */
    targetTool: string;
    /**
     * When targetTool === "agent-mcp__agent", the name of the target agent.
     * Used for the allowedAgents check (#3).
     */
    targetAgentName?: string;
}

// ── internal helpers ──────────────────────────────────────────────────────────

/**
 * Extract the first numeric value for `key` from rate-type template rules.
 * Returns undefined when no rate template carries the key.
 */
function readRateLimit(
    templates: AgentPolicyTemplateRule[] | undefined,
    key: "max_recursion_depth" | "max_tool_loops"
): number | undefined {
    if (!templates) return undefined;
    for (const t of templates) {
        if (t.type !== "rate") continue;
        const val = t.rules[key];
        if (typeof val === "number" && Number.isFinite(val)) return val;
    }
    return undefined;
}

/**
 * Extract the allowedAgents allowlist from permission-type template rules.
 *
 * A permission template is applied only when `mode === "allowlist"`. When found,
 * returns the `allowlist` array (possibly empty = block all). Returns undefined
 * when no permission template with mode=allowlist is present.
 */
function readPermissionAllowlist(
    templates: AgentPolicyTemplateRule[] | undefined
): string[] | undefined {
    if (!templates) return undefined;
    for (const t of templates) {
        if (t.type !== "permission") continue;
        if (t.rules["mode"] !== "allowlist") continue;
        const list = t.rules["allowlist"];
        if (Array.isArray(list)) return list as string[];
    }
    return undefined;
}

/**
 * PolicyEngine enforces the three SPEC §9 safety invariants:
 *
 *  1. Recursion depth limit
 *  2. Tool call loop limit
 *  3. AllowedAgents list (per-agent override takes full precedence over server default)
 *
 * Limits are resolved in priority order:
 *   1. Per-agent agentDefinition fields (highest — always wins)
 *   2. @adhd/agent-policy template rules (when policyTemplateRules is supplied)
 *   3. PolicyConfig server defaults (hardcoded fallback)
 *
 * Throws ToolError on any violation. Does not mutate state.
 */
export class PolicyEngine {
    constructor(private readonly config: PolicyConfig) {}

    check(input: PolicyCheckInput): void {
        const { executionContext, targetTool, targetAgentName } = input;
        const callingAgent = executionContext.agentDefinition;
        const templates = this.config.policyTemplateRules;

        // ── Check 1: Recursion depth ──────────────────────────────────────
        //
        // Priority: agentDefinition.maxToolLoops → rate template max_recursion_depth
        //           → serverMaxDepth (default)
        const templateMaxDepth = readRateLimit(templates, "max_recursion_depth");
        const serverMaxDepth = templateMaxDepth !== undefined
            ? Math.min(templateMaxDepth, this.config.serverMaxDepth)
            : this.config.serverMaxDepth;

        const effectiveMaxDepth = Math.min(
            callingAgent.maxToolLoops ?? serverMaxDepth,
            serverMaxDepth
        );

        if (executionContext.recursionDepth >= effectiveMaxDepth) {
            throw new ToolError(
                "MAX_DEPTH_EXCEEDED",
                `Recursion depth ${executionContext.recursionDepth} has reached or exceeded the maximum of ${effectiveMaxDepth}`
            );
        }

        // ── Check 2: Tool call loop limit ─────────────────────────────────
        //
        // Priority: agentDefinition.maxToolLoops → rate template max_tool_loops
        //           → serverMaxToolLoops (default)
        const templateMaxToolLoops = readRateLimit(templates, "max_tool_loops");
        const serverMaxToolLoops = templateMaxToolLoops !== undefined
            ? Math.min(templateMaxToolLoops, this.config.serverMaxToolLoops)
            : this.config.serverMaxToolLoops;

        const effectiveMaxToolLoops = Math.min(
            callingAgent.maxToolLoops ?? serverMaxToolLoops,
            serverMaxToolLoops
        );

        if (executionContext.toolCallCount >= effectiveMaxToolLoops) {
            throw new ToolError(
                "MAX_TOOL_LOOPS_EXCEEDED",
                `Tool call count ${executionContext.toolCallCount} has reached or exceeded the maximum of ${effectiveMaxToolLoops}`
            );
        }

        // ── Check 3: AllowedAgents (only for agent delegation) ────────────
        if (targetTool === "agent-mcp__agent" && targetAgentName !== undefined) {
            // Per-agent allowedAgents takes FULL precedence over everything.
            const agentAllowedAgents = callingAgent.permissions.allowedAgents;

            let effectiveAllowedAgents: string[] | undefined;
            if (agentAllowedAgents !== undefined) {
                // Agent-level always wins — ignore templates and server default.
                effectiveAllowedAgents = agentAllowedAgents;
            } else {
                // Check permission template allowlist first, then server default.
                const templateAllowlist = readPermissionAllowlist(templates);
                effectiveAllowedAgents = templateAllowlist !== undefined
                    ? templateAllowlist
                    : this.config.serverAllowedAgents;
            }

            // If effectiveAllowedAgents is undefined → unrestricted
            if (effectiveAllowedAgents !== undefined) {
                if (!effectiveAllowedAgents.includes(targetAgentName)) {
                    throw new ToolError(
                        "DELEGATION_NOT_ALLOWED",
                        `Agent '${executionContext.agentName}' is not allowed to delegate to '${targetAgentName}'`
                    );
                }
            }
        }
    }
}
