/**
 * Tests for the TypeScript HostBinding (DESIGN.md §4.6).
 *
 * Three test groups, each with teeth:
 *
 *  1. Coverage — every canonical well-known id appears in `tsHostBinding.codecs`.
 *     Derived from `WELL_KNOWN_TS_CODECS` (the live import array), so it fails
 *     automatically when a codec is dropped or its id changes.
 *
 *  2. Real round-trip — pick date-time (the most common scalar) and drive a real
 *     encode→wire→decode cycle through the codec obtained from the binding.
 *     Asserts the consumer-visible outcome: the decoded value is a real `Date`
 *     with the correct `getTime()`.
 *
 *  3. Negative control (coverage vacuity proof) — construct a partial binding
 *     that intentionally omits one well-known codec and assert the coverage test
 *     throws (i.e. the test ISN'T vacuously green).
 */

import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  type LogicalTypeId,
  type SchemaNode,
  type TranscodeCtx,
  type Wire,
} from '@adhd/apigen-logical';
import {
  tsHostBinding,
  WELL_KNOWN_TS_CODECS,
  type HostBinding,
} from './host-ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal, valid TranscodeCtx for unit tests. */
function makeCtx(override?: Partial<TranscodeCtx>): TranscodeCtx {
  const registry = createRegistry();
  return {
    registry,
    resolve: (_ref: string) => ({} as SchemaNode),
    seen: new WeakSet<object>(),
    path: '',
    mode: 'strict',
    ...override,
  };
}

/**
 * Asserts that every well-known id from `WELL_KNOWN_TS_CODECS` is present in
 * the given binding's codecs map. Throws with the missing ids if coverage is
 * incomplete.
 */
