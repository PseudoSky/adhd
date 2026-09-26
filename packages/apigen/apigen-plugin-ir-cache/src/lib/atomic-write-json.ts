// atomic-write-json.ts — shared atomic + DURABLE JSON write helper (FEAT-002
// Revision 2, design doc R2.3 / implementation spec R2-1; durability added by
// the bake-IR-at-build work, design doc Revision 3). Used by BOTH
// `backends/fs-backend.ts` (directory mode, kept for a possible future
// multi-key/shared backend) and `backends/single-file-backend.ts` (RUNTIME
// CACHE mode) so the same fix isn't duplicated across the two backends.
//
// `rename()` on the same filesystem is atomic (POSIX guarantee): a concurrent
// reader mid-`get()` always observes either the complete OLD file or the
// complete NEW file, never a half-written one. The `pid + randomUUID()`
// temp-file suffix avoids two concurrent writers racing on the SAME temp
// path; the *last* `rename()` wins — an accepted, documented race (design doc
// R2.8 open question 2): both writers computed the same extraction
// independently for byte-identical input, so losing one temp write costs
// nothing but a redundant (already-completed) extraction, never corruption.
//
// ATOMIC is documented for the temp-file content; DURABLE (surviving a crash
// or a `SIGKILL` immediately after `put()` resolves) additionally requires the
// bytes to have reached stable storage BEFORE the rename is published, which
// is why the temp file is written through a real `FileHandle` and `sync()`ed
// before `rename()`. Without that fsync, a host that resolves its `put()`
// promise and is then killed can leave a rename pointing at a temp file whose
// page-cache contents were never flushed — the exact
// `ir-cache.durability.e2e.ts` failure this closes. The parent DIRECTORY is
// then synced best-effort so the rename's directory entry is itself durable;
// that second sync is guarded because it is genuinely optional (some
// filesystems refuse to open/fsync a directory: `EISDIR`/`EINVAL` on Windows,
// `EPERM` under some containers, `ENOTSUP`/`EACCES` elsewhere) and a filesystem
// that cannot fsync a directory still gets the file-content guarantee above.
//
// Uses namespace imports (`import * as fsPromises`) rather than destructured
// named imports so a test can `vi.spyOn(fsPromises, 'rename' | 'open' |
// 'unlink')` and observe the exact calls this module makes at call time —
// destructured named imports bind to a local const at module-eval time and
// are NOT interceptable by a namespace-object spy.

import * as fsPromises from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Filesystem error codes that mean "this platform/filesystem cannot fsync a
 * directory", not "the write failed". The entry-content fsync above has
 * already succeeded by the time this runs, so a directory-sync refusal is a
 * documented, non-fatal degradation — never a reason to fail the write.
 */
const DIR_SYNC_UNSUPPORTED_CODES = new Set([
  'ENOTSUP',
  'EISDIR',
  'EINVAL',
  'EPERM',
  'EACCES',
]);

/**
 * Best-effort fsync of the directory a rename just published into, so the new
 * directory entry itself survives a crash. Never throws: an unsupported
 * directory fsync is swallowed, and any other failure is swallowed too (the
 * file-content fsync already ran, and a caller's `put()` contract is about the
 * entry being complete and its bytes flushed — the dir-sync is extra credit).
 */
async function fsyncParentDirBestEffort(dir: string): Promise<void> {
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(dir, 'r');
    await handle.sync();
  } catch (err) {
    // Best-effort and never fatal. ENOTSUP/EISDIR/EINVAL/EPERM/EACCES are the
    // documented "this platform/filesystem refuses to fsync a directory" cases
    // and return explicitly; any other error falls through (implicitly
    // returning) and is equally non-fatal, because the entry's own bytes were
    // already fsync'd before the rename — failing here would turn a successful
    // durable write into a spurious error.
    if (
      DIR_SYNC_UNSUPPORTED_CODES.has((err as NodeJS.ErrnoException).code ?? '')
    ) {
      return;
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => {
        // Best-effort close only — the directory sync is already over.
      });
    }
  }
}

/**
 * Atomically AND durably write `data` (JSON-serialized) to `path`: write to a
 * unique temp file alongside `path` through a `FileHandle`, `fsync` that
 * handle so the bytes are on stable storage, then `rename()` it into place,
 * then best-effort `fsync` the parent directory so the rename itself is
 * durable. The returned promise resolves only once all of that has happened —
 * callers may treat it as "the entry is durably published", which is exactly
 * the guarantee `IrCacheBackend.put`'s contract now requires (design doc
 * Revision 3). On any failure the temp file is removed best-effort and the
 * original error is re-thrown — never masked.
 */
export async function atomicWriteJson(
  path: string,
  data: unknown
): Promise<void> {
  const dir = dirname(path);
  await fsPromises.mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(tmp, 'w');
    await handle.writeFile(JSON.stringify(data), 'utf8');
    // Flush content+metadata to stable storage BEFORE the rename publishes it,
    // so a crash right after `rename` can never leave a temp file whose bytes
    // were only ever in the page cache.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsPromises.rename(tmp, path);
    await fsyncParentDirBestEffort(dir);
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {
        // Best-effort close only — never mask the real error below.
      });
    }
    await fsPromises.unlink(tmp).catch(() => {
      // Best-effort cleanup only — never mask the real error below.
    });
    throw err;
  }
}
