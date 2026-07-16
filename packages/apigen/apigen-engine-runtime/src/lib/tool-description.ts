// tool-description.ts — BUG-APIGEN-020 support.
//
// Builds the human-visible MCP tool `description` string for a composed
// schema entry. Single source of truth shared by:
//   - the mcp plugin's `generate()` (bakes the description into the
//     generated `index.ts` toolMetas at generate time — deterministic,
//     zero runtime cost), and
//   - the mcp plugin's `run()` (dynamic in-process server) — same output
//     for the same inputs.
//
// Combines an optional caller-supplied override (e.g. a `toolDescriptions`
// plugin option) with the auto-generated data-envelope calling-convention
// note that `composeSchemas` (BUG-APIGEN-020) stamps onto the composed
// schema's `input.description`. Falls back to the bare tool name when
// neither is present.

/** The minimal shape this module reads off a composed schema entry. */
export interface ToolDescriptionSchema {
  input?: {
    description?: unknown;
  };
}

/**
 * Builds the description shown for tool `name` in an MCP `tools/list`
 * response.
 *
 * @param name - The MCP tool name (used as the final fallback).
 * @param schema - The function's composed schema (as produced by
 *   `composeSchemas`); `input.description` carries the auto-generated
 *   envelope/data-wrapper documentation.
 * @param override - An optional caller-supplied description (e.g. from the
 *   `toolDescriptions` plugin option), prepended when present.
 */
export function buildToolDescription(
  name: string,
  schema: ToolDescriptionSchema | undefined,
  override?: string
): string {
  const envelopeDoc =
    typeof schema?.input?.description === 'string'
      ? schema.input.description
      : undefined;
  const parts = [override, envelopeDoc].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  return parts.length > 0 ? parts.join(' — ') : name;
}
