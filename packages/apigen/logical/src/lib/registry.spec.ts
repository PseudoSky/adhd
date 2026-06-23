import { describe, expect, it } from 'vitest';
import { createRegistry, CodecRegistryError } from './registry';
import type { LogicalTypeCodec, SchemaNode } from './contracts';

/**
 * Spine-level proof for the minimal registry stub: id-keyed storage,
 * `E_DUP_CODEC` duplicate detection, the `override` escape hatch, and a frozen
 * snapshot that rejects mutation. Codec resolution / well-known loading are
 * later states and intentionally NOT asserted here.
 */

function fakeCodec(id: string, format?: string): LogicalTypeCodec {
  const schema: SchemaNode = format ? { type: 'string', format } : {};
  return {
    id,
    kind: 'scalar',
    schema,
    // Trivial structural match used by the spine `resolve`.
    matches: (node: SchemaNode) => format != null && node['format'] === format,
    encode: (value) => value as never,
    decode: (wire) => wire as never,
  };
}

describe('createRegistry (contract spine)', () => {
  it('registers and looks up a codec by id', () => {
    const reg = createRegistry();
    const codec = fakeCodec('date-time', 'date-time');
    reg.register(codec);
    expect(reg.get('date-time')).toBe(codec);
    expect(reg.ids()).toEqual(['date-time']);
  });

  it('throws E_DUP_CODEC on a duplicate id', () => {
    const reg = createRegistry();
    reg.register(fakeCodec('date-time', 'date-time'));
    let err: unknown;
    try {
      reg.register(fakeCodec('date-time', 'date-time'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodecRegistryError);
    expect((err as CodecRegistryError).code).toBe('E_DUP_CODEC');
  });

  it('allows re-registration with {override:true}', () => {
    const reg = createRegistry();
    reg.register(fakeCodec('date-time', 'date-time'));
    const replacement = fakeCodec('date-time', 'date-time');
    expect(() => reg.register(replacement, { override: true })).not.toThrow();
    expect(reg.get('date-time')).toBe(replacement);
  });

  it('resolve() uses the codec structural match and returns undefined for plain JSON', () => {
    const reg = createRegistry();
    const codec = fakeCodec('date-time', 'date-time');
    reg.register(codec);
    expect(reg.resolve({ type: 'string', format: 'date-time' })).toBe(codec);
    expect(reg.resolve({ type: 'string' })).toBeUndefined();
  });

  it('freeze() snapshots and rejects further registration', () => {
    const reg = createRegistry();
    reg.register(fakeCodec('date-time', 'date-time'));
    const frozen = reg.freeze();
    expect(frozen.get('date-time')).toBeDefined();
    expect(frozen.ids()).toEqual(['date-time']);
    expect(() => frozen.register(fakeCodec('uuid', 'uuid'))).toThrow(
      CodecRegistryError,
    );
  });
});
