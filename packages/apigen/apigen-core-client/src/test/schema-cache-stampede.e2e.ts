// schema-cache-stampede.spec.ts — regression net for BUG-APIGEN-CORE-003
// (buildSchema OOM on a large real-world re-export barrel).
//
// Root cause (see packages/apigen/apigen-core-client/BACKLOG.md,
// BUG-APIGEN-CORE-003): `session.schemaCache` used to store only the
// RESOLVED value, set AFTER `await`ing `buildSchemaUncached(...)`. Nothing
// deduplicated concurrent IDENTICAL requests for the same
// `(sourceFile, tsconfig, typeText)` key, so `morph-walk.ts`'s
// `Promise.all(members.map(m => walkType(m, recurse, depth + 1)))` (union
// variants resolved concurrently) could see several siblings all miss the
// not-yet-populated cache for a type they all shared, each independently
// paying the full — and, per Path 2's own measured cost, Program-rebuilding —
// price of `buildSchemaUncached`. In the real repro this collapsed 1552
// concurrent calls for the literally identical `"SharedArrayBuffer"` key
// into 1552 redundant, expensive recomputations and drove the process OOM.
//
// The fix: `buildSchema()` now populates `session.schemaCache` with the
// PENDING `Promise` synchronously — before anything is awaited — so a
// concurrent sibling call for the same key joins the in-flight computation
// instead of missing the cache.
//
// This test proves the fix at the unit level, independent of timing or
// machine speed: N concurrent `buildSchema()` calls for the IDENTICAL key
// must trigger the expensive underlying resolution exactly ONCE. It spies on
// `morph-walk.ts`'s `withResolvedType` (the real Path-2 work that the
// BACKLOG entry identified as the expensive, Program-rebuilding step) so a
// bug in the session's own hit/miss counters could not make this test pass
// by accident — the assertion is against an independent witness of real work
// being done, not just the cache's self-reported bookkeeping.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../lib/schema-builders/morph-walk', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../lib/schema-builders/morph-walk')
  >();
  return {
    ...actual,
    // Transparent wrapper: real behavior is unchanged, only call count is observed.
    withResolvedType: vi.fn(actual.withResolvedType),
  };
});

// `buildMapSetTupleSchema` is the one call in `buildSchemaUncached` that is
// NOT wrapped in a try/catch (Path 1 and Path 2 both self-heal internally by
// falling through to the next path on failure — see ts-json-schema.ts's own
// comments) — genuinely making it reject is the only way to exercise
// `buildSchema()`'s cache-eviction-on-rejection branch honestly, without
// relying on internals that already swallow their own errors.
vi.mock('../lib/schema-builders/map-set-tuple', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../lib/schema-builders/map-set-tuple')
  >();
  return {
    ...actual,
    buildMapSetTupleSchema: vi.fn(actual.buildMapSetTupleSchema),
  };
});

import { withResolvedType } from '../lib/schema-builders/morph-walk';
import { buildMapSetTupleSchema } from '../lib/schema-builders/map-set-tuple';
import { buildSchema } from '../lib/schema-builders/ts-json-schema';
import {
  createExtractionSession,
  internalSession,
  clearPersistentProjectCache,
} from '../lib/extraction-session';

const mockedWithResolvedType = vi.mocked(withResolvedType);
const mockedBuildMapSetTupleSchema = vi.mocked(buildMapSetTupleSchema);

let dir: string;
let filePath: string;

// A plain inline/anonymous array type: not a named symbol, so Path 1
// (ts-json-schema-generator's named-type lookup) always throws and the call
// falls through to Path 2 (morph-walk), which is exactly the expensive,
// Program-rebuilding path BUG-APIGEN-CORE-003 documents.
//
// Empirically verified (probe run against a COLD session, logging every
// `withResolvedType` call's typeText — not assumed): resolving `string[]`
// once costs exactly 2 `withResolvedType` calls — one for `string[]` itself,
// and one more because its element type `string` ALSO falls through to
// Path 2 on a cold session (a bare primitive keyword isn't a "root type"
// ts-json-schema-generator's Path 1 can look up by name, so it isn't a
// same-call SCALAR_SCHEMAS-style shortcut the way `Date`/`bigint`/`Buffer`
// are). This is a fixed, reproducible baseline for ANY number of repeated
// requests for the SAME `string[]` key on a cold session — the two nested
// keys (`string[]`, `string`) are each computed exactly once regardless of
// how many times the OUTER key is requested, concurrently or sequentially.
// If the stampede fix regressed, N repeated/concurrent outer requests would
// multiply this baseline (2 × N), not hold it constant at 2.
const INLINE_TYPE_TEXT = 'string[]';
const BASELINE_RESOLUTION_CALLS = 2; // withResolvedType calls for ONE cold resolution
const BASELINE_MISSES = 2; // distinct cache keys touched by ONE cold resolution ("string[]", "string")

