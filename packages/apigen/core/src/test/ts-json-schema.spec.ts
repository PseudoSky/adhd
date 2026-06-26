/**
 * Tests for the scalar logical-type schema extraction (lt-extract-scalars / BUG-APIGEN-005).
 *
 * Verifies that well-known TS built-in types produce their canonical {type, format}
 * JSON-Schema fragments (§3 / §12-13 of apigen-logical-types/DESIGN.md) instead of
 * falling through to the empty {} schema.
 *
 * Includes a negative-control sense: plain `string` stays {type:"string"} with no format.
 */
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { generateSchemas } from '../index'
import type { GeneratedSchemas } from '../lib/types'

const fixture = (name: string) => path.resolve(__dirname, 'fixtures', name)

// `generateSchemas` builds a full ts-json-schema-generator program per fixture
// (~15s). The assertions below only READ the result, so memoise per fixture path
// instead of regenerating once per `it()` — same fixtures, same assertions, but
// O(fixtures) generations instead of O(tests). Without this the suite runs for
// many minutes (37 tests × ~15s) and times out CI.
const _genCache = new Map<string, Promise<GeneratedSchemas>>()
function gen(sourceFile: string): Promise<GeneratedSchemas> {
  let p = _genCache.get(sourceFile)
  if (!p) {
    p = generateSchemas({ sourceFile })
    _genCache.set(sourceFile, p)
  }
  return p
}

describe('lt-extract-scalars: built-in TS scalar → {type, format}', () => {
  // [lt-extract-scalars.1] guard green: npx nx test apigen-core
  // Each test below is a concrete check that contributes to this criterion.

  it('[scalar.date-time] Date return type extracts as {type:string,format:date-time} (not {})', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const output = result.schemas['returnsDate']?.output
    expect(output).toEqual({ type: 'string', format: 'date-time' })
  })

  it('[scalar.date-time.negative-control] plain string stays {type:string} with no format', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const output = result.schemas['takesString']?.output
    // string return — must be {type:"string"} with no format key
    expect(output).toBeDefined()
    const schema = output as Record<string, unknown>
    expect(schema['type']).toBe('string')
    expect(schema).not.toHaveProperty('format')
  })

  it('[scalar.int64] bigint param extracts as {type:string,format:int64}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['takesBigint']?.input?.properties as Record<string, unknown>
    expect(props?.['value']).toEqual({ type: 'string', format: 'int64' })
  })

  it('[scalar.byte.uint8array] Uint8Array param extracts as {type:string,format:byte}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['takesUint8Array']?.input?.properties as Record<string, unknown>
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' })
  })

  it('[scalar.byte.buffer] Buffer param extracts as {type:string,format:byte}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['takesBuffer']?.input?.properties as Record<string, unknown>
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' })
  })

  it('[scalar.uri] URL param extracts as {type:string,format:uri}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['takesURL']?.input?.properties as Record<string, unknown>
    expect(props?.['url']).toEqual({ type: 'string', format: 'uri' })
  })

  it('[scalar.regex] RegExp param extracts as {type:string,format:regex}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['takesRegExp']?.input?.properties as Record<string, unknown>
    expect(props?.['pattern']).toEqual({ type: 'string', format: 'regex' })
  })
})

/**
 * BUG-APIGEN-013 — nested scalar types must preserve their logical format at any nesting depth.
 *
 * Teeth proof: each assertion uses the OPPOSITE shape as a `not` guard so that
 * reverting the fix (making nested scalars return {}) makes the test go red.
 *
 * The full suite covers:
 *   - Date nested in object return type (the canonical reproduction case)
 *   - Date[] array return type
 *   - Date + Date[] together in one object
 *   - bigint nested in object return (must be int64, not number)
 *   - Uint8Array nested in object (must be byte, not expanded object schema)
 *   - Buffer nested in object (must be byte, not $ref to global.Buffer)
 */
