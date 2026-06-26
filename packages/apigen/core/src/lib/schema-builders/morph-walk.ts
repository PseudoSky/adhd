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

import type { Node, Project, SourceFile, Type } from 'ts-morph'

/** Async element-schema builder — the shared `buildSchema` entrypoint, injected to avoid a circular import. */
export type RecurseBuildSchema = (typeText: string) => Promise<Record<string, unknown>>

/** Recursion depth guard — anonymous structures are normally shallow; this caps pathological/recursive types. */
const MAX_DEPTH = 8

/**
 * Get a type's user-facing text relative to an enclosing node (so import-relative
 * names like `Decimal` / `Date` come out as the user wrote them), guarding the
 * rare case where ts-morph's `getText` throws on a synthetic node. Returns
 * `undefined` on failure so the caller falls back to a permissive schema.
 */
function safeTypeText(type: Type, node: Node | undefined): string | undefined {
  try {
    return node ? type.getText(node) : type.getText()
  } catch {
    try {
      return type.getText()
    } catch {
      return undefined
    }
  }
}

/** Counter used only to mint unique throwaway alias names; never persisted. */
let _probeSeq = 0

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
  visit: (type: Type) => Promise<T>,
): Promise<T | undefined> {
  const name = `__ApigenProbe_${process.pid}_${_probeSeq++}`
  let alias: ReturnType<SourceFile['addTypeAlias']> | undefined
  try {
    alias = sf.addTypeAlias({ name, type: typeText })
    const type = alias.getType()
    return await visit(type)
  } catch {
    return undefined
  } finally {
    try {
      alias?.remove()
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
  depth: number,
): Promise<Record<string, unknown>> {
  if (depth > MAX_DEPTH) return {}

  // --- primitives -----------------------------------------------------------
  if (type.isString() || type.isStringLiteral()) {
    // String-literal unions are handled in the union branch; a lone literal
    // collapses to its base `string` schema (the prior generator behaviour).
    if (type.isStringLiteral()) return { type: 'string', enum: [type.getLiteralValue() as string] }
    return { type: 'string' }
  }
  if (type.isNumber() || type.isNumberLiteral()) {
    if (type.isNumberLiteral()) return { type: 'number', enum: [type.getLiteralValue() as number] }
    return { type: 'number' }
  }
  if (type.isBoolean()) return { type: 'boolean' }
  if (type.isBooleanLiteral()) return { type: 'boolean' }
  if (type.isNull() || type.isUndefined() || type.isVoid()) return { type: 'null' }

  // --- unions (incl. string-literal enums) ----------------------------------
  if (type.isUnion()) {
    const members = type.getUnionTypes()
    // boolean is internally `true | false`; ts-morph already collapses it via
    // isBoolean() above, but a union containing booleanLiterals can slip
    // through — drop the synthetic split.
    const allStringLiterals = members.every((m) => m.isStringLiteral())
    if (allStringLiterals && members.length > 0) {
      return { type: 'string', enum: members.map((m) => m.getLiteralValue() as string) }
    }
    const allNumberLiterals = members.every((m) => m.isNumberLiteral())
    if (allNumberLiterals && members.length > 0) {
      return { type: 'number', enum: members.map((m) => m.getLiteralValue() as number) }
    }
    const variants = await Promise.all(members.map((m) => walkType(m, recurse, depth + 1)))
    return { anyOf: variants }
  }

  // --- arrays ---------------------------------------------------------------
  // (Tuples are `isArray()===false / isTuple()===true`; Map/Set arrive as
  // objects here only if their text didn't match the map-set-tuple handler,
  // which it always does at the buildSchema entrypoint — so we route element
  // types back through `recurse` by text to re-enter all handlers.)
  if (type.isArray()) {
    const elem = type.getArrayElementType()
    const items = elem ? await recurse(elem.getText()) : {}
    return { type: 'array', items }
  }

  if (type.isTuple()) {
    const elems = type.getTupleElements()
    const itemSchemas = await Promise.all(elems.map((e) => recurse(e.getText())))
    return {
      type: 'array',
      items: itemSchemas,
      minItems: itemSchemas.length,
      maxItems: itemSchemas.length,
    }
  }

  // --- objects (anonymous shapes, Record index signatures, generic instances) ---
  if (type.isObject()) {
    // Index signature first: `Record<string, V>` / `{ [k: string]: V }` →
    // {type:object, additionalProperties:<V>}. This matches the prior
    // ts-json-schema-generator output exactly.
    const stringIndex = type.getStringIndexType()
    const numberIndex = type.getNumberIndexType()
    const indexValue = stringIndex ?? numberIndex
    const namedProps = type.getProperties()

    if (indexValue && namedProps.length === 0) {
      const additionalProperties = await recurse(indexValue.getText())
      return { type: 'object', additionalProperties }
    }

    const properties: Record<string, unknown> = {}
    for (const sym of namedProps) {
      const name = sym.getName()
      // Resolve the property's declared type at its declaration node so we get
      // the user-written type text (e.g. `Date`, `Decimal`, `Date[]`), then
      // route it back through the shared buildSchema for full handler coverage.
      const decls = sym.getDeclarations()
      const node = decls[0]
      let propType: Type | undefined
      if (node) {
        try {
          propType = sym.getTypeAtLocation(node)
        } catch {
          propType = undefined
        }
      }
      // Skip method / function-valued members. A class instance type (e.g.
      // `Wallet`) carries its methods (`deposit`, `toJSON`) as properties, but
      // methods are not serializable data fields — they were never part of the
      // wire schema, and emitting `{}` for them makes the runtime transcoder try
      // to serialize the function body (BUG-APIGEN: makeWallet leaked method
      // sources into the response). Only data-shaped properties belong in the
      // schema, matching how the prior generator (and the JSON wire) behaved.
      if (propType !== undefined && propType.getCallSignatures().length > 0) continue

      const propTypeText = propType !== undefined ? safeTypeText(propType, node) : undefined
      properties[name] = propTypeText !== undefined ? await recurse(propTypeText) : {}
    }

    if (Object.keys(properties).length > 0) {
      return { type: 'object', properties }
    }
    // An index-signature-only object resolved above; anything else with no
    // data-shaped properties (e.g. all-method object) → permissive empty schema.

    // Object with neither named props nor an index signature (e.g. `{}` or an
    // unresolved generic) → permissive empty schema, matching the prior fallback.
    return {}
  }

  // Anything else (intersections we can't frame, `unknown`, `any`, etc.) →
  // permissive empty schema, preserving the prior generator's behaviour.
  return {}
}
