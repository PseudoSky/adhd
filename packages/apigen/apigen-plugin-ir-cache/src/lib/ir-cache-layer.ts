// ir-cache-layer.ts — the extract-stage IR cache layer (FEAT-002).
//
// Sits INSIDE an extract-stage invoker (`createExtractInvoker`,
// `@adhd/apigen-core-client`), ABOVE the terminal `runExtractor` step: on a
// cache HIT the real extractor is never invoked at all. Caches at
// per-`ExtractCall` → `Operation[]` granularity — the extract-stage onion's
// natural unit of work (NOT per-type fragments, which the in-process
// `ExtractionSession.schemaCache` already covers, and NOT the merged
// multi-source `Descriptor`, which would miss on nearly every run).
//
// RUNTIME CACHE mode (`IrCacheOptions.cache: <file-path>`) — Revision 2
// (design doc `extract-stage-onion-and-ir-cache.md` R2.2/R2.3):
//
//   A single, literal, pre-agreed file IS the entire cache (see
//   `backends/single-file-backend.ts`) — not a content-addressed directory
//   of many keyed files. The caller already knows exactly which file to
//   open; the only question left on a read is "is what's in it still
//   fresh," answered by a two-tier staleness check:
//
//   1. FAST GATE — `stat()` the recorded source path and every recorded
//      transitive-import dep path (no file reads, no hashing) and compare
//      against the `mtimeMs` snapshot stored in the entry's `staleness`
//      field at write time. All match → HIT, `O(deps)` cheap `stat()` calls
//      only. This is the path that makes a repeated, unchanged-source CLI
//      invocation cost a handful of `stat()`s instead of a full content
//      rehash — the exact cost Revision 1 paid on every call, hit or miss.
//   2. SLOW GATE (a `staleness` snapshot exists but at least one mtime
//      disagrees with it) — fall back to the full content/version-addressed
//      key (`computeCacheKey`, unchanged since Revision 1): sha256 of the
//      source and every transitive local import, plus
//      `extractorVersion`/`formatVersion`. Key still matches → HIT (a
//      `touch` with no real edit — e.g. a fresh git checkout that didn't
//      preserve mtimes); the entry's `staleness` mtimes are then rewritten
//      fire-and-forget so the NEXT read takes the fast path again. Key
//      differs → MISS, run the real extractor.
//   3. NO `staleness` SNAPSHOT AT ALL (an ARTIFACT-mode-written entry, or a
//      legacy pre-Revision-2 entry) — `formatVersion`/`extractorVersion`
//      alone do NOT prove the source hasn't drifted since the artifact was
//      generated (there is no stored content key for this shape to compare
//      against), so this is treated as a MISS: the real extractor runs once
//      to revalidate, and the fresh result is written through WITH a
//      `staleness` snapshot so every subsequent read gets the fast/slow gate
//      (design doc R2.5's "switch modes without a migration" — no manual
//      migration step is required, but the first cross-mode read still pays
//      for one real extraction, because that is the only sound way to prove
//      freshness when no content key was ever recorded).
//
// `extractorVersion` in the key is what keeps this cache honest when the
// extractor itself changes — including a future DEBT-003 fix that changes
// extraction output for the same input: that fix is an ordinary
// `extractorVersion` bump that busts every stale entry, so this cache can
// never become a reason to defer it.
//
// `versionHint` (ExtractCall) is deliberately NOT trusted in the key: a
// caller-supplied identity tag could be wrong or malicious, and a shared
// cache must never key on an unverified hint. The layer always hashes the
// real file contents itself (on the slow-gate path).

import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import type {
  ExtractCall,
  ExtractMiddleware,
  Operation,
} from '@adhd/apigen-core-client';
import { collectLocalImportPaths } from '@adhd/apigen-core-client';
import { createSingleFileBackend } from './backends/single-file-backend';

/**
 * Schema version of the cache ENTRY format itself. Bump on any breaking
 * change to what's stored so old entries are ignored rather than misread
 * (read-time gate; the key also folds it in for write-time separation).
 */
