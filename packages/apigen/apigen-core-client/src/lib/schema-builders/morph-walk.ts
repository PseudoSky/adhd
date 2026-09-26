// schema-builders/morph-walk.ts — resolve inline / anonymous types via the
// ALREADY-LOADED ts-morph program instead of spinning up a fresh
// ts-json-schema-generator program per type.
//
// WHY THIS EXISTS (the BUG-APIGEN-013 performance regression):
//
// The BUG-013 fix replaced the single `createGenerator()` call with
// `runScalarAwareGenerator` + an anonymous-type "Path 2" that wrote a temp
// `.ts` file and built a brand-new `ts-json-schema-generator` *program*
// (parse lib.d.ts + the temp file, run the checker) for EVERY anonymous /
// inline type — every inline object return, `Record<…>`, `T[]`, generic
// instantiation (`Box<number>`), union, etc. The named-type path (Path 1) was
// cached per source file, but Path 2 was O(types): each anonymous type cost
// ~0.35–1.0s of full program construction. On the 23-fn showcase that summed
// to ~17.8s; the ts-json-schema.spec suite ballooned to ~494s.
//
// THE FIX: the extractor already holds a fully-loaded ts-morph `Project` /
// `SourceFile` (with lib.d.ts and the user's imports — e.g. `decimal.js` —
// already parsed and type-checked). We resolve the inline type text into a real
// ts-morph `Type` by adding a throwaway in-memory type alias to that SAME
// source file (never saved to disk), then walk the resolved `Type` structurally
// to build the JSON-Schema directly. Reusing the loaded program makes each
// resolution ~10ms instead of ~370ms+ — and there is NO temp file and NO new
// `ts-json-schema-generator` program per anonymous type.
//
// Correctness is preserved by delegating EVERY nested node back through the
// shared `buildSchema` entrypoint (injected as `recurse`): scalar logical
// formats (Date → date-time, bigint → int64, Uint8Array/Buffer → byte,
// Decimal → decimal at any import form/depth), `Map`/`Set`/tuple →
// array-compatible wire, aliases, and readonly arrays all keep flowing through
// their existing, battle-tested handlers. This module only frames the
// *structural* shapes those handlers don't own: anonymous objects, index
// signatures (`Record`), arrays of complex types, and unions.

import type { Node, Project, SourceFile, Type } from 'ts-morph';
import { X_APIGEN_LOGICAL } from '@adhd/apigen-base-logical';

/** Async element-schema builder — the shared `buildSchema` entrypoint, injected to avoid a circular import. */
export type RecurseBuildSchema = (
  typeText: string
) => Promise<Record<string, unknown>>;

/** Recursion depth guard — anonymous structures are normally shallow; this caps pathological/recursive types. */
const MAX_DEPTH = 8;

/**
 * Get a type's user-facing text relative to an enclosing node (so import-relative
 * names like `Decimal` / `Date` come out as the user wrote them), guarding the
 * rare case where ts-morph's `getText` throws on a synthetic node. Returns
 * `undefined` on failure so the caller falls back to a permissive schema.
 */
function safeTypeText(type: Type, node: Node | undefined): string | undefined {
  try {
    return node ? type.getText(node) : type.getText();
  } catch {
    try {
      return type.getText();
    } catch {
      return undefined;
    }
  }
}

/** Counter used only to mint unique throwaway alias names; never persisted. */
let _probeSeq = 0;

/**
 * Resolve a TypeScript type-text string into a ts-morph {@link Type}, evaluated
 * in the lexical scope of `sf` (so the source file's imports and local
 * declarations — `Decimal`, `Box`, `Point`, … — are all in scope).
 *
 * We add a throwaway `type __ApigenProbe_N = <typeText>` alias to the IN-MEMORY
 * source file, read its `.getType()`, run the supplied visitor while the alias
 * node is still live (ts-morph `Type` objects are only meaningfully walkable
 * while their owning node exists), then remove the alias. The file is never
 * `.save()`d, so the user's source on disk is untouched, and re-running the
 * extractor sees the original file.
 *
 * Returns `undefined` if the alias cannot be created or its type cannot be
 * resolved, so the caller can fall through to its text-based fallback.
 */
