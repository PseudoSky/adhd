import { mkdir, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** `<repo>/tmp/policy`: the one gitignored scratch root this package's specs write under. */
export const SCRATCH_ROOT = resolve(import.meta.dirname, '../../../../..', 'tmp', 'policy');

let counter = 0;

/**
 * Removes the scratch root only when it is empty. A non-recursive `rmdir` fails
 * with `ENOTEMPTY` while another spec file (a parallel vitest worker) still has
 * a directory inside, and with `ENOENT` when another worker already removed
 * it; both mean "nothing to do".
 */
export async function removeScratchRootIfEmpty(): Promise<void> {
  try {
    await rmdir(SCRATCH_ROOT);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error;
  }
}

/** `mkdir -p` that survives another worker removing the (momentarily empty) scratch root between the two steps. */
async function makeDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(dir, { recursive: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 5) throw error;
    }
  }
}

/**
 * Runs `fn` with a fresh real directory `tmp/policy/<name>-<pid>-<n>` and always
 * removes it (and the scratch root once empty) afterwards, so a failing test
 * leaves nothing behind.
 */
export async function withTmpDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  counter += 1;
  const dir = join(SCRATCH_ROOT, `${name}-${process.pid}-${counter}`);
  await makeDir(dir);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await removeScratchRootIfEmpty();
  }
}
