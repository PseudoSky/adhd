import type { ExecutionContext } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";

export interface AgentPolicyTemplateRule {
    type: string;
    rules: Record<string, unknown>;
}

export interface PolicyConfig {
    serverMaxDepth: number;
    serverMaxToolLoops: number;
    serverAllowedAgents?: string[];
    policyTemplateRules?: AgentPolicyTemplateRule[];
}

export interface PolicyCheckInput {
    executionContext: ExecutionContext;
    targetTool: string;
    targetAgentName?: string;
}

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

export class PolicyEngine {
    constructor(private readonly config: PolicyConfig) {}

    check(input: PolicyCheckInput): void {
        const { executionContext, targetTool, targetAgentName } = input;
        const callingAgent = executionContext.agentDefinition;
        const templates = this.config.policyTemplateRules;

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

        if (targetTool === "agent-mcp__agent" && targetAgentName !== undefined) {
            const agentAllowedAgents = callingAgent.permissions.allowedAgents;

            let effectiveAllowedAgents: string[] | undefined;
            if (agentAllowedAgents !== undefined) {
                effectiveAllowedAgents = agentAllowedAgents;
            } else {
                const templateAllowlist = readPermissionAllowlist(templates);
                effectiveAllowedAgents = templateAllowlist !== undefined
                    ? templateAllowlist
                    : this.config.serverAllowedAgents;
            }

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