export async function withResolvedType<T>(
  _project: Project,
  sf: SourceFile,
  typeText: string,
  visit: (type: Type) => Promise<T>
): Promise<T | undefined> {
  const name = `__ApigenProbe_${process.pid}_${_probeSeq++}`;
  let alias: ReturnType<SourceFile['addTypeAlias']> | undefined;
  try {
    alias = sf.addTypeAlias({ name, type: typeText });
    const type = alias.getType();
    return await visit(type);
  } catch {
    return undefined;
  } finally {
    try {
      alias?.remove();
    } catch {
      /* ignore cleanup errors — the alias is in-memory only */
    }
  }
}

/**
 * Walk a ts-morph {@link Type} and build the canonical JSON-Schema fragment for
 * the *structural* shapes that the scalar / Map-Set-tuple handlers don't own:
 * anonymous objects, index signatures (`Record`), arrays, tuples, and unions.
 *
 * Every nested type is routed back through `recurse` (the shared `buildSchema`)
 * via its type-text so scalar formats, Map/Set/tuple wire, aliases, and
 * readonly arrays continue to flow through their existing handlers — this
 * function never re-implements those rules.
 *
 * @param type    The resolved ts-morph Type (live; from {@link withResolvedType}).
 * @param recurse The shared buildSchema entrypoint (resolves nested type-text).
 * @param depth   Recursion guard.
 * @returns A JSON-Schema fragment, or `{}` for genuinely opaque types — matching
 *          the prior permissive fallback (e.g. an unresolvable generic).
 */
