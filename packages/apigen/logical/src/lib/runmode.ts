/**
 * @stable Run-mode closure builder for `@adhd/apigen-logical`.
 *
 * This module provides the **in-process** (run-mode) path that does NOT generate
 * files. It is the compile-once alternative to the generate-time emitter
 * (`emit.ts`): given a fully populated registry it returns a `Transcoder` that
 * walks a `SchemaNode` tree at runtime and applies the registered codecs — the
 * same walk semantics described in DESIGN.md §4.4, adapted for codegen-first
 * (§11/§14.2).
 *
 * Optional-peer-dep lazy registration (DESIGN.md §14.2): `tryRegister` lets a
 * codec loader call register only when its backing lib is present. A consumer
 * who never uses `Decimal` never installs `decimal.js` and never pays for it.
 */

import { ENVELOPE_KEY } from './contracts';
import type {
  LogicalTypeCodec,
  SchemaNode,
  Transcoder,
  TranscodeCtx,
  Wire,
} from './contracts';
import type { LogicalTypeRegistry } from './registry';

// ---------------------------------------------------------------------------
// Internal walk helpers
// ---------------------------------------------------------------------------

/**
 * Build a full `TranscodeCtx` from the registry and an optional partial
 * override supplied by the caller. The `resolve` function is a no-op stub here
 * (actual $def resolvers are wired in by later states that own the descriptor
 * root); the cycle guard and mode are initialised with safe defaults.
 */
function buildCtx(
  registry: LogicalTypeRegistry,
  override?: Partial<TranscodeCtx>,
): TranscodeCtx {
  return {
    registry,
    resolve: (ref) => {
      throw new Error(
        `[apigen-logical] $ref "${ref}" cannot be resolved in run-mode without a descriptor root. ` +
          `Supply a resolve() in the ctx override to handle $ref.`,
      );
    },
    seen: new WeakSet<object>(),
    path: '',
    mode: 'strict',
    ...override,
  };
}

/**
 * Encode `value` against `schema` within `ctx`.
 *
 * Walk algorithm (DESIGN.md §4.4):
 *   1. If a codec claims the node → delegate.
 *   2. $ref → recurse into resolved def.
 *   3. oneOf → pick branch by discriminator, recurse.
 *   4. type:'array' → map over items.
 *   5. type:'object' → map over properties.
 *   6. schema-less (type absent / additionalProperties-only) → envelope.
 *   7. Plain JSON passthrough.
 */
function encodeNode(value: unknown, schema: SchemaNode, ctx: TranscodeCtx): Wire {
  // ── 1. Registered codec wins ───────────────────────────────────────────────
  const codec = ctx.registry.resolve(schema);
  if (codec) {
    return codec.encode(value, schema, ctx);
  }

  // ── 2. $ref ────────────────────────────────────────────────────────────────
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const resolved = ctx.resolve(ref);
    return encodeNode(value, resolved, ctx);
  }

  // ── 3. oneOf / discriminated union ─────────────────────────────────────────
  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    const branch = pickUnionBranch(value, oneOf, schema, ctx);
    return encodeNode(value, branch, ctx);
  }

  const schemaType = schema['type'];

  // ── 4. array ───────────────────────────────────────────────────────────────
  if (schemaType === 'array') {
    if (!Array.isArray(value)) {
      return encodeSchemaless(value, schema, ctx);
    }
    const items = schema['items'] as SchemaNode | SchemaNode[] | undefined;
    if (!items) {
      // No items schema → passthrough each element as plain JSON
      return (value as unknown[]).map((el) => encodePassthrough(el)) as Wire[];
    }
    const childPath = ctx.path;
    // Positional (tuple) form: `items` is an array of per-index schemas
    // (draft-07 tuple validation). Walk each element against its positional
    // schema; elements past the tuple length pass through as plain JSON.
    if (Array.isArray(items)) {
      return (value as unknown[]).map((el, i) => {
        const itemSchema = items[i];
        return itemSchema === undefined
          ? (encodePassthrough(el) as Wire)
          : encodeNode(el, itemSchema, { ...ctx, path: `${childPath}/${i}` });
      }) as Wire[];
    }
    return (value as unknown[]).map((el, i) =>
      encodeNode(el, items, { ...ctx, path: `${childPath}/${i}` }),
    ) as Wire[];
  }

  // ── 5. object ──────────────────────────────────────────────────────────────
  if (schemaType === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return encodeSchemaless(value, schema, ctx);
    }
    const props = schema['properties'] as Record<string, SchemaNode> | undefined;
    if (!props) {
      // No properties → passthrough (plain object)
      return encodePassthrough(value) as Wire;
    }
    const childPath = ctx.path;
    const result: { [k: string]: Wire } = {};
    for (const [k, propSchema] of Object.entries(props)) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) {
        result[k] = encodeNode(v, propSchema, { ...ctx, path: `${childPath}/${k}` });
      }
    }
    return result;
  }

  // ── 6. Schema-less / any position → envelope ───────────────────────────────
  if (schemaType === undefined || schemaType === null) {
    return encodeSchemaless(value, schema, ctx);
  }

  // ── 7. Plain JSON passthrough ──────────────────────────────────────────────
  return encodePassthrough(value) as Wire;
}

