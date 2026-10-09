/**
 * tool-arg-coercion.test.ts — backlog 114e014c (BK2), plan 9ed453c1. Pure unit
 * tests for the coercion function: AC2.1 (coerces), AC2.2 (non-coercible ->
 * mismatch with worked example), AC2.3 (string params never coerced). The
 * integration proof (AC2.4) is entrypoint/agent-mcp's tool-arg-coercion.e2e.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { coerceToolArguments } from '../engine/tool-arg-coercion.js';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/bk2-stringified-argv.json', import.meta.url)),
    'utf8'
  )
) as { tool: { inputSchema: unknown }; failingInput: { command: string } };

const schema = (props: Record<string, unknown>) => ({ type: 'object', properties: props });

describe('114e014c AC2.1 coercion (plan 9ed453c1)', () => {
  it('replays the real captured failing payload: stringified argv becomes the array', () => {
    const out = coerceToolArguments(fixture.tool.inputSchema, fixture.failingInput);
    expect(out.mismatch).toBeUndefined();
    expect(out.arguments).toEqual({
      command: ['adhd-backlog', 'backlog', 'get', '--input', '{"uid":"00000000-0000-4000-8000-000000000001"}'],
    });
    expect(out.coercions).toEqual([{ property: 'command', from: 'string', to: 'array' }]);
  });

  it('does not mutate the input arguments', () => {
    const args = { command: '["a"]' };
    coerceToolArguments(schema({ command: { type: 'array', items: { type: 'string' } } }), args);
    expect(args).toEqual({ command: '["a"]' });
  });

  it('coerces a stringified object to the declared object', () => {
    const out = coerceToolArguments(schema({ env: { type: 'object' } }), { env: '{"A":"1"}' });
    expect(out.arguments).toEqual({ env: { A: '1' } });
    expect(out.coercions).toEqual([{ property: 'env', from: 'string', to: 'object' }]);
  });

  it('coerces an array of non-string items when items.type is not string', () => {
    const out = coerceToolArguments(schema({ n: { type: 'array', items: { type: 'number' } } }), { n: '[1,2]' });
    expect(out.arguments).toEqual({ n: [1, 2] });
  });

  it('returns the same reference when nothing applies', () => {
    const args = { command: ['a'] };
    const out = coerceToolArguments(fixture.tool.inputSchema, args);
    expect(out.arguments).toBe(args);
    expect(out.coercions).toEqual([]);
  });
});

describe('114e014c AC2.2 non-coercible mismatch (plan 9ed453c1)', () => {
  const arr = schema({ command: { type: 'array', items: { type: 'string' } } });

  it.each([
    ['not JSON', 'cat /etc/hosts'],
    ['JSON of the wrong type (object for array)', '{"a":1}'],
    ['JSON of the wrong type (number for array)', '5'],
    ['array with a non-string element', '["a", 2]'],
    ['empty string', ''],
  ])('%s -> mismatch naming property, type and a worked example; not coerced', (_n, value) => {
    const out = coerceToolArguments(arr, { command: value });
    expect(out.coercions).toEqual([]);
    expect(out.mismatch?.property).toBe('command');
    expect(out.mismatch?.declaredType).toBe('array');
    expect(out.mismatch?.message).toContain('"command"');
    expect(out.mismatch?.message).toContain('array of string');
    expect(out.mismatch?.message).toContain('Example: {"command": ["first", "second"]}');
    expect(out.arguments).toEqual({ command: value });
  });

  it('object property given a JSON array string -> mismatch with an object example', () => {
    const out = coerceToolArguments(schema({ env: { type: 'object', properties: { A: { type: 'string' } } } }), { env: '[1]' });
    expect(out.mismatch?.declaredType).toBe('object');
    expect(out.mismatch?.message).toContain('Example: {"env": {"A": "value"}}');
  });

  it('JSON null for an object property is a mismatch, not a coercion', () => {
    const out = coerceToolArguments(schema({ env: { type: 'object' } }), { env: 'null' });
    expect(out.mismatch?.property).toBe('env');
  });
});

describe('114e014c AC2.3 never coerce (plan 9ed453c1)', () => {
  const looksLikeJson = ['["a"]', '{"a":1}', '5', 'true', 'null'];

  it.each(looksLikeJson)('declared string keeps %s verbatim', (value) => {
    const args = { s: value };
    const out = coerceToolArguments(schema({ s: { type: 'string' } }), args);
    expect(out.arguments).toBe(args);
    expect(out.coercions).toEqual([]);
    expect(out.mismatch).toBeUndefined();
  });

  it.each([
    ['number', { type: 'number' }, '5'],
    ['integer', { type: 'integer' }, '5'],
    ['boolean', { type: 'boolean' }, 'true'],
    ['union type array', { type: ['array', 'string'] }, '["a"]'],
    ['anyOf', { anyOf: [{ type: 'array' }, { type: 'string' }] }, '["a"]'],
    ['oneOf', { oneOf: [{ type: 'array' }] }, '["a"]'],
    ['allOf', { allOf: [{ type: 'array' }] }, '["a"]'],
    ['$ref', { $ref: '#/$defs/List' }, '["a"]'],
    ['no declared type', {}, '["a"]'],
    ['undeclared property', undefined, '["a"]'],
  ])('%s is left untouched', (_n, node, value) => {
    const props = node === undefined ? {} : { p: node };
    const args = { p: value };
    const out = coerceToolArguments(schema(props), args);
    expect(out.arguments).toBe(args);
    expect(out.coercions).toEqual([]);
    expect(out.mismatch).toBeUndefined();
  });

  it('a value that is already the declared type is not touched', () => {
    const args = { command: ['a'], env: { A: '1' } };
    const out = coerceToolArguments(
      schema({ command: { type: 'array' }, env: { type: 'object' } }),
      args
    );
    expect(out.arguments).toBe(args);
  });

  it('is top-level only and single level: nested stringified values are not reached', () => {
    const nested = schema({ outer: { type: 'object', properties: { inner: { type: 'array' } } } });
    const out = coerceToolArguments(nested, { outer: '{"inner":"[1]"}' });
    expect(out.arguments).toEqual({ outer: { inner: '[1]' } });
    expect(out.coercions).toHaveLength(1);
  });

  it('tolerates missing/odd schemas and non-object args', () => {
    expect(coerceToolArguments(undefined, { a: '[1]' }).coercions).toEqual([]);
    expect(coerceToolArguments({}, { a: '[1]' }).coercions).toEqual([]);
    expect(coerceToolArguments(schema({ a: { type: 'array' } }), 'x').coercions).toEqual([]);
    expect(coerceToolArguments(schema({ a: { type: 'array' } }), ['[1]']).coercions).toEqual([]);
  });
});
