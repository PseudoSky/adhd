/**
 * @stable Run-mode closure builder for `@adhd/apigen-base-logical`.
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
  override?: Partial<TranscodeCtx>
): TranscodeCtx {
  return {
    registry,
    resolve: (ref) => {
      throw new Error(
        `[apigen-logical] $ref "${ref}" cannot be resolved in run-mode without a descriptor root. ` +
          `Supply a resolve() in the ctx override to handle $ref.`
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
function encodeNode(
  value: unknown,
  schema: SchemaNode,
  ctx: TranscodeCtx
): Wire {
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
      encodeNode(el, items, { ...ctx, path: `${childPath}/${i}` })
    ) as Wire[];
  }

  // ── 5. object ──────────────────────────────────────────────────────────────
  if (schemaType === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return encodeSchemaless(value, schema, ctx);
    }
    const props = schema['properties'] as
      | Record<string, SchemaNode>
      | undefined;
    if (!props) {
      // No properties → passthrough (plain object)
      return encodePassthrough(value) as Wire;
    }
    const childPath = ctx.path;
    const result: { [k: string]: Wire } = {};
    for (const [k, propSchema] of Object.entries(props)) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) {
        result[k] = encodeNode(v, propSchema, {
          ...ctx,
          path: `${childPath}/${k}`,
        });
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
function decodeNode(
  wire: Wire,
  schema: SchemaNode,
  ctx: TranscodeCtx
): unknown {
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
      decodeNode(el, items, { ...ctx, path: `${childPath}/${i}` })
    );
  }

  // ── 5. object ──────────────────────────────────────────────────────────────
  if (schemaType === 'object') {
    if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) {
      return wire;
    }
    const props = schema['properties'] as
      | Record<string, SchemaNode>
      | undefined;
    if (!props) {
      return wire;
    }
    const childPath = ctx.path;
    const result: Record<string, unknown> = {};
    for (const [k, propSchema] of Object.entries(props)) {
      const v = (wire as Record<string, Wire>)[k];
      if (v !== undefined) {
        result[k] = decodeNode(v, propSchema, {
          ...ctx,
          path: `${childPath}/${k}`,
        });
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
 * For a `oneOf` schema, pick the branch that `value` actually inhabits.
 *
 * Resolution order (first match wins):
 *  1. **Discriminator** — an explicit `discriminator.propertyName`:
 *     1a. `mapping` naming a branch by `$ref` (OpenAPI 3 style) — only live
 *         when branches are still `$ref`-wrapped.
 *     1b. the resolved branch's OWN declared `propertyName` schema
 *         (`const`/`enum`) matching the value's tag — works whether or not
 *         `$ref`s survived dereferencing (BUG-APIGEN-RUNMODE-DISCRIMINATOR-
 *         DEREF-001). Always tried when a discriminator is declared, since
 *         1a is silently inert post-dereference.
 *  2. **Structural match** — the branch whose declared shape the value
 *     actually satisfies, scored by {@link scoreUnionBranch}. Only reached
 *     when NO discriminator is declared, or the discriminator's tag matched
 *     no branch (e.g. an unmodelled tag value).
 *  3. **First branch** — only when NOTHING structurally matches.
 *
 * Step 2 is not an optimisation; it is a correctness requirement. TypeScript
 * unions reaching apigen are overwhelmingly UNDISCRIMINATED (`A | B`), and
 * `ts-json-schema-generator` emits them as a bare `oneOf` with no
 * `discriminator`. Before structural matching existed, every such union fell
 * to step 3 and encoded against `oneOf[0]` regardless of the value — and
 * because `encodeNode`'s object arm projects ONLY the branch's declared
 * `properties`, every field absent from that arbitrary first branch was
 * SILENTLY DROPPED from the wire.
 *
 * That is not a theoretical hazard: it shipped. `@adhd/backlog`'s six
 * INTERFACE_v2 verbs return `IOutcomeEnvelope<T>` — an undiscriminated union
 * of an error arm `{ok, error, warnings}` and a success arm `{ok, data,
 * warnings, meta}`. `oneOf[0]` is the ERROR arm, so every successful call
 * over every transport (CLI, MCP, HTTP, OpenAPI) serialized to exactly
 * `{"ok":true}` — `data` and `meta` deleted — while the in-process function
 * returned them correctly. Callers could not read an item, list a query, or
 * learn the id they had just minted. Unit tests never saw it because they
 * call the functions directly and never cross the mount.
 * (BUG-BACKLOG-V2-ENVELOPE-DATA-STRIPPED-001.)
 *
 * Shared by BOTH `encodeNode` and `decodeNode`, so the fix is symmetric.
 *
 * @param value  The host (encode) or wire (decode) value being walked.
 * @param oneOf  The branch schemas.
 * @param schema The union node itself (carries any `discriminator`).
 * @param ctx    Transcode ctx — used to resolve `$ref` branches.
 * @returns The chosen branch schema.
 */
