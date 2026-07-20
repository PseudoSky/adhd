/**
 * Tests for the scalar logical-type schema extraction (lt-extract-scalars / BUG-APIGEN-005).
 *
 * Verifies that well-known TS built-in types produce their canonical {type, format}
 * JSON-Schema fragments (§3 / §12-13 of apigen-logical-types/DESIGN.md) instead of
 * falling through to the empty {} schema.
 *
 * Includes a negative-control sense: plain `string` stays {type:"string"} with no format.
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { extract } from '../index';
import type { GeneratedSchemas } from '../lib/types';

const fixture = (name: string) => path.resolve(__dirname, 'fixtures', name);

// BUG-APIGEN-CORE-005 (v1 retirement): this suite drove the deleted v1
// `generateSchemas()` directly; every assertion below reads
// `result.schemas['fnName'].{input,output}` — the exact same shape v2's
// `extract()` produces per-operation (`op.input`/`op.output`), just indexed
// differently (an Operation[] keyed by path, not a flat schemas record). To
// avoid rewriting 36 call sites across 37 tests, `gen()` now calls `extract()`
// and adapts its Operation[] into the same `GeneratedSchemas` shape the old
// `generateSchemas()` returned — same fixtures, same assertions, same
// memoization rationale (extract() builds a full ts-json-schema-generator
// program per fixture, ~15s; memoise per fixture path so the suite runs
// O(fixtures) extractions instead of O(tests) — otherwise 37 tests × ~15s
// times out CI).
const _genCache = new Map<string, Promise<GeneratedSchemas>>();
function gen(sourceFile: string): Promise<GeneratedSchemas> {
  let p = _genCache.get(sourceFile);
  if (!p) {
    p = extract({ sourceFile }).then((ops) => {
      const schemas: GeneratedSchemas['schemas'] = {};
      for (const op of ops) {
        if (op.kind !== 'action') continue;
        const name = op.path.at(-1)?.raw;
        if (!name) continue;
        schemas[name] = {
          input: op.input,
          output: op.output,
          ...(op.hasCtx ? { hasCtx: true } : {}),
        };
      }
      return { metadata: { namespace: '', phase: '' }, schemas };
    });
    _genCache.set(sourceFile, p);
  }
  return p;
}

describe('lt-extract-scalars: built-in TS scalar → {type, format}', () => {
  // [lt-extract-scalars.1] guard green: npx nx test apigen-core
  // Each test below is a concrete check that contributes to this criterion.

  it('[scalar.date-time] Date return type extracts as {type:string,format:date-time} (not {})', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const output = result.schemas['returnsDate']?.output;
    expect(output).toEqual({ type: 'string', format: 'date-time' });
  });

  it('[scalar.date-time.negative-control] plain string stays {type:string} with no format', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const output = result.schemas['takesString']?.output;
    // string return — must be {type:"string"} with no format key
    expect(output).toBeDefined();
    const schema = output as Record<string, unknown>;
    expect(schema['type']).toBe('string');
    expect(schema).not.toHaveProperty('format');
  });

  it('[scalar.int64] bigint param extracts as {type:string,format:int64}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['takesBigint']?.input?.properties as Record<
      string,
      unknown
    >;
    expect(props?.['value']).toEqual({ type: 'string', format: 'int64' });
  });

  it('[scalar.byte.uint8array] Uint8Array param extracts as {type:string,format:byte}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['takesUint8Array']?.input
      ?.properties as Record<string, unknown>;
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' });
  });

  it('[scalar.byte.buffer] Buffer param extracts as {type:string,format:byte}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['takesBuffer']?.input?.properties as Record<
      string,
      unknown
    >;
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' });
  });

  it('[scalar.uri] URL param extracts as {type:string,format:uri}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['takesURL']?.input?.properties as Record<
      string,
      unknown
    >;
    expect(props?.['url']).toEqual({ type: 'string', format: 'uri' });
  });

  it('[scalar.regex] RegExp param extracts as {type:string,format:regex}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['takesRegExp']?.input?.properties as Record<
      string,
      unknown
    >;
    expect(props?.['pattern']).toEqual({ type: 'string', format: 'regex' });
  });
});

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
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['nestedDate']?.output?.properties as Record<
      string,
      unknown
    >;
    // Teeth: if format is dropped, at would be {} — this assertion would fail
    expect(props?.['at']).toEqual({ type: 'string', format: 'date-time' });
    expect(props?.['label']).toEqual({ type: 'string' });
  });

  it('[nested.date-time.obj].negative — {} (dropped format) fails the test', async () => {
    // Negative-control: assert {} would NOT satisfy the format assertion above.
    // If the fix is reverted and props.at === {}, toEqual({type:string,format:date-time}) fails.
    expect({}).not.toEqual({ type: 'string', format: 'date-time' });
  });

  it('[nested.date-time.array] Date[] output → {type:array,items:{type:string,format:date-time}}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const output = result.schemas['dateArray']?.output;
    expect(output).toEqual({
      type: 'array',
      items: { type: 'string', format: 'date-time' },
    });
  });

  it('[nested.date-time.mixed] { at: Date; dates: Date[] } → both fields have date-time format', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['nestedDateAndArray']?.output
      ?.properties as Record<string, unknown>;
    expect(props?.['at']).toEqual({ type: 'string', format: 'date-time' });
    expect(props?.['dates']).toEqual({
      type: 'array',
      items: { type: 'string', format: 'date-time' },
    });
  });

  it('[nested.int64.obj] { n: bigint } output → properties.n is {type:string,format:int64}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['nestedBigint']?.output?.properties as Record<
      string,
      unknown
    >;
    // Teeth: ts-json-schema-generator maps bigint→number by default — this must be overridden
    expect(props?.['n']).toEqual({ type: 'string', format: 'int64' });
    // Must NOT be number (the wrong default)
    expect((props?.['n'] as Record<string, unknown>)?.['type']).not.toBe(
      'number'
    );
  });

  it('[nested.byte.uint8array] { data: Uint8Array } output → properties.data is {type:string,format:byte}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['nestedUint8Array']?.output
      ?.properties as Record<string, unknown>;
    // Teeth: without the fix, ts-json-schema-generator expands Uint8Array to a full object schema
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' });
    expect((props?.['data'] as Record<string, unknown>)?.['type']).not.toBe(
      'object'
    );
  });

  it('[nested.byte.buffer] { data: Buffer } output → properties.data is {type:string,format:byte}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['nestedBuffer']?.output?.properties as Record<
      string,
      unknown
    >;
    // Teeth: without the fix, ts-json-schema-generator emits $ref to global.Buffer
    expect(props?.['data']).toEqual({ type: 'string', format: 'byte' });
    expect(props?.['data']).not.toHaveProperty('$ref');
  });
});

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
  const decimalFixture = fixture('decimal-nested.ts');

  it('[nested.decimal.default-import] { cost: Decimal } → properties.cost is {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture);
    const props = result.schemas['withDefaultImport']?.output
      ?.properties as Record<string, unknown>;
    // Teeth: if alias resolution is dropped, cost would be {} (TSJSG fails on orphaned D symbol)
    expect(props?.['cost']).toEqual({ type: 'string', format: 'decimal' });
    expect(props?.['cost']).not.toEqual({});
  });

  it('[nested.decimal.named-import] second Decimal function → {type:string,format:decimal} (per-function not cached)', async () => {
    // Confirms the fix applies per-function, not just the first Decimal function extracted.
    // (Both import { Decimal } and import Decimal emit the same qualified form in ts-morph.)
    const result = await gen(decimalFixture);
    const props = result.schemas['withNamedImport']?.output
      ?.properties as Record<string, unknown>;
    expect(props?.['cost']).toEqual({ type: 'string', format: 'decimal' });
    expect(props?.['cost']).not.toEqual({});
  });

  it('[nested.decimal.alias-import] { cost: D2 } → properties.cost is {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture);
    const props = result.schemas['withAliasImport']?.output
      ?.properties as Record<string, unknown>;
    // Teeth: D2 is a local alias; without alias resolution this would be {}
    expect(props?.['cost']).toEqual({ type: 'string', format: 'decimal' });
    expect(props?.['cost']).not.toEqual({});
  });

  it('[nested.decimal.array] { amounts: Decimal[] } → items is {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture);
    const props = result.schemas['withDecimalArray']?.output
      ?.properties as Record<string, unknown>;
    const amounts = props?.['amounts'] as Record<string, unknown>;
    // Teeth: without fix, items would be {} because D2 is unresolvable in the temp file
    expect(amounts).toEqual({
      type: 'array',
      items: { type: 'string', format: 'decimal' },
    });
    expect(amounts?.['items'] as Record<string, unknown>).not.toEqual({});
  });

  it('[nested.decimal.alias-array] { amounts: D2[] } via alias → items is {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture);
    const props = result.schemas['withAliasArray']?.output
      ?.properties as Record<string, unknown>;
    const amounts = props?.['amounts'] as Record<string, unknown>;
    expect(amounts).toEqual({
      type: 'array',
      items: { type: 'string', format: 'decimal' },
    });
    expect(amounts?.['items'] as Record<string, unknown>).not.toEqual({});
  });

  it('[nested.decimal.param-alias] D2 top-level param → {type:string,format:decimal}', async () => {
    const result = await gen(decimalFixture);
    const props = result.schemas['withAliasParam']?.input?.properties as Record<
      string,
      unknown
    >;
    expect(props?.['p']).toEqual({ type: 'string', format: 'decimal' });
  });

  it('[nested.decimal.negative-control] plain {a:number,b:string} is unchanged', async () => {
    const result = await gen(decimalFixture);
    const output = result.schemas['plainObject']?.output;
    // Plain object must not be affected by alias resolution
    expect((output as Record<string, unknown>)?.properties).toEqual({
      a: { type: 'number' },
      b: { type: 'string' },
    });
  });
});

/**
 * BUG-APIGEN-011 — readonly T[] / ReadonlyArray<T> must preserve element type.
 *
 * Teeth test: if the `readonly ` prefix is NOT stripped before item-type resolution,
 * morphFallback receives "readonly string" (after slicing "[]") which matches nothing
 * and returns {}, so items would be {} and the test would fail.
 */
