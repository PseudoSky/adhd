import type { LogicalTypeCodec, SchemaNode, TranscodeCtx, Wire } from '../contracts';

/**
 * String sentinels for the three non-finite IEEE 754 values.
 * These match the ProtoJSON convention (DESIGN §3 row 13).
 */
const NAN_WIRE = 'NaN' as const;
const INF_WIRE = 'Infinity' as const;
const NEG_INF_WIRE = '-Infinity' as const;

/** The set of valid number-special wire sentinels. */
const SENTINELS: ReadonlySet<string> = new Set([NAN_WIRE, INF_WIRE, NEG_INF_WIRE]);

/**
 * @stable Codec for non-finite JavaScript numbers: `NaN`, `Infinity`, and
 * `-Infinity` (DESIGN §3 row 13).
 *
 * Canonical wire: string sentinels `"NaN"`, `"Infinity"`, `"-Infinity"`.
 * `JSON.stringify` maps these to `null` by default — this codec overrides that.
 *
 * The schema is `{type: 'number'}` (no `format` key). The `matches` predicate
 * therefore checks only `type:'number'`; the codec is the **last-resort** scalar
 * for bare number nodes. The registry resolves codecs in insertion order, so
 * callers should register well-known codecs before arbitrary number ones — but
 * this codec's encode/decode only fire when the registry dispatches it.
 *
 * Note: ordinary finite numbers at a `{type:'number'}` node are passed through
 * without codec involvement (the registry returns `undefined` when no format
 * is present and this codec is not registered). When this codec IS registered,
 * encode maps finite numbers to their numeric value (plain JSON passthrough is
 * done by the walk; encode is only called when the codec wins the dispatch).
 */
export const numberSpecialCodec: LogicalTypeCodec<number> = {
  id: 'number-special',
  kind: 'scalar',
  schema: { type: 'number' } as SchemaNode,

  matches(node: SchemaNode): boolean {
    // Only claim plain {type:'number'} nodes (no format key) so we do not
    // interfere with int64, decimal, or other format-qualified number variants.
    return node['type'] === 'number' && node['format'] === undefined;
  },

  encode(value: number, _node: SchemaNode, ctx: TranscodeCtx): Wire {
    if (Number.isNaN(value)) return NAN_WIRE;
    if (value === Infinity) return INF_WIRE;
    if (value === -Infinity) return NEG_INF_WIRE;
    // DEBT-LT-003: the three guards above exhaust all non-finite IEEE 754
    // values (NaN, +Inf, -Inf). A `!Number.isFinite` check here is unreachable
    // because `Number.isFinite(value)` is always true at this point. Removed.
    return value;
  },

  decode(wire: Wire, _node: SchemaNode, ctx: TranscodeCtx): number {
    if (typeof wire === 'number') return wire;
    if (typeof wire === 'string') {
      if (wire === NAN_WIRE) return NaN;
      if (wire === INF_WIRE) return Infinity;
      if (wire === NEG_INF_WIRE) return -Infinity;
      // A numeric string (e.g. "3.14") — coerce for lossy mode.
      const n = Number(wire);
      if (!Number.isNaN(n)) return n;
    }
    if (ctx.mode === 'strict') {
      throw new TypeError(
        `[number-special] unrecognized wire value at "${ctx.path}": ${JSON.stringify(wire)}. ` +
          `Expected a number or one of ${[...SENTINELS].join(', ')}.`,
      );
    }
    return NaN;
  },
};
