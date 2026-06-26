import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  dateTimeCodec,
  type LogicalTypeRegistry,
  type SchemaNode,
  type TranscodeCtx,
  type Wire,
} from '@adhd/apigen-logical';
import { createNominalCodec } from './nominal-codec';
import { createUnionCodec, UnionCodecError } from './union-codec';

// ---------------------------------------------------------------------------
// Fixtures: Dog and Cat branch classes + schema nodes + a Pet union.
//
// The discriminator property is `kind`. Dog has `kind:"dog"` and Cat has
// `kind:"cat"`. Both carry a `name` field plus a type-specific extra field.
// ---------------------------------------------------------------------------

class Dog {
  readonly kind = 'dog' as const;
  constructor(
    readonly name: string,
    readonly breed: string,
  ) {}
  static fromJSON(bag: { kind: 'dog'; name: string; breed: string }): Dog {
    return new Dog(bag.name, bag.breed);
  }
  toJSON(): { kind: 'dog'; name: string; breed: string } {
    return { kind: this.kind, name: this.name, breed: this.breed };
  }
}

class Cat {
  readonly kind = 'cat' as const;
  constructor(
    readonly name: string,
    readonly indoor: boolean,
  ) {}
  static fromJSON(bag: { kind: 'cat'; name: string; indoor: boolean }): Cat {
    return new Cat(bag.name, bag.indoor);
  }
  toJSON(): { kind: 'cat'; name: string; indoor: boolean } {
    return { kind: this.kind, name: this.name, indoor: this.indoor };
  }
}

// Schema nodes for each branch ($defs equivalents, pre-resolved).
const DOG_NODE: SchemaNode = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'dog' },
    name: { type: 'string' },
    breed: { type: 'string' },
  },
  required: ['kind', 'name', 'breed'],
  'x-apigen-logical': 'nominal',
  'x-apigen-codec': 'cli.Dog',
  'x-apigen-ctor': 'fromJSON',
  'x-apigen-tojson': 'toJSON',
};

const CAT_NODE: SchemaNode = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'cat' },
    name: { type: 'string' },
    indoor: { type: 'boolean' },
  },
  required: ['kind', 'name', 'indoor'],
  'x-apigen-logical': 'nominal',
  'x-apigen-codec': 'cli.Cat',
  'x-apigen-ctor': 'fromJSON',
  'x-apigen-tojson': 'toJSON',
};

// The union schema node (oneOf + discriminator + advisory hint).
const PET_UNION_NODE: SchemaNode = {
  oneOf: [{ $ref: '#/$defs/Dog' }, { $ref: '#/$defs/Cat' }],
  discriminator: {
    propertyName: 'kind',
    mapping: {
      dog: '#/$defs/Dog',
      cat: '#/$defs/Cat',
    },
  },
  'x-apigen-logical': 'union',
};

// The same union node but with the advisory hint stripped — structure only.
const PET_UNION_NODE_NO_HINT: SchemaNode = {
  oneOf: [{ $ref: '#/$defs/Dog' }, { $ref: '#/$defs/Cat' }],
  discriminator: {
    propertyName: 'kind',
    mapping: {
      dog: '#/$defs/Dog',
      cat: '#/$defs/Cat',
    },
  },
  // x-apigen-logical intentionally omitted — structure is authoritative.
};

// ---------------------------------------------------------------------------
// Registry + context builders
// ---------------------------------------------------------------------------

/**
 * Build a registry with:
 *  - date-time scalar codec (well-known)
 *  - Dog nominal codec
 *  - Cat nominal codec
 *  - Pet union codec (under `id`)
 */
function buildRegistry(): LogicalTypeRegistry {
  const registry = createRegistry();
  registry.register(dateTimeCodec);
  registry.register(createNominalCodec({ id: 'cli.Dog', schema: DOG_NODE, ctor: Dog as never }));
  registry.register(createNominalCodec({ id: 'cli.Cat', schema: CAT_NODE, ctor: Cat as never }));
  registry.register(createUnionCodec({ id: 'cli.Pet', schema: PET_UNION_NODE }));
  return registry;
}

/**
 * Build a TranscodeCtx with a $ref resolver that maps the two branch refs to
 * their pre-resolved schema nodes. Tests that exercise real round-trips need
 * this resolver to pick the correct branch codec.
 */
