/**
 * FEAT-APIGEN-022 — coerceQueryParams: query-string → typed-domain-arg
 * coercion for GET-hoisted operations.
 *
 * Backlog point 3 ("Even the manual override is unsafe for non-string params
 * today"): a GET request's query string carries every value as a string, but
 * the (non-coercing) validate-Layer Ajv instance rejects a string where a
 * `number`/`integer`/`boolean` domain param is declared. This suite proves
 * (a) coerceQueryParams converts exactly those three types and leaves
 * `string` / unparseable / non-string values alone, and (b) wiring it in
 * front of the validate-Layer actually fixes the round-trip — an
 * integration proof, not just a unit test of the coercion function alone.
 */
import { describe, it, expect } from 'vitest';
import { coerceQueryParams } from '../lib/coerce-query';
import { makeValidateLayer } from '../lib/validate-layer';
import { LayerContext } from '../lib/invoke';
import { ApiError } from '@adhd/apigen-base-errors';
import type { Call } from '../lib/invoke';
import type { ComposedSchemas } from '../lib/types';

const schema = {
  input: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
          page: { type: 'integer' },
          active: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'count'],
      },
    },
    required: ['data'],
  },
};

describe('coerceQueryParams', () => {
  it('[coerce-query.1] leaves string-typed params unchanged', () => {
    const result = coerceQueryParams({ name: 'alice' }, schema);
    expect(result['name']).toBe('alice');
  });

  it('[coerce-query.2] coerces a number-typed param string to a number', () => {
    const result = coerceQueryParams({ count: '42' }, schema);
    expect(result['count']).toBe(42);
    expect(typeof result['count']).toBe('number');
  });

  it('[coerce-query.3] coerces an integer-typed param string to a number', () => {
    const result = coerceQueryParams({ page: '7' }, schema);
    expect(result['page']).toBe(7);
  });

  it('[coerce-query.4] coerces "true"/"false" to real booleans for a boolean-typed param', () => {
    expect(coerceQueryParams({ active: 'true' }, schema)['active']).toBe(true);
    expect(coerceQueryParams({ active: 'false' }, schema)['active']).toBe(
      false
    );
  });

  it('[coerce-query.5] an unparseable number string is left AS-IS (so validation still rejects it)', () => {
    const result = coerceQueryParams({ count: 'not-a-number' }, schema);
    expect(result['count']).toBe('not-a-number');
  });

  it('[coerce-query.6] a non-"true"/"false" boolean string is left AS-IS', () => {
    const result = coerceQueryParams({ active: 'yes' }, schema);
    expect(result['active']).toBe('yes');
  });

  it('[coerce-query.7] array-typed params (outside the primitive-only boundary) pass through unchanged', () => {
    const result = coerceQueryParams({ tags: ['a', 'b'] }, schema);
    expect(result['tags']).toEqual(['a', 'b']);
  });

  it('[coerce-query.8] a param not declared on the domain schema at all passes through unchanged', () => {
    const result = coerceQueryParams({ unknownField: '123' }, schema);
    expect(result['unknownField']).toBe('123');
  });

  it('[coerce-query.9] a missing/undefined schema is handled gracefully — no throw, input unchanged', () => {
    expect(coerceQueryParams({ count: '42' }, undefined)).toEqual({
      count: '42',
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: coerceQueryParams in front of the validate-Layer actually
// fixes the GET/query round-trip for number/integer/boolean domain params.
// ---------------------------------------------------------------------------

describe('coerceQueryParams + validate-Layer — GET round-trip integration', () => {
  const schemas: ComposedSchemas = { getPage: schema };

  function makeCall(domainArgs: Record<string, unknown>): Call {
    return {
      operation: { id: 'getPage' },
      ctx: new LayerContext(),
      envelope: {},
      domainArgs,
    };
  }

  it('[coerce-query.10] WITHOUT coercion, a raw query-string number param FAILS validation', async () => {
    const layer = makeValidateLayer(schemas);
    const call = makeCall({ name: 'alice', count: '42' }); // raw query string, uncoerced
    await expect(layer(call, async () => 'ok')).rejects.toThrow(ApiError);
  });

  it('[coerce-query.11] WITH coercion, the same query-string params PASS validation', async () => {
    const layer = makeValidateLayer(schemas);
    const coerced = coerceQueryParams(
      { name: 'alice', count: '42', page: '3', active: 'true' },
      schema
    );
    const call = makeCall(coerced);
    const result = await layer(call, async () => 'ok');
    expect(result).toBe('ok');
  });
});
