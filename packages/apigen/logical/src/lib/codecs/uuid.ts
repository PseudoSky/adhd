import type { LogicalTypeCodec, SchemaNode, TranscodeCtx, Wire } from '../contracts';

/** @stable Lowercase hyphenated RFC 4122 UUID pattern. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @stable Codec for `{type: 'string', format: 'uuid'}`.
 *
 * Canonical wire (DESIGN §3): lowercase hyphenated RFC 4122 UUID.
 * Host type: `string` (UUIDs are naturally strings in TS). The codec
 * normalizes uppercase input on encode to lowercase and validates on decode.
 */
export const uuidCodec: LogicalTypeCodec<string> = {
  id: 'uuid',
  kind: 'scalar',
  schema: { type: 'string', format: 'uuid' } as SchemaNode,

  matches(node: SchemaNode): boolean {
    return node['type'] === 'string' && node['format'] === 'uuid';
  },

  encode(value: string, _node: SchemaNode, _ctx: TranscodeCtx): Wire {
    // Normalize to lowercase-hyphenated (canonical form).
    return value.toLowerCase();
  },

  decode(wire: Wire, _node: SchemaNode, ctx: TranscodeCtx): string {
    if (typeof wire !== 'string') {
      if (ctx.mode === 'strict') {
        throw new TypeError(
          `[uuid] expected a string on the wire at "${ctx.path}", got ${typeof wire}`,
        );
      }
      return String(wire).toLowerCase();
    }
    if (ctx.mode === 'strict' && !UUID_RE.test(wire)) {
      throw new TypeError(
        `[uuid] wire value "${wire}" at "${ctx.path}" is not a lowercase-hyphenated RFC 4122 UUID`,
      );
    }
    return wire;
  },
};
