/**
 * guards: a --use plugin's extractLayer.createLayer runs once per source instead of once per invocation, the extractor choice leaks into ExtractCall.host (changing a cache key), or an option that affects extraction is invisible to a cache layer
 * tier: S
 * cites: REMEDIATION-PLAN T-R2/R5 (single IR-generation entry; invokerCache once-per-invocation); commit 47e06f90 (once-per-invocation extract invoker); ADR-0017 D5
 * tags: contract
 * teeth: red: delete the `invokerCache?.set(registered, invokeExtract)` line in extractSourceEntry (guarded temporary edit, restored) and run `npx vitest run src/test/extract-source-entry.spec.ts` in packages/apigen/apigen-core-client -> exit 1; "builds the extractLayer once across sources" goes red (createLayer ran twice)
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/extract', () => ({ extract: vi.fn() }));

import { createExtractorRegistry, extractSourceEntry, type ExtractInvoker, type Extractor } from '../lib/extraction-entry';
import { resolveSourceReference } from '../lib/source-language';
import { withSourceFiles, type ExtractCall, type ExtractMiddleware } from '../lib/extract-invoker';
import type { Operation } from '../lib/descriptor';
import type { Plugin } from '../lib/plugin';

const OP = (id: string): Operation =>
  ({
    id,
    host: 'ts',
    namespace: { raw: 'ns', words: ['ns'] },
    path: [{ raw: id, words: [id] }],
    kind: 'action',
    async: false,
    streaming: false,
    safe: true,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  }) as Operation;

function resolution(reference: string) {
  const r = resolveSourceReference(reference);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** An extractLayer plugin that records createLayer calls and every ExtractCall that passes through. */
function recordingPlugin() {
  const created: Array<Record<string, unknown>> = [];
  const calls: ExtractCall[] = [];
  const plugin: Plugin = {
    id: 'recorder',
    capabilities: {
      extractLayer: {
        createLayer: (opts): ExtractMiddleware => {
          created.push(opts);
          return (call, next) => {
            calls.push(call);
            return next();
          };
        },
      },
    },
  };
  return { plugin, created, calls };
}

function registryWith(extractor: Extractor, key = 'ts') {
  const registry = createExtractorRegistry();
  registry.register(key, extractor);
  return registry;
}

