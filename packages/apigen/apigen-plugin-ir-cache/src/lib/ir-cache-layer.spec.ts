// ir-cache-layer.spec.ts — behavioral proof for the extract-stage IR cache
// (FEAT-002), per AGENTS.md §7's verification standard.
//
// REAL components: a real local-filesystem backend (`createLocalFsBackend`)
// over a real temp directory, and REAL temp source files (including a
// transitively-imported file) whose bytes are what the content-addressed key
// is computed from. The ONLY thing mocked is the boundary the cache wraps —
// `runExtractor` (the terminal extractor step) — via a call-counting spy,
// exactly like apigen-plugin-batch's spec mocks only `hostBridge.invoke`.
//
// TEETH: test 3 touches the source file's MTIME (not its content) and asserts
// the extractor is NOT called again — this test goes RED if the cache key
// ever reverts to the mtime-based key the in-process ExtractionSession cache
// uses, which is the exact anti-pattern this plugin exists to avoid.
//
// Deterministic: no sleeps, no wall-clock — misses/hits are asserted by call
// counts and key equality, never by timing.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtractCall, Operation } from '@adhd/apigen-core-client';
import { createExtractInvoker } from '@adhd/apigen-core-client';
import {
  computeCacheKey,
  createIrCacheLayer,
  CURRENT_FORMAT_VERSION,
  type IrCacheBackend,
} from './ir-cache-layer';
import { createLocalFsBackend } from './backends/fs-backend';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOp(id: string): Operation {
  const [namespace, ...restPath] = id.split('/');
  return {
    id,
    host: 'ts',
    namespace: { raw: namespace, words: [namespace] },
    path: restPath.map((p) => ({ raw: p, words: [p.toLowerCase()] })),
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

const FIXTURE_OPS: Operation[] = [makeOp('svc/doThing')];

const EXTRACTOR_VERSION = 'test-extractor@1.0.0';

function makeCall(overrides: Partial<ExtractCall> = {}): ExtractCall {
  return {
    source: path.join(dir, 'entry.ts'),
    host: 'ts',
    namespace: 'svc',
    extractorOptions: {},
    ...overrides,
  };
}

// A real source file + a real transitively-imported file.
let dir: string;
let entryPath: string;
let importPath: string;

function writeSources(sourceBody?: string, importBody?: string): void {
  fs.writeFileSync(
    importPath,
    importBody ?? `export interface Imported { v: number }\n`
  );
  fs.writeFileSync(
    entryPath,
    sourceBody ??
      `import type { Imported } from './imported';\n` +
        `export async function doThing(i: Imported): Promise<Imported> { return i }\n`
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-ir-cache-spec-'));
  entryPath = path.join(dir, 'entry.ts');
  importPath = path.join(dir, 'imported.ts');
  writeSources();
});

describe('createLocalFsBackend', () => {
  it('get on a missing key returns undefined and does not throw', async () => {
    const backend = createLocalFsBackend(path.join(dir, 'cache'));
    await expect(backend.get('no-such-key')).resolves.toBeUndefined();
  });

  it('put then get round-trips the entry', async () => {
    const backend = createLocalFsBackend(path.join(dir, 'cache'));
    const entry = {
      formatVersion: CURRENT_FORMAT_VERSION,
      operations: FIXTURE_OPS,
      extractorVersion: EXTRACTOR_VERSION,
      createdAt: new Date().toISOString(),
    };
    await backend.put('k1', entry);
    await expect(backend.get('k1')).resolves.toEqual(entry);
  });

  it('corrupt JSON on disk is a MISS, not a throw', async () => {
    const cacheDir = path.join(dir, 'cache');
    const backend = createLocalFsBackend(cacheDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'k1.json'), '{not json');
    await expect(backend.get('k1')).resolves.toBeUndefined();
  });
});

describe('computeCacheKey', () => {
  it('is deterministic for identical input', async () => {
    const call = makeCall();
    await expect(computeCacheKey(call, EXTRACTOR_VERSION)).resolves.toBe(
      await computeCacheKey(call, EXTRACTOR_VERSION)
    );
  });

  it('changes when the source content changes', async () => {
    const before = await computeCacheKey(makeCall(), EXTRACTOR_VERSION);
    writeSources(`export async function other(): Promise<void> {}\n`);
    const after = await computeCacheKey(makeCall(), EXTRACTOR_VERSION);
    expect(after).not.toBe(before);
  });

  it('changes when a transitively-imported file changes', async () => {
    const before = await computeCacheKey(makeCall(), EXTRACTOR_VERSION);
    writeSources(undefined, `export interface Imported { v: number; extra: string }\n`);
    const after = await computeCacheKey(makeCall(), EXTRACTOR_VERSION);
    expect(after).not.toBe(before);
  });

  it('changes when the extractor version changes', async () => {
    const call = makeCall();
    const v1 = await computeCacheKey(call, 'extractor@1.0.0');
    const v2 = await computeCacheKey(call, 'extractor@2.0.0');
    expect(v2).not.toBe(v1);
  });
});

describe('createIrCacheLayer — HIT/MISS semantics (content-addressed, not mtime)', () => {
  it('first call is a MISS (extractor runs); identical second call is a HIT (extractor does NOT run)', async () => {
    const backend = createLocalFsBackend(path.join(dir, 'cache'));
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer(backend, { extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    const call = makeCall();

    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1);

    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1); // still once — HIT, no re-extraction
  });

  it('touching only the MTIME (content unchanged) is still a HIT — the key is content-addressed', async () => {
    const backend = createLocalFsBackend(path.join(dir, 'cache'));
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer(backend, { extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    const call = makeCall();

    await invoke(call);
    expect(runExtractor).toHaveBeenCalledTimes(1);

    // Change mtime only (content byte-identical). A mtime-keyed cache would
    // MISS here and call the extractor again — this assertion is the teeth.
    const st = fs.statSync(entryPath);
    fs.utimesSync(entryPath, st.atime, new Date(st.mtime.getTime() + 60_000));

    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1); // still once — mtime touch is a HIT
  });

  it('editing the SOURCE content is a MISS (extractor runs again)', async () => {
    const backend = createLocalFsBackend(path.join(dir, 'cache'));
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer(backend, { extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    const call = makeCall();

    await invoke(call);
    expect(runExtractor).toHaveBeenCalledTimes(1);

    writeSources(`export async function changed(): Promise<void> {}\n`);
    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(2); // content change — MISS
  });

  it('editing an IMPORTED file is a MISS (extractor runs again)', async () => {
    const backend = createLocalFsBackend(path.join(dir, 'cache'));
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer(backend, { extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    const call = makeCall();

    await invoke(call);
    expect(runExtractor).toHaveBeenCalledTimes(1);

    writeSources(undefined, `export interface Imported { v: number; extra: boolean }\n`);
    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(2); // transitive import changed — MISS
  });

  it('a cached entry with a stale formatVersion is treated as a MISS', async () => {
    const cacheDir = path.join(dir, 'cache');
    const backend = createLocalFsBackend(cacheDir);
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer(backend, { extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    const call = makeCall();

    // Prime the cache with the real layer, then corrupt the entry's format.
    await invoke(call);
    expect(runExtractor).toHaveBeenCalledTimes(1);
    const key = await computeCacheKey(call, EXTRACTOR_VERSION);
    const entryPathOnDisk = path.join(cacheDir, `${key}.json`);
    const entry = JSON.parse(fs.readFileSync(entryPathOnDisk, 'utf8')) as {
      formatVersion: number;
    };
    fs.writeFileSync(
      entryPathOnDisk,
      JSON.stringify({ ...entry, formatVersion: CURRENT_FORMAT_VERSION + 999 })
    );

    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(2); // stale format — MISS, re-extracted
  });

  it('a failing backend.put never fails the extraction (fire-and-forget write)', async () => {
    const failing: IrCacheBackend = {
      get: async () => undefined,
      put: async () => {
        throw new Error('backend unavailable');
      },
    };
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer(failing, { extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    await expect(invoke(makeCall())).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1);
  });
});
