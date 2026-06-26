import type {
  LogicalTypeCodec,
  LogicalTypeId,
  SchemaNode,
  TranscodeCtx,
  Wire,
} from '@adhd/apigen-logical';
import {
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_LOGICAL,
  X_APIGEN_TOJSON,
} from '@adhd/apigen-logical';

/**
 * Reserved descriptor keyword carrying the extractor's **opt-in-instances**
 * decision (DESIGN.md §4.5 / §13 — risk 8.5, RESOLVED). A class the extractor
 * could not prove reconstructable (sockets, closures, opaque handles) is emitted
 * with `x-apigen-instances:false`; its codec is **encode-only** and `decode`
 * throws a clear `E_NOMINAL_NONRECONSTRUCTABLE` diagnostic rather than minting a
 * half-built instance.
 */
export const X_APIGEN_INSTANCES = 'x-apigen-instances' as const;

/**
 * Stable, transport-neutral error codes raised by the nominal codec. They are
 * carried on a typed `Error` subclass so callers can branch on `err.code`
 * without string-matching the message.
 */
export type NominalCodecErrorCode =
  | 'E_NOMINAL_CYCLE'
  | 'E_NOMINAL_NONRECONSTRUCTABLE'
  | 'E_NOMINAL_INVALID_WIRE';

/** @stable Error carrier for the custom-class (`kind:'nominal'`) codec. */
export class NominalCodecError extends Error {
  readonly code: NominalCodecErrorCode;
  constructor(code: NominalCodecErrorCode, message: string) {
    super(message);
    this.name = 'NominalCodecError';
    this.code = code;
  }
}

/**
 * A host class that knows how to rebuild itself from its field bag. The codec
 * looks up the static reconstructor named by `x-apigen-ctor` (default
 * `fromJSON`) on the registered host class; absent that, it falls back to a
 * schema-projected plain construction.
 */
export type NominalCtor = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (...args: any[]): object;
  fromJSON?(bag: Record<string, unknown>): object;
  [staticCtor: string]: unknown;
};

/** Options threaded into {@link createNominalCodec} for one custom class. */
export interface NominalCodecOptions {
  /** Stable LogicalTypeId (namespace-qualified, e.g. `cli.User`). */
  readonly id: LogicalTypeId;
  /** Resolved `$def` object schema this codec owns (carries `properties`/`required`). */
  readonly schema: SchemaNode;
  /**
   * Host class used to reconstruct instances on decode. OPTIONAL: when absent
   * the codec decodes to a schema-projected plain object (still a faithful
   * round-trip of the field bag — see `[inv:hints-advisory]`).
   */
  readonly ctor?: NominalCtor;
}

/** Read the declared property schemas off a nominal `$def` node. */
function declaredProperties(node: SchemaNode): Record<string, SchemaNode> {
  const props = node['properties'];
  return props && typeof props === 'object' && !Array.isArray(props)
    ? (props as Record<string, SchemaNode>)
    : {};
}

/** Read the `required` field list off a nominal `$def` node. */
function requiredFields(node: SchemaNode): readonly string[] {
  const req = node['required'];
  return Array.isArray(req) ? (req.filter((k) => typeof k === 'string') as string[]) : [];
}

/**
 * Recurse one field VALUE through the registry. If the field's declared schema
 * is owned by a registered codec (e.g. a nested `Date` ⇒ `date-time`), delegate
 * to it; otherwise the value is already plain JSON and passes through. This is
 * the same node-resolution rule the transcoder walk uses (DESIGN.md §4.4), kept
 * local so the nominal codec is self-contained over its own fields.
 */
function encodeField(value: unknown, fieldSchema: SchemaNode | undefined, ctx: TranscodeCtx): Wire {
  if (fieldSchema) {
    const codec = ctx.registry.resolve(fieldSchema);
    if (codec) return codec.encode(value, fieldSchema, ctx);
  }
  return value as Wire;
}

/** Decode mirror of {@link encodeField}: wire field → host field. */
function decodeField(wire: Wire, fieldSchema: SchemaNode | undefined, ctx: TranscodeCtx): unknown {
  if (fieldSchema) {
    const codec = ctx.registry.resolve(fieldSchema);
    if (codec) return codec.decode(wire, fieldSchema, ctx);
  }
  return wire;
}

/**
 * @stable Codec factory for a single custom class (`kind:'nominal'`).
 *
 * Encode (host → wire), DESIGN.md §4/§13:
 *  1. **Cycle guard** — track each visited instance in `ctx.seen`; a back-edge
 *     in `strict` mode throws `E_NOMINAL_CYCLE` (the approved strict policy,
 *     decision 8.3). `lossy` mode breaks the cycle by emitting `null`.
 *  2. **`toJSON` hint** — when the class exposes `toJSON` (named by
 *     `x-apigen-tojson`, default `toJSON`), use its field bag.
 *  3. **Field projection** — otherwise project the schema's declared
 *     `properties`. Either way every field VALUE is recursed through the
 *     registry so nested logical types (e.g. `Date`) encode correctly.
 *
 * Decode (wire → host), validate-then-construct:
 *  1. **Validate** the wire against the node FIRST (object shape + required
 *     fields present) → `E_NOMINAL_INVALID_WIRE` on a mismatch.
 *  2. **Reconstructable gate** — `x-apigen-instances:false` ⇒ encode-only;
 *     decode throws `E_NOMINAL_NONRECONSTRUCTABLE`.
 *  3. **Construct** — via the static reconstructor named by `x-apigen-ctor`
 *     (default `fromJSON`) when the host class is supplied, else a
 *     schema-projected plain object. Field VALUES are recursed first.
 *
 * `[inv:hints-advisory]`: the `x-apigen-*` keys only *accelerate* the choice of
 * hook. With every hint stripped the codec still round-trips via schema
 * projection — proven by a negative-control vector.
 */
