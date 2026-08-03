// backends/fs-backend.ts — local filesystem backend for the IR cache
// (FEAT-002). Content-addressed: one JSON file per key under `dir`.
//
// The remote/shared backend (HTTP GET/PUT by content hash, Nx-remote-cache
// style) is deliberately NOT built in this slice — `IrCacheBackend` is the
// seam; a shared backend is a same-shape implementation swap, and whether a
// repo wants one is a deployment decision, not an architectural one.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CachedExtractEntry,
  IrCacheBackend,
} from '../ir-cache-layer';

/**
 * Content-addressed local backend: `<dir>/<key>.json`.
 *
 * - `get` returns `undefined` on a missing/corrupt entry — a MISS must never
 *   throw (the layer treats it as "compute it").
 * - `put` is a plain write; the layer calls it fire-and-forget, so a slow
 *   filesystem can never add latency to a cache MISS.
 */
export function createLocalFsBackend(dir: string): IrCacheBackend {
  return {
    async get(key: string): Promise<CachedExtractEntry | undefined> {
      try {
        const raw = await readFile(join(dir, `${key}.json`), 'utf8');
        return JSON.parse(raw) as CachedExtractEntry;
      } catch {
        // Missing file, unreadable, or corrupt JSON — all are a MISS.
        return undefined;
      }
    },
    async put(key: string, entry: CachedExtractEntry): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${key}.json`), JSON.stringify(entry), 'utf8');
    },
  };
}
