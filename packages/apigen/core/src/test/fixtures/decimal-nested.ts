/**
 * Fixture: imported external scalar types (decimal.js Decimal) nested in objects/arrays.
 * Used by ts-json-schema.spec.ts BUG-APIGEN-013 (gap) tests.
 *
 * Covers two import forms in a single file:
 *   - default import: `import Decimal from 'decimal.js'`
 *   - aliased named import: `import { Decimal as D2 } from 'decimal.js'`
 *
 * NOTE: In both cases ts-morph emits the fully-qualified path form:
 *   `import("/abs/.../decimal.js/decimal").default`
 * when the Project is created without a tsconfig.  The fix handles this form.
 *
 * Positions tested:
 *   - nested property in object return type  `{ cost: Decimal }`
 *   - element type of an array return type   `{ amounts: Decimal[] }`
 *   - top-level parameter type               `p: D2`
 */
import Decimal from 'decimal.js'
import { Decimal as D2 } from 'decimal.js'

// --------------------------------------------------------------------------
// default import: `import Decimal from 'decimal.js'`
// ts-morph emits: import("/path/decimal.js/decimal").default
// --------------------------------------------------------------------------

/** Nested Decimal (default import) in object return → cost must be {type:string,format:decimal} */
export async function withDefaultImport(p: Decimal): Promise<{ cost: Decimal }> {
  return { cost: p }
}

/** Decimal[] (default import) nested in object → amounts.items must be {type:string,format:decimal} */
export async function withDecimalArray(p: Decimal): Promise<{ amounts: Decimal[] }> {
  return { amounts: [p] }
}

// --------------------------------------------------------------------------
// Both `import Decimal from 'decimal.js'` and `import { Decimal } from 'decimal.js'`
// produce the same qualified-import type text from ts-morph; tested via withDefaultImport.
// Second function demonstrates the fix applies uniformly to all uses of Decimal:
// --------------------------------------------------------------------------

/** Second Decimal-returning function to confirm the fix applies per-function, not just the first. */
export async function withNamedImport(p: Decimal): Promise<{ cost: Decimal }> {
  return { cost: p }
}

// --------------------------------------------------------------------------
// aliased import: `import { Decimal as D2 } from 'decimal.js'`
// --------------------------------------------------------------------------

/** Nested D2 (aliased import) in object return → cost must be {type:string,format:decimal} */
export async function withAliasImport(p: D2): Promise<{ cost: D2 }> {
  return { cost: p }
}

/** D2[] (aliased import) nested in object → amounts.items must be {type:string,format:decimal} */
export async function withAliasArray(p: D2): Promise<{ amounts: D2[] }> {
  return { amounts: [p] }
}

/** D2 as top-level param → input.properties.p must be {type:string,format:decimal} */
export async function withAliasParam(p: D2): Promise<string> {
  return p.toFixed(2)
}

// --------------------------------------------------------------------------
// Map/Set/tuple regression: nested logical inside a Set must keep its format.
// (Decimal-bearing case lives here so scalar-types.ts stays import-free.)
// --------------------------------------------------------------------------

/** Set<Decimal> → element schema must be {type:string,format:decimal}, NOT {size:number} */
export async function setDecimal(s: Set<Decimal>): Promise<Set<Decimal>> {
  return s
}

// --------------------------------------------------------------------------
// negative control: plain object must be unaffected by alias resolution
// --------------------------------------------------------------------------

/** Plain object with primitives — must not be affected by Decimal alias resolution */
export async function plainObject(x: number): Promise<{ a: number; b: string }> {
  return { a: x, b: String(x) }
}
