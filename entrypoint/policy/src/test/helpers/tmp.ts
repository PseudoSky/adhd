import { mkdir, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll } from 'vitest';

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

/** Per-file source of private scratch directories; see {@link useScratchDirs}. */
export interface IScratchDirs {
  /** Creates a new empty directory, distinct from every other one this file made, and returns its absolute path. */
  readonly fresh: (label?: string) => Promise<string>;
  /** `fresh(label)` then `fn(dir)`; the directory is left for the file's single `afterAll` to remove. */
  readonly with: <T>(label: string, fn: (dir: string) => Promise<T>) => Promise<T>;
}

/**
 * Registers, for the spec file that calls it at the top level, ONE scratch parent
 * `tmp/policy/<name>-<pid>-<n>` that is removed in a single `afterAll` (a failing
 * test still gets cleaned up, because `afterAll` runs regardless). `fresh()` then
 * hands each test (or a `beforeAll`) its own empty directory under that parent.
 *
 * Why not {@link withTmpDir} per test: that removes the directory recursively and
 * then tries to remove the shared scratch root after EVERY test, and with parallel
 * vitest workers those root-level `rmdir`/`mkdir` calls contend (the `ENOENT`
 * retry loop in `makeDir`), which shows up as per-test IO spikes. Here the root is
 * touched once at the start and once at the end of the file, and the tests in
 * between only create a leaf directory. Directories are never shared between
 * `fresh()` calls, so a test that mutates its directory cannot affect another.
 */
export function useScratchDirs(name: string): IScratchDirs {
  counter += 1;
  const parent = join(SCRATCH_ROOT, `${name}-${process.pid}-${counter}`);
  let parentReady: Promise<void> | undefined;
  let made = 0;
  afterAll(async () => {
    await rm(parent, { recursive: true, force: true });
    await removeScratchRootIfEmpty();
  });
  const fresh = async (label = 'd'): Promise<string> => {
    parentReady ??= makeDir(parent);
    await parentReady;
    made += 1;
    const dir = join(parent, `${label}-${made}`);
    await mkdir(dir);
    return dir;
  };
  return { fresh, with: async (label, fn) => fn(await fresh(label)) };
}
