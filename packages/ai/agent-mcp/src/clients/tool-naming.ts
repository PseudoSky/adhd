/**
 * Tool-name encoding shared across the registry and the orchestrator.
 *
 * Tools are advertised to the model as `<server>__<tool>`. Many OpenAI-compatible
 * and local models (e.g. LM Studio / qwen) restrict function names to
 * `[A-Za-z0-9_]` and silently rewrite other characters — notably `-` → `_` — so
 * an advertised `agent-mcp__agent` comes back from the model as
 * `agent_mcp__agent`. A literal lookup then fails ("No MCP server config found
 * for server: 'agent_mcp'"), which breaks recursion (the `agent-mcp` key) and any
 * MCP server whose name contains a hyphen. Anthropic preserves the name, so this
 * only bites the OpenAI-compatible providers — but the round-trip must be robust
 * for ALL of them.
 *
 * The fix: index both the advertised name and its normalized form, and normalize
 * the model's returned name the same way before resolving.
 */
export const TOOL_NAME_SEPARATOR = "__";

/** Normalize a tool name to the charset models restrict function names to. */
export function normalizeToolName(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}
