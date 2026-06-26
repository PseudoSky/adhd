// schema-builders/map-set-tuple.ts — array-compatible schemas for Map / Set / tuple.
//
// WHY THIS EXISTS (regression fix for the BUG-APIGEN-013 change):
//
// `ts-json-schema-generator` resolves `Map<K,V>` / `Set<T>` to the *class*
// declaration and expands it to its public shape — `{type:object,
// properties:{size:{type:number}}}`. That object schema both (a) rejects the
// canonical array wire at validation time (`/data/m must be object`) and
// (b) tells the runtime transcoder the value is an object, not an entry array.
//
// The canonical apigen wire (DESIGN §3, demo OPS matrix) is:
//   - `Map<K,V>` → `[[k, v], …]`   (array of 2-tuples; supports non-string keys)
//   - `Set<T>`   → `[t, …]`        (array of elements)
//   - `[A,B,C]`  → `[a, b, c]`     (positional tuple)
//
// Before the BUG-013 change these inline generic types were not named root
// types, so `createGenerator(...).createSchema('Map<number, string>')` threw
// "No root type found" and the code fell through to a permissive `{}` schema —
// which happened to round-trip the array wire because `{}` validates anything
// and the transcoder passes `{}` through untouched. The BUG-013 change added an
// anonymous temp-file path that *succeeds* at expanding the class, which is what
// surfaced the wrong `{size:number}` schema. This module restores correct,
// array-compatible schemas WITHOUT reintroducing the permissive `{}` hole, so
// nested logical types inside Map/Set/tuple (e.g. `Map<string, Date>`,
// `Set<Decimal>`, `[Date, number]`) still get their canonical `format`.
//
// The element schemas are produced by recursing through the SAME `buildSchema`
// entrypoint (passed in as `recurse`) so every nesting rule — scalar formats,
// aliases, readonly arrays, nested objects — applies uniformly.

/** Async element-schema builder — the `buildSchema` entrypoint, injected to avoid a circular import. */
export type RecurseBuildSchema = (typeText: string) => Promise<Record<string, unknown>>

/**
 * Split a comma-separated generic argument / tuple-element list at the TOP
 * level only, respecting nested `<…>`, `[…]`, `{…}`, and `(…)` so that
 * `Map<number, string>` splits into `["number", "string"]` and
 * `[Map<string, Date>, number]` splits into `["Map<string, Date>", "number"]`
 * rather than naively on every comma.
 */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '<' || ch === '[' || ch === '{' || ch === '(') depth++
    else if (ch === '>' || ch === ']' || ch === '}' || ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = inner.slice(start).trim()
  if (tail.length > 0) parts.push(tail)
  return parts
}

/**
 * Match `Map<K, V>` / `ReadonlyMap<K, V>` and return the inner argument text
 * (`"K, V"`), or `undefined` if the type text is not a Map.
 */
function matchMap(t: string): string | undefined {
  const m = /^(?:Readonly)?Map<(.+)>$/.exec(t)
  return m ? m[1] : undefined
}

/**
 * Match `Set<T>` / `ReadonlySet<T>` and return the inner element text (`"T"`),
 * or `undefined` if the type text is not a Set.
 */
function matchSet(t: string): string | undefined {
  const m = /^(?:Readonly)?Set<(.+)>$/.exec(t)
  return m ? m[1] : undefined
}

/**
 * Match a tuple type `[A, B, C]` and return its element texts, or `undefined`
 * if the type text is not a tuple. A leading `readonly` modifier is stripped by
 * the caller (`normalizeTypeText`) before this runs, but guard it here too.
 *
 * The empty tuple `[]` and `string[]` (array, not tuple) are intentionally NOT
 * matched: `string[]` does not start with `[`, and `[]` yields zero elements so
 * we leave it to the array path.
 */
function matchTuple(t: string): string[] | undefined {
  let s = t.trim()
  if (s.startsWith('readonly ')) s = s.slice('readonly '.length).trim()
  if (!s.startsWith('[') || !s.endsWith(']')) return undefined
  const inner = s.slice(1, -1).trim()
  if (inner.length === 0) return undefined
  // A tuple element list splits at top-level commas; an array element type like
  // `Array<...>` never reaches here (it has no surrounding brackets).
  return splitTopLevel(inner)
}

/**
 * If `typeText` is a `Map` / `Set` / tuple, build the canonical
 * array-compatible JSON-Schema fragment (recursing into element types via
 * `recurse`). Returns `undefined` for any other type so the caller can fall
 * through to its normal generator path.
 *
 * Schemas produced:
 *   - `Map<K, V>` → `{ type:'array', items:{ type:'array', items:[Kschema, Vschema],
 *                       minItems:2, maxItems:2 } }`
 *   - `Set<T>`    → `{ type:'array', items:Tschema, uniqueItems:true }`
 *   - `[A, B, C]` → `{ type:'array', items:[Aschema, Bschema, Cschema],
 *                       minItems:N, maxItems:N }`  (positional / "prefixItems" form)
 *
 * The tuple positional `items` array is exactly what Ajv (draft-07) validates
 * positionally, and what the runtime transcoder walks position-by-position.
 */
export async function buildMapSetTupleSchema(
  typeText: string,
  recurse: RecurseBuildSchema,
): Promise<Record<string, unknown> | undefined> {
  const t = typeText.trim()

  const mapInner = matchMap(t)
  if (mapInner !== undefined) {
    const args = splitTopLevel(mapInner)
    if (args.length === 2) {
      const [keySchema, valSchema] = await Promise.all([recurse(args[0]), recurse(args[1])])
      return {
        type: 'array',
        items: {
          type: 'array',
          items: [keySchema, valSchema],
          minItems: 2,
          maxItems: 2,
        },
      }
    }
  }

  const setInner = matchSet(t)
  if (setInner !== undefined) {
    const elemSchema = await recurse(setInner)
    return { type: 'array', items: elemSchema, uniqueItems: true }
  }

  const tupleElems = matchTuple(t)
  if (tupleElems !== undefined) {
    const itemSchemas = await Promise.all(tupleElems.map((e) => recurse(e)))
    return {
      type: 'array',
      items: itemSchemas,
      minItems: itemSchemas.length,
      maxItems: itemSchemas.length,
    }
  }

  return undefined
}
