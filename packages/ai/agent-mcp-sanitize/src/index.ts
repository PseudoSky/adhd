import { z } from "zod";
import type {
    IHookRegistry,
    Plugin,
    PluginContext,
    PluginFactory,
    PostToolCallPayload,
} from "@adhd/agent-mcp-types";

// ── Config schema ────────────────────────────────────────────────────────────

export const configSchema = z.object({
    /**
     * Default strategy applied when an agent has no explicit sanitization config.
     * - "none": raw pass-through
     * - "prefix": prepend a structured boundary label
     * - "wrap": surround with start/end delimiters
     */
    defaultStrategy: z.enum(["none", "prefix", "wrap"]).default("prefix"),

    /**
     * Per-agent strategy overrides. Keyed by agent name.
     * An agent not listed here uses defaultStrategy.
     */
    agents: z
        .record(z.string(), z.enum(["none", "prefix", "wrap"]))
        .optional(),

    /**
     * When true, only sanitize delegation tool calls (agent-mcp__task and
     * agent-mcp__agent). When false, sanitize all tool results.
     */
    delegationOnly: z.boolean().default(true),
});

export type SanitizeConfig = z.infer<typeof configSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function prefixContent(content: string, agentName?: string): string {
    const label = agentName
        ? `[Sub-agent output from "${agentName}"]`
        : "[Sub-agent output]";
    return `${label}\n${content}`;
}

function wrapContent(content: string, agentName?: string): string {
    const header = agentName
        ? `── Agent "${agentName}" output ──`
        : `── Sub-agent output ──`;
    return `${header}\n${content}\n── End agent output ──`;
}

function getAgentName(input: unknown): string | undefined {
    const obj = input as Record<string, unknown> | undefined;
    if (!obj) return undefined;
    const name = obj["agent_name"] ?? obj["name"];
    return typeof name === "string" ? name : undefined;
}

function isDelegation(toolName: string): boolean {
    return toolName === "agent-mcp__task" || toolName === "agent-mcp__agent";
}

// ── Plugin ──────────────────────────────────────────────────────────────────

class SanitizePlugin implements Plugin {
    readonly name = "sanitize";

    constructor(private readonly config: SanitizeConfig) {}

    install(hooks: IHookRegistry): void {
        hooks.register("transform:tool_result", (payload: PostToolCallPayload) => {
            if (payload.isError) return;

            // delegationOnly: skip non-delegation tool calls
            if (this.config.delegationOnly && !isDelegation(payload.toolName)) return;

            // Extract the string content to sanitize. Delegation tools
            // (agent-mcp__task / agent-mcp__agent) return a structured object
            // like { task_id, status, result: "…", usage }. Non-delegation
            // tools return a direct string.
            let rawContent: string | undefined;
            if (typeof payload.result === "string") {
                rawContent = payload.result;
            } else if (typeof payload.result === "object" && payload.result !== null && !Array.isArray(payload.result)) {
                const obj = payload.result as Record<string, unknown>;
                if (typeof obj["result"] === "string") {
                    rawContent = obj["result"];
                }
            }
            if (rawContent === undefined) return;

            const agentName = getAgentName(payload.toolInput);
            const strategy =
                (agentName && this.config.agents?.[agentName]) ??
                this.config.defaultStrategy;

            if (strategy === "none") return;

            const sanitized =
                strategy === "prefix"
                    ? prefixContent(rawContent, agentName)
                    : wrapContent(rawContent, agentName);

            // For delegation tools, replace the inner result string
            // within the structured response object
            if (typeof payload.result === "object" && payload.result !== null && !Array.isArray(payload.result)) {
                const obj = payload.result as Record<string, unknown>;
                payload.result = { ...obj, result: sanitized };
            } else {
                payload.result = sanitized;
            }
        });
    }
}

// ── Factory ──────────────────────────────────────────────────────────────────

const createPlugin: PluginFactory = ({ config }: PluginContext): Plugin => {
    const validated = configSchema.parse(config);
    return new SanitizePlugin(validated);
};

export default createPlugin;
export { createPlugin };
