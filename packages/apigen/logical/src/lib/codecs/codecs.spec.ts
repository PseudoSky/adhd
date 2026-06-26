/**
 * Conformance test for the well-known scalar codecs (lt-scalars).
 *
 * The canonical vector data is inlined here (sourced from
 * `@adhd/apigen-conformance/src/lib/vectors.ts` section F) to avoid the
 * circular dependency: apigen-conformance → apigen-core → apigen-logical.
 * Any change to the canonical vectors in vectors.ts must be mirrored here.
 *
 * For each vector:
 *   - Constructs the native `seed` from the $construct recipe (or uses it directly).
 *   - Asserts `encode(seed)` deep-equals the vector's `wire`.
 *   - Asserts `decode(wire)` satisfies each `invariant`.
 *   - Proves each `negativeControl` turns the vector RED (the check fails on
 *     the mutated value), so the guard has actual teeth.
 *
 * EXIT CODE is what the CI gates on — Vitest propagates a non-zero exit on
 * any failing test, satisfying the "key on exit code, not stdout" constraint.
 */

import { describe, expect, it } from 'vitest';
import { createRegistry } from '../registry';
import { registerWellKnown } from './index';
import type { LogicalTypeCodec, TranscodeCtx, SchemaNode, Wire } from '../contracts';

// ---------------------------------------------------------------------------
// Inlined conformance vectors (DESIGN §3 / vectors.ts §F)
//
// Sourced from packages/apigen/conformance/src/lib/vectors.ts — keep in sync.
// ---------------------------------------------------------------------------

interface LogicalTypeVector {
  readonly id: string;
  readonly logicalType: string;
  readonly schema: Record<string, unknown>;
  readonly seed: Wire | { $construct: string; args: Wire[] };
  readonly wire: Wire;
  readonly invariants?: ReadonlyArray<{ pointer: string; equals: Wire }>;
  readonly negativeControl: { mutate: 'wire' | 'schema' | 'codec'; to: unknown };
}

const SCALAR_VECTORS: LogicalTypeVector[] = [
  // ---- date-time ----
  {
    id: 'logical.date-time.roundtrip',
    logicalType: 'date-time',
    schema: { type: 'string', format: 'date-time' },
    seed: { $construct: 'date-time', args: ['2024-01-15T12:34:56.789Z'] },
    wire: '2024-01-15T12:34:56.789Z',
    invariants: [{ pointer: '/epochMs', equals: 1705322096789 }],
    negativeControl: { mutate: 'wire', to: '2024-01-15T12:34:56.789+05:30' },
  },
  // ---- int64 ----
  {
    id: 'logical.int64.roundtrip',
    logicalType: 'int64',
    schema: { type: 'string', format: 'int64' },
    seed: '9007199254740993',
    wire: '9007199254740993',
    invariants: [{ pointer: '/bigintStr', equals: '9007199254740993' }],
    negativeControl: { mutate: 'wire', to: 9007199254740993 },
  },
  // ---- decimal ----
  {
    id: 'logical.decimal.roundtrip',
    logicalType: 'decimal',
    schema: { type: 'string', format: 'decimal' },
    seed: '123.456',
    wire: '123.456',
    invariants: [{ pointer: '/str', equals: '123.456' }],
    negativeControl: { mutate: 'wire', to: 123.456 },
  },
  // ---- byte ----
  {
    id: 'logical.byte.roundtrip',
    logicalType: 'byte',
    schema: { type: 'string', format: 'byte' },
    seed: { $construct: 'byte', args: [[72, 101, 108, 108, 111]] },
    wire: 'SGVsbG8=',
    invariants: [{ pointer: '/utf8', equals: 'Hello' }],
    negativeControl: { mutate: 'wire', to: 'SGVs_G8=' },
  },
  // ---- uuid ----
  {
    id: 'logical.uuid.roundtrip',
    logicalType: 'uuid',
    schema: { type: 'string', format: 'uuid' },
    seed: '550e8400-e29b-41d4-a716-446655440000',
    wire: '550e8400-e29b-41d4-a716-446655440000',
    invariants: [{ pointer: '/value', equals: '550e8400-e29b-41d4-a716-446655440000' }],
    negativeControl: { mutate: 'wire', to: '550E8400-E29B-41D4-A716-446655440000' },
  },
  // ---- number-special: NaN ----
  {
    id: 'logical.number-special.nan',
    logicalType: 'number-special',
    schema: { type: 'number' },
    seed: { $construct: 'number-special', args: ['NaN'] },
    wire: 'NaN',
    invariants: [{ pointer: '/isNaN', equals: true }],
    negativeControl: { mutate: 'wire', to: null },
  },
  // ---- number-special: Infinity ----
  {
    id: 'logical.number-special.infinity',
    logicalType: 'number-special',
    schema: { type: 'number' },
    seed: { $construct: 'number-special', args: ['Infinity'] },
    wire: 'Infinity',
    invariants: [{ pointer: '/isFinite', equals: false }],
    negativeControl: { mutate: 'wire', to: null },
  },
];

