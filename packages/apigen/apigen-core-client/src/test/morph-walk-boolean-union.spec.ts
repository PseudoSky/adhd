// morph-walk-boolean-union.spec.ts — regression for the duplicated-`oneOf`-
// boolean defect (backlog 3a3e5884).
//
// Root cause: morph-walk.ts's union branch (`walkType`) walked EVERY ts-morph
// union member independently. ts-morph expands a `boolean` union member into
// its synthetic `true | false` literals — `boolean | undefined` is
// `[undefined, false, true]` under strictNullChecks, and `string | boolean` is
// `[string, false, true]` regardless of strictNullChecks — and both boolean
// literals map to `{type:'boolean'}`. The result was a `oneOf` with two
// identical `{type:'boolean'}` branches, which no value can satisfy under
// AJV's exactly-one-match rule (`must match exactly one schema in oneOf`);
// surfaced to MCP callers as -32602.
//
// Fix: (1) `walkType` collapses every `isBooleanLiteral()` member to a single
// branch before building variants, and (2) variants are structurally deduped
// (JSON.stringify equality) as a general guard. This suite drives the REAL
// extractor (`extract()`) against `fixtures/union-boolean/boolean-unions.ts`
// with a REAL strict tsconfig (`fixtures/union-boolean/strict.json`), asserts
// the emitted `oneOf` fragments are duplicate-free, and validates the real
// emitted schema with REAL AJV.
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { extract } from '../index';
import {
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_TOJSON,
} from '@adhd/apigen-base-logical';

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/union-boolean');
const FIXTURE = path.join(FIXTURE_DIR, 'boolean-unions.ts');
const STRICT_TSCONFIG = path.join(FIXTURE_DIR, 'strict.json');

type Schema = Record<string, unknown>;

interface Op {
  input: Schema;
  output: Schema;
}

const _cache = new Map<string, Promise<Map<string, Op>>>();
function extractFixture(tsconfig?: string): Promise<Map<string, Op>> {
  const cacheKey = tsconfig ?? '<none>';
  let p = _cache.get(cacheKey);
  if (!p) {
    p = extract({
      sourceFile: FIXTURE,
      namespace: 'union-boolean',
      ...(tsconfig ? { tsconfig } : {}),
    }).then((ops) => {
      const byName = new Map<string, Op>();
      for (const op of ops) {
        if (op.kind !== 'action') continue;
        const name = op.path.at(-1)?.raw;
        if (!name) continue;
        byName.set(name, {
          input: op.input as Schema,
          output: op.output as Schema,
        });
      }
      return byName;
    });
    _cache.set(cacheKey, p);
  }
  return p;
}

function makeAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  ajv.addFormat('decimal', /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/);
  // Mirrors apigen-engine-runtime/src/lib/validate-layer.ts's Ajv setup —
  // morph-walk.ts stamps every union fragment with `[X_APIGEN_LOGICAL]:
  // 'union'`, which Ajv 8 strict mode otherwise rejects as an unknown keyword.
  for (const keyword of [
    X_APIGEN_LOGICAL,
    X_APIGEN_CODEC,
    X_APIGEN_CTOR,
    X_APIGEN_TOJSON,
    'discriminator',
  ]) {
    ajv.addKeyword({ keyword, valid: true });
  }
  return ajv;
}

function propsOf(schema: Schema): Record<string, Schema> {
  const props = schema['properties'];
  if (!props || typeof props !== 'object') return {};
  return props as Record<string, Schema>;
}

/** Fetch an operation or fail loudly — keeps the suite free of `!` assertions. */
function mustOp(ops: Map<string, Op>, name: string): Op {
  const op = ops.get(name);
  if (!op) {
    throw new Error(
      `operation "${name}" must exist in the union-boolean fixture; got: ${[...ops.keys()].join(', ')}`
    );
  }
  return op;
}

/** The inner `BooleanShapes` object schema of `booleanShapes`'s input envelope. */
function shapesOf(op: Op): Record<string, Schema> {
  const wrapped = propsOf(op.input)['input'];
  expect(
    wrapped,
    `booleanShapes input must wrap the param under "input"; got: ${JSON.stringify(op.input)}`
  ).toBeDefined();
  return propsOf(wrapped);
}

/** Every `oneOf` array anywhere in a schema tree. */
function collectOneOfs(node: unknown, acc: unknown[][] = []): unknown[][] {
  if (Array.isArray(node)) {
    for (const item of node) collectOneOfs(item, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const oneOf = obj['oneOf'];
    if (Array.isArray(oneOf)) acc.push(oneOf);
    for (const key of Object.keys(obj)) collectOneOfs(obj[key], acc);
    return acc;
  }
  return acc;
}

/** Structural duplicates within a single `oneOf` array (JSON.stringify equality). */
function duplicateVariants(oneOf: unknown[]): string[] {
  const seen = new Map<string, number>();
  const dups: string[] = [];
  for (const v of oneOf) {
    const key = JSON.stringify(v);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) dups.push(key);
  }
  return dups;
}

