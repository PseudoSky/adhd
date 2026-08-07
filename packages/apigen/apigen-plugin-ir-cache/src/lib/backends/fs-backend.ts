// backends/fs-backend.ts — local filesystem backend for the IR cache
// (FEAT-002). Content-addressed: one JSON file per key under `dir`.
//
// KEPT (design doc R2-0 / R2-1): not the backend used by RUNTIME CACHE mode
// any more (see `single-file-backend.ts`), but retained as-is for a possible
// future multi-key/directory-shaped backend (e.g. a shared remote store keyed
// by many entries). `get`/`put`'s signatures are untouched — only `put`'s
// write is now atomic (the same fix `single-file-backend.ts` applies), a
// strict improvement with zero behavior change to callers.
//
// The remote/shared backend (HTTP GET/PUT by content hash, Nx-remote-cache
// style) is deliberately NOT built in this slice — `IrCacheBackend` is the
// seam; a shared backend is a same-shape implementation swap, and whether a
// repo wants one is a deployment decision, not an architectural one.

import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CachedExtractEntry,
  IrCacheBackend,
} from '../ir-cache-layer';
import { atomicWriteJson } from '../atomic-write-json';

/**
 * Content-addressed local backend: `<dir>/<key>.json`.
 *
 * - `get` returns `undefined` on a missing/corrupt entry — a MISS must never
 *   throw (the layer treats it as "compute it").
 * - `put` writes atomically (temp file + `rename()`); the layer calls it
 *   fire-and-forget, so a slow filesystem can never add latency to a MISS.
 */
export function createLocalFsBackend(dir: string): IrCacheBackend {
  return {
    async get(key: string): Promise<CachedExtractEntry | undefined> {
      try {
        const raw = await fsPromises.readFile(join(dir, `${key}.json`), 'utf8');
        return JSON.parse(raw) as CachedExtractEntry;
      } catch {
        // Missing file, unreadable, or corrupt JSON — all are a MISS.
        return undefined;
      }
    },
    async put(key: string, entry: CachedExtractEntry): Promise<void> {
      await atomicWriteJson(join(dir, `${key}.json`), entry);
    },
  };
}
