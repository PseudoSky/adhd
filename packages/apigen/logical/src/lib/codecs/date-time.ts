import type { LogicalTypeCodec, SchemaNode, TranscodeCtx, Wire } from '../contracts';

/**
 * @stable Codec for `{type: 'string', format: 'date-time'}`.
 *
 * Canonical wire (DESIGN §3): RFC 3339 UTC string with ≥ms precision.
 * `Date.prototype.toJSON` already emits this format; `toISOString()` is the
 * explicit, deterministic form. Decode validates that the wire is a string
 * before constructing a `Date`.
 */
export const dateTimeCodec: LogicalTypeCodec<Date> = {
  id: 'date-time',
  kind: 'scalar',
  schema: { type: 'string', format: 'date-time' } as SchemaNode,

  matches(node: SchemaNode): boolean {
    return node['type'] === 'string' && node['format'] === 'date-time';
  },

  encode(value: Date, _node: SchemaNode, _ctx: TranscodeCtx): Wire {
    return value.toISOString();
  },

  decode(wire: Wire, _node: SchemaNode, ctx: TranscodeCtx): Date {
    if (typeof wire !== 'string') {
      if (ctx.mode === 'strict') {
        throw new TypeError(
          `[date-time] expected a string on the wire at "${ctx.path}", got ${typeof wire}`,
        );
      }
      return new Date(String(wire));
    }
    // DEBT-LT-001: validate the date string before constructing. An invalid
    // date string like "not-a-date" yields Invalid Date (NaN epochMs), which
    // silently violates the "validate-then-construct" contract (contracts.ts:37).
    if (ctx.mode === 'strict' && Number.isNaN(new Date(wire).getTime())) {
      throw new TypeError(
        `[date-time] invalid date-time string at "${ctx.path}": ${JSON.stringify(wire)}`,
      );
    }
    return new Date(wire);
  },
};
