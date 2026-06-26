import type { LogicalTypeCodec, SchemaNode, TranscodeCtx, Wire } from '../contracts';

/**
 * @stable Codec for `{type: 'string', format: 'byte'}`.
 *
 * Canonical wire (DESIGN §3): base64 **standard** variant (RFC 4648 §4) with
 * padding. Uses `+` and `/` — NOT the URL-safe `-` and `_` variant.
 *
 * Host type: `Uint8Array`. Encode uses Node.js `Buffer.from` with the
 * `'base64'` option; decode reconstructs a `Uint8Array` from the standard
 * base64 string.
 */
export const byteCodec: LogicalTypeCodec<Uint8Array> = {
  id: 'byte',
  kind: 'scalar',
  schema: { type: 'string', format: 'byte' } as SchemaNode,

  matches(node: SchemaNode): boolean {
    return node['type'] === 'string' && node['format'] === 'byte';
  },

  encode(value: Uint8Array, _node: SchemaNode, _ctx: TranscodeCtx): Wire {
    // Standard base64 (RFC 4648 §4): '+' and '/' with '=' padding.
    return Buffer.from(value).toString('base64');
  },

  decode(wire: Wire, _node: SchemaNode, ctx: TranscodeCtx): Uint8Array {
    if (typeof wire !== 'string') {
      if (ctx.mode === 'strict') {
        throw new TypeError(
          `[byte] expected a base64 string on the wire at "${ctx.path}", got ${typeof wire}`,
        );
      }
      return new Uint8Array(0);
    }
    // Validate standard base64 alphabet (not URL-safe).
    if (ctx.mode === 'strict' && !/^[A-Za-z0-9+/]*={0,2}$/.test(wire)) {
      throw new TypeError(
        `[byte] wire value at "${ctx.path}" is not standard base64 (format:byte): "${wire}"`,
      );
    }
    return new Uint8Array(Buffer.from(wire, 'base64'));
  },
};