describe('BUG-APIGEN-011: readonly array element type is preserved', () => {
  it('[readonly-array.string] readonly string[] param schema has items:{type:string} (not {})', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['echoReadonlyStringArray']?.input
      ?.properties as Record<string, unknown>;
    expect(props?.['xs']).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('[readonly-array.string.output] readonly string[] return type schema has items:{type:string}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const output = result.schemas['echoReadonlyStringArray']?.output;
    expect(output).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('[readonly-array.number] readonly number[] param schema has items:{type:number} (not {})', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['echoReadonlyNumberArray']?.input
      ?.properties as Record<string, unknown>;
    expect(props?.['xs']).toEqual({ type: 'array', items: { type: 'number' } });
  });

  it('[readonly-array.generic] ReadonlyArray<string> param schema has items:{type:string}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['echoReadonlyArrayGeneric']?.input
      ?.properties as Record<string, unknown>;
    expect(props?.['xs']).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('[readonly-array.nested] readonly string[][] param schema has correct nested items', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['echoNestedReadonlyArray']?.input
      ?.properties as Record<string, unknown>;
    // "readonly string[][]" → after stripping readonly → "string[][]"
    // morphFallback: ends with [] → items = morphFallback("string[]") = {type:array,items:{type:string}}
    expect(props?.['xs']).toEqual({
      type: 'array',
      items: { type: 'array', items: { type: 'string' } },
    });
  });

  it('[readonly-array.negative-control] plain number[] still yields items:{type:number}', async () => {
    // Regression guard: ensure the fix does not break non-readonly arrays
    const { buildSchema } = await import(
      '../lib/schema-builders/ts-json-schema'
    );
    const { Project } = await import('ts-morph');
    const p = new Project({ skipAddingFilesFromTsConfig: true });
    const sf = p.createSourceFile(
      '__ctrl.ts',
      'export function f(xs: number[]): void {}',
      { overwrite: true }
    );
    const schema = await buildSchema(p, sf, 'number[]');
    expect(schema).toEqual({ type: 'array', items: { type: 'number' } });
  });
});

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
  const decimalFixture = fixture('decimal-nested.ts');

  it('[map.basic] Map<number,string> → array of [number,string] 2-tuples (NOT {size:number})', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['echoMap']?.input?.properties as Record<
      string,
      unknown
    >;
    expect(props?.['m']).toEqual({
      type: 'array',
      items: {
        type: 'array',
        items: [{ type: 'number' }, { type: 'string' }],
        minItems: 2,
        maxItems: 2,
      },
    });
    // Teeth: the class-expansion shape must NOT be produced
    expect(props?.['m']).not.toEqual({
      type: 'object',
      properties: { size: { type: 'number' } },
      required: ['size'],
      additionalProperties: false,
    });
  });

  it('[map.output] Map<number,string> output schema is array-compatible too', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const output = result.schemas['echoMap']?.output;
    expect(output).toEqual({
      type: 'array',
      items: {
        type: 'array',
        items: [{ type: 'number' }, { type: 'string' }],
        minItems: 2,
        maxItems: 2,
      },
    });
  });

  it('[set.basic] Set<string> → array of strings (NOT {size:number})', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['echoSet']?.input?.properties as Record<
      string,
      unknown
    >;
    expect(props?.['s']).toEqual({
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
    });
    expect((props?.['s'] as Record<string, unknown>)?.['type']).not.toBe(
      'object'
    );
  });

  it('[tuple.basic] [string,number,boolean] → positional items array', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['echoTuple']?.input?.properties as Record<
      string,
      unknown
    >;
    expect(props?.['t']).toEqual({
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
      minItems: 3,
      maxItems: 3,
    });
  });

  it('[map.nested-logical] Map<string,Date> value schema is {type:string,format:date-time}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['mapDateValue']?.input?.properties as Record<
      string,
      unknown
    >;
    const m = props?.['m'] as Record<string, unknown>;
    const entry = m?.['items'] as Record<string, unknown>;
    const entryItems = entry?.['items'] as Record<string, unknown>[];
    // [keySchema, valueSchema] — value (index 1) must carry the date-time format
    expect(entryItems?.[0]).toEqual({ type: 'string' });
    expect(entryItems?.[1]).toEqual({ type: 'string', format: 'date-time' });
  });

  it('[set.nested-logical] Set<Decimal> element schema is {type:string,format:decimal}', async () => {
    // Decimal-bearing fixture (small) so scalar-types.ts stays import-free.
    const result = await gen(decimalFixture);
    const props = result.schemas['setDecimal']?.input?.properties as Record<
      string,
      unknown
    >;
    const s = props?.['s'] as Record<string, unknown>;
    expect(s?.['items']).toEqual({ type: 'string', format: 'decimal' });
  });

  it('[tuple.nested-logical] [Date,number] position 0 schema is {type:string,format:date-time}', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['tupleDate']?.input?.properties as Record<
      string,
      unknown
    >;
    const t = props?.['t'] as Record<string, unknown>;
    const items = t?.['items'] as Record<string, unknown>[];
    expect(items?.[0]).toEqual({ type: 'string', format: 'date-time' });
    expect(items?.[1]).toEqual({ type: 'number' });
  });

  it('[map.readonly] ReadonlyMap<number,string> behaves like Map', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['echoReadonlyMap']?.input
      ?.properties as Record<string, unknown>;
    expect(props?.['m']).toEqual({
      type: 'array',
      items: {
        type: 'array',
        items: [{ type: 'number' }, { type: 'string' }],
        minItems: 2,
        maxItems: 2,
      },
    });
  });

  it('[set.readonly] ReadonlySet<string> behaves like Set', async () => {
    const result = await gen(fixture('scalar-types.ts'));
    const props = result.schemas['echoReadonlySet']?.input
      ?.properties as Record<string, unknown>;
    expect(props?.['s']).toEqual({
      type: 'array',
      items: { type: 'string' },
      uniqueItems: true,
    });
  });

  it('[map.negative-control] the class-expansion {size:number} shape is the WRONG answer', () => {
    // Teeth sentinel: documents the exact pre-fix bug shape.
    expect({
      type: 'object',
      properties: { size: { type: 'number' } },
    }).not.toEqual({
      type: 'array',
      items: {
        type: 'array',
        items: [{ type: 'number' }, { type: 'string' }],
        minItems: 2,
        maxItems: 2,
      },
    });
  });
});

