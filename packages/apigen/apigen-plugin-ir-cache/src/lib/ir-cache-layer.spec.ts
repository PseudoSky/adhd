// ir-cache-layer.spec.ts — behavioral proof for the extract-stage IR cache
// (FEAT-002, Revision 2), per AGENTS.md §7's verification standard.
//
// REAL components: real temp source files (including a transitively-imported
// file) whose bytes/mtimes are what the fast/slow gates and the
// content-addressed key are computed from, and a REAL single-file backend
// over a real temp cache file. The ONLY thing mocked is the boundary the
// cache wraps — `runExtractor` (the terminal extractor step) — via a
// call-counting spy, exactly like apigen-plugin-batch's spec mocks only
// `hostBridge.invoke`.
//
// TEETH:
//  - "mtime touch, content same" goes through the REAL slow gate (full
//    content rehash) and asserts a HIT — this test goes RED if the cache key
//    ever reverts to a pure-mtime key (the anti-pattern this plugin exists
//    to avoid).
//  - The FAST GATE test spies on `node:fs/promises`'s `readFile` (namespace
//    import, so the spy actually intercepts the production code's calls —
//    see `atomic-write-json.ts`'s doc comment) and asserts the SOURCE and
//    DEP file paths are never read on a clean fast-gate HIT — proving zero
//    hashing occurs, not merely that the extractor wasn't re-run (the exact
//    gap Revision 1 left open).
//
// Deterministic: no sleeps; the one genuinely fire-and-forget async
// side-effect (the mtime-refresh backfill write) is awaited via `vi.waitFor`
// polling a real file's content — a bounded-deadline wait on a real
// observable state change, never a wall-clock guess.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// `node:fs/promises`'s exports are non-configurable in this runtime, so a
// direct `vi.spyOn(fsPromises, 'readFile')` throws ("Cannot redefine
// property"). `vi.mock` with `importOriginal` is the standard Vitest
// workaround for Node built-ins: it swaps in a REAL passthrough (every
// function still does its real work — the fast/slow-gate tests below depend
// on genuine file I/O) wrapped in a `vi.fn` so call counts/args are
// observable via `vi.mocked(fsPromises.readFile)`.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
  };
});
import type { ExtractCall, Operation } from '@adhd/apigen-core-client';
import { createExtractInvoker } from '@adhd/apigen-core-client';
import {
  computeCacheKey,
  createIrCacheLayer,
  CURRENT_FORMAT_VERSION,
  type CachedExtractEntry,
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
    source: entryPath,
    host: 'ts',
    namespace: 'svc',
    extractorOptions: {},
    ...overrides,
  };
}

// A real source file + a real transitively-imported file + a real cache file.
let dir: string;
let entryPath: string;
let importPath: string;
let cachePath: string;

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

function readCacheFile(): CachedExtractEntry | undefined {
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CachedExtractEntry;
  } catch {
    return undefined;
  }
}

/**
 * `createIrCacheLayer`'s writes are DELIBERATELY fire-and-forget (design doc
 * R2.3: "the layer never blocks on put") — a MISS's `invoke()` call resolves
 * with the fresh operations before the write to disk necessarily lands. A
 * real subprocess consumer (e.g. `entrypoint/backlog`'s `--help` path) is
 * safe because Node only exits once every pending I/O drains; an in-process
 * test issuing a SECOND `invoke()` call immediately after the first would
 * otherwise race that same pending write. This waits for the write's real,
 * observable effect (the cache file existing) via a bounded-deadline poll —
 * never a raw sleep/wall-clock guess.
 */
async function waitForCacheWrite(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(fs.existsSync(cachePath)).toBe(true);
    },
    { timeout: 2000, interval: 10 }
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-ir-cache-spec-'));
  entryPath = path.join(dir, 'entry.ts');
  importPath = path.join(dir, 'imported.ts');
  cachePath = path.join(dir, 'cache', 'ir-cache.json');
  writeSources();
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