describe('BUG-APIGEN-013: nested scalar logical formats preserved at any depth', () => {
  it('[nested.date-time.obj] { at: Date } output → properties.at is {type:string,format:date-time}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['nestedDate']?.output?.properties as Record<string, unknown>
    // Teeth: if format is dropped, at would be {} — this assertion would fail
    expect(props?.['at']).toEqual({ type: 'string', format: 'date-time' })
    expect(props?.['label']).toEqual({ type: 'string' })
  })

  it('[nested.date-time.obj].negative — {} (dropped format) fails the test', async () => {
    // Negative-control: assert {} would NOT satisfy the format assertion above.
    // If the fix is reverted and props.at === {}, toEqual({type:string,format:date-time}) fails.
    expect({}).not.toEqual({ type: 'string', format: 'date-time' })
  })

  it('[nested.date-time.array] Date[] output → {type:array,items:{type:string,format:date-time}}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const output = result.schemas['dateArray']?.output
    expect(output).toEqual({ type: 'array', items: { type: 'string', format: 'date-time' } })
  })

  it('[nested.date-time.mixed] { at: Date; dates: Date[] } → both fields have date-time format', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['nestedDateAndArray']?.output?.properties as Record<string, unknown>
    expect(props?.['at']).toEqual({ type: 'string', format: 'date-time' })
    expect(props?.['dates']).toEqual({ type: 'array', items: { type: 'string', format: 'date-time' } })
  })

  it('[nested.int64.obj] { n: bigint } output → properties.n is {type:string,format:int64}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['nestedBigint']?.output?.properties as Record<string, unknown>
    // Teeth: ts-json-schema-generator maps bigint→number by default — this must be overridden
    expect(props?.['n']).toEqual({ type: 'string', format: 'int64' })
    // Must NOT be number (the wrong default)
    expect((props?.['n'] as Record<string, unknown>)?.['type']).not.toBe('number')
  })

  it('[nested.byte.uint8array] { data: Uint8Array } output → properties.data is {type:string,format:byte}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['nestedUint8Array']?.output?.properties as Record<string, unknown>
    // Teeth: without the fix, ts-json-schema-generator expands Uint8Array to a full object schema
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' })
    expect((props?.['data'] as Record<string, unknown>)?.['type']).not.toBe('object')
  })

  it('[nested.byte.buffer] { data: Buffer } output → properties.data is {type:string,format:byte}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['nestedBuffer']?.output?.properties as Record<string, unknown>
    // Teeth: without the fix, ts-json-schema-generator emits $ref to global.Buffer
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' })
    expect(props?.['data']).not.toHaveProperty('$ref')
  })
})

/**
 * BUG-APIGEN-013 (gap) — IMPORTED external scalar types nested in objects/arrays.
 *
 * The prior fix covered built-in globals (Date/bigint/Uint8Array/Buffer).
 * This suite covers `Decimal` from `decimal.js` with BOTH import forms at any depth:
 *   - default import:  `import Decimal from 'decimal.js'`
 *   - named import:   `import { Decimal } from 'decimal.js'`
 *   - aliased import: `import { Decimal as D2 } from 'decimal.js'`
 *
 * Teeth proof: if the fix is reverted (aliases not resolved), the nested Decimal
 * property would be `{}` — failing the toEqual assertion and passing the not.toEqual({}).
 */
describe('BUG-APIGEN-013 (gap): imported external scalar (Decimal) nested at any depth', () => {
  const decimalFixture = fixture('decimal-nested.ts')

  it('[nested.decimal.default-import] { cost: Decimal } → properties.cost is {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture)
    const props = result.schemas['withDefaultImport']?.output?.properties as Record<string, unknown>
    // Teeth: if alias resolution is dropped, cost would be {} (TSJSG fails on orphaned D symbol)
    expect(props?.['cost']).toEqual({ type: 'string', format: 'decimal' })
    expect(props?.['cost']).not.toEqual({})
  })

  it('[nested.decimal.named-import] second Decimal function → {type:string,format:decimal} (per-function not cached)', async () => {
    // Confirms the fix applies per-function, not just the first Decimal function extracted.
    // (Both import { Decimal } and import Decimal emit the same qualified form in ts-morph.)
    const result = await gen(decimalFixture)
    const props = result.schemas['withNamedImport']?.output?.properties as Record<string, unknown>
    expect(props?.['cost']).toEqual({ type: 'string', format: 'decimal' })
    expect(props?.['cost']).not.toEqual({})
  })

  it('[nested.decimal.alias-import] { cost: D2 } → properties.cost is {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture)
    const props = result.schemas['withAliasImport']?.output?.properties as Record<string, unknown>
    // Teeth: D2 is a local alias; without alias resolution this would be {}
    expect(props?.['cost']).toEqual({ type: 'string', format: 'decimal' })
    expect(props?.['cost']).not.toEqual({})
  })

  it('[nested.decimal.array] { amounts: Decimal[] } → items is {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture)
    const props = result.schemas['withDecimalArray']?.output?.properties as Record<string, unknown>
    const amounts = props?.['amounts'] as Record<string, unknown>
    // Teeth: without fix, items would be {} because D2 is unresolvable in the temp file
    expect(amounts).toEqual({ type: 'array', items: { type: 'string', format: 'decimal' } })
    expect((amounts?.['items'] as Record<string, unknown>)).not.toEqual({})
  })

  it('[nested.decimal.alias-array] { amounts: D2[] } via alias → items is {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture)
    const props = result.schemas['withAliasArray']?.output?.properties as Record<string, unknown>
    const amounts = props?.['amounts'] as Record<string, unknown>
    expect(amounts).toEqual({ type: 'array', items: { type: 'string', format: 'decimal' } })
    expect((amounts?.['items'] as Record<string, unknown>)).not.toEqual({})
  })

  it('[nested.decimal.param-alias] D2 top-level param → {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture)
    const props = result.schemas['withAliasParam']?.input?.properties as Record<string, unknown>
    expect(props?.['p']).toEqual({ type: 'string', format: 'decimal' })
  })

  it('[nested.decimal.negative-control] plain {a:number,b:string} is unchanged', async () => {
    const result = await gen(decimalFixture)
    const output = result.schemas['plainObject']?.output
    // Plain object must not be affected by alias resolution
    expect((output as Record<string, unknown>)?.properties).toEqual({
      a: { type: 'number' },
      b: { type: 'string' },
    })
  })
})