function oneOfTypes(fragment: Schema): string[] {
  const oneOf = fragment['oneOf'];
  if (!Array.isArray(oneOf)) return [];
  return oneOf.map((v) => String((v as Schema)['type']));
}

const BOOLEAN_SHAPES = [
  'managed',
  'maybe',
  'nullable',
  'textOrBool',
  'numOrBool',
  'litOrBool',
] as const;

// ---------------------------------------------------------------------------

describe('[BUG 3a3e5884] walkType union branch — no duplicated oneOf branch for a union containing boolean', () => {
  it('[boolean.invariant] no oneOf anywhere in the strict-tsconfig output/input has structurally duplicate variants', async () => {
    const ops = await extractFixture(STRICT_TSCONFIG);
    const op = mustOp(ops, 'booleanShapes');

    for (const [label, schema] of [
      ['booleanShapes.output', op.output],
      ['booleanShapes.input', op.input],
    ] as const) {
      const oneOfs = collectOneOfs(schema);
      expect(
        oneOfs.length,
        `${label} should contain at least one oneOf union; got: ${JSON.stringify(schema)}`
      ).toBeGreaterThan(0);
      for (const oneOf of oneOfs) {
        expect(
          duplicateVariants(oneOf),
          `${label} has a oneOf with duplicate variants: ${JSON.stringify(oneOf)}`
        ).toEqual([]);
      }
    }
  });

  it('[boolean.shape-matrix] each boolean-containing union collapses to exactly one {type:"boolean"} branch (strict tsconfig)', async () => {
    const ops = await extractFixture(STRICT_TSCONFIG);
    const shapes = shapesOf(mustOp(ops, 'booleanShapes'));

    const expected: Record<string, string[]> = {
      managed: ['null', 'boolean'],
      maybe: ['null', 'boolean'],
      nullable: ['null', 'boolean'],
      textOrBool: ['string', 'boolean'],
      numOrBool: ['number', 'boolean'],
      litOrBool: ['boolean', 'string', 'string'],
    };

    for (const key of BOOLEAN_SHAPES) {
      const fragment = shapes[key];
      expect(fragment, `property "${key}" must be present`).toBeDefined();
      const types = oneOfTypes(fragment);
      expect(types, `property "${key}" oneOf types`).toEqual(expected[key]);
      expect(
        types.filter((t) => t === 'boolean').length,
        `property "${key}" must carry exactly ONE boolean branch; got ${JSON.stringify(fragment)}`
      ).toBe(1);
      expect(fragment[X_APIGEN_LOGICAL]).toBe('union');
    }
  });

  it('[boolean.plain] a plain boolean property stays a bare {type:"boolean"} (not a oneOf)', async () => {
    const ops = await extractFixture(STRICT_TSCONFIG);
    const shapes = shapesOf(mustOp(ops, 'booleanShapes'));
    expect(shapes['plain']).toEqual({ type: 'boolean' });
  });

  it('[boolean.param] direct union parameters (input schema) also collapse (strict tsconfig)', async () => {
    const ops = await extractFixture(STRICT_TSCONFIG);
    const params = propsOf(mustOp(ops, 'directBooleanParams').input);

    expect(params['on']).toEqual({ type: 'boolean' });
    expect(oneOfTypes(params['maybeOn'])).toEqual(['null', 'boolean']);
    expect(oneOfTypes(params['label'])).toEqual(['string', 'boolean']);

    // And the inline object return's property.
    const outProps = propsOf(mustOp(ops, 'directBooleanParams').output);
    expect(outProps['ok']).toEqual({ type: 'boolean' });
    expect(oneOfTypes(outProps['detail'])).toEqual(['string', 'boolean']);
  });

  it('[boolean.ajv] the real emitted schema compiles under AJV and accepts managed:true AND managed:false', async () => {
    const ops = await extractFixture(STRICT_TSCONFIG);
    const op = mustOp(ops, 'booleanShapes');

    const ajv = makeAjv();
    const validateOutput = ajv.compile(op.output);
    const validateInput = ajv.compile(op.input);

    const base = {
      plain: true,
      maybe: false,
      nullable: null,
      textOrBool: 'hello',
      numOrBool: 3,
      litOrBool: 'x',
    };

    for (const managed of [true, false]) {
      const value = { ...base, managed };
      expect(
        validateOutput(value),
        `output must accept managed:${managed}; ajv errors: ${JSON.stringify(validateOutput.errors)}`
      ).toBe(true);
      expect(
        validateInput({ input: value }),
        `input must accept managed:${managed}; ajv errors: ${JSON.stringify(validateInput.errors)}`
      ).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROL — the SAME fixture extracted WITHOUT a tsconfig must be
  // equally duplicate-free. This proves the fix is NOT strict-only: mixed
  // unions (`string | boolean`, `boolean | number`, `'x' | 'y' | boolean`)
  // emit the duplicate EVEN with strictNullChecks off, so a fix that only
  // handled the strict optional-boolean case would still be red here.
  // -------------------------------------------------------------------------
  it('[boolean.non-strict] the same fixture WITHOUT a tsconfig is also duplicate-free (mixed unions fixed too)', async () => {
    const ops = await extractFixture();
    const op = mustOp(ops, 'booleanShapes');

    for (const schema of [op.output, op.input]) {
      for (const oneOf of collectOneOfs(schema)) {
        expect(
          duplicateVariants(oneOf),
          `no-tsconfig extraction has a oneOf with duplicate variants: ${JSON.stringify(oneOf)}`
        ).toEqual([]);
      }
    }

    const shapes = shapesOf(op);
    // mixed unions — these duplicated pre-fix even without a strict tsconfig.
    expect(oneOfTypes(shapes['textOrBool'])).toEqual(['string', 'boolean']);
    expect(oneOfTypes(shapes['numOrBool'])).toEqual(['number', 'boolean']);
    expect(oneOfTypes(shapes['litOrBool'])).toEqual(['boolean', 'string', 'string']);
    // boolean-only unions collapse to a bare boolean without strictNullChecks.
    expect(shapes['managed']).toEqual({ type: 'boolean' });
    expect(shapes['plain']).toEqual({ type: 'boolean' });
  });

  // -------------------------------------------------------------------------
  // Fix 2 (backlog 2f5e64dc) — a LONE boolean literal is not a duplicate, so
  // the collapse above never touches it; without `const` its arm would silently
  // accept the OPPOSITE boolean (e.g. the `true` arm of `true | 'x'` accepting
  // `false`). String/number literal arms already keep a single-value `enum`.
  // -------------------------------------------------------------------------
  it('[boolean.lone-literal] a lone boolean-literal arm carries `const`, rejecting the opposite boolean', async () => {
    const ops = await extractFixture(STRICT_TSCONFIG);
    const op = mustOp(ops, 'loneBooleanLiterals');
    const outProps = propsOf(op.output);

    expect(outProps['trueOrString']['oneOf']).toEqual([
      { type: 'boolean', const: true },
      { type: 'string', enum: ['x'] },
    ]);
    expect(outProps['falseOrNumber']['oneOf']).toEqual([
      { type: 'boolean', const: false },
      { type: 'number', enum: [1] },
    ]);

    const ajv = makeAjv();
    const validate = ajv.compile(op.output);
    expect(
      validate({ trueOrString: true, falseOrNumber: false }),
      `the matching literals must validate; ajv errors: ${JSON.stringify(validate.errors)}`
    ).toBe(true);
    expect(validate({ trueOrString: 'x', falseOrNumber: 1 })).toBe(true);
    // The opposite boolean must be REJECTED by the lone-literal arm.
    expect(
      validate({ trueOrString: false, falseOrNumber: false }),
      `true | 'x' must reject false; ajv errors: ${JSON.stringify(validate.errors)}`
    ).toBe(false);
    expect(
      validate({ trueOrString: true, falseOrNumber: true }),
      `false | 1 must reject true; ajv errors: ${JSON.stringify(validate.errors)}`
    ).toBe(false);

    // Same contract on the input envelope.
    const validateInput = makeAjv().compile(op.input);
    expect(
      validateInput({ input: { trueOrString: true, falseOrNumber: false } })
    ).toBe(true);
    expect(
      validateInput({ input: { trueOrString: false, falseOrNumber: false } })
    ).toBe(false);
  });

  it('[boolean.NEGATIVE] the pre-fix duplicated-oneOf shape is rejected by AJV (proves the failure mode)', () => {
    // The exact pre-fix fragment for `managed?: boolean` under strictNullChecks.
    const preFix = { oneOf: [{ type: 'null' }, { type: 'boolean' }, { type: 'boolean' }] };
    const ajv = makeAjv();
    const validate = ajv.compile(preFix);
    expect(
      validate(false),
      'the pre-fix [{null},{boolean},{boolean}] oneOf was expected to REJECT false ' +
        '(it matches the boolean branch twice); if this now passes, the bug class changed shape'
    ).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === 'oneOf')).toBe(true);
  });
});
