/**
 * FEAT-007 runtime tool emitter.
 *
 * Given a ToolDefinition and a lookup function that resolves its
 * provider_tool_formats row, branches on emit_shape:
 *
 *   custom       → { name, description, input_schema }  (standard custom def)
 *   server_side  → { type: <type_tag>, name }           (no input_schema — executed server-side)
 *   unsupported  → throws UnsupportedNativeToolError     ([inv:gate-not-noop])
 *
 * This is the strategic replacement for agent-mcp's toAnthropicTools(), which
 * maps every tool to the custom shape and never emits a type-tagged server-side
 * entry ([ref:runtime-gap]). Wiring into the live provider is agent-mcp-refactor's
 * job (plan 6); this module delivers the emitter standalone.
 *
 * ([def:server-side-tool], [def:unsupported-native], [inv:server-side-shape],
 *  [inv:gate-not-noop], RUNTIME_GAPS Gap 1 + Gap 2 + Recommended Handoff #2)
 */

import type { ToolDefinition } from "@adhd/agent-mcp-types";
import type { EmitShape, ToolFormat } from "../store/tool-format-store.js";

// ──────────────────────────────────────────────
// Error
// ──────────────────────────────────────────────

/** Error code for unsupported native tools ([def:unsupported-native]). */
export type UnsupportedNativeToolErrorCode = "UNSUPPORTED_NATIVE_TOOL";

/**
 * Thrown when the emitter encounters a provider-native tool that this package
 * does not yet execute (e.g. Anthropic client-executed `bash`, `computer`).
 *
 * The message always names the tool + provider and includes the registered note
 * so callers know exactly what is missing — never a silent no-op.
 * ([inv:gate-not-noop])
 */
export class UnsupportedNativeToolError extends Error {
    readonly code: UnsupportedNativeToolErrorCode = "UNSUPPORTED_NATIVE_TOOL";
    readonly toolName: string;
    readonly providerId: string;

    constructor(toolName: string, providerId: string, note: string | null) {
        const detail = note
            ? note
            : `${toolName} on provider ${providerId} is not supported by @adhd/agent-provider`;
        super(
            `Tool '${toolName}' on provider '${providerId}' cannot be emitted: ${detail}`
        );
        this.name = "UnsupportedNativeToolError";
        this.toolName = toolName;
        this.providerId = providerId;
    }
}

// ──────────────────────────────────────────────
// Emitted shapes
// ──────────────────────────────────────────────

/**
 * Standard custom tool definition emitted to the provider API.
 * Matches the Anthropic / OpenAI `{name, description, input_schema}` shape.
 */
export interface EmittedCustomTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

/**
 * Server-side type-tagged entry emitted to the Anthropic API.
 * Has NO `input_schema` — the tool executes on Anthropic's servers.
 * e.g. `{ type: "web_search_20250305", name: "web_search" }`
 * ([def:server-side-tool], [inv:server-side-shape])
 */
export interface EmittedServerSideTool {
    type: string;
    name: string;
}

/** Discriminated union of both emitted shapes. */
export type EmittedTool = EmittedCustomTool | EmittedServerSideTool;

// ──────────────────────────────────────────────
// Lookup signature
// ──────────────────────────────────────────────

/**
 * A function that, given (providerId, canonicalTool), returns the registered
 * ToolFormat row or null if no row exists.  Callers typically pass
 * `ToolFormatStore.getShape` bound to a store instance, but can supply any
 * compatible lookup (e.g. an in-memory fixture in tests).
 */
export type ToolFormatLookup = (
    providerId: string,
    canonicalTool: string
) => ToolFormat | null;

// ──────────────────────────────────────────────
// Emitter
// ──────────────────────────────────────────────

/**
 * Emit a single tool for the given provider.
 *
 * Branches on `emit_shape` from the tool format lookup:
 * - `custom` (or no registered row) → `EmittedCustomTool`
 * - `server_side`                   → `EmittedServerSideTool` (no input_schema)
 * - `unsupported`                   → throws `UnsupportedNativeToolError`
 *
 * @param tool       - The canonical ToolDefinition.
 * @param providerId - The provider id (e.g. "anthropic") used to look up the format row.
 * @param lookup     - Format lookup, typically `store.getShape.bind(store)`.
 * @throws {UnsupportedNativeToolError} when the tool's emit_shape is "unsupported".
 */
export function emitTool(
    tool: ToolDefinition,
    providerId: string,
    lookup: ToolFormatLookup
): EmittedTool {
    const format = lookup(providerId, tool.name);
    const shape: EmitShape = format?.emitShape ?? "custom";

    switch (shape) {
        case "server_side": {
            // type_tag must be set for server_side rows ([inv:server-side-shape])
            const typeTag = format?.typeTag;
            if (!typeTag) {
                throw new Error(
                    `Tool format for '${tool.name}' on provider '${providerId}' is server_side but has no type_tag`
                );
            }
            // Emitted with NO input_schema — server executes it
            return { type: typeTag, name: tool.name } satisfies EmittedServerSideTool;
        }

        case "unsupported": {
            // Always throw — never silent no-op ([inv:gate-not-noop])
            throw new UnsupportedNativeToolError(
                tool.name,
                providerId,
                format?.note ?? null
            );
        }

        default: {
            // "custom" or no registered row → standard tool definition shape
            return {
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
            } satisfies EmittedCustomTool;
        }
    }
}

/**
 * Emit all tools for the given provider, applying `emitTool` to each.
 *
 * Throws on the first `unsupported` tool encountered so callers get an
 * early, actionable error rather than a partially-built list.
 *
 * @param tools      - Array of canonical ToolDefinitions.
 * @param providerId - Provider id used to look up format rows.
 * @param lookup     - Format lookup, typically `store.getShape.bind(store)`.
 * @throws {UnsupportedNativeToolError} on the first unsupported tool.
 */
export function emitToolsForProvider(
    tools: ToolDefinition[],
    providerId: string,
    lookup: ToolFormatLookup
): EmittedTool[] {
    return tools.map(tool => emitTool(tool, providerId, lookup));
}