export async function walkType(
  type: Type,
  recurse: RecurseBuildSchema,
  depth: number
): Promise<Record<string, unknown>> {
  if (depth > MAX_DEPTH) return {};

  // --- primitives -----------------------------------------------------------
  if (type.isString() || type.isStringLiteral()) {
    // String-literal unions are handled in the union branch; a lone literal
    // collapses to its base `string` schema (the prior generator behaviour).
    if (type.isStringLiteral())
      return { type: 'string', enum: [type.getLiteralValue() as string] };
    return { type: 'string' };
  }
  if (type.isNumber() || type.isNumberLiteral()) {
    if (type.isNumberLiteral())
      return { type: 'number', enum: [type.getLiteralValue() as number] };
    return { type: 'number' };
  }
  if (type.isBoolean()) return { type: 'boolean' };
  // A LONE boolean literal keeps its value as `const`, mirroring the
  // single-value `enum` emitted for string/number literals just above; a bare
  // `{type:'boolean'}` would silently accept the OPPOSITE boolean (e.g. the
  // `true` arm of `true | 'x'` accepting `false`). `getLiteralValue()` returns
  // undefined for boolean literals (ts-morph only stamps `.value` on
  // string/number literals), so read the literal from the type text.
  if (type.isBooleanLiteral())
    return { type: 'boolean', const: type.getText() === 'true' };
  if (type.isNull() || type.isUndefined() || type.isVoid())
    return { type: 'null' };

  // --- unions (incl. string-literal enums) ----------------------------------
  if (type.isUnion()) {
    const members = type.getUnionTypes();
    // boolean is internally `true | false`; ts-morph expands a `boolean` union
    // member into BOTH literals (e.g. `boolean | undefined` → [undefined,
    // false, true] under strictNullChecks, and `string | boolean` → [string,
    // false, true] regardless of strictNullChecks). A real `boolean` member is
    // therefore exactly "both literals present" and collapses to ONE bare
    // `{type:'boolean'}`; a LONE literal (`true | 'x'`) instead carries `const`
    // so its arm does not also accept the opposite boolean. Emitting one
    // variant per literal would duplicate the branch, and a `oneOf` with two
    // identical branches is unsatisfiable (AJV: "must match exactly one schema
    // in oneOf"; surfaced to MCP callers as -32602). Keep only the FIRST
    // boolean-literal member: the true|false split is a type-checker artifact,
    // not a real union distinction. (backlog 3a3e5884)
    const booleanLiteralMembers = members.filter((m) => m.isBooleanLiteral());
    const hasTrue = booleanLiteralMembers.some((m) => m.getText() === 'true');
    const hasFalse = booleanLiteralMembers.some((m) => m.getText() === 'false');
    // Belt-and-suspenders with `dedupeVariants` below, NOT interchangeable:
    // this collapse is what yields the single bare boolean branch (removing it
    // would leave two distinct `const` branches), while `dedupeVariants` is the
    // general guard for any OTHER duplicate-emitting union member. Keep both.
    let sawBooleanLiteral = false;
    const plannedMembers = members.filter((m) => {
      if (!m.isBooleanLiteral()) return true;
      if (sawBooleanLiteral) return false;
      sawBooleanLiteral = true;
      return true;
    });
    const allStringLiterals = members.every((m) => m.isStringLiteral());
    if (allStringLiterals && members.length > 0) {
      return {
        type: 'string',
        enum: members.map((m) => m.getLiteralValue() as string),
      };
    }
    const allNumberLiterals = members.every((m) => m.isNumberLiteral());
    if (allNumberLiterals && members.length > 0) {
      return {
        type: 'number',
        enum: members.map((m) => m.getLiteralValue() as number),
      };
    }
    const rawVariants: Record<string, unknown>[] = await Promise.all(
      plannedMembers.map(async (m) => {
        if (!m.isBooleanLiteral()) return walkType(m, recurse, depth + 1);
        // Both literals ⇒ a real `boolean` member ⇒ bare; a lone literal ⇒
        // `const` (hasTrue flips to `const:false` for the lone-`false` case).
        return hasTrue && hasFalse
          ? { type: 'boolean' }
          : { type: 'boolean', const: hasTrue };
      })
    );
    // BUG-APIGEN-019: a TS union means the runtime value is EXACTLY ONE of
    // these shapes — `oneOf` (mutually exclusive) is the semantically correct
    // JSON-Schema keyword, not `anyOf` (any-match, which permits ambiguity
    // and collapses towards a permissive schema when one arm is broad, e.g.
    // `Record<string, unknown>`). When the variants also share a common
    // literal-discriminant property (the `{ kind: 'dog' } | { kind: 'cat' }`
    // shape), attach an advisory `discriminator` so consumers don't have to
    // structurally diff the branches to know which one matched.
    const discriminator = detectDiscriminator(rawVariants);
    // BUG-APIGEN-059: detectDiscriminator correctly declines a discriminator for a
    // union with a vacuous catch-all branch (by design) — but the returned `oneOf`
    // must use the SANITIZED variants, or that catch-all still ambiguously matches
    // a sibling branch's values. Discriminator detection itself must run on the RAW
    // (pre-sanitized) variants — sanitizeCatchAllVariants's allOf/not wrapping would
    // make a catch-all branch's `type` field indistinguishable from an object branch.
    // backlog 3a3e5884: structurally dedupe BEFORE the catch-all sanitize — a
    // general guard so ANY duplicate-emitting union member (not only the
    // boolean-literal split collapsed above) cannot leave the `oneOf`
    // unsatisfiable. Dedupe runs on the unwrapped variants so identical shapes
    // are still recognised after sanitizeCatchAllVariants rewrites a catch-all
    // into an allOf/not wrapper.
    //
    // Invariant keeping the raw-index discriminator mapping safe (see the
    // info-level review note): `detectDiscriminator(rawVariants)` builds its
    // `mapping` as `#/oneOf/<i>` from the RAW indices, while the emitted array
    // is the deduped+reordered `variants`. That is only sound because a
    // discriminator is returned solely when EVERY variant is an object carrying
    // a single-literal `enum` discriminant that is pairwise DISTINCT across
    // variants — structurally-equal variants would share that discriminant
    // value, so detectDiscriminator would already have declined. Hence whenever
    // `discriminator` is set, `dedupeVariants` removes nothing and
    // `sanitizeCatchAllVariants` is 1:1 and order-preserving, so
    // `variants.length === rawVariants.length` and `#/oneOf/<i>` still points at
    // the branch it was computed from.
    const variants = sanitizeCatchAllVariants(dedupeVariants(rawVariants));
    return {
      oneOf: variants,
      ...(discriminator ? { discriminator } : {}),
      [X_APIGEN_LOGICAL]: 'union',
    };
  }

  // --- arrays ---------------------------------------------------------------
  // (Tuples are `isArray()===false / isTuple()===true`; Map/Set arrive as
  // objects here only if their text didn't match the map-set-tuple handler,
  // which it always does at the buildSchema entrypoint — so we route element
  // types back through `recurse` by text to re-enter all handlers.)
  if (type.isArray()) {
    const elem = type.getArrayElementType();
    const items = elem ? await recurse(elem.getText()) : {};
    return { type: 'array', items };
  }

  if (type.isTuple()) {
    const elems = type.getTupleElements();
    const itemSchemas = await Promise.all(
      elems.map((e) => recurse(e.getText()))
    );
    return {
      type: 'array',
      items: itemSchemas,
      minItems: itemSchemas.length,
      maxItems: itemSchemas.length,
    };
  }

  // --- objects (anonymous shapes, Record index signatures, generic instances) ---
  if (type.isObject()) {
    // Index signature first: `Record<string, V>` / `{ [k: string]: V }` →
    // {type:object, additionalProperties:<V>}. This matches the prior
    // ts-json-schema-generator output exactly.
    const stringIndex = type.getStringIndexType();
    const numberIndex = type.getNumberIndexType();
    const indexValue = stringIndex ?? numberIndex;
    const namedProps = type.getProperties();

    if (indexValue && namedProps.length === 0) {
      const additionalProperties = await recurse(indexValue.getText());
      return { type: 'object', additionalProperties };
    }

    const properties: Record<string, unknown> = {};
    // BUG-APIGEN-CORE-CLIENT-001: object shapes resolved through THIS path
    // (Path 2 — reached whenever Path 1's ts-json-schema-generator lookup
    // fails or is skipped, which is the common case for a named interface
    // used as a function-parameter type: `p.getTypeAtLocation(sig.getDeclaration())
    // .getText()` with no enclosing-node context emits a fully-qualified
    // `import("<abs path>").TypeName` expression — see extract.ts's
    // `rawParams`/`rawParamsFromSig` — which ts-json-schema-generator cannot
    // resolve as a type name and throws, falling through to this walker) must
    // carry non-optional TS properties into the JSON-Schema `required` array
    // the exact same way ts-json-schema-generator's own ObjectTypeFormatter
    // does. Previously this branch never populated `required` at all, so ANY
    // object reaching Path 2 — not just one type — silently lost required-field
    // enforcement at the AJV validate-layer (confirmed: `entrypoint/backlog`'s
    // `CreateItemInput.family` sailed through validation missing entirely,
    // persisting the literal string "undefined").
    const required: string[] = [];
    for (const sym of namedProps) {
      const name = sym.getName();
      // Resolve the property's declared type at its declaration node so we get
      // the user-written type text (e.g. `Date`, `Decimal`, `Date[]`), then
      // route it back through the shared buildSchema for full handler coverage.
      const decls = sym.getDeclarations();
      const node = decls[0];
      let propType: Type | undefined;
      if (node) {
        try {
          propType = sym.getTypeAtLocation(node);
        } catch {
          propType = undefined;
        }
      }
      // Skip method / function-valued members. A class instance type (e.g.
      // `Wallet`) carries its methods (`deposit`, `toJSON`) as properties, but
      // methods are not serializable data fields — they were never part of the
      // wire schema, and emitting `{}` for them makes the runtime transcoder try
      // to serialize the function body (BUG-APIGEN: makeWallet leaked method
      // sources into the response). Only data-shaped properties belong in the
      // schema, matching how the prior generator (and the JSON wire) behaved.
      if (propType !== undefined && propType.getCallSignatures().length > 0)
        continue;

      const propTypeText =
        propType !== undefined ? safeTypeText(propType, node) : undefined;
      properties[name] =
        propTypeText !== undefined ? await recurse(propTypeText) : {};

      // `sym.isOptional()` reflects the TS `?` modifier (interface/type-literal
      // property signatures) — the same signal ts-json-schema-generator's own
      // formatter uses to decide `required` membership.
      if (!sym.isOptional()) required.push(name);
    }

    if (Object.keys(properties).length > 0) {
      const additionalProperties = indexValue
        ? await recurse(indexValue.getText())
        : false;
      return {
        type: 'object',
        properties,
        // Match ts-json-schema-generator's own convention: omit `required`
        // entirely when no property is required, rather than emitting `[]`.
        ...(required.length > 0 ? { required } : {}),
        // BUG-APIGEN-017 (nested case): mirror compose-schemas.ts's top-level
        // additionalProperties:false so Ajv rejects unknown keys on THIS
        // interface-derived nested object too, not only at the envelope/data
        // wrapper. Without this, an unrecognized key nested inside a domain
        // param object (e.g. a typo'd flag on a query-options interface)
        // validates successfully and is then silently discarded by
        // `decodeNode`'s object branch (runtime.ts) instead of erroring —
        // confirmed as BUG-BACKLOG-QUERY-001's actual mechanism: `full`/
        // `view`-shaped optional keys on a nested options object were
        // accepted-and-ignored rather than rejected.
        // Index-signature aware: an interface WITH a string/number index
        // signature legitimately accepts extra keys, so closing it with a
        // hardcoded `false` would reject valid input. `indexValue ? <resolved>
        // : false` keeps the BUG-APIGEN-017 closure above as the default and
        // only opens the schema where the TYPE itself declares it open.
        additionalProperties,
      };
    }
    // An index-signature-only object resolved above; anything else with no
    // data-shaped properties (e.g. all-method object) → permissive empty schema.

    // Object with neither named props nor an index signature (e.g. `{}` or an
    // unresolved generic) → permissive empty schema, matching the prior fallback.
    return {};
  }

  // Anything else (intersections we can't frame, `unknown`, `any`, etc.) →
  // permissive empty schema, preserving the prior generator's behaviour.
  return {};
}

