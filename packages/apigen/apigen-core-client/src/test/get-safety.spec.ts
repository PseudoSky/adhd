import { describe, it, expect } from 'vitest';
import { isPrimitiveOnlyInputSchema } from '../lib/get-safety';

// ---------------------------------------------------------------------------
// FEAT-APIGEN-022 — isPrimitiveOnlyInputSchema: the shape-based GET-hoist test
// ---------------------------------------------------------------------------

describe('isPrimitiveOnlyInputSchema', () => {
  it('[get-safety.1] zero declared properties (real zero-param shape) — vacuously true', () => {
    expect(
      isPrimitiveOnlyInputSchema({ type: 'object', properties: {}, required: [] })
    ).toBe(true);
  });

  it('[get-safety.2] no "properties" key at all — false (not a real, populated input shape)', () => {
    expect(isPrimitiveOnlyInputSchema({})).toBe(false);
    expect(isPrimitiveOnlyInputSchema(undefined)).toBe(false);
    expect(isPrimitiveOnlyInputSchema(null)).toBe(false);
  });

  it('[get-safety.3] all string/number/boolean/integer params — true', () => {
    expect(
      isPrimitiveOnlyInputSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
          active: { type: 'boolean' },
          page: { type: 'integer' },
        },
        required: ['name'],
      })
    ).toBe(true);
  });

  it('[get-safety.4] a param typed union with "null" (optional primitive) — still true', () => {
    expect(
      isPrimitiveOnlyInputSchema({
        type: 'object',
        properties: { name: { type: ['string', 'null'] } },
        required: [],
      })
    ).toBe(true);
  });

  it('[get-safety.5] an object-typed param — false', () => {
    expect(
      isPrimitiveOnlyInputSchema({
        type: 'object',
        properties: {
          id: { type: 'string' },
          payload: { type: 'object', properties: { x: { type: 'number' } } },
        },
        required: ['id', 'payload'],
      })
    ).toBe(false);
  });

  it('[get-safety.6] an array-typed param — false', () => {
    expect(
      isPrimitiveOnlyInputSchema({
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' } } },
        required: ['ids'],
      })
    ).toBe(false);
  });

  it('[get-safety.7] a $ref (named/branded type) param — false', () => {
    expect(
      isPrimitiveOnlyInputSchema({
        type: 'object',
        properties: { user: { $ref: '#/$defs/User' } },
        required: ['user'],
      })
    ).toBe(false);
  });

  it('[get-safety.8] a oneOf/anyOf/allOf (union/logical) param — false', () => {
    expect(
      isPrimitiveOnlyInputSchema({
        type: 'object',
        properties: {
          choice: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
        required: ['choice'],
      })
    ).toBe(false);
    expect(
      isPrimitiveOnlyInputSchema({
        type: 'object',
        properties: { choice: { anyOf: [{ type: 'string' }] } },
        required: [],
      })
    ).toBe(false);
  });

  it('[get-safety.9] a primitive-literal enum without an explicit "type" — true', () => {
    expect(
      isPrimitiveOnlyInputSchema({
        type: 'object',
        properties: { status: { enum: ['active', 'inactive'] } },
        required: ['status'],
      })
    ).toBe(true);
  });

  it('[get-safety.10] one primitive + one complex param — false (ALL must be primitive)', () => {
    expect(
      isPrimitiveOnlyInputSchema({
        type: 'object',
        properties: {
          id: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      })
    ).toBe(false);
  });
});
