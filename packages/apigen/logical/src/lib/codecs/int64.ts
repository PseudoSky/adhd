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
      // DEBT-LT-002 (non-string lossy path): BigInt() throws SyntaxError for
      // values like NaN, Infinity, or fractional numbers ("3.14"). Wrap in
      // try/catch so the lossy path is consistent with other lossy handlers.
      try {
        return BigInt(Math.trunc(Number(wire)));
      } catch {
        return BigInt(0);
      }
    }
    // DEBT-LT-002 (string lossy path): BigInt('abc') throws an uncaught
    // SyntaxError. Validate the wire is a decimal-integer string first;
    // fall through to BigInt(0) in lossy mode rather than crashing.
    if (ctx.mode === 'strict') {
      return BigInt(wire);
    }
    // Lossy: only attempt BigInt if the string looks like a decimal integer.
    if (/^-?\d+$/.test(wire)) {
      try {
        return BigInt(wire);
      } catch {
        return BigInt(0);
      }
    }
    return BigInt(0);
  },
};
