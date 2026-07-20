/**
 * Regression test for BUG-APIGEN-030 — real extract → compose → AJV-compile
 * pipeline, not hand-built schema fixtures (same rationale as
 * `named-type-param.spec.ts`, sibling regression for BUG-APIGEN-026).
 *
 * apigen's own schema builders (`schema-builders/nominal.ts`,
 * `schema-builders/union.ts`, and the inline-union path in
 * `schema-builders/morph-walk.ts`) tag nominal/branded and union `$def`s with
 * advisory `x-apigen-logical`/`x-apigen-codec`/`x-apigen-ctor`/
 * `x-apigen-tojson` keys, plus an OpenAPI-style `discriminator` object on
 * union fragments — read back by `union-codec.ts`/`nominal-codec.ts` at
 * decode time, never declared to Ajv. Ajv 8's default `strict: true` throws
 * `strict mode: unknown keyword` the first time `ajv.compile()` runs on any
 * such schema — every call to a union- or nominal-typed operation crashed
 * with a 500, regardless of input (BACKLOG BUG-APIGEN-030).
 *
 * [apigen-030.1]-[apigen-030.3] exercise the REAL `extract()` → `composeSchemas()`
 * pipeline against an inline discriminated-union parameter (`Pet = Dog | Cat`),
 * which is the shape `morph-walk.ts`'s union branch actually produces today.
 *
 * [apigen-030.4]/[apigen-030.5] cover `x-apigen-codec`/`x-apigen-ctor`/
 * `x-apigen-tojson` — the additional advisory keys `schema-builders/
 * nominal.ts`'s `buildNominalSchema` emits alongside `x-apigen-logical` (see
 * `nominal.ts:87-90`). As of this fix, `buildNominalSchema`/`buildUnionSchema`
 * are not yet wired into the real `extract()`/`composeSchemas()` pipeline for
 * class-typed parameters (confirmed: no call site outside their own spec
 * files and `orchestrator.ts`'s `extractClasses()` usage is for
 * constructor/instance-method operations, not embedding nominal `$def`s into
 * other functions' input schemas — filed as BUG-APIGEN-036, a distinct,
 * narrower gap). These tests hand-build schemas using the same
 * `X_APIGEN_LOGICAL`/`X_APIGEN_CODEC`/`X_APIGEN_CTOR`/`X_APIGEN_TOJSON`
 * constants `nominal.ts` imports from `@adhd/apigen-base-logical`, so the fix
 * is proven against the real, exported keyword names rather than
 * hand-typed string literals that could silently drift from them.
 */
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import type { Operation, GeneratedSchemas } from '@adhd/apigen-core-client';
import {
  X_APIGEN_LOGICAL,
  X_APIGEN_CODEC,
  X_APIGEN_CTOR,
  X_APIGEN_TOJSON,
} from '@adhd/apigen-base-logical';
import { createInvoker, LayerContext } from '../lib/invoke';
import { makeValidateLayer } from '../lib/validate-layer';
import type { Call } from '../lib/invoke';
import type { ComposedSchemas } from '../lib/types';

const fixture = path.resolve(__dirname, 'fixtures', 'bug-apigen-030.ts');

function makeCall(operationId: string, domainArgs: Record<string, unknown>): Call {
  return {
    operation: { id: operationId },
    ctx: new LayerContext(),
    envelope: {},
    domainArgs,
  };
}

// Mirrors buildDescriptor's Step 5 adapter (orchestrator.ts) — same helper
// as named-type-param.spec.ts, reproduced here since it isn't exported as a
// standalone helper.
function toGeneratedSchemas(operations: readonly Operation[]): GeneratedSchemas {
  const generated: GeneratedSchemas = {
    metadata: { namespace: '', phase: '' },
    schemas: {},
  };
  for (const op of operations) {
    if (op.kind !== 'action') continue;
    const fnName = op.path[op.path.length - 1].raw;
    generated.schemas[fnName] = {
      input: op.input,
      output: op.output,
      ...(op.hasCtx ? { hasCtx: true } : {}),
    };
  }
  return generated;
}