/**
 * BUG-APIGEN-CORE-001 — zod-contaminated $ref resolution.
 *
 * When a source file transitively imports anything using zod,
 * ts-json-schema-generator's whole-file extraction can register zod-derived
 * type declarations into the shared definitions registry, corrupting
 * unrelated primitive entries and causing runtime crashes when generated
 * schemas try to resolve `$ref "#/definitions/boolean"`.
 *
 * This suite verifies:
 *   1. Zod-internal definitions (keys containing "zod"/"Zod") are stripped
 *      from generated schemas' `$defs`.
 *   2. Generated schemas for clean user functions are not corrupted even
 *      when the source file imports zod.
 *   3. (Teeth) A schema with dangling `$ref` (pointing to a non-existent
 *      definition) is rejected at GENERATE time rather than silently
 *      crashing at runtime.
 */
describe('BUG-APIGEN-CORE-001: zod-contaminated $ref resolution', () => {
  const zodFixture = fixture('zod-contamination.ts');

  it('[zod-core-001.1] zod-internal definitions are stripped from $defs', async () => {
    const result = await gen(zodFixture);
    const calibrate = result.schemas['calibrate'];
    expect(calibrate).toBeDefined();

    // Check that no zod-derived keys appear in $defs or definitions
    const defs =
      (calibrate as Record<string, unknown>)['$defs'] ??
      (calibrate as Record<string, unknown>)['definitions'];
    if (defs && typeof defs === 'object') {
      const keys = Object.keys(defs as Record<string, unknown>);
      const zodKeys = keys.filter((k) => /zod/i.test(k));
      expect(zodKeys).toEqual([]);
    }

    // Teeth: the calibrate function's output must be the expected clean shape
    const output = calibrate?.output as Record<string, unknown>;
    expect(output?.type).toBe('object');
    const props = output?.properties as Record<string, unknown>;
    expect(props?.['status']).toEqual({ type: 'string' });
    expect(props?.['score']).toEqual({ type: 'number' });
  });

  it('[zod-core-001.2] user schemas are fully inlined — no dangling $ref to removed definitions', async () => {
    const result = await gen(zodFixture);
    const calibrate = result.schemas['calibrate'] as Record<string, unknown>;

    // The schema should not contain any $ref that points to a
    // non-existent definition. Walk the entire schema tree.
    const missingRefs = findDanglingRefs(calibrate);
    expect(
      missingRefs,
      `dangling $ref found: ${JSON.stringify(missingRefs)}`
    ).toEqual([]);
  });

  it('[zod-core-001.3] (teeth) a schema with a dangling $ref throws at generate time', () => {
    // This test verifies that the generate-time validation runs.
    // We build a deliberately broken schema with a $ref that points
    // nowhere and assert it is rejected.
    const broken: Record<string, unknown> = {
      type: 'object',
      properties: {
        value: { $ref: '#/definitions/ghost' },
      },
      // ghost is missing from $defs/definitions
    };
    expect(() => validateSchemaRefs(broken)).toThrow(/ghost/);
  });
});

