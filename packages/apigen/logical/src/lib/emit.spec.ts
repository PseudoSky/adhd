import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry';
import type { LogicalTypeCodec, SchemaNode } from './contracts';
import {
  EmitError,
  TS_TEMPLATE_TABLE,
  createEmitCtx,
  emitDecode,
  emitEncode,
  rootRefResolver,
} from './emit';

/**
 * Proves the generate-time walk (DESIGN §4.4 / §11): it lowers a resolved
 * JSON-Schema node + a registry + a per-language template table into a string
 * expression of direct (de)hydration glue. We drive the REAL registry resolve
 * path (codecs match by `format`) and the REAL TS template column — no mocking
 * of the thing under test. The assertions key on the emitted source so a
 * regression in the walk turns the test red (negative controls below prove the
 * teeth).
 */

/** A scalar codec that the registry resolves by JSON-Schema `format`. */
function scalarCodec(format: string): LogicalTypeCodec {
  return {
    id: format,
    kind: 'scalar',
    schema: { type: 'string', format },
    matches: (node: SchemaNode) => node['format'] === format,
    encode: (v) => v as never,
    decode: (w) => w as never,
  };
}

function tsRegistry() {
  const reg = createRegistry();
  reg.register(scalarCodec('date-time'));
  reg.register(scalarCodec('int64'));
  reg.register(scalarCodec('byte'));
  return reg;
}

function ctx(root?: SchemaNode) {
  return createEmitCtx(tsRegistry(), TS_TEMPLATE_TABLE, { root });
}

/** Evaluate emitted TS glue against a value to prove the expression is real. */
function run(exprSource: string, valueName: string, value: unknown): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(valueName, `return (${exprSource});`);
  return fn(value);
}

