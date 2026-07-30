// batch.spec.ts — lib/batch.ts unit tests (F1/F2, BATCH_0.0.1.md).
//
// Coverage:
//   [F2] syntheticOp builds the shared ~10-field Operation boilerplate,
//        stripping the leading underscore only from the namespace segment.
//   [F1] groupBatchableOperationsByKind groups by kind and honors `exclude`.
//   [F1] buildBatchKindSchema: 1-op kind → no oneOf; ≥2-op kind → real
//        InlineDiscriminator oneOf (morph-walk mechanism, NOT union.ts).
//   [F1] buildBatchMountedOperations: one `_batch/<kind>` mount per distinct
//        kind, truthful per-mount kind/safe (not one hardcoded action/unsafe
//        mount for everything), zero mounts for zero batchable operations.

import { describe, it, expect } from 'vitest';
import { syntheticOp } from '../lib/plugin';
import type { Descriptor } from '../lib/plugin';
import type { Operation } from '../lib/descriptor';
import {
  deriveBatchOperationBranch,
  groupBatchableOperationsByKind,
  buildBatchKindSchema,
  buildBatchMountedOperations,
} from '../lib/batch';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seg(raw: string) {
  return { raw, words: [raw.toLowerCase()] };
}

function op(id: string, kind: Operation['kind'] = 'action'): Operation {
  const [namespace, ...path] = id.split('/');
  return {
    id,
    host: 'ts',
    namespace: seg(namespace),
    path: path.map(seg),
    kind,
    async: true,
    streaming: false,
    safe: kind === 'query',
    input: { type: 'object', properties: { x: { type: 'string' } } },
    output: { type: 'string' },
    envelope: {},
    typeText: null,
  };
}

function descriptorOf(operations: Operation[]): Descriptor {
  return { host: 'ts', operations };
}

// ---------------------------------------------------------------------------
// F2 — syntheticOp
// ---------------------------------------------------------------------------