describe('extractSourceEntry (T-R2/R5)', () => {
  it('returns the operations and the files the extractor reported, entry file included', async () => {
    const extractor: Extractor = async () => withSourceFiles([OP('a')], ['/p/b.ts', '/p/a.ts']);
    const out = await extractSourceEntry({
      reference: '/p/a.ts',
      resolution: resolution('/p/a.ts'),
      namespace: 'ns',
      usePlugins: [],
      extractLayerOptions: {},
      registry: registryWith(extractor),
    });
    expect(out.operations.map((o) => o.id)).toEqual(['a']);
    expect(out.files).toEqual(['/p/a.ts', '/p/b.ts']);
  });

  it('reports no files when the extractor reports none', async () => {
    const out = await extractSourceEntry({
      reference: 'x.ts',
      resolution: resolution('x.ts'),
      usePlugins: [],
      extractLayerOptions: {},
      registry: registryWith(async () => [OP('a')]),
    });
    expect(out.files).toEqual([]);
  });

  it('builds the extractLayer once across sources that share an invokerCache', async () => {
    const { plugin, created, calls } = recordingPlugin();
    const registry = registryWith(async () => [OP('a')]);
    const invokerCache = new Map<string, ExtractInvoker>();
    for (const ref of ['/p/one.ts', '/p/two.ts', '/p/three.ts']) {
      await extractSourceEntry({
        reference: ref,
        resolution: resolution(ref),
        usePlugins: [plugin],
        extractLayerOptions: { cache: '/c' },
        registry,
        invokerCache,
      });
    }
    expect(created).toEqual([{ cache: '/c' }]);
    expect(calls.map((c) => c.source)).toEqual(['/p/one.ts', '/p/two.ts', '/p/three.ts']);
    expect([...invokerCache.keys()]).toEqual(['ts']);
  });

  it('builds the extractLayer per source when no invokerCache is given', async () => {
    const { plugin, created } = recordingPlugin();
    const registry = registryWith(async () => [OP('a')]);
    for (const ref of ['/p/one.ts', '/p/two.ts']) {
      await extractSourceEntry({
        reference: ref,
        resolution: resolution(ref),
        usePlugins: [plugin],
        extractLayerOptions: {},
        registry,
      });
    }
    expect(created).toHaveLength(2);
  });

  it('keeps one cached invoker per registry key', async () => {
    const { plugin, created } = recordingPlugin();
    const registry = registryWith(async () => [OP('in-process')]);
    registry.register('ts-subprocess', async () => [OP('subprocess')]);
    const invokerCache = new Map<string, ExtractInvoker>();
    const base = {
      reference: '/p/a.ts',
      resolution: resolution('/p/a.ts'),
      usePlugins: [plugin],
      extractLayerOptions: {},
      registry,
      invokerCache,
    };
    const a = await extractSourceEntry(base);
    const b = await extractSourceEntry({ ...base, extractor: 'ts-subprocess' });
    const c = await extractSourceEntry({ ...base, extractor: 'ts-subprocess' });
    expect([a, b, c].map((r) => r.operations[0].id)).toEqual(['in-process', 'subprocess', 'subprocess']);
    expect(created).toHaveLength(2);
    expect([...invokerCache.keys()].sort()).toEqual(['ts', 'ts-subprocess']);
  });

  it('routes to the chosen extractor while ExtractCall.host stays the translator id', async () => {
    const { plugin, calls } = recordingPlugin();
    const registry = registryWith(async () => [OP('x')]);
    registry.register('ts-subprocess', async (call) => [OP(`ran-${call.host}`)]);
    const out = await extractSourceEntry({
      reference: '/p/a.ts',
      resolution: resolution('/p/a.ts'),
      usePlugins: [plugin],
      extractLayerOptions: {},
      registry,
      extractor: 'ts-subprocess',
    });
    expect(out.operations.map((o) => o.id)).toEqual(['ran-ts']);
    expect(calls[0].host).toBe('ts');
  });

  it('carries namespace, tsconfig, dropFileSegment and the session in the call a cache layer sees', async () => {
    const { plugin, calls } = recordingPlugin();
    const session = { run: 1 } as never;
    await extractSourceEntry({
      reference: '/p/a.ts',
      resolution: resolution('/p/a.ts'),
      namespace: 'backlog',
      tsconfig: '/p/tsconfig.json',
      dropFileSegment: false,
      session,
      usePlugins: [plugin],
      extractLayerOptions: {},
      registry: registryWith(async () => [OP('a')]),
    });
    expect(calls[0]).toEqual({
      source: '/p/a.ts',
      host: 'ts',
      namespace: 'backlog',
      extractorOptions: { tsconfig: '/p/tsconfig.json', dropFileSegment: false, session },
    });
  });

  it('omits options the caller did not set', async () => {
    const { plugin, calls } = recordingPlugin();
    await extractSourceEntry({
      reference: '/p/a.ts',
      resolution: resolution('/p/a.ts'),
      usePlugins: [plugin],
      extractLayerOptions: {},
      registry: registryWith(async () => [OP('a')]),
    });
    expect(calls[0].extractorOptions).toEqual({});
  });

  it('a cache layer that short-circuits keeps the real extractor from running', async () => {
    const extractor = vi.fn<Extractor>(async () => [OP('real')]);
    const plugin: Plugin = {
      id: 'cache-hit',
      capabilities: { extractLayer: { layer: async () => [OP('cached')] } },
    };
    const out = await extractSourceEntry({
      reference: '/p/a.ts',
      resolution: resolution('/p/a.ts'),
      usePlugins: [plugin],
      extractLayerOptions: {},
      registry: registryWith(extractor),
    });
    expect(out.operations.map((o) => o.id)).toEqual(['cached']);
    expect(extractor).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON option before building anything', async () => {
    const { plugin, created } = recordingPlugin();
    await expect(
      extractSourceEntry({
        reference: '/p/a.ts',
        resolution: resolution('/p/a.ts'),
        tsconfig: 7 as unknown as string,
        usePlugins: [plugin],
        extractLayerOptions: {},
        registry: registryWith(async () => []),
      })
    ).rejects.toThrow(/tsconfig must be a string/);
    expect(created).toHaveLength(0);
  });

  it('throws naming the source when the resolution has no translator', async () => {
    await expect(
      extractSourceEntry({
        reference: 'bin:git',
        resolution: resolution('bin:git'),
        usePlugins: [],
        extractLayerOptions: {},
        registry: createExtractorRegistry(),
      })
    ).rejects.toThrow(/source "bin:git" names no translator/);
  });

  it('throws naming the key when no extractor is registered for it', async () => {
    await expect(
      extractSourceEntry({
        reference: 'api.py',
        resolution: resolution('api.py'),
        usePlugins: [],
        extractLayerOptions: {},
        registry: createExtractorRegistry(),
      })
    ).rejects.toThrow(/no py extractor is registered/);
    await expect(
      extractSourceEntry({
        reference: '/p/a.ts',
        resolution: resolution('/p/a.ts'),
        usePlugins: [],
        extractLayerOptions: {},
        registry: createExtractorRegistry(),
        extractor: 'ts-subprocess',
      })
    ).rejects.toThrow(/no ts-subprocess extractor is registered/);
  });
});