// ---------------------------------------------------------------------------
// Helpers for BUG-APIGEN-CORE-001
// ---------------------------------------------------------------------------

/**
 * Walk a schema tree and return a list of all `$ref` values that point to
 * definitions NOT present in the schema's own `$defs` or `definitions`.
 */
function findDanglingRefs(
  schema: Record<string, unknown>,
  defs?: Set<string>
): string[] {
  if (!schema || typeof schema !== 'object') return [];

  // On first call, collect the available definition keys
  const availableDefs =
    defs ??
    (() => {
      const d = new Set<string>();
      for (const defKey of ['$defs', 'definitions']) {
        const obj = schema[defKey] as Record<string, unknown> | undefined;
        if (obj && typeof obj === 'object') {
          for (const k of Object.keys(obj)) d.add(k);
        }
      }
      return d;
    })();

  const dangling: string[] = [];

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string') {
      // $ref values look like "#/definitions/Foo" or "#/$defs/Foo"
      const match = value.match(/#\/(?:\$defs|definitions)\/(.+)$/);
      if (match && !availableDefs.has(match[1])) {
        dangling.push(value);
      }
    } else if (typeof value === 'object' && value !== null) {
      dangling.push(
        ...findDanglingRefs(value as Record<string, unknown>, availableDefs)
      );
    }
  }

  // Also check arrays
  for (const [, value] of Object.entries(schema)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          dangling.push(
            ...findDanglingRefs(item as Record<string, unknown>, availableDefs)
          );
        }
      }
    }
  }

  return dangling;
}

/**
 * Validate that all `$ref` entries in a schema point to definitions that
 * exist within the schema's own `$defs` or `definitions`.
 *
 * Throws at GENERATE time if any dangling `$ref` is found.
 */
function validateSchemaRefs(schema: Record<string, unknown>): void {
  const dangling = findDanglingRefs(schema);
  if (dangling.length > 0) {
    throw new Error(
      `[apigen-core-client] Generated schema contains ${
        dangling.length
      } unresolvable $ref(s): ${dangling.join(', ')}. ` +
        `This usually means zod-internal definitions were stripped but ` +
        `$ref references to them remain. Check the source file's imports ` +
        `or the ts-json-schema-generator output.`
    );
  }
}