function ctxFor(registry: LogicalTypeRegistry, mode: 'strict' | 'lossy' = 'strict'): TranscodeCtx {
  const refMap: Record<string, SchemaNode> = {
    '#/$defs/Dog': DOG_NODE,
    '#/$defs/Cat': CAT_NODE,
  };
  return {
    registry,
    resolve: (ref: string) => {
      const node = refMap[ref];
      if (!node) throw new Error(`unexpected $ref: ${ref}`);
      return node;
    },
    seen: new WeakSet<object>(),
    path: '',
    mode,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createUnionCodec', () => {
  // ── matches ────────────────────────────────────────────────────────────────

  it('matches a node with x-apigen-logical:"union" (advisory hint path)', () => {
    const codec = createUnionCodec({ id: 'cli.Pet', schema: PET_UNION_NODE });
    expect(codec.matches(PET_UNION_NODE)).toBe(true);
  });

  it('matches a node that has oneOf + discriminator but no x-apigen-logical hint', () => {
    const codec = createUnionCodec({ id: 'cli.Pet', schema: PET_UNION_NODE });
    expect(codec.matches(PET_UNION_NODE_NO_HINT)).toBe(true);
  });

  it('does NOT match a plain object node', () => {
    const codec = createUnionCodec({ id: 'cli.Pet', schema: PET_UNION_NODE });
    expect(codec.matches({ type: 'object', properties: {} } as SchemaNode)).toBe(false);
  });

  it('does NOT match a node with oneOf but no discriminator', () => {
    const codec = createUnionCodec({ id: 'cli.Pet', schema: PET_UNION_NODE });
    expect(
      codec.matches({ oneOf: [{ type: 'string' }] } as SchemaNode),
    ).toBe(false);
  });

  // ── Dog round-trip ─────────────────────────────────────────────────────────

  it('round-trips a Dog value: TS → wire → Dog instance (correct variant)', () => {
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;
    expect(codec).toBeDefined();

    const dog = new Dog('Rex', 'Labrador');
    const ctx = ctxFor(registry);

    // Encode: Dog host → wire object
    const wire = codec.encode(dog, PET_UNION_NODE, ctx) as Record<string, Wire>;
    expect(wire).toEqual({ kind: 'dog', name: 'Rex', breed: 'Labrador' });

    // Decode: wire → back to a Dog instance
    const back = codec.decode(wire, PET_UNION_NODE, ctxFor(registry));
    // Consumer-visible outcome: the correct *variant* is reconstructed.
    expect(back).toBeInstanceOf(Dog);
    const decoded = back as Dog;
    expect(decoded.kind).toBe('dog');
    expect(decoded.name).toBe('Rex');
    expect(decoded.breed).toBe('Labrador');
  });

  // ── Cat round-trip ─────────────────────────────────────────────────────────

  it('round-trips a Cat value: TS → wire → Cat instance (correct variant)', () => {
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;
    const cat = new Cat('Whiskers', true);
    const ctx = ctxFor(registry);

    const wire = codec.encode(cat, PET_UNION_NODE, ctx) as Record<string, Wire>;
    expect(wire).toEqual({ kind: 'cat', name: 'Whiskers', indoor: true });

    const back = codec.decode(wire, PET_UNION_NODE, ctxFor(registry));
    expect(back).toBeInstanceOf(Cat);
    const decoded = back as Cat;
    expect(decoded.kind).toBe('cat');
    expect(decoded.name).toBe('Whiskers');
    expect(decoded.indoor).toBe(true);
  });

  // ── Dog is a Dog, Cat is a Cat (cross-variant isolation) ───────────────────

  it('ensures Dog→wire→decode yields Dog (not Cat) and Cat→wire→decode yields Cat (not Dog)', () => {
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;
    const dog = new Dog('Buddy', 'Beagle');
    const cat = new Cat('Luna', false);
    const ctx = ctxFor(registry);

    const dogWire = codec.encode(dog, PET_UNION_NODE, ctx);
    const catWire = codec.encode(cat, PET_UNION_NODE, ctx);

    const decodedDog = codec.decode(dogWire, PET_UNION_NODE, ctxFor(registry));
    const decodedCat = codec.decode(catWire, PET_UNION_NODE, ctxFor(registry));

    expect(decodedDog).toBeInstanceOf(Dog);
    expect(decodedDog).not.toBeInstanceOf(Cat);
    expect(decodedCat).toBeInstanceOf(Cat);
    expect(decodedCat).not.toBeInstanceOf(Dog);
  });

  // ── Negative control (a): unknown tag → E_UNION_UNKNOWN_TAG ───────────────

  it('[neg-a] throws E_UNION_UNKNOWN_TAG when the wire has an unknown discriminator tag', () => {
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;
    const unknownWire = { kind: 'fish', name: 'Nemo' } as unknown as Wire;

    try {
      codec.decode(unknownWire, PET_UNION_NODE, ctxFor(registry));
      throw new Error('expected E_UNION_UNKNOWN_TAG to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnionCodecError);
      expect((err as UnionCodecError).code).toBe('E_UNION_UNKNOWN_TAG');
    }
  });

  it('[neg-a] throws E_UNION_UNKNOWN_TAG when encoding a value with an unknown discriminator tag', () => {
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;
    const unknownValue = { kind: 'fish', name: 'Nemo' } as unknown as object;

    try {
      codec.encode(unknownValue, PET_UNION_NODE, ctxFor(registry));
      throw new Error('expected E_UNION_UNKNOWN_TAG to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnionCodecError);
      expect((err as UnionCodecError).code).toBe('E_UNION_UNKNOWN_TAG');
    }
  });

  // ── Negative control (b): missing discriminator property → E_UNION_NO_DISCRIMINATOR ──

  it('[neg-b] throws E_UNION_NO_DISCRIMINATOR when the value is missing the discriminator property', () => {
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;
    const noTag = { name: 'Rex', breed: 'Labrador' } as unknown as object;

    try {
      codec.encode(noTag, PET_UNION_NODE, ctxFor(registry));
      throw new Error('expected E_UNION_NO_DISCRIMINATOR to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnionCodecError);
      expect((err as UnionCodecError).code).toBe('E_UNION_NO_DISCRIMINATOR');
    }
  });

  it('[neg-b] throws E_UNION_NO_DISCRIMINATOR when the wire object is missing the discriminator property', () => {
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;
    const noTagWire = { name: 'Rex', breed: 'Labrador' } as unknown as Wire;

    try {
      codec.decode(noTagWire, PET_UNION_NODE, ctxFor(registry));
      throw new Error('expected E_UNION_NO_DISCRIMINATOR to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnionCodecError);
      expect((err as UnionCodecError).code).toBe('E_UNION_NO_DISCRIMINATOR');
    }
  });

  // ── Negative control (c): hints-advisory invariant ────────────────────────

  it('[neg-c] hints-advisory: decoding with x-apigen-logical stripped yields identical result', () => {
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;

    const dog = new Dog('Scout', 'Golden Retriever');
    const ctx = ctxFor(registry);

    // Encode against the node WITH the hint
    const wireWithHint = codec.encode(dog, PET_UNION_NODE, ctx) as Record<string, Wire>;
    // Encode against the node WITHOUT the hint (structure only)
    const wireWithoutHint = codec.encode(dog, PET_UNION_NODE_NO_HINT, ctxFor(registry)) as Record<string, Wire>;

    // Wire must be byte-equal regardless of hint
    expect(wireWithoutHint).toEqual(wireWithHint);

    // Decode with hint
    const decodedWithHint = codec.decode(wireWithHint, PET_UNION_NODE, ctxFor(registry));
    // Decode without hint (structure-only node)
    const decodedWithoutHint = codec.decode(wireWithoutHint, PET_UNION_NODE_NO_HINT, ctxFor(registry));

    // Both must reconstruct the correct variant (Dog) with identical field values
    expect(decodedWithHint).toBeInstanceOf(Dog);
    expect(decodedWithoutHint).toBeInstanceOf(Dog);
    expect((decodedWithHint as Dog).name).toBe('Scout');
    expect((decodedWithoutHint as Dog).name).toBe('Scout');
    expect((decodedWithHint as Dog).breed).toBe('Golden Retriever');
    expect((decodedWithoutHint as Dog).breed).toBe('Golden Retriever');
  });

  // ── Invalid wire (non-object) → E_UNION_INVALID_WIRE ─────────────────────

  it('throws E_UNION_INVALID_WIRE when the wire is not an object', () => {
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;

    expect(() =>
      codec.decode('not-an-object' as Wire, PET_UNION_NODE, ctxFor(registry)),
    ).toThrow(UnionCodecError);

    expect(() =>
      codec.decode(null as Wire, PET_UNION_NODE, ctxFor(registry)),
    ).toThrow(UnionCodecError);

    expect(() =>
      codec.decode([{ kind: 'dog' }] as Wire, PET_UNION_NODE, ctxFor(registry)),
    ).toThrow(UnionCodecError);

    try {
      codec.decode(42 as Wire, PET_UNION_NODE, ctxFor(registry));
      throw new Error('expected E_UNION_INVALID_WIRE');
    } catch (err) {
      expect(err).toBeInstanceOf(UnionCodecError);
      expect((err as UnionCodecError).code).toBe('E_UNION_INVALID_WIRE');
    }
  });

  // ── Prove a negative control actually fails when the codec is broken ──────
  // This test verifies that removing the discriminator mapping from the schema
  // causes E_UNION_UNKNOWN_TAG (the codec breaks, the test goes red).
  // When the codec is correct, the broken-schema path throws; when it is
  // bypassed, the assertion below catches the missing throw.

  it('[teeth] a schema with an empty mapping always throws E_UNION_UNKNOWN_TAG (proves the test has teeth)', () => {
    const brokenUnionNode: SchemaNode = {
      oneOf: [{ $ref: '#/$defs/Dog' }],
      discriminator: {
        propertyName: 'kind',
        mapping: {}, // empty — no tags known
      },
      'x-apigen-logical': 'union',
    };
    const registry = buildRegistry();
    const codec = registry.get('cli.Pet')!;
    const dog = new Dog('Max', 'Poodle');

    try {
      codec.encode(dog, brokenUnionNode, ctxFor(registry));
      throw new Error('expected E_UNION_UNKNOWN_TAG — if this fires, the codec is broken');
    } catch (err) {
      expect(err).toBeInstanceOf(UnionCodecError);
      expect((err as UnionCodecError).code).toBe('E_UNION_UNKNOWN_TAG');
    }
  });
});
