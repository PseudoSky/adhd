import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  dateTimeCodec,
  type LogicalTypeRegistry,
  type SchemaNode,
  type TranscodeCtx,
  type Wire,
} from '@adhd/apigen-logical';
import { createNominalCodec, NominalCodecError, X_APIGEN_INSTANCES } from './nominal-codec';

// ---------------------------------------------------------------------------
// Fixtures: a real `User` host class with a nested Date field, a `fromJSON`
// reconstructor (the x-apigen-ctor hint), and a `toJSON` field bag.
// ---------------------------------------------------------------------------

class User {
  constructor(
    readonly id: string,
    readonly joinedAt: Date,
  ) {}

  static fromJSON(bag: { id: string; joinedAt: Date }): User {
    return new User(bag.id, bag.joinedAt);
  }

  toJSON(): { id: string; joinedAt: Date } {
    return { id: this.id, joinedAt: this.joinedAt };
  }
}

const USER_NODE: SchemaNode = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    joinedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'joinedAt'],
  'x-apigen-logical': 'nominal',
  'x-apigen-codec': 'cli.User',
  'x-apigen-ctor': 'fromJSON',
  'x-apigen-tojson': 'toJSON',
};

/** Build a registry pre-loaded with the date-time scalar codec + a nominal codec. */
function buildRegistry(node: SchemaNode, ctor?: typeof User): LogicalTypeRegistry {
  const registry = createRegistry();
  registry.register(dateTimeCodec);
  registry.register(createNominalCodec({ id: 'cli.User', schema: node, ctor }));
  return registry;
}

function ctxFor(registry: LogicalTypeRegistry, mode: 'strict' | 'lossy' = 'strict'): TranscodeCtx {
  return {
    registry,
    resolve: (ref) => {
      throw new Error(`unexpected $ref ${ref}`);
    },
    seen: new WeakSet<object>(),
    path: '',
    mode,
  };
}