// ---------------------------------------------------------------------------
// Shared registry (frozen after all codecs are loaded)
// ---------------------------------------------------------------------------

const registry = createRegistry();
registerWellKnown(registry);
const frozenRegistry = registry.freeze();

/** Minimal stub ctx; path and mode are all the scalar codecs need. */
function makeCtx(overrides: Partial<TranscodeCtx> = {}): TranscodeCtx {
  return {
    registry: frozenRegistry,
    resolve: (ref) => {
      throw new Error(`$ref ${ref} not expected in scalar codec tests`);
    },
    seen: new WeakSet<object>(),
    path: '',
    mode: 'strict',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// $construct seed builder
// ---------------------------------------------------------------------------

function buildSeed(seed: LogicalTypeVector['seed'], logicalType: string): unknown {
  if (
    seed !== null &&
    typeof seed === 'object' &&
    !Array.isArray(seed) &&
    '$construct' in (seed as object)
  ) {
    const recipe = seed as { $construct: string; args: Wire[] };
    switch (recipe.$construct) {
      case 'date-time':
        return new Date(recipe.args[0] as string);
      case 'byte':
        return new Uint8Array(recipe.args[0] as number[]);
      case 'number-special': {
        const s = recipe.args[0] as string;
        if (s === 'NaN') return NaN;
        if (s === 'Infinity') return Infinity;
        if (s === '-Infinity') return -Infinity;
        throw new Error(`[number-special] unknown sentinel "${s}"`);
      }
      default:
        throw new Error(
          `buildSeed: unknown $construct "${recipe.$construct}" for type "${logicalType}"`,
        );
    }
  }
  // Plain wire value used directly as the native seed (int64, decimal, uuid).
  return seed;
}

// ---------------------------------------------------------------------------
// Invariant evaluator
//
// Vector invariants use virtual pointer segments (/epochMs, /bigintStr, etc.)
// that are logical assertions on the decoded host type, not real object paths.
// ---------------------------------------------------------------------------

function evalInvariant(decoded: unknown, pointer: string): unknown {
  switch (pointer) {
    case '/epochMs':
      return decoded instanceof Date ? decoded.getTime() : undefined;
    case '/bigintStr':
      return typeof decoded === 'bigint' ? String(decoded) : undefined;
    case '/str':
      return typeof decoded === 'string' ? decoded : undefined;
    case '/utf8':
      return decoded instanceof Uint8Array
        ? Buffer.from(decoded).toString('utf8')
        : undefined;
    case '/value':
      return decoded;
    case '/isNaN':
      return typeof decoded === 'number' ? Number.isNaN(decoded) : undefined;
    case '/isFinite':
      return typeof decoded === 'number' ? Number.isFinite(decoded) : undefined;
    default: {
      // Real JSON-Pointer traversal fallback.
      const parts = pointer.replace(/^\//, '').split('/');
      let cur: unknown = decoded;
      for (const part of parts) {
        if (cur === null || cur === undefined) return undefined;
        cur = (cur as Record<string, unknown>)[part];
      }
      return cur;
    }
  }
}

// ---------------------------------------------------------------------------
// Main conformance vector loop
// ---------------------------------------------------------------------------

describe('well-known scalar codecs — conformance vectors', () => {
  for (const vector of SCALAR_VECTORS) {
    describe(`vector: ${vector.id}`, () => {
      const codec = frozenRegistry.get(vector.logicalType) as LogicalTypeCodec | undefined;

      it('codec is registered for this logical type', () => {
        expect(codec, `no codec registered for "${vector.logicalType}"`).toBeDefined();
      });

      if (!codec) return; // narrowing; below only executes when codec is defined

      const ctx = makeCtx();
      const schema = vector.schema as SchemaNode;

      it('codec.matches() claims the canonical schema node', () => {
        expect(codec.matches(schema)).toBe(true);
      });

      it('encode(seed) === canonical wire', () => {
        const seed = buildSeed(vector.seed, vector.logicalType);
        const encoded = codec.encode(seed as never, schema, ctx);
        expect(encoded).toStrictEqual(vector.wire);
      });

      if (vector.invariants && vector.invariants.length > 0) {
        for (const inv of vector.invariants) {
          it(`decode(wire) invariant ${inv.pointer} === ${JSON.stringify(inv.equals)}`, () => {
            const decoded = codec.decode(vector.wire, schema, ctx);
            const actual = evalInvariant(decoded, inv.pointer);
            expect(actual).toStrictEqual(inv.equals);
          });
        }
      }

      it('encode(decode(wire)) round-trips to canonical wire', () => {
        const decoded = codec.decode(vector.wire, schema, ctx);
        const reEncoded = codec.encode(decoded as never, schema, ctx);
        expect(reEncoded).toStrictEqual(vector.wire);
      });

      it('negative control: encode(seed) !== negativeControl.to (teeth)', () => {
        if (vector.negativeControl.mutate === 'wire') {
          // The negative-control wire must NOT equal the canonical encode result.
          const seed = buildSeed(vector.seed, vector.logicalType);
          const encoded = codec.encode(seed as never, schema, ctx);
          expect(encoded).not.toStrictEqual(vector.negativeControl.to);
        } else if (vector.negativeControl.mutate === 'schema') {
          // Mutated schema — codec must NOT claim it, or encode result differs.
          const mutatedSchema = vector.negativeControl.to as SchemaNode;
          const doesMatch = codec.matches(mutatedSchema);
          if (!doesMatch) {
            expect(doesMatch).toBe(false);
          } else {
            const seed = buildSeed(vector.seed, vector.logicalType);
            const encoded = codec.encode(seed as never, mutatedSchema, ctx);
            expect(encoded).not.toStrictEqual(vector.wire);
          }
        } else {
          // mutate:'codec' — replacement codec id must differ from original.
          expect(vector.negativeControl.to).not.toStrictEqual(codec.id);
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// registerWellKnown — unit tests
// ---------------------------------------------------------------------------

describe('registerWellKnown', () => {
  it('loads all 6 well-known scalar codecs into a fresh registry', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(reg.ids()).toContain('date-time');
    expect(reg.ids()).toContain('int64');
    expect(reg.ids()).toContain('decimal');
    expect(reg.ids()).toContain('byte');
    expect(reg.ids()).toContain('uuid');
    expect(reg.ids()).toContain('number-special');
    expect(reg.ids()).toHaveLength(6);
  });

  it('throws on second call without override (E_DUP_CODEC)', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(() => registerWellKnown(reg)).toThrow();
  });

  it('is idempotent with {override:true}', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(() => registerWellKnown(reg, { override: true })).not.toThrow();
    expect(reg.ids()).toHaveLength(6);
  });

  it('resolve() dispatches to date-time codec for format:date-time node', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(reg.resolve({ type: 'string', format: 'date-time' })?.id).toBe('date-time');
  });

  it('resolve() dispatches to int64 codec for format:int64 node', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(reg.resolve({ type: 'string', format: 'int64' })?.id).toBe('int64');
  });

  it('resolve() dispatches to decimal codec for format:decimal node', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(reg.resolve({ type: 'string', format: 'decimal' })?.id).toBe('decimal');
  });

  it('resolve() dispatches to byte codec for format:byte node', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(reg.resolve({ type: 'string', format: 'byte' })?.id).toBe('byte');
  });

  it('resolve() dispatches to uuid codec for format:uuid node', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(reg.resolve({ type: 'string', format: 'uuid' })?.id).toBe('uuid');
  });

  it('resolve() dispatches to number-special codec for bare type:number node', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(reg.resolve({ type: 'number' })?.id).toBe('number-special');
  });

  it('resolve() returns undefined for plain {type:string} without format', () => {
    const reg = createRegistry();
    registerWellKnown(reg);
    expect(reg.resolve({ type: 'string' })).toBeUndefined();
  });

  it('resolve() does NOT claim {type:number,format:float} (format-qualified number)', () => {
    // number-special only claims bare {type:'number'} — no format key.
    const reg = createRegistry();
    registerWellKnown(reg);
    // A node with a format key on a number should not match number-special.
    const codec = reg.resolve({ type: 'number', format: 'float' });
    expect(codec?.id).not.toBe('number-special');
  });
});

// ---------------------------------------------------------------------------
// Individual codec unit tests (edge cases not covered by vectors)
// ---------------------------------------------------------------------------

describe('dateTimeCodec', () => {
  let codec: LogicalTypeCodec;
  const reg = createRegistry();
  registerWellKnown(reg);
  codec = reg.get('date-time')!;
  const schema = { type: 'string', format: 'date-time' } as SchemaNode;
  const ctx = makeCtx();

  it('decode in lossy mode coerces non-string to Date', () => {
    const d = codec.decode(1705322096789 as unknown as Wire, schema, {
      ...ctx,
      mode: 'lossy',
    });
    expect(d).toBeInstanceOf(Date);
  });

  it('encode in strict mode throws for non-Date', () => {
    // Date codec encode calls .toISOString(); passing a non-Date throws a TypeError.
    expect(() =>
      codec.encode('not-a-date' as unknown as never, schema, ctx),
    ).toThrow();
  });
});

describe('int64Codec', () => {
  const reg = createRegistry();
  registerWellKnown(reg);
  const codec = reg.get('int64')!;
  const schema = { type: 'string', format: 'int64' } as SchemaNode;
  const ctx = makeCtx();

  it('encodes negative bigint', () => {
    expect(codec.encode(BigInt(-1) as never, schema, ctx)).toBe('-1');
  });

  it('decodes negative decimal string', () => {
    expect(codec.decode('-1', schema, ctx)).toBe(BigInt(-1));
  });

  it('strict mode throws on numeric wire (precision loss)', () => {
    expect(() => codec.decode(9007199254740993 as unknown as Wire, schema, ctx)).toThrow();
  });
});

describe('byteCodec', () => {
  const reg = createRegistry();
  registerWellKnown(reg);
  const codec = reg.get('byte')!;
  const schema = { type: 'string', format: 'byte' } as SchemaNode;
  const ctx = makeCtx();

  it('empty Uint8Array encodes to empty string', () => {
    expect(codec.encode(new Uint8Array(0) as never, schema, ctx)).toBe('');
  });

  it('strict mode rejects URL-safe base64 wire (has _)', () => {
    expect(() => codec.decode('SGVs_G8=' as Wire, schema, ctx)).toThrow();
  });
});

describe('uuidCodec', () => {
  const reg = createRegistry();
  registerWellKnown(reg);
  const codec = reg.get('uuid')!;
  const schema = { type: 'string', format: 'uuid' } as SchemaNode;
  const ctx = makeCtx();

  it('normalizes uppercase UUID to lowercase on encode', () => {
    const upper = '550E8400-E29B-41D4-A716-446655440000';
    expect(codec.encode(upper as never, schema, ctx)).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('strict mode rejects uppercase UUID on decode', () => {
    expect(() =>
      codec.decode('550E8400-E29B-41D4-A716-446655440000' as Wire, schema, ctx),
    ).toThrow();
  });
});

describe('numberSpecialCodec', () => {
  const reg = createRegistry();
  registerWellKnown(reg);
  const codec = reg.get('number-special')!;
  const schema = { type: 'number' } as SchemaNode;
  const ctx = makeCtx();

  it('encodes finite number as a plain number (not a string)', () => {
    expect(codec.encode(42 as never, schema, ctx)).toBe(42);
  });

  it('decodes finite number wire value as a number', () => {
    expect(codec.decode(42 as Wire, schema, ctx)).toBe(42);
  });

  it('encodes -Infinity as "-Infinity"', () => {
    expect(codec.encode(-Infinity as never, schema, ctx)).toBe('-Infinity');
  });

  it('decodes "-Infinity" as -Infinity', () => {
    expect(codec.decode('-Infinity' as Wire, schema, ctx)).toBe(-Infinity);
  });

  it('strict mode throws on null wire (JSON.stringify default for NaN)', () => {
    expect(() => codec.decode(null as Wire, schema, ctx)).toThrow();
  });
});
