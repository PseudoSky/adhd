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

export interface ResolvedToolName {
    server: string;
    tool: string;
}

/** Split a name on the first separator into { server, tool } (no resolution). */
function splitToolName(name: string): ResolvedToolName {
    const i = name.indexOf(TOOL_NAME_SEPARATOR);
    return i === -1
        ? { server: name, tool: name }
        : { server: name.slice(0, i), tool: name.slice(i + TOOL_NAME_SEPARATOR.length) };
}

/**
 * Resolve a tool name AS RETURNED BY A MODEL into { server, tool }.
 *
 * - A qualified `<server>__<tool>` name splits on the separator (prior behavior).
 * - A **bare** `<tool>` name (no separator) is resolved against the tool names the
 *   model was actually advertised: if exactly one advertised tool has that
 *   tool-part it is used; if several do, an actionable error lists the qualified
 *   candidates; if none do, it falls back to a literal split so downstream
 *   "unknown tool / no server config" handling still applies.
 *
 * Background (BACKLOG DEBT-004): capable models frequently emit the bare tool
 * name (`agent` / `task`) instead of the advertised `agent-mcp__agent`, which used
 * to hard-fail the whole task with "Invalid tool name (missing server prefix)".
 * Since the separator is unambiguous in advertised names, a bare name that maps to
 * exactly one advertised tool can be resolved deterministically.
 *
 * @param rawName    the tool name the model returned
 * @param advertised the advertised tool names the model was given (`<server>__<tool>`)
 */
export function resolveToolCallName(rawName: string, advertised: readonly string[] = []): ResolvedToolName {
    if (rawName.includes(TOOL_NAME_SEPARATOR)) return splitToolName(rawName);

    const norm = normalizeToolName(rawName);
    const candidates = Array.from(new Set(advertised)).filter((a) => {
        const { tool } = splitToolName(a);
        return tool === rawName || normalizeToolName(tool) === norm;
    });

    if (candidates.length === 1) return splitToolName(candidates[0]);
    if (candidates.length > 1) {
        throw new Error(
            `Ambiguous tool name '${rawName}': multiple servers expose it — qualify with a server prefix, one of: ${candidates.join(", ")}`
        );
    }
    // No advertised match — preserve prior split (server = tool = rawName); the
    // registry then surfaces a normal "no server config" / unknown-tool error.
    return splitToolName(rawName);
}