/**
 * True when a schema fragment is a "vacuous catch-all" — one that places no
 * constraint distinguishing it from an arbitrary object (or, for a bare `{}`,
 * from ANY value at all). Two shapes reach here looking like this:
 *   - `{ type: 'object', additionalProperties: <schema> }` with no (or empty)
 *     `properties` — an index-signature-only / `Record<string, V>` object
 *     (see `walkType`'s object branch, `indexValue && namedProps.length === 0`).
 *   - `{}` — the permissive fallback for an unresolved/opaque/all-method type.
 * A branch shaped like this inside a `oneOf` union matches virtually any value
 * that ALSO matches a sibling, more specific branch — which breaks `oneOf`'s
 * exactly-one-match semantics: AJV rejects an otherwise-valid, specifically-shaped
 * value because it satisfies BOTH its own branch and the catch-all
 * (BUG-APIGEN-059).
 */
function isVacuousCatchAll(schema: Record<string, unknown>): boolean {
  if (Object.keys(schema).length === 0) return true;
  return (
    schema['type'] === 'object' &&
    schema['additionalProperties'] !== undefined &&
    schema['additionalProperties'] !== false &&
    (schema['properties'] === undefined ||
      Object.keys(schema['properties'] as Record<string, unknown>).length === 0)
  );
}