/**
 * Decode `wire` against `schema` within `ctx`.
 *
 * Mirror of `encodeNode`: codec → $ref → oneOf → array → object → envelope →
 * passthrough.
 */
function decodeNode(wire: Wire, schema: SchemaNode, ctx: TranscodeCtx): unknown {
  // ── 1. Registered codec wins ───────────────────────────────────────────────
  const codec = ctx.registry.resolve(schema);
  if (codec) {
    return codec.decode(wire, schema, ctx);
  }

  // ── 2. $ref ────────────────────────────────────────────────────────────────
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const resolved = ctx.resolve(ref);
    return decodeNode(wire, resolved, ctx);
  }

  // ── 3. oneOf / discriminated union ─────────────────────────────────────────
  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    const branch = pickUnionBranch(wire, oneOf, schema, ctx);
    return decodeNode(wire, branch, ctx);
  }

  const schemaType = schema['type'];

  // ── 4. array ───────────────────────────────────────────────────────────────
  if (schemaType === 'array') {
    if (!Array.isArray(wire)) {
      return wire;
    }
    const items = schema['items'] as SchemaNode | SchemaNode[] | undefined;
    if (!items) {
      return wire;
    }
    const childPath = ctx.path;
    // Positional (tuple) form: `items` is an array of per-index schemas.
    // Mirror of the encode side — decode each element against its positional
    // schema; elements past the tuple length pass through unchanged.
    if (Array.isArray(items)) {
      return wire.map((el, i) => {
        const itemSchema = items[i];
        return itemSchema === undefined
          ? el
          : decodeNode(el, itemSchema, { ...ctx, path: `${childPath}/${i}` });
      });
    }
    return wire.map((el, i) =>
      decodeNode(el, items, { ...ctx, path: `${childPath}/${i}` }),
    );
  }

  // ── 5. object ──────────────────────────────────────────────────────────────
  if (schemaType === 'object') {
    if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) {
      return wire;
    }
    const props = schema['properties'] as Record<string, SchemaNode> | undefined;
    if (!props) {
      return wire;
    }
    const childPath = ctx.path;
    const result: Record<string, unknown> = {};
    for (const [k, propSchema] of Object.entries(props)) {
      const v = (wire as Record<string, Wire>)[k];
      if (v !== undefined) {
        result[k] = decodeNode(v, propSchema, { ...ctx, path: `${childPath}/${k}` });
      }
    }
    return result;
  }

  // ── 6. Envelope check (schema-less positions) ──────────────────────────────
  if (schemaType === undefined || schemaType === null) {
    return decodeEnvelope(wire, ctx);
  }

  // ── 7. Passthrough ─────────────────────────────────────────────────────────
  return wire;
}

// ---------------------------------------------------------------------------
// Discriminated union helpers
// ---------------------------------------------------------------------------

/**
 * For a `oneOf` schema, pick the branch whose discriminator property matches
 * `value`. Falls back to the first branch if no discriminator is present.
 */
function pickUnionBranch(
  value: unknown,
  oneOf: SchemaNode[],
  schema: SchemaNode,
  _ctx: TranscodeCtx,
): SchemaNode {
  const discriminator = schema['discriminator'] as
    | { propertyName?: string; mapping?: Record<string, string> }
    | undefined;

  if (discriminator?.propertyName) {
    const tag =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)[discriminator.propertyName]
        : undefined;

    if (typeof tag === 'string' && discriminator.mapping) {
      const ref = discriminator.mapping[tag];
      if (ref) {
        // Find the branch in oneOf whose $ref matches
        const matched = oneOf.find((b) => b['$ref'] === ref);
        if (matched) return matched;
      }
    }
  }

  // Fallback: return the first branch (later states handle structural matching)
  return oneOf[0] ?? {};
}

// ---------------------------------------------------------------------------
// Envelope (schema-less any positions)
// ---------------------------------------------------------------------------

/**
 * Wrap a value in an apigen envelope `{ $apigen: id, v: wire }` when a codec
 * can be found for it, or pass it through as-is.
 *
 * This is the encode side for schema-less (`type` absent) positions (DESIGN.md §4.5).
 */
function encodeSchemaless(
  value: unknown,
  _schema: SchemaNode,
  ctx: TranscodeCtx,
): Wire {
  // Try to find a codec by scanning the registry for one that matches the
  // value directly (e.g. a Date instance). We use a heuristic: attempt every
  // codec's encode; the first that does not throw wins and is wrapped.
  for (const id of ctx.registry.ids()) {
    const codec = ctx.registry.get(id);
    if (!codec) continue;
    try {
      const encoded = codec.encode(value, codec.schema, ctx);
      // Wrap in the self-describing envelope
      return { [ENVELOPE_KEY]: id, v: encoded };
    } catch {
      // Codec does not own this value; try the next one
    }
  }

  // No codec matched → passthrough
  return encodePassthrough(value) as Wire;
}

