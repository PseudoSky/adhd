/**
 * guards: a nullable numeric or boolean query parameter (oneOf / anyOf / type-array with a null branch) stays a string, so `GET ?limit=2` is rejected by the strict validate layer as "not an integer"
 * tier: S
 * cites: backlog 9429470e-4362-4c8b-9ce4-936e8aff0574 (R3a); REMEDIATION-PLAN T-R3a
 * tags: regression:9429470e
 * teeth: red: delete the `soleNonNullBranch(...)` resolution line in coercibleType (guarded temporary edit, restored) and run `npx vitest run src/test/coerce-query-nullable.spec.ts` in packages/apigen/apigen-engine-runtime -> exit 1; the oneOf / anyOf / nested cases receive the string "2"
 *
 * The path is the transport's: raw query string -> coerceQueryParams -> the package invoker's strict validate layer
 * -> the function. Ajv has no coerceTypes, so an uncoerced "2" cannot pass for an integer.
 */
import { describe, expect, it } from 'vitest';
import { coerceQueryParams } from '../../src/lib/coerce-query';
import { createPackageInvoker } from '../../src/lib/package-invoker';
import { LayerContext, type Call } from '../../src/lib/invoke';
import type { ComposedSchemas } from '../../src/lib/types';

function schemaFor(prop: Record<string, unknown>): ComposedSchemas[string] {
  return {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: { v: prop } } },
    },
    output: {},
  } as ComposedSchemas[string];
}

/** GET path: parse the query string, coerce, validate, call; returns what the function received. */
async function get(queryString: string, prop: Record<string, unknown>): Promise<{ received: unknown } | { error: unknown }> {
  const schema = schemaFor(prop);
  const schemas: ComposedSchemas = { fn: schema };
  const query = Object.fromEntries(new URLSearchParams(queryString));
  const domainArgs = coerceQueryParams(query, schema);
  let received: unknown = 'not-called';
  const call: Call = { operation: { id: 'fn' }, ctx: new LayerContext(), envelope: {}, domainArgs, transport: 'http' };
  try {
    await createPackageInvoker(schemas, [])('fn', call, {
      fns: { fn: (v: unknown) => ((received = v), 'ok') },
      schemas,
    });
  } catch (error) {
    return { error };
  }
  return { received };
}

const NULL = { type: 'null' };

describe('coerceQueryParams on nullable schemas (T-R3a)', () => {
  it.each<[string, Record<string, unknown>, string, unknown]>([
    ['oneOf [null, integer]', { oneOf: [NULL, { type: 'integer' }] }, 'v=2', 2],
    ['oneOf [integer, null]', { oneOf: [{ type: 'integer' }, NULL] }, 'v=2', 2],
    ['anyOf [null, number]', { anyOf: [NULL, { type: 'number' }] }, 'v=2.5', 2.5],
    ['type [null, integer]', { type: ['null', 'integer'] }, 'v=7', 7],
    ['type [null, boolean]', { type: ['null', 'boolean'] }, 'v=true', true],
    ['oneOf [null, boolean]', { oneOf: [NULL, { type: 'boolean' }] }, 'v=false', false],
    ['nested nullable union', { oneOf: [NULL, { anyOf: [NULL, { type: 'integer' }] }] }, 'v=3', 3],
    ['a type-array branch', { oneOf: [NULL, { type: ['integer'] }] }, 'v=4', 4],
    ['a null branch spelled as a type array', { oneOf: [{ type: ['null'] }, { type: 'integer' }] }, 'v=5', 5],
    ['a plain integer (unchanged)', { type: 'integer' }, 'v=6', 6],
  ])('%s: ?%s reaches the function as the typed value', async (_name, prop, qs, expected) => {
    expect(await get(qs, prop)).toEqual({ received: expected });
  });

  it('the issue case: GET ?limit=2 on a nullable integer reaches the function as the number 2', async () => {
    const schema = {
      input: {
        type: 'object',
        properties: {
          data: { type: 'object', properties: { limit: { oneOf: [NULL, { type: 'integer' }] } } },
        },
      },
      output: {},
    };
    const coerced = coerceQueryParams(Object.fromEntries(new URLSearchParams('limit=2')), schema);
    expect(coerced).toEqual({ limit: 2 });
    expect(typeof coerced['limit']).toBe('number');
  });

  it('a nullable string stays a string', async () => {
    expect(await get('v=2', { oneOf: [NULL, { type: 'string' }] })).toEqual({ received: '2' });
    expect(await get('v=true', { type: ['null', 'string'] })).toEqual({ received: 'true' });
  });

  it('an ambiguous union (several non-null branches) is never guessed at', () => {
    const schema = schemaFor({ oneOf: [NULL, { type: 'integer' }, { type: 'boolean' }] });
    expect(coerceQueryParams({ v: '2' }, schema)).toEqual({ v: '2' });
    expect(coerceQueryParams({ v: 'true' }, schema)).toEqual({ v: 'true' });
  });

  it('an unparseable value stays a string and the validate layer rejects it as invalid_argument', async () => {
    const outcome = await get('v=abc', { oneOf: [NULL, { type: 'integer' }] });
    expect(outcome).toHaveProperty('error');
    expect((outcome as { error: { code: string } }).error.code).toBe('invalid_argument');
  });

  it('an empty value stays a string (not coerced to 0)', () => {
    expect(coerceQueryParams({ v: '' }, schemaFor({ oneOf: [NULL, { type: 'integer' }] }))).toEqual({ v: '' });
    expect(coerceQueryParams({ v: '  ' }, schemaFor({ type: ['null', 'number'] }))).toEqual({ v: '  ' });
  });

  it('a pathological self-nesting union terminates and leaves the value alone', () => {
    const prop: Record<string, unknown> = {};
    prop['oneOf'] = [NULL, prop];
    expect(coerceQueryParams({ v: '2' }, schemaFor(prop))).toEqual({ v: '2' });
  });

  it('leaves unknown params, repeated keys and schemas without properties alone', () => {
    expect(coerceQueryParams({ other: '2', v: ['1', '2'] as unknown as string }, schemaFor({ type: 'integer' }))).toEqual({
      other: '2',
      v: ['1', '2'],
    });
    expect(coerceQueryParams({ v: '2' }, undefined)).toEqual({ v: '2' });
  });
});