export function createNominalCodec(opts: NominalCodecOptions): LogicalTypeCodec<object> {
  const { id, schema, ctor } = opts;

  return {
    id,
    kind: 'nominal',
    schema,

    /**
     * Structural ownership test: the node advertises `x-apigen-logical:'nominal'`
     * or carries an `x-apigen-codec` matching this codec's id. Per
     * `[inv:hints-advisory]` these are accelerators; a later structural fallback
     * (object `$def` with `properties`) is the authoritative signal and is
     * handled by the transcoder walk, not by this cheap test.
     */
    matches(node: SchemaNode): boolean {
      if (node[X_APIGEN_LOGICAL] === 'nominal') return true;
      const codecId = node[X_APIGEN_CODEC];
      return codecId === id;
    },

    encode(value: object, node: SchemaNode, ctx: TranscodeCtx): Wire {
      if (value === null || typeof value !== 'object') {
        // A non-object slipped into a nominal position: pass the primitive
        // through unchanged (the validate layer flags the real shape error).
        return value as Wire;
      }

      // ── 1. Cycle guard (strict rejects back-edges; lossy breaks them) ───────
      if (ctx.seen.has(value)) {
        if (ctx.mode === 'strict') {
          throw new NominalCodecError(
            'E_NOMINAL_CYCLE',
            `[${id}] cycle detected at "${ctx.path}": a nominal instance references itself. ` +
              `Strict mode rejects cycles (DESIGN §8.3); break the cycle or use 'lossy' mode.`,
          );
        }
        return null;
      }
      ctx.seen.add(value);
      try {
        const props = declaredProperties(node);

        // ── 2. toJSON hint ────────────────────────────────────────────────────
        const tojsonName =
          typeof node[X_APIGEN_TOJSON] === 'string' ? (node[X_APIGEN_TOJSON] as string) : 'toJSON';
        const tojson = (value as Record<string, unknown>)[tojsonName];
        if (typeof tojson === 'function') {
          const bag = (tojson as () => unknown).call(value);
          if (bag !== null && typeof bag === 'object' && !Array.isArray(bag)) {
            // Recurse the projected bag through declared field schemas so nested
            // logical types still encode (a custom toJSON may hand back live Dates).
            const out: { [k: string]: Wire } = {};
            for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
              out[k] = encodeField(v, props[k], { ...ctx, path: `${ctx.path}/${k}` });
            }
            return out;
          }
          return bag as Wire;
        }

        // ── 3. Schema-projected field encode ────────────────────────────────────
        const out: { [k: string]: Wire } = {};
        const keys = Object.keys(props);
        const source = value as Record<string, unknown>;
        // Fall back to own enumerable keys when the schema declares no properties
        // (a bare `{type:'object'}` nominal) so we never silently drop fields.
        const fieldKeys = keys.length > 0 ? keys : Object.keys(source);
        for (const k of fieldKeys) {
          const fv = source[k];
          if (fv === undefined) continue;
          out[k] = encodeField(fv, props[k], { ...ctx, path: `${ctx.path}/${k}` });
        }
        return out;
      } finally {
        // Allow the same instance to re-appear on a sibling branch (a DAG is
        // legal; only a true back-edge on the active path is a cycle).
        ctx.seen.delete(value);
      }
    },

    decode(wire: Wire, node: SchemaNode, ctx: TranscodeCtx): object {
      // ── 1. Validate the wire shape FIRST (validate-then-construct) ──────────
      if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) {
        throw new NominalCodecError(
          'E_NOMINAL_INVALID_WIRE',
          `[${id}] expected a JSON object on the wire at "${ctx.path}", got ${
            wire === null ? 'null' : Array.isArray(wire) ? 'array' : typeof wire
          }.`,
        );
      }
      const bagWire = wire as Record<string, Wire>;
      for (const r of requiredFields(node)) {
        if (!(r in bagWire)) {
          throw new NominalCodecError(
            'E_NOMINAL_INVALID_WIRE',
            `[${id}] required field "${r}" missing on the wire at "${ctx.path}".`,
          );
        }
      }

      // ── 2. Reconstructable gate (opt-in-instances) ──────────────────────────
      if (node[X_APIGEN_INSTANCES] === false) {
        throw new NominalCodecError(
          'E_NOMINAL_NONRECONSTRUCTABLE',
          `[${id}] is encode-only: the extractor marked it non-reconstructable ` +
            `(x-apigen-instances:false). It cannot be decoded back to a live instance.`,
        );
      }

      // ── 3. Recurse field values, then construct ─────────────────────────────
      const props = declaredProperties(node);
      const bag: Record<string, unknown> = {};
      for (const [k, fw] of Object.entries(bagWire)) {
        bag[k] = decodeField(fw, props[k], { ...ctx, path: `${ctx.path}/${k}` });
      }

      // Construct via x-apigen-ctor (default `fromJSON`) on the host class when
      // supplied; otherwise return the schema-projected field bag as a plain
      // object (still a faithful round-trip — [inv:hints-advisory]).
      if (ctor) {
        const ctorName =
          typeof node[X_APIGEN_CTOR] === 'string' ? (node[X_APIGEN_CTOR] as string) : 'fromJSON';
        const reconstructor = (ctor as Record<string, unknown>)[ctorName];
        if (typeof reconstructor === 'function') {
          return (reconstructor as (b: Record<string, unknown>) => object).call(ctor, bag);
        }
        // No static reconstructor: build via the constructor, passing the bag.
        // Convention mirrors the §13 TS cell `new {T}({fields})`.
        const Ctor = ctor as new (b: Record<string, unknown>) => object;
        return new Ctor(bag);
      }
      return bag;
    },
  };
}
