// morph-walk-dedupe.spec.ts — regression for the canonical-dedupe gap
// (review finding MEDIUM; branch fix/apigen-union-oneof-boolean-and-catchall).
//
// LANE RULING (2026-09-25, dispatcher) — this real-ts-morph extraction suite
// deliberately runs in the DEFAULT `test` lane, NOT the `.e2e.ts` lane.
// `vite.config.ts:64-72` / `project.json` split `*.e2e.ts` out of
// `nx affected -t test` and the pre-commit/pre-push hooks, but AGENTS.md §7
// makes default-running behavioral tests mandatory and the e2e lane currently
// has NO CI runner (backlog c05e598e). Moving this suite there would make it
// unrunnable — strictly worse than the extra seconds in the default lane. The
// durable remedy is fixing that lane runner (c05e598e / 53023ba0); that is a
// separate follow-up, not this branch's job. Do not re-litigate.
//
// Root cause: `dedupeVariants` compared union variants with raw
// `JSON.stringify`, which is key-INSERTION-ORDER sensitive. Two same-shape
// interfaces declared with their properties in a different order produce object
// branches that are semantically identical but stringify differently — the
// object branch emits BOTH `properties` AND `required` in declaration order, so
// both reorder. Dedupe kept both branches, and a `oneOf` with two (semantically)
// identical branches is unsatisfiable: AJV rejects every value that matches
// both ("must match exactly one schema in oneOf"; MCP -32602) — the same failure
// class this branch exists to remove.
//
// Fix: `dedupeVariants` now compares via `canonicalJson`, a recursive form that
// sorts object keys and the unordered-set keywords (`required`/`enum`/array
// `type`).
//
// This suite drives the REAL extractor against
// `fixtures/union-reordered-keys.ts` and validates the real emitted schema with
// REAL AJV. The duplicate detector below is an INDEPENDENT re-implementation of
// the canonical comparison, so a regression to raw `JSON.stringify` in
// production cannot pass by mirroring the bug in the test.
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

type Schema = Record<string, unknown>;

interface Op {
  input: Schema;
  output: Schema;
}

const FIXTURE = path.resolve(__dirname, 'fixtures/union-reordered-keys.ts');

const _cache = new Map<string, Promise<Map<string, Op>>>();
function extractFixture(): Promise<Map<string, Op>> {
  let p = _cache.get('x');
  if (!p) {
    p = extract({ sourceFile: FIXTURE, namespace: 'union-reordered' }).then(
      (ops) => {
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
      }
    );
    _cache.set('x', p);
  }
  return p;
}

function makeAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  ajv.addFormat('decimal', /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/);
  // Mirrors apigen-engine-runtime/src/lib/validate-layer.ts's Ajv setup.
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

/** Independent canonical form: sorted object keys + unordered-set keywords. */
const SET_KEYWORDS = new Set(['required', 'enum', 'type']);
function canon(value: unknown, key?: string): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map((entry) => canon(entry));
    if (key !== undefined && SET_KEYWORDS.has(key)) items.sort();
    return `[${items.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canon(obj[k], k)}`)
    .join(',')}}`;
}

/** Canonically-duplicate variants within a single `oneOf` array. */
function canonicalDuplicates(oneOf: unknown[]): string[] {
  const seen = new Map<string, number>();
  const dups: string[] = [];
  for (const v of oneOf) {
    const k = canon(v);
    const count = (seen.get(k) ?? 0) + 1;
    seen.set(k, count);
    if (count === 2) dups.push(k);
  }
  return dups;
}

function mustOp(ops: Map<string, Op>, name: string): Op {
  const op = ops.get(name);
  if (!op) {
    throw new Error(
      `operation "${name}" must exist in the union-reordered fixture; got: ${[...ops.keys()].join(', ')}`
    );
  }
  return op;
}

function oneOfOf(schema: Schema): Schema[] {
  const oneOf = schema['oneOf'];
  expect(
    Array.isArray(oneOf),
    `expected a oneOf union; got: ${JSON.stringify(schema)}`
  ).toBe(true);
  return oneOf as Schema[];
}

function innerUnion(op: Op): Schema {
  const props = op.input['properties'] as Record<string, Schema> | undefined;
  const wrapped = props?.['input'];
  expect(
    wrapped,
    `input must wrap the union under "input"; got: ${JSON.stringify(op.input)}`
  ).toBeDefined();
  return wrapped as Schema;
}

describe('[dedupe reordered-keys] same-shape variants with reordered properties collapse to ONE branch', () => {
  it('[dedupe.shape] output oneOf has exactly ONE branch and NO canonical duplicates', async () => {
    const op = mustOp(await extractFixture(), 'reorderedKeys');
    const oneOf = oneOfOf(op.output);

    expect(
      oneOf,
      `AlphaFirst | BetaFirst are structurally identical, so the oneOf must collapse ` +
        `to a single branch; got: ${JSON.stringify(oneOf)}`
    ).toHaveLength(1);
    expect(canonicalDuplicates(oneOf)).toEqual([]);
    expect(op.output[X_APIGEN_LOGICAL]).toBe('union');
  });

  it('[dedupe.input] the input envelope union is deduped identically', async () => {
    const op = mustOp(await extractFixture(), 'reorderedKeys');
    const oneOf = oneOfOf(innerUnion(op));
    expect(oneOf).toHaveLength(1);
    expect(canonicalDuplicates(oneOf)).toEqual([]);
  });

  it('[dedupe.ajv] the real emitted schema compiles and accepts a matching value / rejects non-matching ones', async () => {
    const op = mustOp(await extractFixture(), 'reorderedKeys');

    const validateOut = makeAjv().compile(op.output);
    expect(
      validateOut({ alpha: 'x', beta: 1 }),
      `{alpha,beta} must validate; ajv errors: ${JSON.stringify(validateOut.errors)}`
    ).toBe(true);
    // Everything below must be rejected by the (single, canonical) branch.
    expect(validateOut({ alpha: 'x' })).toBe(false); // missing required beta
    expect(validateOut({ alpha: 1, beta: 'x' })).toBe(false); // swapped types
    expect(validateOut({ alpha: 'x', beta: 1, extra: true })).toBe(false); // additionalProperties:false

    const validateIn = makeAjv().compile(op.input);
    expect(validateIn({ input: { alpha: 'x', beta: 1 } })).toBe(true);
    expect(validateIn({ input: { alpha: 1, beta: 'x' } })).toBe(false);
  });

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROL — the exact PRE-FIX shape: both reordered branches kept
  // (raw-stringify dedupe misses them). AJV must REJECT a value that matches
  // both branches, proving the positive assertions above have teeth and that
  // the defect is real (not merely theoretical).
  // -------------------------------------------------------------------------
  it('[dedupe.NEGATIVE] the pre-fix two-branch shape rejects an otherwise-valid value (proves teeth)', () => {
    const branchA = {
      type: 'object',
      properties: { alpha: { type: 'string' }, beta: { type: 'number' } },
      required: ['alpha', 'beta'],
      additionalProperties: false,
    };
    const branchB = {
      type: 'object',
      properties: { beta: { type: 'number' }, alpha: { type: 'string' } },
      required: ['beta', 'alpha'],
      additionalProperties: false,
    };
    const validate = makeAjv().compile({ oneOf: [branchA, branchB] });
    expect(
      validate({ alpha: 'x', beta: 1 }),
      'the pre-fix two-identical-branch oneOf was expected to REJECT a value matching ' +
        'both branches; if this now passes, the failure class may have changed shape'
    ).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === 'oneOf')).toBe(true);
  });
});
