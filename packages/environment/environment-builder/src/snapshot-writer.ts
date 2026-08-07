/**
 * `snapshot-writer.ts` — the optional, on-disk snapshot artifact
 * (ARCHITECTURE.md §2.1: `.write()` is a cross-process handoff / drift
 * inspection artifact, never a read prerequisite).
 *
 * Salvaged from the pre-redesign builder: the atomic tmp-file + `renameSync`
 * write (`[inv:atomic-write]`) and owner-only file/dir permissions (the
 * snapshot may carry secret env-var *names*, even though never plaintext
 * secret values).
 */

import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SNAPSHOT_FILENAME } from '@adhd/environment-base-spec';

import type { Roots } from './roots';
import { rootForScope } from './roots';
import type { Scope } from '@adhd/environment-base-spec';

/** Resolves the on-disk snapshot path for the active scope's root:
 *  `<root>/adhd-environment.json`. */
export function resolveSnapshotPath(roots: Roots, scope: Scope): string {
  return join(rootForScope(roots, scope), SNAPSHOT_FILENAME);
}

export interface AtomicWriteOptions {
  /** POSIX file mode for the written file. Defaults to `0o600` (owner
   *  read/write only) — the snapshot may carry secret env-var *names*
   *  (never plaintext values), so it must never be created world-readable. */
  mode?: number;
  /** POSIX mode for the created parent directory. Defaults to `0o700`. */
  dirMode?: number;
}

export const DEFAULT_SNAPSHOT_FILE_MODE = 0o600;
export const DEFAULT_SNAPSHOT_DIR_MODE = 0o700;

/**
 * Atomically writes `data` (JSON-stringified unless already a string) to
 * `filePath`: creates the parent directory tree if needed, writes to
 * `<filePath>.tmp` (created owner-only), then `renameSync`s over `filePath`.
 * `renameSync` on the same filesystem is atomic — a reader can never observe
 * a partially-written file. The tmp file is `unlinkSync`ed if the write or
 * rename throws, so a mid-write failure never leaves a stale, world-readable
 * `.tmp` behind.
 */
export function atomicWrite(filePath: string, data: unknown, opts: AtomicWriteOptions = {}): void {
  const fileMode = opts.mode ?? DEFAULT_SNAPSHOT_FILE_MODE;
  const dirMode = opts.dirMode ?? DEFAULT_SNAPSHOT_DIR_MODE;
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: dirMode });
  chmodSync(dir, dirMode);

  const tmpPath = `${filePath}.tmp`;
  const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  try {
    writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: fileMode });
    chmodSync(tmpPath, fileMode);
    renameSync(tmpPath, filePath);
    chmodSync(filePath, fileMode);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup — surface the original error below */
    }
    throw err;
  }
}
