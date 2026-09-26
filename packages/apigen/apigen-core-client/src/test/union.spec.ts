// union.spec.ts — schema-builders/union.ts unit tests.
//
// Guard: npx nx test apigen-core
// Criterion: [lt-extract-union.1] guard green.
//
// Coverage:
//   [union.1] A Dog|Cat fixture with discriminator "kind" produces:
//             oneOf:[{$ref:#/$defs/Dog},{$ref:#/$defs/Cat}],
//             discriminator.propertyName:"kind",
//             discriminator.mapping:{dog:"#/$defs/Dog",cat:"#/$defs/Cat"},
//             x-apigen-logical:"union".
//   [union.2] $ref strings follow the #/$defs/<ClassName> format (same as nominal.ts).
//   [union.3] mapping keys are the discriminantValues supplied to UnionVariant.
//   [union.4] x-apigen-logical is exactly "union".
//   [union.5] Three-variant union includes all three $refs and mapping entries.
//   [union.NEGATIVE] Fewer than 2 variants throws an Error (not a silent empty/single).
//   [union.NEGATIVE-2] Removing x-apigen-logical from the result leaves a structurally
//             valid oneOf+discriminator schema — proves [inv:hints-advisory] holds.
//
// Fixtures: the canonical Dog|Cat example from DESIGN.md §4.1.

import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildUnionSchema,
  type UnionInfo,
  type UnionVariant,
} from '../lib/schema-builders/union';
import { extract } from '../index';
import { X_APIGEN_LOGICAL } from '@adhd/apigen-base-logical';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/** The canonical Dog|Cat discriminated union from DESIGN §4.1. */
function dogCatInfo(): UnionInfo {
  return {
    discriminatorPropertyName: 'kind',
    variants: [
      { className: 'Dog', discriminantValue: 'dog' },
      { className: 'Cat', discriminantValue: 'cat' },
    ],
  };
}

// ---------------------------------------------------------------------------
// [union.1] Full output shape
// ---------------------------------------------------------------------------

describe('buildUnionSchema — full output shape (Dog|Cat)', () => {
  it('[union.1.1] result has a oneOf array with two entries', () => {
    const result = buildUnionSchema(dogCatInfo());
    expect(Array.isArray(result.oneOf)).toBe(true);
    expect(result.oneOf).toHaveLength(2);
  });

  it('[union.1.2] first oneOf entry is {$ref:"#/$defs/Dog"}', () => {
    const result = buildUnionSchema(dogCatInfo());
    expect(result.oneOf[0]).toEqual({ $ref: '#/$defs/Dog' });
  });

  it('[union.1.3] second oneOf entry is {$ref:"#/$defs/Cat"}', () => {
    const result = buildUnionSchema(dogCatInfo());
    expect(result.oneOf[1]).toEqual({ $ref: '#/$defs/Cat' });
  });

  it('[union.1.4] discriminator.propertyName is "kind"', () => {
    const result = buildUnionSchema(dogCatInfo());
    expect(result.discriminator.propertyName).toBe('kind');
  });

  it('[union.1.5] discriminator.mapping has key "dog" → "#/$defs/Dog"', () => {
    const result = buildUnionSchema(dogCatInfo());
    expect(result.discriminator.mapping['dog']).toBe('#/$defs/Dog');
  });

  it('[union.1.6] discriminator.mapping has key "cat" → "#/$defs/Cat"', () => {
    const result = buildUnionSchema(dogCatInfo());
    expect(result.discriminator.mapping['cat']).toBe('#/$defs/Cat');
  });

  it('[union.1.7] x-apigen-logical is "union"', () => {
    const result = buildUnionSchema(dogCatInfo());
    expect(result[X_APIGEN_LOGICAL]).toBe('union');
  });
});

// ---------------------------------------------------------------------------
// [union.2] $ref format matches nominal.ts's buildNominalSchema output
// ---------------------------------------------------------------------------