/**
 * Decode an apigen envelope back to its host value, or return the wire value
 * as-is when no envelope is detected.
 */
function decodeEnvelope(wire: Wire, ctx: TranscodeCtx): unknown {
  if (
    wire !== null &&
    typeof wire === 'object' &&
    !Array.isArray(wire) &&
    ENVELOPE_KEY in (wire as Record<string, unknown>)
  ) {
    const env = wire as { [ENVELOPE_KEY]: string; v: Wire };
    const id = env[ENVELOPE_KEY];
    const codec = ctx.registry.get(id);
    if (codec) {
      return codec.decode(env.v, codec.schema, ctx);
    }
  }
  return wire;
}

/**
 * Recursively drop non-JSON-safe values to produce a plain `Wire`.
 * Functions, undefined, and class instances with no `toJSON` are dropped.
 */
function encodePassthrough(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(encodePassthrough);
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        result[k] = encodePassthrough(v);
      }
    }
    return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @stable Build a compile-once, schema-walking `Transcoder` over a frozen
 * registry snapshot.
 *
 * The returned transcoder is the **in-process (run-mode) analog** of the
 * generate-time emitter: it walks `schema` and the value in lockstep at
 * runtime, applying the registered codec at any node the codec claims, and
 * recursing through object properties, array items, `$ref`, and `oneOf`
 * branches (DESIGN.md §4.4 / §11).
 *
 * Call `registry.freeze()` before passing it here to guarantee a stable,
 * immutable view across concurrent dispatch calls.
 *
 * ## DEBT-LT-006 — registration-order sensitivity of `encodeSchemaless`
 *
 * For schema-less positions (nodes with no `type` or `format`), the
 * `encodeSchemaless` function inside this module iterates `registry.ids()` in
 * **insertion order** and returns the FIRST codec whose `encode()` succeeds.
 * This is a first-match-wins policy.
 *
 * **Consequence:** a permissive custom codec registered BEFORE the canonical
 * well-known codecs (date-time, int64, decimal, etc.) could shadow them at
 * schema-less positions, producing incorrect envelopes.  The standard
 * registration order (via `registerWellKnown()`) is safe because the
 * well-known codecs are inserted first.  Custom codecs should be registered
 * AFTER `registerWellKnown()` unless they intentionally take priority.
 *
 * A future `priority`/`weight` field on `LogicalTypeCodec` would make this
 * explicit and order-independent.
 *
 * @example
 * ```ts
 * const registry = createRegistry();
 * registry.register(myDateCodec);
 * const transcoder = buildTranscoder(registry.freeze());
 *
 * const wire = transcoder.encode(new Date(), { type: 'string', format: 'date-time' });
 * const host = transcoder.decode(wire, { type: 'string', format: 'date-time' });
 * ```
 */
export function buildTranscoder(registry: LogicalTypeRegistry): Transcoder {
  return {
    encode(value, schema, ctxOverride) {
      const ctx = buildCtx(registry, ctxOverride);
      return encodeNode(value, schema, ctx);
    },
    decode(wire, schema, ctxOverride) {
      const ctx = buildCtx(registry, ctxOverride);
      return decodeNode(wire, schema, ctx);
    },
  };
}

/**
 * @stable Optional-peer-dep lazy registration (DESIGN.md §14.2).
 *
 * Attempts to register a codec by calling `loader()`. If `loader` throws a
 * module-not-found error (the backing lib is absent), the registration is
 * silently skipped. Any other error is re-thrown so programming mistakes
 * surface immediately.
 *
 * This lets a consumer who never uses `Decimal` never install `decimal.js`
 * and never pay for it. If a surface *does* use the type and the lib is
 * absent, the fail-fast guard (§15.1) catches it at startup.
 *
 * @param registry - The registry to register into.
 * @param _id      - Logical type id (informational; the codec carries its own).
 * @param loader   - Synchronous factory that returns the codec. May throw
 *                   `MODULE_NOT_FOUND` when the backing lib is absent.
 *
 * @example
 * ```ts
 * tryRegister(registry, 'decimal', () => {
 *   // eslint-disable-next-line @typescript-eslint/no-require-imports
 *   const { Decimal } = require('decimal.js');
 *   return buildDecimalCodec(Decimal);
 * });
 * ```
 */
export function tryRegister(
  registry: LogicalTypeRegistry,
  _id: string,
  loader: () => LogicalTypeCodec,
): void {
  try {
    const codec = loader();
    registry.register(codec);
  } catch (err: unknown) {
    if (isModuleNotFound(err)) {
      // Backing lib absent — silently skip, per §14.2
      return;
    }
    // Programming error or unexpected runtime failure — re-throw
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/** Detect a Node.js MODULE_NOT_FOUND resolution error. */
function isModuleNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  // Node.js require() throws with code 'MODULE_NOT_FOUND'
  return e['code'] === 'MODULE_NOT_FOUND';
}

// Re-export the Transcoder interface so consumers can import from this module.
export type {
  Transcoder,
  SchemaNode,
  TranscodeCtx,
  Wire,
} from './contracts';
export type { LogicalTypeRegistry } from './registry';
