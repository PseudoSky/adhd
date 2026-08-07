// backends/single-file-backend.ts — RUNTIME CACHE mode backend (FEAT-002
// Revision 2, design doc R2.3 / implementation spec R2-1).
//
// Unlike `fs-backend.ts`'s content-addressed directory (one file PER key,
// many possible keys), this backend treats a single, literal, pre-agreed
// file path (`IrCacheOptions.cache`) as the ENTIRE cache — there is exactly
// one entry, ever. The caller already knows exactly which file to open, so
// this backend ignores the `key` parameter `IrCacheBackend` requires
// entirely; the interface is kept identical only so `createIrCacheLayer`
// doesn't need two different backend shapes for its two modes.
//
// `get()` never throws on a missing/corrupt file — that's a MISS, exactly
// like `fs-backend.ts`. `put()` writes atomically (temp file + `rename()`)
// via the shared `atomicWriteJson` helper — the fix for the review-flagged
// non-atomic-write gap.

import * as fsPromises from 'node:fs/promises';
import type { CachedExtractEntry, IrCacheBackend } from '../ir-cache-layer';
import { atomicWriteJson } from '../atomic-write-json';

/**
 * Build a single-entry `IrCacheBackend` backed by the literal file at `path`.
 *
 * @param path - Absolute or relative file path. RUNTIME CACHE mode
 *   (`IrCacheOptions.cache`) always resolves to this — never a directory.
 */
export function createSingleFileBackend(path: string): IrCacheBackend {
  return {
    async get(): Promise<CachedExtractEntry | undefined> {
      try {
        const raw = await fsPromises.readFile(path, 'utf8');
        return JSON.parse(raw) as CachedExtractEntry;
      } catch {
        // Missing file, unreadable, or corrupt JSON — all are a MISS.
        return undefined;
      }
    },
    async put(_key: string, entry: CachedExtractEntry): Promise<void> {
      await atomicWriteJson(path, entry);
    },
  };
}
