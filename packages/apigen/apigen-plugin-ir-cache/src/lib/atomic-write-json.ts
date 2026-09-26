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
// ATOMIC is documented for the temp-file content; DURABLE — meaning it
// survives the PROCESS being SIGKILLed or the OS crashing immediately after
// `put()` resolves (not a power cut; see the scope note below) — additionally
// requires the bytes to have been fsync(2)'d BEFORE the rename is published,
// which is why the temp file is written through a real `FileHandle` and
// `sync()`ed before `rename()`. Without that fsync, a host that resolves its
// `put()` promise and is then killed can leave a rename pointing at a temp file
// whose contents were never flushed past the writer — the exact
// `ir-cache.durability.e2e.ts` failure this closes. The parent DIRECTORY is
// then synced best-effort so the rename's directory entry itself is published;
// that second sync is genuinely optional (some filesystems refuse to open/fsync
// a directory) and ALL of its failures are swallowed — the file-content fsync is
// the guarantee, the dir sync is extra credit.
//
// SCOPE — `FileHandle.sync()` is `fsync(2)` (Node exposes no `fdatasync`), and
// on some platforms (e.g. macOS/APFS) `fsync(2)` does not force the drive's own
// write cache to media — that needs `F_FULLFSYNC`, which Node does not expose.
// The guarantee here is therefore crash-of-PROCESS / crash-of-OS, not
// power-loss.
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
 * Best-effort fsync of the directory a rename just published into, so the new
 * directory entry itself is published. NEVER throws: every failure — including
 * the ones platforms routinely raise when a directory cannot be fsync'd
 * (`ENOTSUP`/`EISDIR`/`EINVAL`/`EPERM`/`EACCES`, plus anything else) — is
 * swallowed, because the entry's own content fsync already ran and a caller's
 * `put()` contract is about the entry's bytes, not the directory entry. There
 * is deliberately no allow-list of "expected" codes: distinguishing them would
 * not change the control flow (both would fall through to the same return), so
 * an allow-list here is an honest no-op dressed up as a decision.
 */
async function fsyncParentDirBestEffort(dir: string): Promise<void> {
  let handle: fsPromises.FileHandle | undefined;
  try {
    handle = await fsPromises.open(dir, 'r');
    await handle.sync();
  } catch {
    // Intentionally swallowed in full — see this function's doc. The
    // entry-content fsync is the durability guarantee; failing here would turn
    // a successful durable write into a spurious error.
  } finally {
    if (handle) {
      await handle.close().catch(() => {
        // Best-effort close only — the directory sync is already over.
      });
    }
  }
}

/**
 * Atomically AND durably (against process/OS crash — see the scope note at the
 * top of this file) write `data` (JSON-serialized) to `path`: write to a
 * unique temp file alongside `path` through a `FileHandle`, `fsync` that
 * handle, then `rename()` it into place, then best-effort `fsync` the parent
 * directory. The returned promise resolves only once all of that has happened
 * — callers may treat it as "the entry is published with its bytes fsync'd",
 * which is exactly the guarantee `IrCacheBackend.put`'s contract now requires
 * (design doc Revision 3). On any failure the temp file is removed best-effort
 * and the original error is re-thrown — never masked.
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
    // fsync the content+metadata BEFORE the rename publishes the file, so a
    // process killed (or OS crash) right after `rename` cannot leave a temp
    // file whose bytes were never written past the writer. This is the
    // process/OS-crash guarantee; see the scope note at the top of this file
    // for why it is not a power-loss guarantee.
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