export const CURRENT_FORMAT_VERSION = 1;

/** A cheap freshness snapshot recorded at write time (RUNTIME CACHE mode only). */
export interface CachedExtractStaleness {
  /** The full content/version-addressed key (`computeCacheKey`'s formula) —
   *  compared only on the slow gate. */
  contentKey: string;
  /** Absolute path + mtimeMs of the source file at write time. */
  source: { path: string; mtimeMs: number };
  /** Absolute path + mtimeMs of every transitive local import at write time
   *  (the same `collectLocalImportPaths` walk `computeCacheKey` already uses). */
  deps: Array<{ path: string; mtimeMs: number }>;
}

/** One cached extraction result, exactly as `runExtractor` would produce it. */
export interface CachedExtractEntry {
  formatVersion: number;
  /** The extraction result verbatim — no post-processing is ever cached. */
  operations: Operation[];
  /** Which extractor build produced this (e.g. apigen-core-client's version). */
  extractorVersion: string;
  /** ISO timestamp — provenance/audit only, never part of the key. */
  createdAt: string;
  /**
   * RUNTIME CACHE mode only — absent for an ARTIFACT-mode entry (a build
   * artifact is never staleness-checked at read time) and absent for an
   * entry written by a future directory-mode caller reusing this same
   * interface (its reader just always takes the full-rehash slow-gate path,
   * which is correct, just not fast). Additive, never required — this is
   * what makes "switch modes without a migration" true.
   */
  staleness?: CachedExtractStaleness;
}

/**
 * The backend seam. Local filesystem backends ship first
 * ({@link createLocalFsBackend}, {@link createSingleFileBackend}); a
 * remote/shared backend (Nx-remote-cache style content-addressed store) is a
 * same-shape drop-in — `get`/`put` are plain Promise-returning methods, so
 * nothing about the layer changes.
 */
export interface IrCacheBackend {
  /** Fetch a cached entry by key, or `undefined` on miss. MUST NOT throw on miss. */
  get(key: string): Promise<CachedExtractEntry | undefined>;
  /** Store an entry. Backends may fire-and-forget; the layer never blocks on put. */
  put(key: string, entry: CachedExtractEntry): Promise<void>;
}

/**
 * Unified plugin options (design doc Revision 2, R2.2): one `cache` string
 * selects one of two modes.
 */
export interface IrCacheOptions {
  /**
   * Either:
   *  - An absolute or relative file path: RUNTIME CACHE mode. Treated as a
   *    single-entry cache at that literal file — never a content-addressed
   *    directory of many keyed files.
   *  - The literal string `'artifact'`: ARTIFACT mode (`./lib/target.ts`).
   *    Passing this to {@link createIrCacheLayer} is a caller mistake and
   *    throws — that value selects the `target` capability instead.
   */
  cache: string;
  /** Filename for the emitted artifact in ARTIFACT mode. Default: `ir-cache.json`.
   *  Ignored in RUNTIME CACHE mode (the `cache` value itself IS the path). */
  filename?: string;
  /** Override for `extractorVersion` (defaults to `@adhd/apigen-core-client`'s
   *  own `package.json` version at the plugin's default-export call site). */
  extractorVersion?: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await fsPromises.readFile(filePath, 'utf8'));
}

/** `stat().mtimeMs`, or `undefined` if the path doesn't exist / isn't readable. */
async function statMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await fsPromises.stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Compute the content/version-addressed cache key for one `ExtractCall`.
 * Deterministic for identical input; changes if the source file OR any of its
 * transitive local imports changes, if the extractor version changes, or if
 * the entry format version changes. `collectLocalImportPaths` returns a
 * sorted path list, so the key is stable across calls and machines.
 *
 * This is the SLOW-GATE fallback (RUNTIME CACHE mode) and the sole key
 * formula ARTIFACT mode's cross-mode-compatible reader falls back to when no
 * `staleness` snapshot is present. Exported for direct unit testing
 * (determinism + sensitivity) and for any future directory-mode caller.
 */
