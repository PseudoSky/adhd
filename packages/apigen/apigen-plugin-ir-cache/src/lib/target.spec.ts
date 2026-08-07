// target.spec.ts — ARTIFACT mode behavioral proof (FEAT-002 Revision 2, R2.4).

import { describe, expect, it } from 'vitest';
import type { Descriptor, Operation } from '@adhd/apigen-core-client';
import { buildIrCacheArtifact } from './target';
import { CURRENT_FORMAT_VERSION, type CachedExtractEntry } from './ir-cache-layer';

function makeOp(id: string): Operation {
  return {
    id,
    host: 'ts',
    namespace: { raw: 'svc', words: ['svc'] },
    path: [{ raw: 'doThing', words: ['do', 'thing'] }],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input: { type: 'object', properties: {}, required: [] },
    output: { type: 'object' },
    envelope: {},
    typeText: null,
  };
}

const FIXTURE_DESCRIPTOR: Descriptor = {
  operations: [makeOp('svc/doThing')],
  host: 'ts',
};

describe('buildIrCacheArtifact — ARTIFACT mode (--type ir-cache --opt cache=artifact)', () => {
  it('throws when cache !== "artifact" (that value selects the RUNTIME CACHE layer instead)', () => {
    expect(() =>
      buildIrCacheArtifact(FIXTURE_DESCRIPTOR, { cache: '/tmp/some-file.json' })
    ).toThrow(/cache=artifact/);
  });

  it('emits exactly one File whose JSON content round-trips through CachedExtractEntry with no staleness field', () => {
    const files = buildIrCacheArtifact(FIXTURE_DESCRIPTOR, {
      cache: 'artifact',
      extractorVersion: 'test-extractor@1.0.0',
    });

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('ir-cache.json');

    const entry = JSON.parse(files[0].content) as CachedExtractEntry;
    expect(entry.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(entry.operations).toEqual(FIXTURE_DESCRIPTOR.operations);
    expect(entry.extractorVersion).toBe('test-extractor@1.0.0');
    expect(typeof entry.createdAt).toBe('string');
    expect(entry.staleness).toBeUndefined();
    expect('staleness' in entry).toBe(false);
  });

  it('honors a custom filename', () => {
    const files = buildIrCacheArtifact(FIXTURE_DESCRIPTOR, {
      cache: 'artifact',
      filename: 'client.ir.json',
      extractorVersion: 'test-extractor@1.0.0',
    });
    expect(files[0].path).toBe('client.ir.json');
  });

  it('defaults extractorVersion to the installed @adhd/apigen-core-client version when omitted', () => {
    const files = buildIrCacheArtifact(FIXTURE_DESCRIPTOR, { cache: 'artifact' });
    const entry = JSON.parse(files[0].content) as CachedExtractEntry;
    expect(entry.extractorVersion).toEqual(expect.any(String));
    expect(entry.extractorVersion.length).toBeGreaterThan(0);
  });
});
