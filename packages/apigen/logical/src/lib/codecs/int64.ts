import type { LogicalTypeCodec, SchemaNode, TranscodeCtx, Wire } from '../contracts';

/**
 * @stable Codec for `{type: 'string', format: 'int64'}`.
 *
 * Canonical wire (DESIGN §3): decimal string (e.g. `"9007199254740993"`).
 * Avoids JS f64 precision loss for values beyond `Number.MAX_SAFE_INTEGER`.
 *
 * Host type: `bigint`. The encode uses `String(bigint)` which emits a decimal
 * string. Decode uses `BigInt(string)` which is exact over the full int64 range.
 */
export const int64Codec: LogicalTypeCodec<bigint> = {
  id: 'int64',
  kind: 'scalar',
  schema: { type: 'string', format: 'int64' } as SchemaNode,

  matches(node: SchemaNode): boolean {
    return node['type'] === 'string' && node['format'] === 'int64';
  },

  encode(value: bigint, _node: SchemaNode, _ctx: TranscodeCtx): Wire {
    return String(value);
  },

  decode(wire: Wire, _node: SchemaNode, ctx: TranscodeCtx): bigint {
    if (typeof wire !== 'string') {
      if (ctx.mode === 'strict') {
        throw new TypeError(
          `[int64] expected a string on the wire at "${ctx.path}", got ${typeof wire}`,
        );
      }
      return BigInt(String(wire));
    }
    return BigInt(wire);
  },
};
