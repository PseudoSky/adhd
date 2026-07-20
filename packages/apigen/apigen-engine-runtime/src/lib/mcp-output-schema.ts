// mcp-output-schema.ts — BUG-APIGEN-019 (MCP transport half).
//
// The composed schema's `output` fragment (built by
// `apigen-core-client`'s `buildSchema`/`normalizeTopLevelUnion`) already
// renders a union return type as `oneOf` + an advisory `discriminator`
// instead of a permissive `anyOf`/bare `object` — that half of BUG-APIGEN-019
// was already fixed. But the MCP transport never surfaced ANY `output`
// schema to clients (`tools/list` only ever emitted `inputSchema`), so the
// strengthened schema never reached an MCP host regardless of return type.
//
// The MCP protocol's `Tool.outputSchema` is constrained to a top-level
// `{ type: "object", ... }` shape (see `@modelcontextprotocol/sdk`'s
// `ToolSchema.outputSchema`, a `ZodObject` with a literal `type: "object"`)
// — passing a non-object top-level schema (e.g. this exact `oneOf`
// discriminated-union case) straight through would fail the SDK's own
// runtime validation. So a non-object output is wrapped as
// `{ type: "object", properties: { result: <output> }, required: ["result"] }`
// and the paired runtime value is wrapped the same way in `structuredContent`
// (also constrained to a plain object by the SDK).  An already-object-shaped
// output (the common case) passes through unwrapped on both sides.

/** Result of adapting a composed-schema `output` fragment for MCP's `outputSchema` field. */
export interface McpOutputAdapter {
  /** The MCP `Tool.outputSchema` value, or `undefined` when `output` carries no usable schema. */
  outputSchema: Record<string, unknown> | undefined;
  /** True when the output wasn't top-level `type:"object"` and had to be wrapped under `result`. */
  wrapped: boolean;
}

/**
 * Builds the MCP `outputSchema` for a composed schema's `output` fragment.
 *
 * @param output - `ComposedSchemas[fn].output`, whatever `buildSchema` produced
 *   (may be `type:"object"`, `oneOf`+`discriminator` for a union, an array, a
 *   bare scalar, or `undefined`/`{}` for an unresolved/void return).
 */
export function buildMcpOutputSchema(output: unknown): McpOutputAdapter {
  if (
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    Object.keys(output).length === 0
  ) {
    return { outputSchema: undefined, wrapped: false };
  }
  const rawOutput = output as Record<string, unknown>;
  if (rawOutput['type'] === 'object') {
    return { outputSchema: rawOutput, wrapped: false };
  }
  return {
    outputSchema: {
      type: 'object',
      properties: { result: rawOutput },
      required: ['result'],
    },
    wrapped: true,
  };
}

/**
 * Wraps a tool's actual return value to match the `outputSchema` shape built by
 * `buildMcpOutputSchema` for the SAME `output` fragment, for use as MCP's
 * `structuredContent` (also constrained to a plain object by the SDK).
 */
export function wrapMcpStructuredContent(
  wrapped: boolean,
  value: unknown
): Record<string, unknown> | undefined {
  if (wrapped) return { result: value };
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