/**
 * JSON-Schema keywords whose array value is an UNORDERED SET, so two variants
 * that differ only in the element order of one of these are semantically the
 * same schema and must compare equal in {@link canonicalJson}. `required` is an
 * explicit JSON-Schema set; `enum` and an array-valued `type` are matched by
 * membership, not position. Every OTHER array (`items`/`prefixItems`/`allOf`/…)
 * is positional and is left in order.
 */
const UNORDERED_SET_KEYWORDS = new Set(['required', 'enum', 'type']);

/**
 * Deterministic canonical JSON text for a schema fragment, used to compare two
 * union variants STRUCTURALLY rather than by their incidental key order.
 *
 * `JSON.stringify` is INSERTION-ORDER sensitive: two object schemas that are
 * semantically identical but whose `properties` keys were declared in a
 * different order stringify differently. A dedupe keyed on raw
 * `JSON.stringify` would then keep BOTH branches, and a `oneOf` with two
 * semantically-identical branches is unsatisfiable (AJV "must match exactly one
 * schema in oneOf"; MCP -32602) — the exact failure class this guard exists to
 * remove.
 *
 * Normalisations applied (recursively, at every depth):
 *   - object keys are sorted, so `{a,b}` and `{b,a}` compare equal;
 *   - the unordered-set keywords above are sorted, so e.g.
 *     `required:["a","b"]` and `required:["b","a"]` compare equal (the object
 *     branch emits `properties` AND `required` in declaration order, so both
 *     reorder together for two same-shape interfaces declared differently);
 *   - `undefined`-valued object keys are dropped, matching `JSON.stringify`.
 *
 * LIMITS — this is structural, NOT full semantic equivalence. Positional arrays
 * (`items`/`prefixItems`) and the ORDER of combinator branches inside a nested
 * `oneOf`/`anyOf`/`allOf` are not normalised, so two variants differing only
 * there are treated as distinct. That is a deliberately conservative choice:
 * a false "distinct" merely leaves a redundant branch, whereas a false "equal"
 * would wrongly collapse a genuinely different schema.
 */
