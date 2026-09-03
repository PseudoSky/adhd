// union-catchall.spec.ts — BUG-APIGEN-059 regression.
//
// Root cause: morph-walk.ts's union branch (`walkType`) built each union
// member's schema, then unconditionally emitted `{oneOf: variants, ...}`.
// When one variant is a "vacuous catch-all" (a `Record<string, unknown>` /
// index-signature-only object, or a bare `{}`), that branch matches
// virtually any object — INCLUDING one that also matches a more specific
// sibling branch. AJV's `oneOf` requires EXACTLY ONE match, so a
// legitimately `Dog`-shaped value was REJECTED because it also satisfied
// the catch-all's `additionalProperties` schema.
//
// Fix: morph-walk.ts's `sanitizeCatchAllVariants` rewrites each catch-all
// variant to `{allOf: [<catch-all>, {not: {anyOf: <every other variant>}}]}`
// so it no longer ambiguously matches a sibling's values.
//
// This suite drives the REAL extractor (`extract()` from `../index`)
// against `fixtures/union-catchall.ts` — a `Dog | Cat |
// Record<string, unknown>` union used INLINE as both a function's
// parameter and return type, which always routes through morph-walk.ts's
// union branch (Path 2), never ts-json-schema-generator's Path 1 (see the
// fixture's own header comment). No hand-crafted mock schema is used for
// the positive assertions — only real AJV compiling the real extracted
// schema.
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { extract } from '../index';
import type { GeneratedSchemas } from '../lib/types';
import {
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_TOJSON,
} from '@adhd/apigen-base-logical';

const fixture = (name: string) => path.resolve(__dirname, 'fixtures', name);

function makeAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  // Mirrors apigen-engine-runtime/src/lib/validate-layer.ts's Ajv setup for
  // apigen's own logical-type formats not shipped by ajv-formats.
  ajv.addFormat('decimal', /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/);
  // Mirrors validate-layer.ts's advisory-keyword registration — apigen's
  // schema builders tag same-document union branches with an OpenAPI-style
  // `discriminator` object, plus `x-apigen-*` advisory hints on nominal/union
  // fragments (X_APIGEN_LOGICAL et al. — see morph-walk.ts's union branch,
  // which stamps `[X_APIGEN_LOGICAL]: 'union'` on every union fragment this
  // suite compiles); Ajv 8's strict mode otherwise rejects each as an unknown
  // keyword at compile time.
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

