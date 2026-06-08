import type { ExecutionContext } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";

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

/**
 * PolicyEngine enforces the three SPEC §9 safety invariants:
 *
 *  1. Recursion depth limit
 *  2. Tool call loop limit
 *  3. AllowedAgents list (per-agent override takes full precedence over server default)
 *
 * Throws ToolError on any violation. Does not mutate state.
 */
export class PolicyEngine {
    constructor(private readonly config: PolicyConfig) {}

    check(input: PolicyCheckInput): void {
        const { executionContext, targetTool, targetAgentName } = input;
        const callingAgent = executionContext.agentDefinition;

        // ── Check 1: Recursion depth ──────────────────────────────────────
        const effectiveMaxDepth = Math.min(
            callingAgent.maxToolLoops ?? this.config.serverMaxDepth,
            this.config.serverMaxDepth
        );

        if (executionContext.recursionDepth >= effectiveMaxDepth) {
            throw new ToolError(
                "MAX_DEPTH_EXCEEDED",
                `Recursion depth ${executionContext.recursionDepth} has reached or exceeded the maximum of ${effectiveMaxDepth}`
            );
        }

        // ── Check 2: Tool call loop limit ─────────────────────────────────
        const effectiveMaxToolLoops = Math.min(
            callingAgent.maxToolLoops ?? this.config.serverMaxToolLoops,
            this.config.serverMaxToolLoops
        );

        if (executionContext.toolCallCount >= effectiveMaxToolLoops) {
            throw new ToolError(
                "MAX_TOOL_LOOPS_EXCEEDED",
                `Tool call count ${executionContext.toolCallCount} has reached or exceeded the maximum of ${effectiveMaxToolLoops}`
            );
        }

        // ── Check 3: AllowedAgents (only for agent delegation) ────────────
        if (targetTool === "agent-mcp__agent" && targetAgentName !== undefined) {
            // Per-agent allowedAgents takes FULL precedence over server default.
            const agentAllowedAgents = callingAgent.permissions.allowedAgents;
            const effectiveAllowedAgents =
                agentAllowedAgents !== undefined
                    ? agentAllowedAgents         // agent-level: always wins
                    : this.config.serverAllowedAgents; // fall back to server default

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