describe('createLocalFsBackend (directory mode, kept for a future multi-key backend)', () => {
  it('get on a missing key returns undefined and does not throw', async () => {
    const backend = createLocalFsBackend(path.join(dir, 'cache'));
    await expect(backend.get('no-such-key')).resolves.toBeUndefined();
  });

  it('put then get round-trips the entry', async () => {
    const backend = createLocalFsBackend(path.join(dir, 'cache'));
    const entry: CachedExtractEntry = {
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

describe('createIrCacheLayer — cache: "artifact" guard (R2.2)', () => {
  it('throws when constructed with cache: "artifact" instead of a file path', () => {
    expect(() =>
      createIrCacheLayer({ cache: 'artifact', extractorVersion: EXTRACTOR_VERSION })
    ).toThrow(/artifact/i);
  });
});

describe('createIrCacheLayer — RUNTIME CACHE mode HIT/MISS semantics', () => {
  it('first call is a MISS (extractor runs); identical second call is a HIT (extractor does NOT run)', async () => {
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    const call = makeCall();

    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1);
    await waitForCacheWrite(); // the MISS's write-through is fire-and-forget

    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1); // still once — HIT, no re-extraction
  });

  it('FAST GATE: a clean repeated call reads source/dep bytes ZERO times (no hashing) — not just "extractor not re-run"', async () => {
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    const call = makeCall();

    // Prime the cache (MISS) — writes the entry with a staleness snapshot.
    await invoke(call);
    expect(runExtractor).toHaveBeenCalledTimes(1);
    await waitForCacheWrite();

    const readFileSpy = vi.mocked(fsPromises.readFile);
    readFileSpy.mockClear();

    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1); // HIT

    // The cache entry file itself is legitimately read (to fetch the
    // staleness snapshot) — but the SOURCE and its transitive DEP must never
    // be read: the fast gate proves freshness via `stat()` alone.
    const readPaths = readFileSpy.mock.calls.map((c) => c[0]);
    expect(readPaths).not.toContain(entryPath);
    expect(readPaths).not.toContain(importPath);
  });

  it('touching only the MTIME (content unchanged) is still a HIT via the SLOW GATE — the key is content-addressed', async () => {
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    const call = makeCall();

    await invoke(call);
    expect(runExtractor).toHaveBeenCalledTimes(1);
    await waitForCacheWrite();
    const writtenMtime = readCacheFile()?.staleness?.source.mtimeMs;

    // Change mtime only (content byte-identical). A mtime-keyed cache would
    // MISS here and call the extractor again — this assertion is the teeth.
    const st = fs.statSync(entryPath);
    const newMtime = new Date(st.mtime.getTime() + 60_000);
    fs.utimesSync(entryPath, st.atime, newMtime);
    // Read the mtime back the SAME way production code does (`fs.stat`),
    // rather than trusting `newMtime.getTime()` verbatim — some filesystems
    // (e.g. APFS's nanosecond-precision timestamps) don't round-trip a
    // `utimesSync` Date to a bit-identical `mtimeMs` double, so comparing
    // against the JS-constructed target is a floating-point-precision false
    // negative, not a real production-code mismatch (the layer itself only
    // ever compares stat-to-stat, never stat-to-a-`Date`).
    const actualNewMtime = fs.statSync(entryPath).mtimeMs;

    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1); // still once — mtime touch is a HIT

    // The slow-gate HIT fire-and-forget rewrites the staleness mtime so the
    // NEXT read is fast again — a real, observable state change, awaited via
    // a bounded-deadline poll (never a raw sleep).
    await vi.waitFor(
      () => {
        const refreshed = readCacheFile()?.staleness?.source.mtimeMs;
        expect(refreshed).toBe(actualNewMtime);
        expect(refreshed).not.toBe(writtenMtime);
      },
      { timeout: 2000, interval: 20 }
    );
  });

  it('editing the SOURCE content is a MISS (extractor runs again)', async () => {
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: EXTRACTOR_VERSION })],
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
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: EXTRACTOR_VERSION })],
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
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    const call = makeCall();

    await invoke(call);
    expect(runExtractor).toHaveBeenCalledTimes(1);
    await waitForCacheWrite();
    const entry = readCacheFile();
    if (!entry) throw new Error('expected a written cache entry');
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ ...entry, formatVersion: CURRENT_FORMAT_VERSION + 999 })
    );

    await expect(invoke(call)).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(2); // stale format — MISS, re-extracted
  });

  it('a cached entry with a mismatched extractorVersion is treated as a MISS', async () => {
    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    await invoke(makeCall());
    expect(runExtractor).toHaveBeenCalledTimes(1);

    // A DIFFERENT extractorVersion reading the same file must MISS — DEBT-003's
    // "an extractor fix busts every stale entry" invariant.
    const invokeV2 = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: 'test-extractor@2.0.0' })],
      runExtractor
    );
    await expect(invokeV2(makeCall())).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(2);
  });

  it('a failing backend write never fails the extraction (fire-and-forget write)', async () => {
    const unwritableCache = path.join(dir, 'no', 'such', 'deeply', 'nested', 'dir', 'cache.json');
    // Simulate an unwritable target by pointing the cache file at a path
    // whose parent is actually a FILE, not a directory — mkdir(recursive)
    // will fail there, exercising the real atomic-write failure path.
    fs.writeFileSync(path.join(dir, 'no'), 'i am a file, not a directory');

    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: unwritableCache, extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );
    await expect(invoke(makeCall())).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1);
  });
});

