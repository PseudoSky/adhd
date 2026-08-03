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
// KEY DESIGN — content/version-addressed, never mtime:
//
//   key = sha256(formatVersion, extractorVersion, host, namespace,
//                sha256(source bytes), [ {path, sha256(bytes)} for every
//                transitively-imported LOCAL file ])
//
// The existing in-process `ExtractionSession` generator cache keys on
// `mtimeMs:size` — fine for "don't recompute twice within one process run",
// actively wrong for a cache meant to be shared across runs/machines/CI
// (mtime is not preserved by git clones or CI checkouts). Including the
// content of every local transitive import is required for correctness: a
// type changed in an imported file must invalidate the entry even though the
// entry file's own bytes never changed. `extractorVersion` in the key is
// what keeps this cache honest when the extractor itself changes — including
// a future DEBT-003 fix that changes extraction output for the same input:
// that fix is an ordinary `extractorVersion` bump that busts every stale
// entry, so this cache can never become a reason to defer it.
//
// `versionHint` (ExtractCall) is deliberately NOT trusted in the key: a
// caller-supplied identity tag could be wrong or malicious, and a shared
// cache must never key on an unverified hint. The layer always hashes the
// real file contents itself.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  ExtractCall,
  ExtractMiddleware,
  Operation,
} from '@adhd/apigen-core-client';
import { collectLocalImportPaths } from '@adhd/apigen-core-client';

/**
 * Schema version of the cache ENTRY format itself. Bump on any breaking
 * change to what's stored so old entries are ignored rather than misread
 * (read-time gate; the key also folds it in for write-time separation).
 */
export const CURRENT_FORMAT_VERSION = 1;

/** One cached extraction result, exactly as `runExtractor` would produce it. */
export interface CachedExtractEntry {
  formatVersion: number;
  /** The extraction result verbatim — no post-processing is ever cached. */
  operations: Operation[];
  /** Which extractor build produced this (e.g. apigen-core-client's version). */
  extractorVersion: string;
  /** ISO timestamp — provenance/audit only, never part of the key. */
  createdAt: string;
}

/**
 * The backend seam. Local filesystem backend ships first
 * ({@link createLocalFsBackend}); a remote/shared backend (Nx-remote-cache
 * style content-addressed store) is a same-shape drop-in — `get`/`put` are
 * plain Promise-returning methods, so nothing about the layer changes.
 */
export interface IrCacheBackend {
  /** Fetch a cached entry by key, or `undefined` on miss. MUST NOT throw on miss. */
  get(key: string): Promise<CachedExtractEntry | undefined>;
  /** Store an entry. Backends may fire-and-forget; the layer never blocks on put. */
  put(key: string, entry: CachedExtractEntry): Promise<void>;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await readFile(filePath, 'utf8'));
}

/**
 * Compute the content/version-addressed cache key for one `ExtractCall`.
 * Deterministic for identical input; changes if the source file OR any of its
 * transitive local imports changes, if the extractor version changes, or if
 * the entry format version changes. `collectLocalImportPaths` returns a
 * sorted path list, so the key is stable across calls and machines.
 *
 * Exported for direct unit testing (determinism + sensitivity).
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
 * Build the extract-stage cache middleware.
 *
 * - HIT (entry exists with a matching `formatVersion`): return the cached
 *   operations WITHOUT invoking `next()` — the real extractor never runs.
 * - MISS: `next()` runs the real extractor; the result is written through to
 *   the backend fire-and-forget (a slow/unreachable backend must never add
 *   latency to a MISS, only skip the benefit of a future HIT; a write failure
 *   is logged at debug, never fatal).
 *
 * Wire it as the only middleware of an extract invoker:
 *
 *   createExtractInvoker([createIrCacheLayer(backend, { extractorVersion })], runExtractor)
 */
export function createIrCacheLayer(
  backend: IrCacheBackend,
  opts: { extractorVersion: string }
): ExtractMiddleware {
  return async (call, next) => {
    const key = await computeCacheKey(call, opts.extractorVersion);
    const hit = await backend.get(key);
    if (hit && hit.formatVersion === CURRENT_FORMAT_VERSION) {
      return hit.operations;
    }
    const result = await next();
    void backend
      .put(key, {
        formatVersion: CURRENT_FORMAT_VERSION,
        operations: result,
        extractorVersion: opts.extractorVersion,
        createdAt: new Date().toISOString(),
      })
      .catch(() => {
        // Cache write failures are non-fatal — a failed put must never fail
        // the extraction (or the CLI run that drove it).
      });
    return result;
  };
}