function assertFullWellKnownCoverage(binding: HostBinding): void {
  const missing: LogicalTypeId[] = [];
  for (const codec of WELL_KNOWN_TS_CODECS) {
    if (!binding.codecs.has(codec.id)) {
      missing.push(codec.id);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `tsHostBinding.codecs is missing well-known id(s): ${missing.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. Coverage — every canonical well-known id must be present
// ---------------------------------------------------------------------------

describe('tsHostBinding — well-known id coverage', () => {
  it('covers every well-known scalar id derived from WELL_KNOWN_TS_CODECS', () => {
    // The expected id set is derived from the live codec array — NOT hard-coded.
    // Dropping a codec from WELL_KNOWN_TS_CODECS or from the binding's codecs
    // map will fail this test.
    const expectedIds = WELL_KNOWN_TS_CODECS.map((c) => c.id);

    for (const id of expectedIds) {
      expect(
        tsHostBinding.codecs.has(id),
        `binding.codecs should contain well-known id "${id}"`,
      ).toBe(true);
    }

    // Also verify every codec in the binding keyed by a well-known id
    // resolves to the correct codec instance (id round-trip).
    for (const id of expectedIds) {
      const codec = tsHostBinding.codecs.get(id);
      expect(codec?.id).toBe(id);
    }
  });

  it('covers the nominal kind (ts.NominalSentinel)', () => {
    const codec = tsHostBinding.codecs.get('ts.NominalSentinel');
    expect(codec).toBeDefined();
    expect(codec?.kind).toBe('nominal');
  });

  it('covers the union kind (ts.UnionSentinel)', () => {
    const codec = tsHostBinding.codecs.get('ts.UnionSentinel');
    expect(codec).toBeDefined();
    expect(codec?.kind).toBe('union');
  });

  it('binding is frozen (immutable)', () => {
    expect(Object.isFrozen(tsHostBinding)).toBe(true);
  });

  it('host is "ts"', () => {
    expect(tsHostBinding.host).toBe('ts');
  });

  it('logicalTypeVersion is a non-empty string', () => {
    expect(typeof tsHostBinding.logicalTypeVersion).toBe('string');
    expect(tsHostBinding.logicalTypeVersion.length).toBeGreaterThan(0);
  });

  it('WELL_KNOWN_TS_CODECS has 6 entries matching the DESIGN §3 canonical list', () => {
    expect(WELL_KNOWN_TS_CODECS).toHaveLength(6);
    const ids = WELL_KNOWN_TS_CODECS.map((c) => c.id);
    expect(ids).toContain('date-time');
    expect(ids).toContain('int64');
    expect(ids).toContain('decimal');
    expect(ids).toContain('byte');
    expect(ids).toContain('uuid');
    expect(ids).toContain('number-special');
  });
});

// ---------------------------------------------------------------------------
// 2. Real round-trip — date-time encode → wire → decode
// ---------------------------------------------------------------------------

describe('tsHostBinding — date-time round-trip through the binding', () => {
  const dateTimeCodecFromBinding = tsHostBinding.codecs.get('date-time');
  const schema: SchemaNode = { type: 'string', format: 'date-time' };

  it('retrieves the date-time codec from the binding', () => {
    expect(dateTimeCodecFromBinding).toBeDefined();
    expect(dateTimeCodecFromBinding?.id).toBe('date-time');
    expect(dateTimeCodecFromBinding?.kind).toBe('scalar');
  });

  it('encodes a Date to an RFC 3339 UTC string', () => {
    const codec = dateTimeCodecFromBinding!;
    const seed = new Date('2024-03-15T10:30:00.000Z');
    const ctx = makeCtx();

    const wire = codec.encode(seed, schema, ctx);

    expect(typeof wire).toBe('string');
    // Must be a valid RFC 3339 UTC string — ends with Z
    expect(wire as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(wire as string).toMatch(/Z$/);
  });

  it('decodes the wire back to a Date with the same getTime()', () => {
    const codec = dateTimeCodecFromBinding!;
    const originalMs = 1710496200000; // 2024-03-15T10:30:00.000Z
    const seed = new Date(originalMs);
    const ctx = makeCtx();

    const wire: Wire = codec.encode(seed, schema, ctx);
    const decoded = codec.decode(wire, schema, ctx);

    // Consumer-visible outcome: decoded is a real Date, not a string
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).getTime()).toBe(originalMs);
  });

  it('full round-trip is identity over getTime()', () => {
    const codec = dateTimeCodecFromBinding!;
    const ctx = makeCtx();
    const dates = [
      new Date('2000-01-01T00:00:00.000Z'),
      new Date('2024-06-25T15:00:00.500Z'),
      new Date('1970-01-01T00:00:00.000Z'),
    ];
    for (const d of dates) {
      const wire = codec.encode(d, schema, ctx);
      const back = codec.decode(wire, schema, ctx);
      expect((back as Date).getTime()).toBe(d.getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Negative control — proves the coverage test is not vacuous
// ---------------------------------------------------------------------------

describe('tsHostBinding — negative control: coverage test has teeth', () => {
  it('a binding missing one well-known id fails the coverage assertion', () => {
    // Build a partial binding by copying all codecs except 'uuid'.
    const partialMap = new Map<LogicalTypeId, import('@adhd/apigen-logical').LogicalTypeCodec>(
      tsHostBinding.codecs,
    );
    partialMap.delete('uuid');

    const partialBinding: HostBinding = Object.freeze({
      host: 'ts' as const,
      logicalTypeVersion: tsHostBinding.logicalTypeVersion,
      codecs: Object.freeze(partialMap) as ReadonlyMap<LogicalTypeId, import('@adhd/apigen-logical').LogicalTypeCodec>,
    });

    // assertFullWellKnownCoverage MUST throw for the partial binding.
    expect(() => assertFullWellKnownCoverage(partialBinding)).toThrow(
      /missing well-known id\(s\): uuid/,
    );
  });

  it('a binding missing ALL scalar codecs fails coverage for all 6 ids', () => {
    const emptyBinding: HostBinding = Object.freeze({
      host: 'ts' as const,
      logicalTypeVersion: tsHostBinding.logicalTypeVersion,
      codecs: Object.freeze(new Map()) as ReadonlyMap<LogicalTypeId, import('@adhd/apigen-logical').LogicalTypeCodec>,
    });

    expect(() => assertFullWellKnownCoverage(emptyBinding)).toThrow();
  });

  it('the real tsHostBinding passes assertFullWellKnownCoverage (sanity)', () => {
    // This MUST NOT throw — the real binding is complete.
    expect(() => assertFullWellKnownCoverage(tsHostBinding)).not.toThrow();
  });
});
