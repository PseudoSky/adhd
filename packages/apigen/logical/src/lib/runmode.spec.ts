import { describe, expect, it, vi } from 'vitest';
import { buildTranscoder, tryRegister } from './runmode';
import { createRegistry } from './registry';
import type { LogicalTypeCodec, SchemaNode, TranscodeCtx, Wire } from './contracts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal stub codec: identity encode/decode over a tagged scalar. */
function makeStubCodec(
  id: string,
  format: string,
  transform: { encode: (v: unknown) => Wire; decode: (w: Wire) => unknown },
): LogicalTypeCodec {
  return {
    id,
    kind: 'scalar',
    schema: { type: 'string', format },
    matches: (node: SchemaNode) => node['format'] === format,
    encode: (value, _node, _ctx) => transform.encode(value),
    decode: (wire, _node, _ctx) => transform.decode(wire),
  };
}

/** A codec that wraps/unwraps a value in a marker object so we can prove the
 *  transcoder path actually touched it. */
const MARKED_FORMAT = 'x-test-marked';
const markedCodec: LogicalTypeCodec = makeStubCodec(MARKED_FORMAT, MARKED_FORMAT, {
  encode: (v) => `encoded(${String(v)})`,
  decode: (w) => `decoded(${String(w)})`,
});

// ---------------------------------------------------------------------------
// buildTranscoder
// ---------------------------------------------------------------------------