export async function computeCacheKey(
  call: ExtractCall,
  extractorVersion: string
): Promise<string> {
  const sourceHash = await sha256File(call.source);
  const h = createHash('sha256');
  h.update(`formatVersion:${CURRENT_FORMAT_VERSION}\n`);
  h.update(`extractorVersion:${extractorVersion}\n`);
  h.update(`host:${call.host}\n`);
  h.update(`namespace:${call.namespace ?? ''}\n`);
  h.update(`source:${sourceHash}\n`);
  for (const depPath of collectLocalImportPaths(call.source)) {
    if (depPath === call.source) continue; // the entry file is already hashed
    h.update(`dep:${depPath}:${await sha256File(depPath)}\n`);
  }
  return h.digest('hex');
}

/**
 * Build a fresh `staleness` snapshot for `call`, given its already-computed
 * `contentKey` — a cheap `stat()` per source/dep path, no hashing. Used both
 * when writing a fresh entry (MISS) and when refreshing an existing entry's
 * mtimes after a slow-gate HIT (so the NEXT read takes the fast gate).
 */
async function buildStalenessSnapshot(
  call: ExtractCall,
  contentKey: string
): Promise<CachedExtractStaleness> {
  const sourceMtimeMs = (await statMtimeMs(call.source)) ?? 0;
  const deps: Array<{ path: string; mtimeMs: number }> = [];
  for (const depPath of collectLocalImportPaths(call.source)) {
    if (depPath === call.source) continue;
    const mtimeMs = await statMtimeMs(depPath);
    if (mtimeMs !== undefined) deps.push({ path: depPath, mtimeMs });
  }
  return {
    contentKey,
    source: { path: call.source, mtimeMs: sourceMtimeMs },
    deps,
  };
}

/**
 * FAST GATE (design doc R2.3 step 3): `stat()` the recorded source path and
 * every recorded dep path directly — no `collectLocalImportPaths` call, no
 * hashing, just `fs.stat` on a short, already-known list of paths. Returns
 * `true` only if `call.source` still matches the recorded source path AND
 * every current `mtimeMs` matches the recorded one.
 */
async function fastGateHits(
  call: ExtractCall,
  staleness: CachedExtractStaleness
): Promise<boolean> {
  if (staleness.source.path !== call.source) return false;
  const currentSourceMtime = await statMtimeMs(staleness.source.path);
  if (currentSourceMtime === undefined || currentSourceMtime !== staleness.source.mtimeMs) {
    return false;
  }
  for (const dep of staleness.deps) {
    const currentMtime = await statMtimeMs(dep.path);
    if (currentMtime === undefined || currentMtime !== dep.mtimeMs) return false;
  }
  return true;
}

/**
 * Build the RUNTIME CACHE mode extract-stage middleware (design doc Revision
 * 2, R2.2/R2.3) — the `extractLayer` capability's `layer` function.
 *
 * - `opts.cache === 'artifact'` throws immediately: that value selects the
 *   ARTIFACT-mode `target` capability (`./lib/target.ts`), not this layer —
 *   a caller mistake this constructor catches rather than silently
 *   mis-caching against.
 * - Read path: missing/format-mismatched entry, OR an entry with NO
 *   `staleness` snapshot at all (e.g. an ARTIFACT-mode-written entry — there
 *   is no stored content key for it to be validated against) → MISS. Present
 *   entry with a `staleness` snapshot whose mtimes all still match (FAST
 *   GATE) → HIT, no hashing. Present entry with a `staleness` snapshot whose
 *   mtimes DON'T match → SLOW GATE: recompute the full content key and
 *   compare; match → HIT (+ fire-and-forget mtime-refresh write so the next
 *   read is fast again); mismatch → MISS.
 * - MISS → `next()` runs the real extractor; the result is written through
 *   ATOMICALLY (temp file + `rename()`) and fire-and-forget (a slow/failing
 *   backend must never add latency to a MISS or fail the run — a write
 *   failure is swallowed, never fatal).
 *
 * Wire it as the only middleware of an extract invoker:
 *
 *   createExtractInvoker([createIrCacheLayer({ cache: cacheFile, extractorVersion })], runExtractor)
 */