beforeEach(() => {
  clearPersistentProjectCache();
  mockedWithResolvedType.mockClear();
  mockedBuildMapSetTupleSchema.mockClear();
});

describe('BUG-APIGEN-CORE-003: buildSchema cache-stampede fix', () => {
  it('N concurrent buildSchema() calls for the identical (sourceFile, tsconfig, typeText) key trigger the expensive Path-2 resolution exactly ONCE', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-stampede-spec-'));
    filePath = path.join(dir, 'stampede.ts');
    fs.writeFileSync(
      filePath,
      `export function noop(): void {}\n` // buildSchema doesn't require the type to be physically declared
    );

    const session = createExtractionSession();
    const internal = internalSession(session);
    const project = internal.projectFor(undefined);
    const sf = internal.sourceFileFor(filePath, undefined);

    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        buildSchema(project, sf, INLINE_TYPE_TEXT, undefined, internal)
      )
    );

    // Independent witness: the real expensive Path-2 work ran exactly the
    // COLD baseline number of times (2 — see BASELINE_RESOLUTION_CALLS),
    // NOT multiplied by N — this is the assertion that would have caught
    // the stampede (a count of the underlying computation, not just that
    // the N results happen to be equal). Before the fix this would have
    // been up to 2×N (each of the N concurrent callers redundantly
    // recomputing both the outer and nested resolution).
    expect(mockedWithResolvedType).toHaveBeenCalledTimes(
      BASELINE_RESOLUTION_CALLS
    );

    // The session's own bookkeeping agrees: exactly the baseline number of
    // misses (the ONE computation that actually ran, plus its one nested
    // key) and N-1 hits at the outer key (every other caller joined the
    // in-flight promise or the now-resolved cache entry).
    expect(internal.stats.schemaCacheMisses).toBe(BASELINE_MISSES);
    expect(internal.stats.schemaCacheHits).toBe(N - 1);

    // Every concurrent caller got the SAME result (by reference — they all
    // awaited literally the same cached promise/value).
    for (const r of results) {
      expect(r).toBe(results[0]);
    }
    expect(results[0]).toMatchObject({ type: 'array' });

    session.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a SEQUENTIAL second call after the first resolves is served from cache too (not just concurrent joins)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-stampede-seq-spec-'));
    filePath = path.join(dir, 'stampede-seq.ts');
    fs.writeFileSync(filePath, `export function noop(): void {}\n`);

    const session = createExtractionSession();
    const internal = internalSession(session);
    const project = internal.projectFor(undefined);
    const sf = internal.sourceFileFor(filePath, undefined);

    const first = await buildSchema(
      project,
      sf,
      INLINE_TYPE_TEXT,
      undefined,
      internal
    );
    const second = await buildSchema(
      project,
      sf,
      INLINE_TYPE_TEXT,
      undefined,
      internal
    );

    // The FIRST call alone pays the full cold baseline (2); the SECOND call
    // must add ZERO further `withResolvedType` calls — a pure cache hit.
    expect(mockedWithResolvedType).toHaveBeenCalledTimes(
      BASELINE_RESOLUTION_CALLS
    );
    expect(internal.stats.schemaCacheMisses).toBe(BASELINE_MISSES);
    expect(internal.stats.schemaCacheHits).toBe(1);
    expect(second).toBe(first);

    session.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a rejected computation is NOT cached permanently — a later call for the same key gets a fresh attempt', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-stampede-err-spec-'));
    filePath = path.join(dir, 'stampede-err.ts');
    fs.writeFileSync(filePath, `export function noop(): void {}\n`);

    const session = createExtractionSession();
    const internal = internalSession(session);
    const project = internal.projectFor(undefined);
    const sf = internal.sourceFileFor(filePath, undefined);

    // `buildMapSetTupleSchema` is the ONE call inside `buildSchemaUncached`
    // that is NOT wrapped in a try/catch (Path 1 and Path 2 both self-heal
    // internally by falling through to the next path on failure) — so it's
    // the only honest way to make the real `buildSchemaUncached` genuinely
    // reject, to prove the cache-eviction branch fires for real rather than
    // being untestable dead code.
    const MAP_TYPE_TEXT = 'Map<string, number>';
    mockedBuildMapSetTupleSchema.mockImplementationOnce(async () => {
      throw new Error('injected failure for cache-eviction test');
    });

    const key = `${sf.getFilePath()}\0${''}\0${MAP_TYPE_TEXT}`;

    await expect(
      buildSchema(project, sf, MAP_TYPE_TEXT, undefined, internal)
    ).rejects.toThrow('injected failure for cache-eviction test');

    // The failed attempt must NOT still be sitting in the cache as a
    // permanently-rejected promise.
    expect(internal.schemaCache.has(key)).toBe(false);

    // A later, independent call for the SAME key gets a fresh attempt (the
    // mock only threw `mockImplementationOnce`, so the real implementation
    // runs this time) and succeeds.
    const second = await buildSchema(
      project,
      sf,
      MAP_TYPE_TEXT,
      undefined,
      internal
    );
    expect(second).toMatchObject({ type: 'array' });
    expect(internal.schemaCache.has(key)).toBe(true);

    session.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('BUG-APIGEN-CORE-003 deadlock guard: a self-referential type resolves without hanging (not just without OOMing)', async () => {
    // The stampede fix alone (caching the PENDING promise synchronously)
    // introduces a NEW failure mode for self-referential / recursive types:
    // `interface RecursiveNode { children: RecursiveNode[] }` walks
    // `children: RecursiveNode[]` -> element type `RecursiveNode` -> back
    // into the IDENTICAL `(sourceFile, tsconfig, "RecursiveNode")` key that
    // is STILL being resolved by the outer call. Without a cycle guard, the
    // inner call would join that exact in-flight promise and deadlock
    // (verified live against the real BUG-APIGEN-CORE-003 repro: the
    // process hung indefinitely -- flat CPU, flat heap, event loop idle --
    // rather than completing or OOMing). This is exactly why real-world
    // schema generators need `$ref`/cycle handling, and why this file
    // imports `zod` -- forcing Path 1 (ts-json-schema-generator, which DOES
    // have its own cycle handling and would mask this bug) to be skipped
    // for every type, per BUG-APIGEN-CORE-001 -- routing `RecursiveNode`
    // itself through Path 2 (morph-walk), the ONLY path that recurses back
    // through `buildSchema`.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-stampede-cycle-spec-'));
    filePath = path.join(dir, 'recursive.ts');
    fs.writeFileSync(
      filePath,
      [
        `import { z } from 'zod';`,
        `void z;`,
        `export interface RecursiveNode {`,
        `  value: string;`,
        `  children: RecursiveNode[];`,
        `}`,
        '',
      ].join('\n')
    );

    const session = createExtractionSession();
    const internal = internalSession(session);
    const project = internal.projectFor(undefined);
    const sf = internal.sourceFileFor(filePath, undefined);

    const HANG_TIMEOUT_MS = 8000;
    const result = await Promise.race([
      buildSchema(project, sf, 'RecursiveNode', undefined, internal),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'buildSchema() did not resolve within the timeout — ' +
                  'almost certainly a deadlock on the self-referential type, ' +
                  'not slowness (this fixture is trivially small)'
              )
            ),
          HANG_TIMEOUT_MS
        )
      ),
    ]);

    expect(result).toMatchObject({ type: 'object' });
    const properties = (result as { properties: Record<string, unknown> })
      .properties;
    expect(properties.value).toEqual({ type: 'string' });
    // The cyclic self-reference is broken with a permissive fallback rather
    // than recursing forever — the array wrapper itself still resolves.
    expect(properties.children).toMatchObject({ type: 'array' });

    session.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 10000);
});
