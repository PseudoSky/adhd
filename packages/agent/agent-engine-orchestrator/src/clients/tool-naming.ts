export const TOOL_NAME_SEPARATOR = "__";

export function normalizeToolName(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

export interface ResolvedToolName {
    server: string;
    tool: string;
}

function splitToolName(name: string): ResolvedToolName {
    const i = name.indexOf(TOOL_NAME_SEPARATOR);
    return i === -1
        ? { server: name, tool: name }
        : { server: name.slice(0, i), tool: name.slice(i + TOOL_NAME_SEPARATOR.length) };
}

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
    return splitToolName(rawName);
}