export function createIrCacheLayer(
  opts: IrCacheOptions & { extractorVersion: string }
): ExtractMiddleware {
  if (opts.cache === 'artifact') {
    throw new Error(
      "apigen-plugin-ir-cache: createIrCacheLayer() (the RUNTIME CACHE 'extractLayer' " +
        "capability) received cache: 'artifact'. That value selects the ARTIFACT-mode " +
        "'target' capability instead (--type ir-cache --opt cache=artifact) — a file " +
        'path is required here. See docs/apigen/design-notes/' +
        'extract-stage-onion-and-ir-cache.md Revision 2 (R2.2).'
    );
  }

  const backend = createSingleFileBackend(opts.cache);
  const extractorVersion = opts.extractorVersion;

  async function writeThrough(
    call: ExtractCall,
    operations: Operation[],
    precomputedContentKey?: string
  ): Promise<void> {
    const contentKey = precomputedContentKey ?? (await computeCacheKey(call, extractorVersion));
    const staleness = await buildStalenessSnapshot(call, contentKey);
    await backend.put(opts.cache, {
      formatVersion: CURRENT_FORMAT_VERSION,
      operations,
      extractorVersion,
      createdAt: new Date().toISOString(),
      staleness,
    });
  }

  return async (call, next) => {
    const entry = await backend.get(opts.cache);

    // No entry, a format/version mismatch, OR no `staleness` snapshot at all
    // (an ARTIFACT-mode-written entry, or a legacy pre-Revision-2 entry) are
    // all treated as a MISS. `formatVersion`/`extractorVersion` alone cannot
    // prove the SOURCE CONTENT hasn't drifted since the entry was written —
    // there is no stored content key in this shape to validate against — so
    // trusting `entry.operations` here would (and, before this fix, did)
    // permanently launder stale data as "fresh" the moment it's first read,
    // with no future self-correction. Revalidating via one real extraction
    // is the only sound way to prove freshness when nothing was recorded;
    // the fresh result is then written through WITH a `staleness` snapshot so
    // every subsequent read gets the fast/slow gate (this is what makes
    // "switch modes without a migration" true — no manual step, just one
    // real extraction to bootstrap the fast path).
    if (
      !entry ||
      entry.formatVersion !== CURRENT_FORMAT_VERSION ||
      entry.extractorVersion !== extractorVersion ||
      !entry.staleness
    ) {
      const result = await next();
      void writeThrough(call, result).catch(() => {
        // Cache write failures are non-fatal — a failed put must never fail
        // the extraction (or the CLI run that drove it).
      });
      return result;
    }

    // Step 3 — FAST GATE: stat() only, no hashing.
    if (await fastGateHits(call, entry.staleness)) {
      return entry.operations;
    }

    // Step 4 — SLOW GATE: a real staleness snapshot exists but at least one
    // mtime disagrees with it — only a genuine content-hash compare can
    // resolve whether this is a real change or a harmless touch (e.g. a
    // fresh git checkout / CI restore that didn't preserve mtimes).
    const contentKey = await computeCacheKey(call, extractorVersion);
    if (contentKey === entry.staleness.contentKey) {
      // HIT — content genuinely unchanged despite the mtime touch. Refresh
      // the staleness snapshot fire-and-forget so the NEXT read is fast.
      void buildStalenessSnapshot(call, contentKey)
        .then((staleness) => backend.put(opts.cache, { ...entry, staleness }))
        .catch(() => {
          // Refresh-write failures are non-fatal — the slow gate will
          // simply be paid again next time, never a correctness issue.
        });
      return entry.operations;
    }

    // MISS — genuine content change.
    const result = await next();
    void writeThrough(call, result, contentKey).catch(() => {
      // See the format-mismatch branch above — never fatal.
    });
    return result;
  };
}