function pickUnionBranch(
  value: unknown,
  oneOf: SchemaNode[],
  schema: SchemaNode,
  ctx: TranscodeCtx
): SchemaNode {
  const discriminator = schema['discriminator'] as
    | { propertyName?: string; mapping?: Record<string, string> }
    | undefined;

  if (discriminator?.propertyName) {
    const propertyName = discriminator.propertyName;
    const tag =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)[propertyName]
        : undefined;

    if (typeof tag === 'string') {
      // 1a. OpenAPI-style `discriminator.mapping` naming a branch by `$ref`
      // (codegen mode, where oneOf branches stay `$ref`-wrapped).
      if (discriminator.mapping) {
        const ref = discriminator.mapping[tag];
        if (ref) {
          const matched = oneOf.find((b) => b['$ref'] === ref);
          if (matched) return matched;
        }
      }

      // 1b. BUG-APIGEN-RUNMODE-DISCRIMINATOR-DEREF-001: match by the
      // RESOLVED branch's own declared discriminator value. 1a alone is
      // silently inert whenever the caller has inlined every `$ref` before
      // dispatch (`@adhd/backlog`'s `dereferenceSchema` does exactly this —
      // its own doc comment explains WHY: run-mode's `ctx.resolve` has no
      // descriptor root and unconditionally throws on any `$ref` it sees, so
      // a host that wants run-mode dispatch to work AT ALL must strip every
      // `$ref` before the schema ever reaches this transcoder). Once
      // `oneOf`'s branches are inlined object schemas, NONE of them carry a
      // `$ref` key any more, so `oneOf.find((b) => b['$ref'] === ref)` above
      // always returns `undefined` and 1a silently no-ops — `mapping` was
      // copied from the PRE-dereference schema, so it still exists and still
      // looks correct, which is what made this invisible.
      //
      // Falling through to structural scoring (step 2) below is NOT a safe
      // substitute here: `scoreUnionBranch` only checks required-key
      // PRESENCE, not literal enum/const values, so any set of sibling
      // branches sharing the exact same property NAMES (e.g. every
      // `{action,report}`-shaped arm of a tagged-union `report` field) scores
      // an exact tie on every call regardless of which branch is actually
      // right, and the documented tie-break ("earliest declared branch wins")
      // then silently re-encodes EVERY tied branch as `oneOf[0]` — dropping
      // every field the real value has that `oneOf[0]`'s branch doesn't
      // declare. Confirmed on `@adhd/backlog`'s `backlog_admin` output
      // union: `prune`/`archive`/`merge`/`import`/`batch`/`reconcile_repo`
      // (six actions, not just the one first reported) all share `doctor`'s
      // `{action,report}` shape and were silently re-encoded as `{}` reports
      // — everything past `action` vanished, live-verified via the built CLI.
      //
      // The correct, general fix: resolve each candidate branch and check
      // whether ITS OWN declared schema for `propertyName` accepts `tag`
      // (`const === tag` or `tag` in `enum`) — this is exactly what
      // "discriminator" means, is agnostic to whether `$ref` survived
      // dereferencing, and needs no `mapping` at all.
      for (const branch of oneOf) {
        const resolved = resolveBranch(branch, ctx);
        const tagSchema = (
          resolved['properties'] as Record<string, SchemaNode> | undefined
        )?.[propertyName];
        if (!tagSchema) continue;
        const enumVals = tagSchema['enum'];
        const constVal = tagSchema['const'];
        if (
          constVal === tag ||
          (Array.isArray(enumVals) && enumVals.includes(tag))
        ) {
          return branch;
        }
      }
    }
  }

  // ── Structural match ───────────────────────────────────────────────────────
  // Score every branch; keep the strictly-best. Ties resolve to the EARLIEST
  // branch, preserving declaration order as the documented tie-break.
  let best: SchemaNode | undefined;
  let bestScore = -1;
  for (const branch of oneOf) {
    const resolved = resolveBranch(branch, ctx);
    const score = scoreUnionBranch(value, resolved, ctx);
    if (score !== null && score > bestScore) {
      bestScore = score;
      best = branch;
    }
  }
  if (best !== undefined) return best;

  // Nothing matched structurally — fall back to declaration order rather than
  // throwing, so an unmodelled value still round-trips as plain JSON.
  return oneOf[0] ?? {};
}