describe('buildTranscoder', () => {
  describe('scalar codec round-trip', () => {
    it('delegates to the registered codec for a matching schema node', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = { type: 'string', format: MARKED_FORMAT };
      const wire = transcoder.encode('hello', schema);
      expect(wire).toBe('encoded(hello)');

      const host = transcoder.decode(wire, schema);
      expect(host).toBe('decoded(encoded(hello))');
    });

    it('round-trips a value through encode → decode', () => {
      // A "lossless" codec: encode prepends a tag, decode strips it.
      const codec = makeStubCodec('tagged', 'x-tagged', {
        encode: (v) => `T:${String(v)}`,
        decode: (w) => String(w).slice(2),  // strip "T:"
      });
      const registry = createRegistry();
      registry.register(codec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = { type: 'string', format: 'x-tagged' };
      const original = 'round-trip-me';
      const wire = transcoder.encode(original, schema);
      const recovered = transcoder.decode(wire, schema);
      expect(recovered).toBe(original);
    });
  });

  describe('plain JSON passthrough', () => {
    it('passes through a plain string when no codec matches', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());
      const schema: SchemaNode = { type: 'string' };
      expect(transcoder.encode('hello', schema)).toBe('hello');
      expect(transcoder.decode('hello', schema)).toBe('hello');
    });

    it('passes through a plain number', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());
      const schema: SchemaNode = { type: 'number' };
      expect(transcoder.encode(42, schema)).toBe(42);
      expect(transcoder.decode(42, schema)).toBe(42);
    });

    it('passes through null', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());
      const schema: SchemaNode = { type: 'string' };
      expect(transcoder.encode(null, schema)).toBeNull();
      expect(transcoder.decode(null, schema)).toBeNull();
    });
  });

  describe('object properties walk', () => {
    it('recurses into object properties applying codecs per-property', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'object',
        properties: {
          label: { type: 'string' },
          tag: { type: 'string', format: MARKED_FORMAT },
        },
      };
      const wire = transcoder.encode({ label: 'hi', tag: 'value' }, schema);
      expect(wire).toEqual({ label: 'hi', tag: 'encoded(value)' });

      const host = transcoder.decode(wire as Wire, schema);
      expect(host).toEqual({ label: 'hi', tag: 'decoded(encoded(value))' });
    });

    it('omits undefined properties', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
        },
      };
      // Only 'a' is present
      const wire = transcoder.encode({ a: 'x' }, schema);
      expect(wire).toEqual({ a: 'x' });
    });
  });

  describe('array items walk', () => {
    it('recurses into array items applying the codec per-element', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'array',
        items: { type: 'string', format: MARKED_FORMAT },
      };
      const wire = transcoder.encode(['a', 'b', 'c'], schema);
      expect(wire).toEqual(['encoded(a)', 'encoded(b)', 'encoded(c)']);

      const host = transcoder.decode(wire as Wire, schema);
      expect(host).toEqual([
        'decoded(encoded(a))',
        'decoded(encoded(b))',
        'decoded(encoded(c))',
      ]);
    });

    it('passes through array elements when no items schema is given', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = { type: 'array' };
      const wire = transcoder.encode([1, 'two', true], schema);
      expect(wire).toEqual([1, 'two', true]);
    });

    // REGRESSION: tuple/positional `items` (an ARRAY of per-index schemas) must
    // be walked position-by-position — NOT treated as a single element schema
    // (which made encodeSchemaless envelope every element: the BUG-013 tuple bug
    // surfaced as `[{"$apigen":"int64","v":"x"},…]`).
    it('walks positional (tuple) items array by index, no per-element envelope', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      // Tuple [marked, plain-number, plain-boolean]: only position 0 has a codec.
      const schema: SchemaNode = {
        type: 'array',
        items: [
          { type: 'string', format: MARKED_FORMAT },
          { type: 'number' },
          { type: 'boolean' },
        ],
        minItems: 3,
        maxItems: 3,
      };
      const wire = transcoder.encode(['x', 1, true], schema);
      // Position 0 goes through the codec; positions 1 & 2 pass through as-is.
      // Teeth: a wrong impl envelopes element 0 → {$apigen:…}; here it must be a string.
      expect(wire).toEqual(['encoded(x)', 1, true]);

      const host = transcoder.decode(wire as Wire, schema);
      expect(host).toEqual(['decoded(encoded(x))', 1, true]);
    });

    it('plain tuple of scalars (no logical types) round-trips untouched', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
        minItems: 3,
        maxItems: 3,
      };
      const wire = transcoder.encode(['x', 1, true], schema);
      expect(wire).toEqual(['x', 1, true]);
      expect(transcoder.decode(wire as Wire, schema)).toEqual(['x', 1, true]);
    });

    it('positional items: elements past the tuple length pass through', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        type: 'array',
        items: [{ type: 'string' }],
      };
      const wire = transcoder.encode(['a', 2, 3], schema);
      expect(wire).toEqual(['a', 2, 3]);
    });
  });

  describe('$ref resolution', () => {
    it('resolves a $ref through the ctx.resolve override', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const defs: Record<string, SchemaNode> = {
        '#/$defs/Tag': { type: 'string', format: MARKED_FORMAT },
      };
      const refSchema: SchemaNode = { $ref: '#/$defs/Tag' };

      const wire = transcoder.encode('original', refSchema, {
        resolve: (ref) => defs[ref] ?? {},
      });
      expect(wire).toBe('encoded(original)');
    });

    it('throws when $ref cannot be resolved without a ctx.resolve override', () => {
      const registry = createRegistry();
      const transcoder = buildTranscoder(registry.freeze());

      expect(() =>
        transcoder.encode('x', { $ref: '#/$defs/Missing' }),
      ).toThrow(/\$ref/);
    });
  });

  describe('oneOf / discriminated union', () => {
    it('picks the branch matching the discriminator tag and encodes through it', () => {
      const registry = createRegistry();
      registry.register(markedCodec);
      const transcoder = buildTranscoder(registry.freeze());

      const schema: SchemaNode = {
        oneOf: [
          { $ref: '#/$defs/Dog' },
          { $ref: '#/$defs/Cat' },
        ],
        discriminator: {
          propertyName: 'kind',
          mapping: { dog: '#/$defs/Dog', cat: '#/$defs/Cat' },
        },
      };
      const defs: Record<string, SchemaNode> = {
        '#/$defs/Dog': {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            name: { type: 'string', format: MARKED_FORMAT },
          },
        },
        '#/$defs/Cat': {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            lives: { type: 'number' },
          },
        },
      };

      const resolve = (ref: string): SchemaNode => defs[ref] ?? {};
      const dogWire = transcoder.encode({ kind: 'dog', name: 'Rex' }, schema, { resolve });
      // Dog branch: name is MARKED_FORMAT so codec runs
      expect(dogWire).toEqual({ kind: 'dog', name: 'encoded(Rex)' });
    });
  });

  describe('schema-less envelope (any position)', () => {
    it('wraps a value in the $apigen envelope when a codec matches at schema-less position', () => {
      const registry = createRegistry();
      // Codec that always claims to encode objects
      const anyCodec: LogicalTypeCodec = {
        id: 'x-any',
        kind: 'scalar',
        schema: {},
        matches: () => false, // does NOT match via resolve — only used in schema-less path
        encode: (v) => `wrapped(${String(v)})`,
        decode: (w) => `unwrapped(${String(w)})`,
      };
      registry.register(anyCodec);
      const transcoder = buildTranscoder(registry.freeze());

      // A schema-less node (type absent)
      const schema: SchemaNode = {};
      const wire = transcoder.encode('payload', schema);
      // Envelope: { $apigen: 'x-any', v: 'wrapped(payload)' }
      expect(wire).toEqual({ $apigen: 'x-any', v: 'wrapped(payload)' });

      const host = transcoder.decode(wire as Wire, schema);
      expect(host).toBe('unwrapped(wrapped(payload))');
    });

    it('falls back to passthrough when no codec can encode the value at schema-less position', () => {
      const registry = createRegistry();
      // Codec whose encode always throws (simulates "not my type")
      const picky: LogicalTypeCodec = {
        id: 'x-picky',
        kind: 'scalar',
        schema: {},
        matches: () => false,
        encode: () => { throw new Error('not my value'); },
        decode: (w) => w,
      };
      registry.register(picky);
      const transcoder = buildTranscoder(registry.freeze());

      const wire = transcoder.encode('plain', {});
      expect(wire).toBe('plain');
    });
  });

  describe('ctx partial override', () => {
    it('respects the mode override threaded through the context', () => {
      const registry = createRegistry();
      let capturedMode: string | undefined;
      const modeCapture: LogicalTypeCodec = {
        id: 'x-capture',
        kind: 'scalar',
        schema: { type: 'string', format: 'x-capture' },
        matches: (n: SchemaNode) => n['format'] === 'x-capture',
        encode: (_v, _n, ctx: TranscodeCtx) => {
          capturedMode = ctx.mode;
          return 'enc';
        },
        decode: (w) => w,
      };
      registry.register(modeCapture);
      const transcoder = buildTranscoder(registry.freeze());

      transcoder.encode('x', { type: 'string', format: 'x-capture' }, { mode: 'lossy' });
      expect(capturedMode).toBe('lossy');
    });
  });
});

