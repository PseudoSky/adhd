import type {
  LogicalTypeCodec,
  LogicalTypeId,
  SchemaNode,
  TranscodeCtx,
  Wire,
} from '@adhd/apigen-logical';
import { X_APIGEN_CODEC, X_APIGEN_LOGICAL } from '@adhd/apigen-logical';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Stable, transport-neutral error codes raised by the union codec. Carried on
 * a typed `Error` subclass so callers can branch on `err.code` without
 * string-matching the message.
 */
export type UnionCodecErrorCode =
  | 'E_UNION_NO_DISCRIMINATOR'
  | 'E_UNION_UNKNOWN_TAG'
  | 'E_UNION_INVALID_WIRE';

/** @stable Error carrier for the polymorphic-union (`kind:'union'`) codec. */
export class UnionCodecError extends Error {
  readonly code: UnionCodecErrorCode;
  constructor(code: UnionCodecErrorCode, message: string) {
    super(message);
    this.name = 'UnionCodecError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pull the `discriminator` block off a union schema node (if present). */
function getDiscriminator(
  node: SchemaNode,
): { propertyName: string; mapping: Record<string, string> } | undefined {
  const d = node['discriminator'];
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return undefined;
  const disc = d as Record<string, unknown>;
  if (typeof disc['propertyName'] !== 'string') return undefined;
  const mapping = disc['mapping'];
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) return undefined;
  return {
    propertyName: disc['propertyName'] as string,
    mapping: mapping as Record<string, string>,
  };
}

/**
 * Resolve the codec responsible for a branch schema node.
 *
 * Resolution priority (most-specific first):
 *  1. Direct id lookup via `x-apigen-codec` on the branch node — this is a
 *     stable, unambiguous key that bypasses the ordered `matches()` scan.
 *     This is critical for unions: all nominal branches share `x-apigen-logical
 *     :"nominal"`, so a naïve `registry.resolve(node)` scan stops at whichever
 *     nominal codec was registered first — always wrong for the second branch.
 *  2. Full structural `registry.resolve(node)` scan — for branch schemas that
 *     carry no `x-apigen-codec` (plain object schemas, scalar branches, etc.).
 *  3. Identity pass-through — no codec registered for this branch shape.
 */
function resolveBranchCodec(
  branchNode: SchemaNode,
  ctx: TranscodeCtx,
): LogicalTypeCodec | undefined {
  const codecId = branchNode[X_APIGEN_CODEC];
  if (typeof codecId === 'string') {
    const codec = ctx.registry.get(codecId);
    if (codec) return codec;
  }
  return ctx.registry.resolve(branchNode);
}

/**
 * Encode or decode one union branch value by delegating through `ctx.registry`
 * → the branch codec. Falls back to identity when the branch schema owns no
 * registered codec (a plain object schema passes the field bag through
 * unchanged — per `[inv:hints-advisory]` the structural projection is always
 * the authoritative fallback).
 */
function encodeBranch(value: unknown, branchNode: SchemaNode, ctx: TranscodeCtx): Wire {
  const codec = resolveBranchCodec(branchNode, ctx);
  if (codec) return codec.encode(value, branchNode, ctx);
  // Plain structural object — project as-is (JSON-safe pass-through)
  return value as Wire;
}

function decodeBranch(wire: Wire, branchNode: SchemaNode, ctx: TranscodeCtx): unknown {
  const codec = resolveBranchCodec(branchNode, ctx);
  if (codec) return codec.decode(wire, branchNode, ctx);
  return wire;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options threaded into {@link createUnionCodec} for one polymorphic union. */
export interface UnionCodecOptions {
  /** Stable LogicalTypeId (namespace-qualified, e.g. `cli.Pet`). */
  readonly id: LogicalTypeId;
  /**
   * The union schema node: `{ oneOf:[...], discriminator:{propertyName, mapping} }`.
   * This is the authoritative ownership schema stored on the codec; individual
   * `encode`/`decode` calls may pass a node with `x-apigen-logical` stripped
   * (or a structurally equivalent node) — the codec MUST behave identically.
   */
  readonly schema: SchemaNode;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @stable Codec factory for a discriminated union (`kind:'union'`).
 *
 * Wire shape (DESIGN §3 + §4.1): the value is a JSON object that carries a
 * const discriminator property (e.g. `kind`). The schema node looks like:
 * ```json
 * { "oneOf": [{"$ref":"#/$defs/Dog"},{"$ref":"#/$defs/Cat"}],
 *   "discriminator": {"propertyName":"kind","mapping":{"dog":"#/$defs/Dog","cat":"#/$defs/Cat"}},
 *   "x-apigen-logical": "union" }
 * ```
 *
 * Ownership test — `matches(node)`:
 *   true when the node has BOTH `oneOf` (array) AND `discriminator` (object with
 *   `propertyName`). The `x-apigen-logical:"union"` hint accelerates dispatch but
 *   is NOT required — structure is authoritative (`[inv:hints-advisory]`).
 *
 * Encode (host → wire):
 *  1. Read `discriminator.propertyName` off the **value** to get the tag.
 *     Throws `E_UNION_NO_DISCRIMINATOR` if the tag prop is absent/undefined.
 *  2. Map tag → branch `$ref` via `discriminator.mapping[tag]`.
 *     Throws `E_UNION_UNKNOWN_TAG` if the tag isn't in the mapping.
 *  3. Resolve the branch schema node via `ctx.resolve(ref)`.
 *  4. Delegate encoding of value to the branch codec via `ctx.registry.resolve`,
 *     falling back to structural identity pass-through for plain object schemas.
 *
 * Decode (wire → host) — mirror of encode:
 *  1. Validate the wire is a non-null, non-array object.
 *     Throws `E_UNION_INVALID_WIRE` on a non-object.
 *  2. Read the discriminator tag off the wire object.
 *     Throws `E_UNION_NO_DISCRIMINATOR` if absent.
 *  3. Map tag → branch `$ref` + resolve, then delegate to the branch codec.
 *     Throws `E_UNION_UNKNOWN_TAG` if the tag isn't in the mapping.
 *
 * `[inv:hints-advisory]`: stripping `x-apigen-logical:"union"` from the node
 *  passed to `encode`/`decode` produces identical output. Proven by the
 *  negative-control vector in the spec.
 */
export function createUnionCodec(opts: UnionCodecOptions): LogicalTypeCodec<object> {
  const { id, schema } = opts;

  return {
    id,
    kind: 'union',
    schema,

    /**
     * Structural ownership test: the node carries both `oneOf` (non-empty array)
     * and `discriminator.propertyName`. The `x-apigen-logical:"union"` hint
     * accelerates the match but is advisory — the structure is authoritative.
     */
    matches(node: SchemaNode): boolean {
      // Fast-path: advisory hint present
      if (node[X_APIGEN_LOGICAL] === 'union') return true;
      // Structural: oneOf + discriminator
      const oneOf = node['oneOf'];
      if (!Array.isArray(oneOf) || oneOf.length === 0) return false;
      return getDiscriminator(node) !== undefined;
    },

    encode(value: object, node: SchemaNode, ctx: TranscodeCtx): Wire {
      // ── 1. Read the discriminator tag off the value ──────────────────────────
      const disc = getDiscriminator(node);
      if (!disc) {
        // The node doesn't carry a discriminator block at all — this codec should
        // not have been invoked, but be defensive.
        throw new UnionCodecError(
          'E_UNION_NO_DISCRIMINATOR',
          `[${id}] schema node at "${ctx.path}" has no discriminator.propertyName; cannot dispatch union branch.`,
        );
      }
      const { propertyName, mapping } = disc;
      const tag = (value as Record<string, unknown>)[propertyName];
      if (tag === undefined || tag === null) {
        throw new UnionCodecError(
          'E_UNION_NO_DISCRIMINATOR',
          `[${id}] value at "${ctx.path}" is missing the discriminator property "${propertyName}".`,
        );
      }

      // ── 2. Map tag → branch $ref ──────────────────────────────────────────────
      const tagStr = String(tag);
      const ref = mapping[tagStr];
      if (!ref) {
        throw new UnionCodecError(
          'E_UNION_UNKNOWN_TAG',
          `[${id}] discriminator tag "${tagStr}" at "${ctx.path}" is not in the mapping (known: ${Object.keys(mapping).join(', ')}).`,
        );
      }

      // ── 3. Resolve branch schema via ctx.resolve($ref) ───────────────────────
      const branchNode = ctx.resolve(ref);

      // ── 4. Delegate to branch codec (or structural pass-through) ─────────────
      return encodeBranch(value, branchNode, { ...ctx, path: `${ctx.path}[${tagStr}]` });
    },

    decode(wire: Wire, node: SchemaNode, ctx: TranscodeCtx): object {
      // ── 1. Validate: wire must be a non-null, non-array object ────────────────
      if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) {
        let wireKind: string
        if (wire === null) {
          wireKind = 'null'
        } else if (Array.isArray(wire)) {
          wireKind = 'array'
        } else {
          wireKind = typeof wire
        }
        throw new UnionCodecError(
          'E_UNION_INVALID_WIRE',
          `[${id}] expected a JSON object on the wire at "${ctx.path}", got ${wireKind}.`,
        );
      }
      const wireObj = wire as Record<string, Wire>;

      // ── 2. Read discriminator config from the node ────────────────────────────
      const disc = getDiscriminator(node);
      if (!disc) {
        throw new UnionCodecError(
          'E_UNION_NO_DISCRIMINATOR',
          `[${id}] schema node at "${ctx.path}" has no discriminator.propertyName; cannot dispatch union branch.`,
        );
      }
      const { propertyName, mapping } = disc;

      // ── 3. Read the tag from the wire object ──────────────────────────────────
      const tag = wireObj[propertyName];
      if (tag === undefined || tag === null) {
        throw new UnionCodecError(
          'E_UNION_NO_DISCRIMINATOR',
          `[${id}] wire object at "${ctx.path}" is missing the discriminator property "${propertyName}".`,
        );
      }

      // ── 4. Map tag → branch $ref ──────────────────────────────────────────────
      const tagStr = String(tag);
      const ref = mapping[tagStr];
      if (!ref) {
        throw new UnionCodecError(
          'E_UNION_UNKNOWN_TAG',
          `[${id}] discriminator tag "${tagStr}" on the wire at "${ctx.path}" is not in the mapping (known: ${Object.keys(mapping).join(', ')}).`,
        );
      }

      // ── 5. Resolve branch schema and delegate ────────────────────────────────
      const branchNode = ctx.resolve(ref);
      return decodeBranch(wire, branchNode, { ...ctx, path: `${ctx.path}[${tagStr}]` }) as object;
    },
  };
}