function canonicalJson(value: unknown, key?: string): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    const items = value.map((entry) => canonicalJson(entry));
    if (key !== undefined && UNORDERED_SET_KEYWORDS.has(key)) items.sort();
    return `[${items.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], k)}`)
    .join(',')}}`;
}

/**
 * Structurally dedupe union variants by {@link canonicalJson} equality
 * (key-order- and set-element-order-insensitive), preserving the first
 * occurrence's position. A general guard for the defect class where two union
 * members resolve to the SAME schema fragment: ts-morph's synthetic
 * `true | false` boolean-literal expansion is the one known emitter (it is also
 * collapsed up-front in `walkType`'s union branch), but any future
 * duplicate-emitting member would otherwise produce a `oneOf` with two
 * canonically-identical branches — which no value can satisfy under AJV's
 * exactly-one-match rule (backlog 3a3e5884 / MCP -32602).
 */
function dedupeVariants(
  variants: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const v of variants) {
    const key = canonicalJson(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Restores `oneOf` mutual-exclusivity when one or more variants is a vacuous
 * catch-all (see {@link isVacuousCatchAll}): each catch-all variant is rewritten
 * to `{ allOf: [ <catch-all>, { not: { anyOf: <every OTHER variant> } } ] }` so a
 * value already covered by a more specific sibling branch no longer ALSO matches
 * the catch-all (BUG-APIGEN-059). Skipped (variants returned unchanged) when
 * there are fewer than 2 variants, when NO variant is a catch-all (nothing to
 * fix), or when EVERY variant is a catch-all (nothing more specific to exclude
 * against — narrowing would leave zero possible catch-all match, worse than a
 * merely-ambiguous schema).
 */
function sanitizeCatchAllVariants(
  variants: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown>[] {
  if (variants.length < 2) return variants.slice();
  const isCatchAll = variants.map(isVacuousCatchAll);
  const catchAllIdx = variants
    .map((_, i) => (isCatchAll[i] ? i : -1))
    .filter((i) => i >= 0);
  if (catchAllIdx.length === 0 || catchAllIdx.length === variants.length) {
    return variants.slice();
  }
  // The more-specific, non-catch-all siblings every catch-all must exclude.
  const specificIdx = variants
    .map((_, i) => (isCatchAll[i] ? -1 : i))
    .filter((i) => i >= 0);
  return variants.map((v, i) => {
    if (!isCatchAll[i]) return v;
    // Narrow catch-all i against every MORE SPECIFIC branch: the specific
    // siblings AND the catch-alls that PRECEDE it. Excluding only the specific
    // siblings is insufficient — two co-resident catch-alls (e.g. the `{}`
    // that b6a04e7f emits for an imported optional object property, alongside a
    // `Record<string,unknown>`) would then BOTH match an ordinary object and
    // `oneOf` rejects it for matching TWICE — the same consumer-visible failure
    // as the original zero-match shape, merely inverted. Chaining the
    // catch-alls in declaration order partitions the catch-all space: each
    // value is claimed by exactly the FIRST catch-all that accepts it.
    const others = variants.filter(
      (_, j) =>
        j !== i && (specificIdx.includes(j) || (isCatchAll[j] && j < i))
    );
    return { allOf: [v, { not: { anyOf: others } }] };
  });
}

// ---------------------------------------------------------------------------
// BUG-APIGEN-019 — discriminator detection for inline (non-nominal) unions
// ---------------------------------------------------------------------------

/** Advisory discriminator metadata attached to a `oneOf` union fragment. */
export interface InlineDiscriminator {
  /** Name of the property shared by every branch that carries a distinct literal value. */
  propertyName: string;
  /**
   * Literal value → JSON-Pointer into this schema's own `oneOf` array
   * (e.g. `"dog": "#/oneOf/0"`). Inline branches have no `$ref`/`$defs`
   * identity of their own, so — unlike `union.ts`'s $ref-based
   * `buildUnionSchema` — the mapping target is a same-document pointer.
   */
  mapping: Record<string, string>;
}

/**
 * Looks for a property name present in EVERY variant's schema whose value is
 * a single-value string/number `enum` (i.e. a literal, such as `kind: 'dog'`)
 * and whose literal values are pairwise distinct across variants. When found,
 * returns the discriminator metadata; otherwise `undefined` — a plain `oneOf`
 * (no discriminator) still correctly models "exactly one of these variants"
 * even when the variants have no shared literal tag (e.g. a domain interface
 * unioned with `Record<string, unknown>`).
 */
export function detectDiscriminator(
  variants: ReadonlyArray<Record<string, unknown>>
): InlineDiscriminator | undefined {
  if (variants.length < 2) return undefined;

  const propSets: Array<Record<string, unknown>> = [];
  for (const v of variants) {
    if (v['type'] !== 'object') return undefined;
    const props = v['properties'];
    if (!props || typeof props !== 'object') return undefined;
    propSets.push(props as Record<string, unknown>);
  }

  const candidateNames = Object.keys(propSets[0]).filter((name) =>
    propSets.every((p) => Object.prototype.hasOwnProperty.call(p, name))
  );

  for (const name of candidateNames) {
    const values: string[] = [];
    let allSingleLiteral = true;
    for (const props of propSets) {
      const propSchema = props[name] as Record<string, unknown> | undefined;
      const isLiteralType =
        propSchema &&
        (propSchema['type'] === 'string' || propSchema['type'] === 'number');
      const enumValues = propSchema?.['enum'];
      if (
        !isLiteralType ||
        !Array.isArray(enumValues) ||
        enumValues.length !== 1
      ) {
        allSingleLiteral = false;
        break;
      }
      values.push(String(enumValues[0]));
    }
    if (!allSingleLiteral) continue;
    if (new Set(values).size !== values.length) continue; // must be pairwise distinct

    const mapping: Record<string, string> = {};
    values.forEach((v, i) => {
      mapping[v] = `#/oneOf/${i}`;
    });
    return { propertyName: name, mapping };
  }

  return undefined;
}