describe('createNominalCodec', () => {
  it('matches a node by x-apigen-logical or x-apigen-codec', () => {
    const codec = createNominalCodec({ id: 'cli.User', schema: USER_NODE });
    expect(codec.matches(USER_NODE)).toBe(true);
    expect(codec.matches({ 'x-apigen-codec': 'cli.User' } as SchemaNode)).toBe(true);
    expect(codec.matches({ type: 'object' } as SchemaNode)).toBe(false);
  });

  it('round-trips a User encode→decode to a real instance with nested Date recursion', () => {
    const registry = buildRegistry(USER_NODE, User);
    const codec = registry.get('cli.User');
    expect(codec).toBeDefined();

    const joined = new Date('2024-01-02T03:04:05.678Z');
    const user = new User('u-1', joined);

    const wire = codec!.encode(user, USER_NODE, ctxFor(registry)) as Record<string, Wire>;
    // Nested Date recursed through the date-time codec → RFC3339 string on the wire.
    expect(wire).toEqual({ id: 'u-1', joinedAt: '2024-01-02T03:04:05.678Z' });

    const back = codec!.decode(wire, USER_NODE, ctxFor(registry));
    expect(back).toBeInstanceOf(User);
    const decoded = back as User;
    expect(decoded.id).toBe('u-1');
    // Nested Date round-trips back to a real Date instance.
    expect(decoded.joinedAt).toBeInstanceOf(Date);
    expect(decoded.joinedAt.toISOString()).toBe(joined.toISOString());
  });

  it('throws E_NOMINAL_CYCLE in strict mode on a cyclic object graph', () => {
    // A self-referential node schema so the codec recurses into itself.
    const NODE_NODE: SchemaNode = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        next: {
          type: 'object',
          properties: { name: { type: 'string' } },
          'x-apigen-logical': 'nominal',
          'x-apigen-codec': 'cli.Node',
        },
      },
      'x-apigen-logical': 'nominal',
      'x-apigen-codec': 'cli.Node',
    };
    const registry = createRegistry();
    registry.register(createNominalCodec({ id: 'cli.Node', schema: NODE_NODE }));
    const codec = registry.get('cli.Node')!;

    const a: Record<string, unknown> = { name: 'a' };
    a['next'] = a; // back-edge

    expect(() => codec.encode(a, NODE_NODE, ctxFor(registry, 'strict'))).toThrow(NominalCodecError);
    try {
      codec.encode(a, NODE_NODE, ctxFor(registry, 'strict'));
    } catch (err) {
      expect((err as NominalCodecError).code).toBe('E_NOMINAL_CYCLE');
    }
  });

  it('[inv:hints-advisory]: strips x-apigen-ctor/tojson and still round-trips via schema projection', () => {
    // Node with ALL x-apigen-* hints stripped except the structural codec marker
    // needed for matches(). Decode falls back to the constructor-fed bag.
    const stripped: SchemaNode = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        joinedAt: { type: 'string', format: 'date-time' },
      },
      required: ['id', 'joinedAt'],
      'x-apigen-codec': 'cli.User',
    };
    const registry = buildRegistry(stripped, User);
    const codec = registry.get('cli.User')!;

    const joined = new Date('2024-06-23T00:00:00.000Z');
    const user = new User('u-2', joined);

    const wire = codec.encode(user, stripped, ctxFor(registry)) as Record<string, Wire>;
    expect(wire).toEqual({ id: 'u-2', joinedAt: '2024-06-23T00:00:00.000Z' });

    // Without x-apigen-ctor, the codec falls to `new User(bag)` — User's ctor is
    // (id, joinedAt) so the schema-projected bag goes in. Prove the field bag is
    // faithful by decoding against NO host class (plain-object projection).
    const plainRegistry = createRegistry();
    plainRegistry.register(dateTimeCodec);
    plainRegistry.register(createNominalCodec({ id: 'cli.User', schema: stripped }));
    const plainCodec = plainRegistry.get('cli.User')!;
    const bag = plainCodec.decode(wire, stripped, ctxFor(plainRegistry)) as Record<string, unknown>;
    expect(bag['id']).toBe('u-2');
    expect(bag['joinedAt']).toBeInstanceOf(Date);
    expect((bag['joinedAt'] as Date).toISOString()).toBe(joined.toISOString());

    // And the wire is byte-identical to the fully-hinted node (hints are advisory).
    const hintedRegistry = buildRegistry(USER_NODE, User);
    const hintedWire = hintedRegistry
      .get('cli.User')!
      .encode(user, USER_NODE, ctxFor(hintedRegistry));
    expect(wire).toEqual(hintedWire);
  });

  it('uses toJSON when present and field-projects when absent (same wire)', () => {
    const registry = buildRegistry(USER_NODE, User);
    const codec = registry.get('cli.User')!;
    const joined = new Date('2024-01-02T03:04:05.678Z');
    const user = new User('u-3', joined);

    // With toJSON hint
    const viaToJSON = codec.encode(user, USER_NODE, ctxFor(registry));

    // Strip the tojson hint → field projection path
    const noToJSONNode: SchemaNode = { ...USER_NODE, 'x-apigen-tojson': '__absent__' };
    const viaProjection = codec.encode(user, noToJSONNode, ctxFor(registry));

    expect(viaToJSON).toEqual(viaProjection);
  });

  it('gates non-reconstructable classes: decode throws E_NOMINAL_NONRECONSTRUCTABLE', () => {
    const node: SchemaNode = {
      type: 'object',
      properties: { id: { type: 'string' } },
      'x-apigen-codec': 'cli.Socket',
      [X_APIGEN_INSTANCES]: false,
    };
    const registry = createRegistry();
    registry.register(createNominalCodec({ id: 'cli.Socket', schema: node }));
    const codec = registry.get('cli.Socket')!;

    // Encode still works (encode-only).
    const wire = codec.encode({ id: 's-1' }, node, ctxFor(registry));
    expect(wire).toEqual({ id: 's-1' });

    // Decode is rejected with the stable code.
    try {
      codec.decode(wire, node, ctxFor(registry));
      throw new Error('expected decode to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NominalCodecError);
      expect((err as NominalCodecError).code).toBe('E_NOMINAL_NONRECONSTRUCTABLE');
    }
  });

  it('validate-then-construct: rejects a non-object wire and missing required fields', () => {
    const registry = buildRegistry(USER_NODE, User);
    const codec = registry.get('cli.User')!;

    expect(() => codec.decode('not-an-object' as Wire, USER_NODE, ctxFor(registry))).toThrow(
      NominalCodecError,
    );
    expect(() => codec.decode({ id: 'u-1' } as Wire, USER_NODE, ctxFor(registry))).toThrow(
      /required field "joinedAt"/,
    );
  });
});
