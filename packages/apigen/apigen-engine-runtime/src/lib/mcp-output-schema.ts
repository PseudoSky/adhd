// mcp-output-schema.ts — ADR-0004: MCP tool output is the FLAT payload on
// `content`; no `{result}` envelope, ever.
//
// History (why this file looked the way it did). MCP restricts
// `Tool.outputSchema` to a root `{ type: "object", ... }`
// (`@modelcontextprotocol/sdk` — "Currently restricted to type: object at the
// root level"). So a composed `output` fragment that was NOT already a
// top-level object — a union rendered as `oneOf`+`discriminator`, an array, or
// a scalar — used to be adapted by wrapping it as
// `{ type:'object', properties:{ result:<output> }, required:['result'] }`
// and pairing the runtime value as `{ result: value }` in `structuredContent`.
//
// That was BUG-APIGEN-019's transport half, and it silently SPLIT the two
// output channels of the SAME call: `content` stayed flat
// (`JSON.stringify(result)`) while `structuredContent` became `{result:value}`
// — a host reading one saw a different shape from a host reading the other,
// contradicting the tool's own documented flat return contract.
//
// ADR-0004 removes the split at this single choke point: an `outputSchema`
// (and therefore a `structuredContent`) is emitted ONLY when the return is
// already a top-level `type:'object'`. A non-object return (union, array,
// scalar, void) is passed through FLAT — no `outputSchema`, no
// `structuredContent`, and NO `{result}` envelope. `outputSchema` is optional
// in MCP, so omitting it is protocol-legal; where it IS emitted (object
// returns) the existing object-validation behaviour is unchanged.

/** Result of adapting a composed-schema `output` fragment for MCP's `outputSchema` field. */
export interface McpOutputAdapter {
  /** The MCP `Tool.outputSchema` value, or `undefined` when the return is not
   *  already a top-level `type:"object"` (nothing protocol-representable to
   *  advertise — see ADR-0004). */
  outputSchema: Record<string, unknown> | undefined;
  /**
   * Whether a matching `structuredContent` should be emitted for this output.
   *
   * `true` iff the return is already a top-level `type:"object"` — the only
   * case in which an `outputSchema` is emitted at all; `false` for a
   * union/array/scalar/void return, which is passed through flat on `content`
   * alone (ADR-0004).
   *
   * Retained under its historical name because the generated host templates
   * destructure `wrapped` and pass it straight to `wrapMcpStructuredContent`
   * (as do already-generated hosts out in the wild). Since ADR-0004 it no
   * longer means "the schema was wrapped under `result`" — nothing is ever
   * wrapped. Read it as `emitStructuredContent`.
   */
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
    return { outputSchema: rawOutput, wrapped: true };
  }
  // ADR-0004: a non-object return is passed through flat. Manufacturing an
  // `outputSchema` for it is exactly what required the `{result}` envelope
  // (and the structuredContent that disagreed with `content`), so we omit the
  // optional `outputSchema` instead.
  return { outputSchema: undefined, wrapped: false };
}

/**
 * Returns the MCP `structuredContent` for a tool's actual return value.
 *
 * `emit` is `McpOutputAdapter.wrapped` for the SAME `output` fragment: only an
 * already-object return emits `structuredContent`, and it is the value itself
 * — never wrapped under `result` (ADR-0004). A non-plain-object value (or an
 * `emit:false` non-object return) yields `undefined`: `structuredContent`
 * (like `outputSchema`) is constrained to a plain object by the SDK, so an
 * array/scalar must not be emitted there.
 */
export function wrapMcpStructuredContent(
  emit: boolean,
  value: unknown
): Record<string, unknown> | undefined {
  if (!emit) return undefined;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
