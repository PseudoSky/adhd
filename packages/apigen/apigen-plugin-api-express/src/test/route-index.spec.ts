/**
 * `buildOperationIndex` / `operationKey` — the O(1) replacement for
 * `generate()`'s per-fn linear `operationFor` scan.
 *
 * The index MUST resolve to the exact same `Operation` the linear scan would
 * (first-match-wins), so emitted routes stay byte-identical.
 */
import { describe, it, expect } from 'vitest';
import type { Operation, Segment } from '@adhd/apigen-core-client';
import { buildOperationIndex, operationFor, operationKey } from '../lib/route';

/** Minimal Segment (only `.raw` is read by the resolver). */
function seg(raw: string): Segment {
  return { raw, words: [raw] };
}

/** Minimal Operation — only namespace + path are consumed by route resolution. */
function op(id: string, namespace: string, path: string[]): Operation {
  return {
    id,
    host: 'ts',
    namespace: seg(namespace),
    path: path.map(seg),
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
}

const schema: Record<string, unknown> = {};

describe('buildOperationIndex', () => {
  it('[express.index.1] resolves each descriptor to the SAME Operation as the linear operationFor scan', () => {
    const ops = [
      op('utils/ping', 'utils', ['ping']),
      op('backlog/client-d/get-item', 'backlog', ['client-d', 'getItem']),
    ];
    const index = buildOperationIndex(ops);
    for (const o of ops) {
      const fn = o.path[o.path.length - 1].raw;
      expect(index.get(operationKey(o.namespace.raw, fn))).toBe(o);
      // Linear-scan parity — the whole point of the refactor.
      expect(operationFor(o.namespace.raw, fn, schema, ops)).toBe(o);
    }
  });

  it('[express.index.2] a multi-segment path resolves by its terminal fn name (route fidelity)', () => {
    const multi = op('backlog/client-d/get-item', 'backlog', [
      'client-d',
      'getItem',
    ]);
    const index = buildOperationIndex([multi]);
    expect(index.get(operationKey('backlog', 'getItem'))).toBe(multi);
  });

  it('[express.index.3] first-match-wins — a later duplicate identity never overwrites', () => {
    const first = op('pkg/a', 'pkg', ['a']);
    const second = op('pkg/a-copy', 'pkg', ['a']);
    const index = buildOperationIndex([first, second]);
    expect(index.get(operationKey('pkg', 'a'))).toBe(first);
    expect(operationFor('pkg', 'a', schema, [first, second])).toBe(first);
  });

  it('[express.index.4] an op with no path segment is skipped (never matches, like operationFor)', () => {
    const emptyPath = op('pkg/empty', 'pkg', []);
    expect(buildOperationIndex([emptyPath]).size).toBe(0);
  });

  it('[express.index.5] undefined operations → empty index (the no-operations fallback path)', () => {
    expect(buildOperationIndex(undefined).size).toBe(0);
  });

  it('[express.index.6] operationKey cannot be forged by a separator-bearing id', () => {
    // A NUL separates the two halves, so `:`/`/` in either half cannot make two
    // different identities collide the way a `:`/`/`-joined key would.
    expect(operationKey('a:b', 'c')).not.toBe(operationKey('a', 'b:c'));
    expect(operationKey('a/b', 'c')).not.toBe(operationKey('a', 'b/c'));
  });
});