describe('syntheticOp (F2)', () => {
  const d: Descriptor = { host: 'ts', operations: [] };

  it('builds id, host, namespace, path from "<ns>/<path>"', () => {
    const result = syntheticOp('_meta/health', d);
    expect(result.id).toBe('_meta/health');
    expect(result.host).toBe('ts');
    expect(result.namespace.raw).toBe('meta'); // leading `_` stripped
    expect(result.path).toEqual([{ raw: 'health', words: ['health'] }]);
  });

  it('supports multi-segment paths', () => {
    const result = syntheticOp('_batch/query', d);
    expect(result.namespace.raw).toBe('batch');
    expect(result.path).toEqual([{ raw: 'query', words: ['query'] }]);
  });

  it('defaults kind to "action" and safe to false', () => {
    const result = syntheticOp('_meta/version', d);
    expect(result.kind).toBe('action');
    expect(result.safe).toBe(false);
  });

  it('defaults safe from kind when kind is "query"', () => {
    const result = syntheticOp('_meta/version', d, { kind: 'query' });
    expect(result.safe).toBe(true);
  });

  it('an explicit safe overrides the kind-derived default', () => {
    const result = syntheticOp('_meta/version', d, {
      kind: 'query',
      safe: false,
    });
    expect(result.safe).toBe(false);
  });

  it('defaults input/output/envelope to {} and typeText to null', () => {
    const result = syntheticOp('_meta/version', d);
    expect(result.input).toEqual({});
    expect(result.output).toEqual({});
    expect(result.envelope).toEqual({});
    expect(result.typeText).toBeNull();
  });

  it('passes through transports when supplied, omits the field otherwise', () => {
    const withTransports = syntheticOp('_meta/version', d, {
      transports: ['http', 'grpc'],
    });
    expect(withTransports.transports).toEqual(['http', 'grpc']);
    const withoutTransports = syntheticOp('_meta/version', d);
    expect(withoutTransports.transports).toBeUndefined();
  });

  it('throws on an id with fewer than two segments', () => {
    expect(() => syntheticOp('meta', d)).toThrow();
  });

  it('throws on an id with an empty segment', () => {
    expect(() => syntheticOp('_meta/', d)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// F1 — grouping
// ---------------------------------------------------------------------------

describe('groupBatchableOperationsByKind (F1)', () => {
  it('groups operations by kind', () => {
    const ops = [op('a/one', 'action'), op('a/two', 'query'), op('a/three', 'action')];
    const groups = groupBatchableOperationsByKind(ops);
    expect(groups.get('action')?.map((o) => o.id)).toEqual(['a/one', 'a/three']);
    expect(groups.get('query')?.map((o) => o.id)).toEqual(['a/two']);
  });

  it('excludes ids in opts.exclude', () => {
    const ops = [op('a/one', 'action'), op('a/two', 'action')];
    const groups = groupBatchableOperationsByKind(ops, { exclude: ['a/two'] });
    expect(groups.get('action')?.map((o) => o.id)).toEqual(['a/one']);
  });

  it('returns an empty map for an empty operation set', () => {
    expect(groupBatchableOperationsByKind([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F1 — per-kind schema (discriminator mechanism correctness)
// ---------------------------------------------------------------------------

describe('buildBatchKindSchema (F1)', () => {
  it('a single op of a kind produces NO oneOf wrapper (1-branch union is not a union)', () => {
    const { input, output, discriminator } = buildBatchKindSchema([op('a/one', 'action')]);
    expect(input['oneOf']).toBeUndefined();
    expect(discriminator).toBeUndefined();
    expect(input['type']).toBe('object');
    expect((input['properties'] as Record<string, unknown>)['operation']).toEqual({
      type: 'string',
      enum: ['a/one'],
    });
    expect(output).toEqual({ type: 'array', items: expect.any(Object) });
  });

  it('two+ ops of a kind produce a real oneOf + InlineDiscriminator (morph-walk mechanism)', () => {
    const ops = [op('a/one', 'action'), op('a/two', 'action')];
    const { input, discriminator } = buildBatchKindSchema(ops);
    expect(Array.isArray(input['oneOf'])).toBe(true);
    expect((input['oneOf'] as unknown[]).length).toBe(2);
    // InlineDiscriminator shape: propertyName + same-document JSON-Pointer mapping.
    expect(discriminator).toEqual({
      propertyName: 'operation',
      mapping: { 'a/one': '#/oneOf/0', 'a/two': '#/oneOf/1' },
    });
    // discriminator is embedded on the input schema itself too.
    expect(input['discriminator']).toEqual(discriminator);
  });

  it('branch object schemas are not closed (additionalProperties !== false) — additive-forward-compat', () => {
    const ops = [op('a/one', 'action'), op('a/two', 'action')];
    const { input } = buildBatchKindSchema(ops);
    for (const variant of input['oneOf'] as Record<string, unknown>[]) {
      expect(variant['additionalProperties']).not.toBe(false);
    }
  });

  it('throws for an empty operation list', () => {
    expect(() => buildBatchKindSchema([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// F1 — mount derivation
// ---------------------------------------------------------------------------

describe('buildBatchMountedOperations (F1)', () => {
  it('mounts one _batch/<kind> operation per distinct kind present', () => {
    const d = descriptorOf([
      op('a/one', 'action'),
      op('a/two', 'action'),
      op('a/three', 'query'),
    ]);
    const mounts = buildBatchMountedOperations(d);
    const ids = mounts.map((m) => m.id).sort();
    expect(ids).toEqual(['_batch/action', '_batch/query']);
  });

  it('each mount has a TRUTHFUL per-kind kind/safe — not a single hardcoded action/unsafe mount', () => {
    const d = descriptorOf([op('a/one', 'action'), op('a/two', 'query')]);
    const mounts = buildBatchMountedOperations(d);
    const byKind = Object.fromEntries(mounts.map((m) => [m.kind, m]));
    expect(byKind['action'].kind).toBe('action');
    expect(byKind['action'].safe).toBe(false);
    expect(byKind['query'].kind).toBe('query');
    expect(byKind['query'].safe).toBe(true);
  });

  it('restricts each mount\'s operation enum to ids of that kind only', () => {
    const d = descriptorOf([
      op('a/one', 'action'),
      op('a/two', 'query'),
    ]);
    const mounts = buildBatchMountedOperations(d);
    const actionMount = mounts.find((m) => m.kind === 'action');
    expect(actionMount?.operationIds).toEqual(['a/one']);
    const queryMount = mounts.find((m) => m.kind === 'query');
    expect(queryMount?.operationIds).toEqual(['a/two']);
  });

  it('refuses to mount anything for a descriptor with zero batchable operations', () => {
    const d = descriptorOf([]);
    expect(buildBatchMountedOperations(d)).toEqual([]);
  });

  it('honors opts.exclude — an excluded op never appears in any mount', () => {
    const d = descriptorOf([op('a/one', 'action'), op('a/two', 'action')]);
    const mounts = buildBatchMountedOperations(d, { exclude: ['a/two'] });
    const actionMount = mounts.find((m) => m.kind === 'action');
    expect(actionMount?.operationIds).toEqual(['a/one']);
  });

  it('negative — a mount is NOT declared safe:true when its kind is action (F1 teeth)', () => {
    // If per-kind classification regressed to a single hardcoded safe:false
    // for everything (or safe:true for everything), this must fail for the
    // opposing kind.
    const d = descriptorOf([op('a/one', 'action')]);
    const mounts = buildBatchMountedOperations(d);
    expect(mounts[0].safe).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §1.2 — deriveBatchOperationBranch
// ---------------------------------------------------------------------------

describe('deriveBatchOperationBranch (§1.2)', () => {
  it('carries the operation id, its real input schema, and a BatchItemResult<output> schema', () => {
    const o = op('a/one', 'action');
    const branch = deriveBatchOperationBranch(o);
    expect(branch.operationConst).toBe('a/one');
    expect(branch.itemsSchema).toBe(o.input);
    expect(Array.isArray(branch.resultSchema['oneOf'])).toBe(true);
  });
});