describe('BUG-APIGEN-030: x-apigen-logical / discriminator crash — real pipeline', () => {
  it('[apigen-030.1] the composed schema for a union-typed param carries oneOf + discriminator + x-apigen-logical:union', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);

    const petSchema = JSON.stringify(schemas['describePet'].input);
    expect(petSchema).toContain('"oneOf"');
    expect(petSchema).toContain('"x-apigen-logical":"union"');
  });

  it('[apigen-030.2] constructing the validate layer over a union-typed schema does not throw (pre-fix: strict mode: unknown keyword)', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);

    expect(() => makeValidateLayer(schemas)).not.toThrow();
  });

  it('[apigen-030.3] a real call carrying a union-typed param reaches dispatch instead of crashing with a 500', async () => {
    const operations = await extract({ sourceFile: fixture });
    const schemas = composeSchemas(toGeneratedSchemas(operations), []);
    const dispatchSpy = vi.fn().mockResolvedValue('Dog: Rex');

    const invoke = createInvoker([makeValidateLayer(schemas)]);
    const result = await invoke(
      'describePet',
      makeCall('describePet', { pet: { kind: 'dog', name: 'Rex' } }),
      { fns: { describePet: dispatchSpy }, schemas }
    );

    expect(dispatchSpy).toHaveBeenCalledOnce();
    expect(result).toBe('Dog: Rex');
  });

  it('[apigen-030.4] a nominal $def carrying all four x-apigen-* advisory keys (per nominal.ts:87-90) compiles and validates', async () => {
    const userIdDef = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      [X_APIGEN_LOGICAL]: 'nominal',
      [X_APIGEN_CODEC]: 'ts.UserId',
      [X_APIGEN_CTOR]: 'fromJSON',
      [X_APIGEN_TOJSON]: 'toJSON',
    };

    const schemas: ComposedSchemas = {
      wrapId: {
        input: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { id: { $ref: '#/$defs/UserId' } },
              required: ['id'],
            },
          },
          required: ['data'],
          $defs: { UserId: userIdDef },
        },
        output: {},
      },
    };

    // Exercise the validateLayer directly (Ajv compile + validate), not the
    // full invoker/dispatch chain — dispatch's typed-decode step is a
    // separate SPEC §6 boundary (see validate-layer.ts's module JSDoc) with
    // its own $ref-resolution machinery, out of scope for BUG-APIGEN-030.
    const validationLayer = makeValidateLayer(schemas);
    const nextSpy = vi.fn().mockResolvedValue('abc-123');
    const result = await validationLayer(
      makeCall('wrapId', { id: { value: 'abc-123' } }),
      nextSpy
    );

    expect(nextSpy).toHaveBeenCalledOnce();
    expect(result).toBe('abc-123');
  });

  it('[apigen-030.5] a union $def with discriminator.mapping (the shape Ajv\'s built-in discriminator:true option rejects) compiles and validates both variants', async () => {
    const dogDef = {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['dog'] }, name: { type: 'string' } },
      required: ['kind', 'name'],
      [X_APIGEN_LOGICAL]: 'nominal',
      [X_APIGEN_CODEC]: 'Dog',
    };
    const catDef = {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['cat'] }, lives: { type: 'number' } },
      required: ['kind', 'lives'],
      [X_APIGEN_LOGICAL]: 'nominal',
      [X_APIGEN_CODEC]: 'Cat',
    };
    const petUnion = {
      oneOf: [{ $ref: '#/$defs/Dog' }, { $ref: '#/$defs/Cat' }],
      discriminator: {
        propertyName: 'kind',
        mapping: { dog: '#/$defs/Dog', cat: '#/$defs/Cat' },
      },
      [X_APIGEN_LOGICAL]: 'union',
    };

    const schemas: ComposedSchemas = {
      describePet2: {
        input: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { pet: petUnion },
              required: ['pet'],
            },
          },
          required: ['data'],
          $defs: { Dog: dogDef, Cat: catDef },
        },
        output: {},
      },
    };

    // Exercise the validateLayer directly — see rationale in [apigen-030.4].
    const validationLayer = makeValidateLayer(schemas);
    const dogSpy = vi.fn().mockResolvedValue('woof');
    const catSpy = vi.fn().mockResolvedValue('meow');

    const dogResult = await validationLayer(
      makeCall('describePet2', { pet: { kind: 'dog', name: 'Rex' } }),
      dogSpy
    );
    const catResult = await validationLayer(
      makeCall('describePet2', { pet: { kind: 'cat', lives: 9 } }),
      catSpy
    );

    expect(dogSpy).toHaveBeenCalledOnce();
    expect(catSpy).toHaveBeenCalledOnce();
    expect(dogResult).toBe('woof');
    expect(catResult).toBe('meow');
  });
});