describe('buildUnionSchema — $ref format', () => {
  it('[union.2.1] $ref entries follow #/$defs/<ClassName>', () => {
    const result = buildUnionSchema(dogCatInfo());
    for (const entry of result.oneOf) {
      expect(entry.$ref).toMatch(/^#\/\$defs\/[A-Za-z]/);
    }
  });

  it('[union.2.2] mapping values follow #/$defs/<ClassName>', () => {
    const result = buildUnionSchema(dogCatInfo());
    for (const ref of Object.values(result.discriminator.mapping)) {
      expect(ref).toMatch(/^#\/\$defs\/[A-Za-z]/);
    }
  });
});

// ---------------------------------------------------------------------------
// [union.3] mapping keys are discriminantValues
// ---------------------------------------------------------------------------

describe('buildUnionSchema — mapping keys are discriminantValues', () => {
  it('[union.3.1] mapping keys exactly equal the supplied discriminantValues', () => {
    const result = buildUnionSchema(dogCatInfo());
    const keys = Object.keys(result.discriminator.mapping).sort();
    expect(keys).toEqual(['cat', 'dog']);
  });

  it('[union.3.2] custom discriminant value is reflected in mapping', () => {
    const info: UnionInfo = {
      discriminatorPropertyName: 'type',
      variants: [
        { className: 'Circle', discriminantValue: 'circle' },
        { className: 'Rectangle', discriminantValue: 'rectangle' },
      ],
    };
    const result = buildUnionSchema(info);
    expect(result.discriminator.mapping['circle']).toBe('#/$defs/Circle');
    expect(result.discriminator.mapping['rectangle']).toBe('#/$defs/Rectangle');
    expect(result.discriminator.propertyName).toBe('type');
  });
});

// ---------------------------------------------------------------------------
// [union.4] x-apigen-logical:"union" tag
// ---------------------------------------------------------------------------

describe('buildUnionSchema — x-apigen-logical tag', () => {
  it('[union.4.1] x-apigen-logical is the string literal "union"', () => {
    const result = buildUnionSchema(dogCatInfo());
    expect(result[X_APIGEN_LOGICAL]).toBe('union');
  });

  it('[union.4.2] x-apigen-logical key is present on result', () => {
    const result = buildUnionSchema(dogCatInfo());
    expect(Object.prototype.hasOwnProperty.call(result, X_APIGEN_LOGICAL)).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// [union.5] Three-variant union
// ---------------------------------------------------------------------------

describe('buildUnionSchema — three-variant union', () => {
  const threeVariants: UnionInfo = {
    discriminatorPropertyName: 'shape',
    variants: [
      { className: 'Circle', discriminantValue: 'circle' },
      { className: 'Rectangle', discriminantValue: 'rectangle' },
      { className: 'Triangle', discriminantValue: 'triangle' },
    ],
  };

  it('[union.5.1] oneOf has three entries', () => {
    const result = buildUnionSchema(threeVariants);
    expect(result.oneOf).toHaveLength(3);
  });

  it('[union.5.2] mapping has three entries', () => {
    const result = buildUnionSchema(threeVariants);
    expect(Object.keys(result.discriminator.mapping)).toHaveLength(3);
  });

  it('[union.5.3] all three $refs are correct', () => {
    const result = buildUnionSchema(threeVariants);
    expect(result.oneOf[0]).toEqual({ $ref: '#/$defs/Circle' });
    expect(result.oneOf[1]).toEqual({ $ref: '#/$defs/Rectangle' });
    expect(result.oneOf[2]).toEqual({ $ref: '#/$defs/Triangle' });
  });
});

// ---------------------------------------------------------------------------
// [union.NEGATIVE] fewer than 2 variants throws
// ---------------------------------------------------------------------------

describe('buildUnionSchema — guard: fewer than 2 variants', () => {
  it('[union.NEGATIVE.1] zero variants throws', () => {
    expect(() =>
      buildUnionSchema({ discriminatorPropertyName: 'kind', variants: [] })
    ).toThrow();
  });

  it('[union.NEGATIVE.2] one variant throws', () => {
    const oneVariant: UnionVariant[] = [
      { className: 'Dog', discriminantValue: 'dog' },
    ];
    expect(() =>
      buildUnionSchema({
        discriminatorPropertyName: 'kind',
        variants: oneVariant,
      })
    ).toThrow();
  });

  // Proves teeth: two variants must NOT throw (negative-of-negative).
  it('[union.NEGATIVE.3] exactly two variants does NOT throw', () => {
    expect(() => buildUnionSchema(dogCatInfo())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [union.NEGATIVE-2] [inv:hints-advisory] — schema is valid without x-apigen-* key
// ---------------------------------------------------------------------------

describe('buildUnionSchema — [inv:hints-advisory]: structural schema survives hint removal', () => {
  it('[union.NEGATIVE-2.1] removing x-apigen-logical leaves oneOf intact', () => {
    const result = buildUnionSchema(dogCatInfo());
    const stripped = { ...result } as Record<string, unknown>;
    delete stripped[X_APIGEN_LOGICAL];

    // The structural contract — oneOf + discriminator — must be present.
    expect(stripped['oneOf']).toBeDefined();
    expect(stripped['discriminator']).toBeDefined();
    // The advisory key is absent.
    expect(
      Object.prototype.hasOwnProperty.call(stripped, X_APIGEN_LOGICAL)
    ).toBe(false);
  });

  it('[union.NEGATIVE-2.2] stripped schema still has discriminator.propertyName', () => {
    const result = buildUnionSchema(dogCatInfo());
    const stripped = { ...result } as Record<string, unknown>;
    delete stripped[X_APIGEN_LOGICAL];
    const discriminator = stripped['discriminator'] as { propertyName: string };
    expect(discriminator.propertyName).toBe('kind');
  });
});

// ---------------------------------------------------------------------------
// [union.boolean] — boolean-in-union coverage (backlog 3a3e5884).
//
// LANE RULING (2026-09-25, dispatcher) — the real-ts-morph extraction cases in
// this describe deliberately run in the DEFAULT `test` lane, NOT the `.e2e.ts`
// lane. `vite.config.ts:64-72` / `project.json` split `*.e2e.ts` out of
// `nx affected -t test` and the pre-commit/pre-push hooks, but AGENTS.md §7
// makes default-running behavioral tests mandatory and the e2e lane currently
// has NO CI runner (backlog c05e598e). Moving these there would make them
// unrunnable — strictly worse than the extra seconds in the default lane. The
// durable remedy is fixing that lane runner (c05e598e / 53023ba0); that is a
// separate follow-up, not this branch's job. Do not re-litigate.
//
// This file previously had ZERO boolean coverage. A union containing `boolean`
// is the one shape `buildUnionSchema` never sees (it models NOMINAL,
// $ref-based unions) but which `morph-walk.ts`'s inline `walkType` union branch
// DOES emit — and where ts-morph's synthetic `true | false` expansion used to
// produce a duplicated `{type:'boolean'}` branch. The full shape matrix and
// AJV semantics live in `morph-walk-boolean-union.spec.ts`; these two assert
// the core contract on the real extractor output.
// ---------------------------------------------------------------------------

describe('boolean-in-union extraction — no duplicated oneOf branch (3a3e5884)', () => {
  const dir = path.resolve(__dirname, 'fixtures/union-boolean');
  const fixture = path.join(dir, 'boolean-unions.ts');
  const strictConfig = path.join(dir, 'strict.json');

  const booleanBranchCount = (fragment: Record<string, unknown>): number => {
    const oneOf = fragment['oneOf'];
    if (!Array.isArray(oneOf)) return 0;
    return oneOf.filter(
      (v) => (v as Record<string, unknown>)['type'] === 'boolean'
    ).length;
  };

  async function shapesOf(tsconfig?: string): Promise<Record<string, Record<string, unknown>>> {
    const ops = await extract({
      sourceFile: fixture,
      ...(tsconfig ? { tsconfig } : {}),
    });
    const op = ops.find((o) => o.path.at(-1)?.raw === 'booleanShapes');
    if (!op) {
      throw new Error('booleanShapes operation must exist in the union-boolean fixture');
    }
    const output = op.output as Record<string, unknown>;
    const props = output['properties'] as Record<string, Record<string, unknown>>;
    return props;
  }

  it('[union.boolean.1] strict tsconfig — textOrBool is exactly [string, boolean] (one boolean branch)', async () => {
    const shapes = await shapesOf(strictConfig);
    expect(shapes['textOrBool']['oneOf']).toEqual([
      { type: 'string' },
      { type: 'boolean' },
    ]);
    expect(booleanBranchCount(shapes['textOrBool'])).toBe(1);
    expect(shapes['textOrBool'][X_APIGEN_LOGICAL]).toBe('union');
  });

  it('[union.boolean.2] no tsconfig — mixed boolean|number union still collapses to one boolean branch', async () => {
    // Doubled pre-fix even with strictNullChecks off; guards against a
    // strict-only fix.
    const shapes = await shapesOf();
    expect(shapes['numOrBool']['oneOf']).toEqual([
      { type: 'number' },
      { type: 'boolean' },
    ]);
    expect(booleanBranchCount(shapes['numOrBool'])).toBe(1);
  });
});