// ---------------------------------------------------------------------------
// tryRegister
// ---------------------------------------------------------------------------

describe('tryRegister', () => {
  it('registers a codec when the loader succeeds', () => {
    const registry = createRegistry();
    tryRegister(registry, 'test-ok', () => markedCodec);
    expect(registry.get(MARKED_FORMAT)).toBe(markedCodec);
  });

  it('silently skips when the loader throws MODULE_NOT_FOUND (lib absent)', () => {
    const registry = createRegistry();

    const notFound = Object.assign(new Error('Cannot find module'), {
      code: 'MODULE_NOT_FOUND',
    });
    tryRegister(registry, 'decimal', () => { throw notFound; });

    // Registry must still be empty — no crash
    expect(registry.ids()).toHaveLength(0);
  });

  it('re-throws when the loader throws a non-MODULE_NOT_FOUND error', () => {
    const registry = createRegistry();
    const boom = new Error('unexpected failure');

    expect(() => tryRegister(registry, 'x', () => { throw boom; })).toThrow(boom);
  });

  it('does not crash the process when multiple codecs are attempted and one is absent', () => {
    const registry = createRegistry();

    // Codec A is present
    tryRegister(registry, MARKED_FORMAT, () => markedCodec);
    // Codec B is absent
    const absent = Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
    tryRegister(registry, 'absent-lib', () => { throw absent; });

    // Only A registered
    expect(registry.ids()).toEqual([MARKED_FORMAT]);
  });

  it('re-throws loader errors that are non-Error objects', () => {
    const registry = createRegistry();
    expect(() =>
      tryRegister(registry, 'x', () => { throw 'string-error'; }),
    ).toThrow();
  });

  it('uses the loader to construct the codec (not the _id param)', () => {
    const registry = createRegistry();
    // _id parameter is informational — the codec's own id governs registration
    const codecA = makeStubCodec('actual-id', 'x-actual', {
      encode: (v) => v as Wire,
      decode: (w) => w,
    });
    tryRegister(registry, 'does-not-matter', () => codecA);
    expect(registry.get('actual-id')).toBe(codecA);
    expect(registry.get('does-not-matter')).toBeUndefined();
  });

  describe('negative-control: lazy-register skips a codec whose loader throws MODULE_NOT_FOUND', () => {
    it('registry has no codecs registered after a MODULE_NOT_FOUND loader', () => {
      const registry = createRegistry();
      const missingLib = Object.assign(
        new Error("Cannot find module 'decimal.js'"),
        { code: 'MODULE_NOT_FOUND' },
      );
      tryRegister(registry, 'decimal', () => { throw missingLib; });

      // Negative control: if tryRegister DID NOT swallow MODULE_NOT_FOUND,
      // the test would throw before reaching this assertion.
      expect(registry.ids()).toHaveLength(0);
    });

    it('a transcoder built over an empty registry passes plain values through (no crash)', () => {
      const registry = createRegistry();
      // Simulate failed lazy-load
      const missingLib = Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
      tryRegister(registry, 'decimal', () => { throw missingLib; });

      const transcoder = buildTranscoder(registry.freeze());
      // No codec registered; plain string passthrough must not throw
      expect(transcoder.encode('1.23', { type: 'string', format: 'decimal' })).toBe('1.23');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: stub codec round-trip through a full schema tree
// ---------------------------------------------------------------------------

describe('buildTranscoder (integration)', () => {
  it('full encode→decode round-trip through a nested object with a custom scalar', () => {
    const codec = makeStubCodec('tagged', 'x-tagged', {
      encode: (v) => `ENC[${String(v)}]`,
      decode: (w) => String(w).replace(/^ENC\[(.+)\]$/, '$1'),
    });
    const registry = createRegistry();
    registry.register(codec);
    const transcoder = buildTranscoder(registry.freeze());

    const schema: SchemaNode = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        items: {
          type: 'array',
          items: { type: 'string', format: 'x-tagged' },
        },
      },
    };

    const original = { name: 'test', items: ['alpha', 'beta'] };
    const wire = transcoder.encode(original, schema);
    expect(wire).toEqual({ name: 'test', items: ['ENC[alpha]', 'ENC[beta]'] });

    const host = transcoder.decode(wire as Wire, schema);
    expect(host).toEqual(original);
  });

  it('vi.spyOn verifies the codec is actually called during round-trip', () => {
    const codec = makeStubCodec('spied', 'x-spied', {
      encode: (v) => String(v),
      decode: (w) => w,
    });
    const encodeSpy = vi.spyOn(codec, 'encode');
    const decodeSpy = vi.spyOn(codec, 'decode');

    const registry = createRegistry();
    registry.register(codec);
    const transcoder = buildTranscoder(registry.freeze());

    const schema: SchemaNode = { type: 'string', format: 'x-spied' };
    transcoder.encode('hello', schema);
    transcoder.decode('hello', schema);

    expect(encodeSpy).toHaveBeenCalledOnce();
    expect(decodeSpy).toHaveBeenCalledOnce();
  });
});
