// atomic-write-json.ts — shared atomic JSON write helper (FEAT-002 Revision 2,
// design doc R2.3 / implementation spec R2-1). Used by BOTH
// `backends/fs-backend.ts` (directory mode, kept for a possible future
// multi-key/shared backend) and `backends/single-file-backend.ts` (RUNTIME
// CACHE mode) so the same non-atomic-write fix isn't duplicated across the
// two backends.
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
// Uses namespace imports (`import * as fsPromises`) rather than destructured
// named imports so a test can `vi.spyOn(fsPromises, 'rename' | 'writeFile' |
// 'unlink')` and observe the exact calls this module makes at call time —
// destructured named imports bind to a local const at module-eval time and
// are NOT interceptable by a namespace-object spy.

import * as fsPromises from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Atomically write `data` (JSON-serialized) to `path`: write to a unique temp
 * file alongside `path`, then `rename()` it into place. On any failure, the
 * temp file is removed best-effort and the original error is re-thrown —
 * never masked.
 */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await fsPromises.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsPromises.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fsPromises.rename(tmp, path);
  } catch (err) {
    await fsPromises.unlink(tmp).catch(() => {
      // Best-effort cleanup only — never mask the real error below.
    });
    throw err;
  }
}