describe('createIrCacheLayer — cross-mode compatibility (R2.5)', () => {
  it('reads an ARTIFACT-mode-written entry (no staleness) as a MISS — revalidates via one real extraction, then writes a staleness-carrying entry so the NEXT read is a fast HIT', async () => {
    // Simulate what `./target.ts`'s `buildIrCacheArtifact` writes: the same
    // `CachedExtractEntry` shape, but with NO `staleness` field — there is no
    // stored content key in this shape to validate a read against.
    const artifactEntry: CachedExtractEntry = {
      formatVersion: CURRENT_FORMAT_VERSION,
      operations: FIXTURE_OPS,
      extractorVersion: EXTRACTOR_VERSION,
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(artifactEntry));

    const runExtractor = vi.fn(async () => FIXTURE_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );

    // MISS — a no-staleness entry can never be proven fresh, so the real
    // extractor runs once to revalidate (design doc R2.5: no manual
    // migration step is required, but this first cross-mode read is not
    // free — nothing here would be a "HIT no one asked for").
    await expect(invoke(makeCall())).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1);

    // The MISS write-through lands a `staleness` snapshot fire-and-forget so
    // the NEXT read gets the fast path — a real, observable state change,
    // awaited via a bounded-deadline poll.
    await vi.waitFor(
      () => {
        const staleness = readCacheFile()?.staleness;
        expect(staleness).toBeDefined();
        expect(staleness?.source.path).toBe(entryPath);
      },
      { timeout: 2000, interval: 20 }
    );

    // And now that staleness has been recorded, a THIRD call takes the fast
    // gate — proof the write-through actually round-trips into a real HIT.
    await expect(invoke(makeCall())).resolves.toEqual(FIXTURE_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1);
  });

  it('MUST_FIX regression: an ARTIFACT-mode entry that has gone stale (source edited after artifact generation, artifact never regenerated) is a MISS, not a permanently-laundered HIT', async () => {
    // Write the ARTIFACT-mode entry for the ORIGINAL source (v1 operations).
    const staleArtifactEntry: CachedExtractEntry = {
      formatVersion: CURRENT_FORMAT_VERSION,
      operations: FIXTURE_OPS, // "v1" operations — stale the moment source changes below.
      extractorVersion: EXTRACTOR_VERSION,
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(staleArtifactEntry));

    // Now edit the source WITHOUT regenerating the artifact — the exact
    // failure scenario: `formatVersion`/`extractorVersion` still match, but
    // the on-disk operations no longer reflect the current source.
    writeSources(`export async function somethingElseEntirely(): Promise<void> {}\n`);

    const FRESH_OPS: Operation[] = [makeOp('svc/somethingElseEntirely')];
    const runExtractor = vi.fn(async () => FRESH_OPS);
    const invoke = createExtractInvoker(
      [createIrCacheLayer({ cache: cachePath, extractorVersion: EXTRACTOR_VERSION })],
      runExtractor
    );

    // Before the fix, this returned the STALE `FIXTURE_OPS` unconditionally
    // and then backfilled a `staleness` snapshot from the (already-edited)
    // current source — permanently laundering the wrong data as "fresh"
    // with no future self-correction. The fix must MISS here and return the
    // FRESH result from the real extractor instead.
    await expect(invoke(makeCall())).resolves.toEqual(FRESH_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1);

    // And the write-through must persist the FRESH operations (not the
    // stale ones) so every subsequent read — fast or slow gate — serves the
    // correct data forever after, never the laundered v1 result.
    await vi.waitFor(
      () => {
        expect(readCacheFile()?.operations).toEqual(FRESH_OPS);
      },
      { timeout: 2000, interval: 20 }
    );
    await expect(invoke(makeCall())).resolves.toEqual(FRESH_OPS);
    expect(runExtractor).toHaveBeenCalledTimes(1);
  });
});