/** Resolve a `$ref` branch to the node it names; other branches pass through. */
function resolveBranch(branch: SchemaNode, ctx: TranscodeCtx): SchemaNode {
  const ref = branch['$ref'];
  return typeof ref === 'string' ? ctx.resolve(ref) : branch;
}

/** The JSON type name of a runtime value, for comparison against `type`. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return t; // 'string' | 'boolean' | 'object' | 'undefined' | ...
}

/**
 * Score how well `value` fits `branch`. Higher is a better fit.
 *
 * Returns `null` — meaning DISQUALIFIED, never chosen — when the branch is
 * definitively wrong for this value:
 *  - the branch declares a `type` the value cannot satisfy, or
 *  - the branch declares `required` keys the value does not carry.
 *
 * The `required` test is what separates the two arms of an outcome envelope:
 * a success value `{ok:true, data:{…}}` fails the error arm's
 * `required:['ok','error']` and passes the success arm's `required:
 * ['ok','data']`.
 *
 * Scoring weights required-key matches above optional ones, so a branch that
 * pins the value's identity beats a broader branch that merely tolerates it.
 * A branch with no constraints at all scores 0 — eligible, but only when
 * nothing better fits.
 */
function scoreUnionBranch(
  value: unknown,
  branch: SchemaNode,
  ctx: TranscodeCtx
): number | null {
  // A `oneOf` nested directly inside a branch: take its best sub-branch score
  // so nesting does not silently disqualify the whole branch.
  const nested = branch['oneOf'];
  if (Array.isArray(nested)) {
    let bestNested: number | null = null;
    for (const sub of nested) {
      const s = scoreUnionBranch(value, resolveBranch(sub, ctx), ctx);
      if (s !== null && (bestNested === null || s > bestNested)) bestNested = s;
    }
    return bestNested;
  }

  const declaredType = branch['type'];
  const actualType = jsonTypeOf(value);

  if (typeof declaredType === 'string') {
    // `integer` is a refinement of `number`; a whole number satisfies both.
    const ok =
      declaredType === actualType ||
      (declaredType === 'number' && actualType === 'integer');
    if (!ok) return null;
  } else if (Array.isArray(declaredType)) {
    const ok = declaredType.some(
      (t) => t === actualType || (t === 'number' && actualType === 'integer')
    );
    if (!ok) return null;
  }

  // Non-objects carry no further structure to compare — a satisfied `type` is
  // the whole signal.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return typeof declaredType === 'string' ? 1 : 0;
  }

  const bag = value as Record<string, unknown>;
  const required = branch['required'];
  let score = 0;

  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== 'string') continue;
      if (bag[key] === undefined) return null; // missing a required key ⇒ wrong branch
      score += 2;
    }
  }

  const props = branch['properties'] as
    | Record<string, SchemaNode>
    | undefined;
  if (props) {
    for (const key of Object.keys(props)) {
      if (bag[key] !== undefined) score += 1;
    }
    // Penalise keys the value carries that this branch does not model at all —
    // they would be DROPPED by `encodeNode`'s projection, which is precisely
    // the data loss this scorer exists to prevent.
    for (const key of Object.keys(bag)) {
      if (props[key] === undefined) score -= 1;
    }
  }

  return score;
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
  ctx: TranscodeCtx
): Wire {
  // A codec may claim this value ONLY via its explicit `ownsValue` predicate.
  //
  // This used to "try every codec's encode; the first that does not throw
  // wins". That heuristic is unsound, because a codec's `encode` is not a
  // membership test: several are TOTAL and never throw for any input
  // (`int64` is `String(value)`, `decimal` is a passthrough). So the winner
  // was decided by registry iteration order, not by the value — and the
  // winner then REWROTE the value. A whole object reaching a `{}` node came
  // back as `{$apigen:'int64', v:'[object Object]'}`: silent, total data
  // destruction on the one path that exists precisely because the schema
  // could not describe the value. (This is DEBT-LT-006's registration-order
  // sensitivity; the consequence was worse than that item recorded.)
  //
  // `ownsValue` is order-independent and false by default, so an unclaimed
  // value now passes through structurally instead of being captured by
  // whichever total codec happened to be registered first.
  for (const id of ctx.registry.ids()) {
    const codec = ctx.registry.get(id);
    if (!codec?.ownsValue?.(value)) continue;
    return { [ENVELOPE_KEY]: id, v: codec.encode(value as never, codec.schema, ctx) };
  }

  // Not owned by any codec: recurse, so a non-JSON-native value NESTED inside
  // an otherwise plain payload still gets its envelope. Without this, only a
  // top-level Date would survive a `{}` node.
  if (Array.isArray(value)) {
    return value.map((v) => encodeSchemaless(v, {}, ctx)) as Wire;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = encodeSchemaless(v, {}, ctx);
    }
    return out as Wire;
  }

  // Scalar (or an exotic object no codec claims) → existing passthrough rules.
  return encodePassthrough(value) as Wire;
}