describe('emitEncode / emitDecode — schema walk', () => {
  it('scalar date-time: splices the TS template cell ($ = expr)', () => {
    const node: SchemaNode = { type: 'string', format: 'date-time' };
    expect(emitDecode('w', node, ctx())).toBe('new Date(w)');
    expect(emitEncode('v', node, ctx())).toBe('v.toISOString()');
  });

  it('decode produces a real Date from an RFC-3339 string', () => {
    const node: SchemaNode = { type: 'string', format: 'date-time' };
    const src = emitDecode('w', node, ctx());
    const out = run(src, 'w', '2024-01-15T12:00:00.000Z') as Date;
    expect(out).toBeInstanceOf(Date);
    expect(out.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });

  it('nested object: rebuilds an object literal over declared properties', () => {
    const node: SchemaNode = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    };
    const src = emitDecode('w', node, ctx());
    // The scalar field is transformed; the plain field passes through.
    const out = run(src, 'w', {
      id: 'a',
      createdAt: '2024-01-15T12:00:00.000Z',
    }) as { id: string; createdAt: Date };
    expect(out.id).toBe('a');
    expect(out.createdAt).toBeInstanceOf(Date);
    expect(out.createdAt.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });

  it('array of date-times: maps each item through the item codec', () => {
    const node: SchemaNode = {
      type: 'array',
      items: { type: 'string', format: 'date-time' },
    };
    const src = emitDecode('w', node, ctx());
    expect(src).toContain('.map(');
    expect(src).toContain('new Date(');
    const out = run(src, 'w', [
      '2024-01-15T12:00:00.000Z',
      '2024-02-20T00:00:00.000Z',
    ]) as Date[];
    expect(out).toHaveLength(2);
    expect(out.every((d) => d instanceof Date)).toBe(true);
    expect(out[1].toISOString()).toBe('2024-02-20T00:00:00.000Z');
  });

  it('$ref: recurses the referenced $def', () => {
    const root: SchemaNode = {
      $defs: {
        Stamp: { type: 'string', format: 'date-time' },
      },
    };
    const node: SchemaNode = { $ref: '#/$defs/Stamp' };
    const src = emitDecode('w', node, ctx(root));
    expect(src).toBe('new Date(w)');
    const out = run(src, 'w', '2024-01-15T12:00:00.000Z') as Date;
    expect(out.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });

  it('object whose property is a $ref to a $def transforms that field', () => {
    const root: SchemaNode = {
      $defs: { Stamp: { type: 'string', format: 'date-time' } },
    };
    const node: SchemaNode = {
      type: 'object',
      properties: {
        when: { $ref: '#/$defs/Stamp' },
        label: { type: 'string' },
      },
    };
    const out = run(emitDecode('w', node, ctx(root)), 'w', {
      when: '2024-01-15T12:00:00.000Z',
      label: 'x',
    }) as { when: Date; label: string };
    expect(out.when).toBeInstanceOf(Date);
    expect(out.label).toBe('x');
  });

  it('encode round-trips an array of date-times back to the wire', () => {
    const node: SchemaNode = {
      type: 'array',
      items: { type: 'string', format: 'date-time' },
    };
    const decoded = run(
      emitDecode('w', node, ctx()),
      'w',
      ['2024-01-15T12:00:00.000Z'],
    ) as Date[];
    const wire = run(emitEncode('v', node, ctx()), 'v', decoded) as string[];
    expect(wire).toEqual(['2024-01-15T12:00:00.000Z']);
  });

  it('plain JSON scalar passes through unchanged (no template entry)', () => {
    const node: SchemaNode = { type: 'string' };
    expect(emitDecode('w', node, ctx())).toBe('w');
    expect(emitEncode('v', node, ctx())).toBe('v');
  });

  it('non-identifier property keys are bracketed/quoted safely', () => {
    const node: SchemaNode = {
      type: 'object',
      properties: {
        'created-at': { type: 'string', format: 'date-time' },
      },
    };
    const out = run(emitDecode('w', node, ctx()), 'w', {
      'created-at': '2024-01-15T12:00:00.000Z',
    }) as Record<string, Date>;
    expect(out['created-at']).toBeInstanceOf(Date);
  });
});

describe('emit — failure modes (teeth)', () => {
  it('throws E_EMIT on a $ref with no resolvable $def', () => {
    const node: SchemaNode = { $ref: '#/$defs/Missing' };
    let err: unknown;
    try {
      emitDecode('w', node, ctx({ $defs: {} }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EmitError);
    expect((err as EmitError).code).toBe('E_EMIT');
  });

  it('throws E_EMIT on a cyclic $ref (cannot be a finite expression)', () => {
    const root: SchemaNode = { $defs: { Loop: { $ref: '#/$defs/Loop' } } };
    expect(() =>
      emitDecode('w', { $ref: '#/$defs/Loop' }, ctx(root)),
    ).toThrow(EmitError);
  });

  it('NEGATIVE CONTROL: a wrong cell makes the decode produce the wrong value', () => {
    // If the walk spliced the WRONG column, decode would not yield a Date.
    // Prove the assertion has teeth by deliberately mis-typing the table.
    const reg = createRegistry();
    reg.register(scalarCodec('date-time'));
    const brokenTable = { 'date-time': { encode: '$', decode: '$', mode: 'native' as const } };
    const brokenCtx = createEmitCtx(reg, brokenTable);
    const node: SchemaNode = { type: 'string', format: 'date-time' };
    const out = run(emitDecode('w', node, brokenCtx), 'w', '2024-01-15T12:00:00.000Z');
    expect(out).not.toBeInstanceOf(Date); // broken table -> string passthrough
  });
});

describe('rootRefResolver', () => {
  it('resolves #/$defs and #/definitions', () => {
    const resolve = rootRefResolver({
      $defs: { A: { type: 'number' } },
      definitions: { B: { type: 'boolean' } },
    });
    expect(resolve('#/$defs/A')).toEqual({ type: 'number' });
    expect(resolve('#/definitions/B')).toEqual({ type: 'boolean' });
  });
});
