import type { ToolDefinition } from "../providers/types.js";

export interface IMcpClient {
    listTools(): Promise<ToolDefinition[]>;
    callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
    close(): Promise<void>;
}

/** The three MCP annotation hints the engine reads (`ToolDefinition.annotations`). */
const ANNOTATION_HINT_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint"] as const;

/**
 * Projects a server's `tools/list` `annotations` object onto the typed hints the engine reads
 * (R10 S3): only `readOnlyHint`, `destructiveHint` and `idempotentHint`, and only when they are
 * booleans. Everything else the server sent (`openWorldHint`, `title`, vendor keys) is dropped, so
 * the engine-internal field stays small and typed. Returns `undefined` when the server declared
 * no usable hint; callers spread the result only when defined so a tool without annotations keeps
 * exactly the shape it had before this field existed.
 *
 * The result is ENGINE-INTERNAL metadata: it must never reach a provider wire request or a tool
 * hash (see `ToolDefinition.annotations`).
 */
export function pickToolAnnotations(raw: unknown): ToolDefinition["annotations"] | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const src = raw as Record<string, unknown>;
    const out: NonNullable<ToolDefinition["annotations"]> = {};
    for (const key of ANNOTATION_HINT_KEYS) {
        const value = src[key];
        if (typeof value === "boolean") out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Spread target for a `tools/list` entry: `{ annotations }` when the server declared a usable
 * hint, `{}` otherwise (so the key is absent, not `undefined`).
 */
export function annotationsOf(tool: { annotations?: unknown }): { annotations?: NonNullable<ToolDefinition["annotations"]> } {
    const annotations = pickToolAnnotations(tool.annotations);
    return annotations === undefined ? {} : { annotations };
}