/**
 * True for a direct-`Object`/null-prototype object — NOT for arrays, `Date`,
 * `Uint8Array`, or any other class instance. Used to decide what is safe to
 * walk key-by-key; a class instance is opaque and belongs to a codec or to
 * `encodePassthrough`, never to a structural walk.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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

  // Mirror `encodeSchemaless`'s recursion: an envelope nested inside a plain
  // container must be unwrapped too, or a payload that encoded correctly
  // decodes back to the raw `{$apigen,v}` bag instead of the host value.
  if (Array.isArray(wire)) {
    return wire.map((w) => decodeEnvelope(w as Wire, ctx));
  }
  if (isPlainObject(wire)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wire)) {
      out[k] = decodeEnvelope(v as Wire, ctx);
    }
    return out;
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
 * @stable Validate all `$ref` values in a schema tree against a `$defs` dictionary.
 *
 * Walks `schema` recursively (into `properties`, `items`, `oneOf`, `$ref`,
 * `additionalProperties`, `propertyNames`) and throws if any `$ref` value
 * does not resolve to a key in `defs`.  Call this during schema generation
 * (e.g., from `generate-schemas.ts`) to surface unresolvable `$ref` values at
 * build time instead of at first runtime invocation (BUG-APIGEN-CORE-001).
 *
 * @param schema - The root schema node to validate.
 * @param defs   - Dictionary of named definitions keyed by full `$ref` URI
 *                 (e.g., `"#/$defs/MyType"`). If omitted, no cross-schema
 *                 validation is performed and only the structural walk runs.
 *
 * @throws {Error} When any `$ref` in `schema` cannot be resolved against `defs`.
 *
 * @example
 * ```ts
 * const defs = { '#/$defs/User': { type: 'object', properties: { ... } } };
 * validateSchemaRefs({ $ref: '#/$defs/User' }, defs); // ok
 * validateSchemaRefs({ $ref: '#/$defs/Missing' }, defs);  // throws
 * ```
 */
export function validateSchemaRefs(
  schema: SchemaNode,
  defs?: Readonly<Record<string, SchemaNode>>
): void {
  const visited = new Set<SchemaNode>();
  const stack: SchemaNode[] = [schema];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (visited.has(node)) continue;
    visited.add(node);

    // $ref — validate and recurse into the resolved definition
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      if (defs) {
        const resolved = defs[ref];
        if (!resolved) {
          const available = Object.keys(defs).join(', ') || '(none)';
          throw new Error(
            `[apigen-logical] $ref "${ref}" cannot be resolved. ` +
              `Available $defs: ${available}`
          );
        }
        stack.push(resolved);
      }
      continue;
    }

    // oneOf
    const oneOf = node['oneOf'];
    if (Array.isArray(oneOf)) {
      for (const branch of oneOf) {
        if (typeof branch === 'object' && branch !== null)
          stack.push(branch as SchemaNode);
      }
    }

    // object properties
    const props = node['properties'] as
      | Record<string, SchemaNode>
      | undefined;
    if (props) {
      for (const v of Object.values(props)) stack.push(v);
    }

    // array items (singular + positional tuple form)
    const items = node['items'];
    if (Array.isArray(items)) {
      for (const it of items) {
        if (typeof it === 'object' && it !== null)
          stack.push(it as SchemaNode);
      }
    } else if (typeof items === 'object' && items !== null) {
      stack.push(items as SchemaNode);
    }

    // additionalProperties schema (maps)
    const addl = node['additionalProperties'];
    if (typeof addl === 'object' && addl !== null)
      stack.push(addl as SchemaNode);

    // propertyNames schema (record key validation)
    const pn = node['propertyNames'];
    if (typeof pn === 'object' && pn !== null) stack.push(pn as SchemaNode);
  }
}

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
  loader: () => LogicalTypeCodec
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
export type { Transcoder, SchemaNode, TranscodeCtx, Wire } from './contracts';
export type { LogicalTypeRegistry } from './registry';