describe('[BUG-APIGEN-059] union-catchall: oneOf stays unambiguous with a Record<string,unknown> branch', () => {
  it('[union-catchall.shape] the real extracted output is a 3-branch oneOf with exactly one sanitized (allOf/not) catch-all branch', async () => {
    // Guards against the positive assertions below passing VACUOUSLY (e.g.
    // the fixture collapsing to a permissive schema, or never actually
    // reaching morph-walk.ts's union branch at all) — asserts the shape the
    // fix is actually relied upon to have produced.
    const result = await gen(fixture('union-catchall.ts'));
    const output = result.schemas['classifyPet']?.output as
      | { oneOf?: unknown[]; ['x-apigen-logical']?: string }
      | undefined;
    if (!output) {
      throw new Error(
        `operation "classifyPet" must exist in the real extracted union-catchall fixture; ` +
          `got schemas: ${JSON.stringify(Object.keys(result.schemas))}`
      );
    }

    expect(
      Array.isArray(output.oneOf),
      `expected a oneOf union; got: ${JSON.stringify(output)}`
    ).toBe(true);
    const oneOf = output.oneOf as Record<string, unknown>[];
    expect(oneOf, `expected 3 branches (Dog, Cat, catch-all); got: ${JSON.stringify(oneOf)}`).toHaveLength(3);

    const sanitizedBranches = oneOf.filter(
      (v) => Array.isArray(v['allOf']) && (v['allOf'] as unknown[]).length === 2
    );
    expect(
      sanitizedBranches,
      `expected exactly 1 sanitized (allOf/not) catch-all branch; got branches: ${JSON.stringify(oneOf)}`
    ).toHaveLength(1);
    const sanitized = sanitizedBranches[0]['allOf'] as Record<string, unknown>[];
    expect(sanitized[1]).toHaveProperty('not');
    expect((sanitized[1] as { not: { anyOf: unknown[] } }).not.anyOf).toHaveLength(2);

    expect(output['x-apigen-logical']).toBe('union');
  });

  it('[union-catchall.compile] both input and output schemas compile with real AJV', async () => {
    const result = await gen(fixture('union-catchall.ts'));
    const op = result.schemas['classifyPet'];
    expect(op).toBeDefined();

    const ajv = makeAjv();
    expect(() => ajv.compile(op.input as Record<string, unknown>)).not.toThrow();
    expect(() => ajv.compile(op.output as Record<string, unknown>)).not.toThrow();
  });

  it('[union-catchall.dog] a Dog-shaped value validates unambiguously against both input and output', async () => {
    const result = await gen(fixture('union-catchall.ts'));
    const op = result.schemas['classifyPet'];

    const dog = { kind: 'dog', bark: 'woof' };

    const ajvIn = makeAjv();
    const validateIn = ajvIn.compile(op.input as Record<string, unknown>);
    const wrappedInput = { input: dog };
    expect(
      validateIn(wrappedInput),
      `Dog-shaped input must validate; ajv errors: ${JSON.stringify(validateIn.errors)}`
    ).toBe(true);

    const ajvOut = makeAjv();
    const validateOut = ajvOut.compile(op.output as Record<string, unknown>);
    expect(
      validateOut(dog),
      `Dog-shaped output must validate; ajv errors: ${JSON.stringify(validateOut.errors)}`
    ).toBe(true);
  });

  it('[union-catchall.cat] a Cat-shaped value validates unambiguously against both input and output', async () => {
    const result = await gen(fixture('union-catchall.ts'));
    const op = result.schemas['classifyPet'];

    const cat = { kind: 'cat', meow: 'meow' };

    const ajvIn = makeAjv();
    const validateIn = ajvIn.compile(op.input as Record<string, unknown>);
    const wrappedInput = { input: cat };
    expect(
      validateIn(wrappedInput),
      `Cat-shaped input must validate; ajv errors: ${JSON.stringify(validateIn.errors)}`
    ).toBe(true);

    const ajvOut = makeAjv();
    const validateOut = ajvOut.compile(op.output as Record<string, unknown>);
    expect(
      validateOut(cat),
      `Cat-shaped output must validate; ajv errors: ${JSON.stringify(validateOut.errors)}`
    ).toBe(true);
  });

  it('[union-catchall.unrelated] a value matching neither Dog nor Cat still validates via the sanitized catch-all', async () => {
    const result = await gen(fixture('union-catchall.ts'));
    const op = result.schemas['classifyPet'];

    const unrelated = { unrelated: true };

    const ajvIn = makeAjv();
    const validateIn = ajvIn.compile(op.input as Record<string, unknown>);
    const wrappedInput = { input: unrelated };
    expect(
      validateIn(wrappedInput),
      `unrelated-shaped input must still validate via the catch-all; ajv errors: ${JSON.stringify(
        validateIn.errors
      )}`
    ).toBe(true);

    const ajvOut = makeAjv();
    const validateOut = ajvOut.compile(op.output as Record<string, unknown>);
    expect(
      validateOut(unrelated),
      `unrelated-shaped output must still validate via the catch-all; ajv errors: ${JSON.stringify(
        validateOut.errors
      )}`
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROL: manually construct the PRE-FIX shape (the catch-all
  // branch NOT wrapped in allOf/not) and prove it rejects a Dog-shaped value
  // — demonstrating the bug this fix addresses is real, and that the new
  // positive assertions above have teeth against a revert.
  // -------------------------------------------------------------------------
  it('[union-catchall.NEGATIVE] the pre-fix unsanitized oneOf shape rejects a Dog-shaped value (proves teeth)', () => {
    const dogSchema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['dog'] },
        bark: { type: 'string' },
      },
      required: ['kind', 'bark'],
      additionalProperties: false,
    };
    const catSchema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['cat'] },
        meow: { type: 'string' },
      },
      required: ['kind', 'meow'],
      additionalProperties: false,
    };
    // The exact pre-fix shape: the catch-all branch emitted verbatim, with
    // NO allOf/not narrowing against its siblings.
    const preFixSchema = {
      oneOf: [dogSchema, catSchema, { type: 'object', additionalProperties: {} }],
    };

    const ajv = makeAjv();
    const validate = ajv.compile(preFixSchema);
    const dog = { kind: 'dog', bark: 'woof' };

    // Dog matches BOTH the `dogSchema` branch AND the unsanitized catch-all
    // branch (`additionalProperties: {}` accepts any object) — oneOf's
    // exactly-one-match requirement rejects it.
    expect(
      validate(dog),
      'the pre-fix (unsanitized) oneOf shape was expected to REJECT a Dog-shaped value ' +
        '(it matches both the Dog branch and the unguarded catch-all branch); if this now ' +
        'passes, the bug class this test guards may have changed shape'
    ).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === 'oneOf')).toBe(true);
  });
});
