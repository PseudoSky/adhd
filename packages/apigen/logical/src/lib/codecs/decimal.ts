import type { LogicalTypeCodec, SchemaNode, TranscodeCtx, Wire } from '../contracts';

/**
 * @stable Branded primitive type for decimal values (mode:'branded', DESIGN §14.2).
 *
 * In TS the default decimal host type is a branded string — zero third-party
 * deps; consumers that need rich arithmetic can opt in to `decimal.js`
 * (DESIGN §14.2, §18 resolved decision). The brand prevents accidental
 * narrowing to `string` at call-sites while keeping the runtime cost zero.
 */
export type DecimalString = string & { readonly __brand: 'DecimalString' };

/**
 * @stable Wrap a plain string as a `DecimalString` branded type.
 *
 * No validation here; the codec validates on decode. Use `makeDecimal` for
 * constructing values from literals or from external strings.
 */
export function makeDecimal(value: string): DecimalString {
  return value as DecimalString;
}

/**
 * @stable Codec for `{type: 'string', format: 'decimal'}`.
 *
 * Canonical wire (DESIGN §3): decimal string (e.g. `"123.456"`), never a
 * float. In TS the host type is the {@link DecimalString} branded string.
 * The encode passes the string through; decode validates the format and brands
 * the result.
 */
export const decimalCodec: LogicalTypeCodec<DecimalString> = {
  id: 'decimal',
  kind: 'scalar',
  schema: { type: 'string', format: 'decimal' } as SchemaNode,

  matches(node: SchemaNode): boolean {
    return node['type'] === 'string' && node['format'] === 'decimal';
  },

  encode(value: DecimalString, _node: SchemaNode, _ctx: TranscodeCtx): Wire {
    // Branded string — passthrough; already a decimal string.
    return value as string;
  },

  decode(wire: Wire, _node: SchemaNode, ctx: TranscodeCtx): DecimalString {
    if (typeof wire !== 'string') {
      if (ctx.mode === 'strict') {
        throw new TypeError(
          `[decimal] expected a string on the wire at "${ctx.path}", got ${typeof wire}`,
        );
      }
      return makeDecimal(String(wire));
    }
    if (ctx.mode === 'strict' && !/^-?\d+(\.\d+)?$/.test(wire)) {
      throw new TypeError(
        `[decimal] wire value "${wire}" at "${ctx.path}" is not a valid decimal string`,
      );
    }
    return makeDecimal(wire);
  },
};