/**
 * BUG-APIGEN-011 — readonly T[] / ReadonlyArray<T> must preserve element type.
 *
 * Teeth test: if the `readonly ` prefix is NOT stripped before item-type resolution,
 * morphFallback receives "readonly string" (after slicing "[]") which matches nothing
 * and returns {}, so items would be {} and the test would fail.
 */
describe('BUG-APIGEN-011: readonly array element type is preserved', () => {
  it('[readonly-array.string] readonly string[] param schema has items:{type:string} (not {})', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['echoReadonlyStringArray']?.input?.properties as Record<string, unknown>
    expect(props?.['xs']).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('[readonly-array.string.output] readonly string[] return type schema has items:{type:string}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const output = result.schemas['echoReadonlyStringArray']?.output
    expect(output).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('[readonly-array.number] readonly number[] param schema has items:{type:number} (not {})', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['echoReadonlyNumberArray']?.input?.properties as Record<string, unknown>
    expect(props?.['xs']).toEqual({ type: 'array', items: { type: 'number' } })
  })

  it('[readonly-array.generic] ReadonlyArray<string> param schema has items:{type:string}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['echoReadonlyArrayGeneric']?.input?.properties as Record<string, unknown>
    expect(props?.['xs']).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('[readonly-array.nested] readonly string[][] param schema has correct nested items', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['echoNestedReadonlyArray']?.input?.properties as Record<string, unknown>
    // "readonly string[][]" → after stripping readonly → "string[][]"
    // morphFallback: ends with [] → items = morphFallback("string[]") = {type:array,items:{type:string}}
    expect(props?.['xs']).toEqual({ type: 'array', items: { type: 'array', items: { type: 'string' } } })
  })

  it('[readonly-array.negative-control] plain number[] still yields items:{type:number}', async () => {
    // Regression guard: ensure the fix does not break non-readonly arrays
    const { buildSchema } = await import('../lib/schema-builders/ts-json-schema')
    const { Project } = await import('ts-morph')
    const p = new Project({ skipAddingFilesFromTsConfig: true })
    const sf = p.createSourceFile('__ctrl.ts', 'export function f(xs: number[]): void {}', { overwrite: true })
    const schema = await buildSchema(p, sf, 'number[]')
    expect(schema).toEqual({ type: 'array', items: { type: 'number' } })
  })
})

/**
 * REGRESSION GUARD — Map / Set / tuple must produce array-compatible schemas.
 *
 * The BUG-APIGEN-013 fix replaced the legacy `createGenerator()` call (which
 * threw "No root type found" for inline `Map<K,V>` / `Set<T>` and fell through
 * to a permissive `{}`) with an anonymous-temp-file path that SUCCEEDS at
 * expanding the Map/Set CLASS to `{type:object, properties:{size:{type:number}}}`.
 * That object schema rejects the canonical `[[k,v]]` / `[v]` array wire over a
 * live transport (`/data/m must be object`). This suite proves the schemas are
 * array-compatible again WITHOUT reintroducing the permissive `{}` hole, and
 * that nested logical types inside Map/Set/tuple keep their canonical `format`.
 *
 * TEETH: each test asserts the WRONG class-expansion shape is NOT produced, so
 * reverting the fix (letting the temp-file path expand Map/Set) goes red.
 */
describe('REGRESSION: Map / Set / tuple → array-compatible schemas', () => {
  const decimalFixture = fixture('decimal-nested.ts')

  it('[map.basic] Map<number,string> → array of [number,string] 2-tuples (NOT {size:number})', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['echoMap']?.input?.properties as Record<string, unknown>
    expect(props?.['m']).toEqual({
      type: 'array',
      items: { type: 'array', items: [{ type: 'number' }, { type: 'string' }], minItems: 2, maxItems: 2 },
    })
    // Teeth: the class-expansion shape must NOT be produced
    expect(props?.['m']).not.toEqual({
      type: 'object',
      properties: { size: { type: 'number' } },
      required: ['size'],
      additionalProperties: false,
    })
  })

  it('[map.output] Map<number,string> output schema is array-compatible too', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const output = result.schemas['echoMap']?.output
    expect(output).toEqual({
      type: 'array',
      items: { type: 'array', items: [{ type: 'number' }, { type: 'string' }], minItems: 2, maxItems: 2 },
    })
  })

  it('[set.basic] Set<string> → array of strings (NOT {size:number})', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['echoSet']?.input?.properties as Record<string, unknown>
    expect(props?.['s']).toEqual({ type: 'array', items: { type: 'string' }, uniqueItems: true })
    expect((props?.['s'] as Record<string, unknown>)?.['type']).not.toBe('object')
  })

  it('[tuple.basic] [string,number,boolean] → positional items array', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['echoTuple']?.input?.properties as Record<string, unknown>
    expect(props?.['t']).toEqual({
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
      minItems: 3,
      maxItems: 3,
    })
  })

  it('[map.nested-logical] Map<string,Date> value schema is {type:string,format:date-time}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['mapDateValue']?.input?.properties as Record<string, unknown>
    const m = props?.['m'] as Record<string, unknown>
    const entry = m?.['items'] as Record<string, unknown>
    const entryItems = entry?.['items'] as Record<string, unknown>[]
    // [keySchema, valueSchema] — value (index 1) must carry the date-time format
    expect(entryItems?.[0]).toEqual({ type: 'string' })
    expect(entryItems?.[1]).toEqual({ type: 'string', format: 'date-time' })
  })

  it('[set.nested-logical] Set<Decimal> element schema is {type:string,format:decimal}', async () => {
    // Decimal-bearing fixture (small) so scalar-types.ts stays import-free.
    const result = await gen(decimalFixture)
    const props = result.schemas['setDecimal']?.input?.properties as Record<string, unknown>
    const s = props?.['s'] as Record<string, unknown>
    expect(s?.['items']).toEqual({ type: 'string', format: 'decimal' })
  })

  it('[tuple.nested-logical] [Date,number] position 0 schema is {type:string,format:date-time}', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['tupleDate']?.input?.properties as Record<string, unknown>
    const t = props?.['t'] as Record<string, unknown>
    const items = t?.['items'] as Record<string, unknown>[]
    expect(items?.[0]).toEqual({ type: 'string', format: 'date-time' })
    expect(items?.[1]).toEqual({ type: 'number' })
  })

  it('[map.readonly] ReadonlyMap<number,string> behaves like Map', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['echoReadonlyMap']?.input?.properties as Record<string, unknown>
    expect(props?.['m']).toEqual({
      type: 'array',
      items: { type: 'array', items: [{ type: 'number' }, { type: 'string' }], minItems: 2, maxItems: 2 },
    })
  })

  it('[set.readonly] ReadonlySet<string> behaves like Set', async () => {
    const result = await gen(fixture('scalar-types.ts'))
    const props = result.schemas['echoReadonlySet']?.input?.properties as Record<string, unknown>
    expect(props?.['s']).toEqual({ type: 'array', items: { type: 'string' }, uniqueItems: true })
  })

  it('[map.negative-control] the class-expansion {size:number} shape is the WRONG answer', () => {
    // Teeth sentinel: documents the exact pre-fix bug shape.
    expect({ type: 'object', properties: { size: { type: 'number' } } }).not.toEqual({
      type: 'array',
      items: { type: 'array', items: [{ type: 'number' }, { type: 'string' }], minItems: 2, maxItems: 2 },
    })
  })
})
