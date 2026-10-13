import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** `<repo>/tmp/policy-core-client`: the one gitignored scratch root this package's tests write under. */
const SCRATCH_ROOT = resolve(import.meta.dirname, '../../../../../..', 'tmp', 'policy-core-client');

let counter = 0;

/**
 * Runs `fn` with a fresh real directory `tmp/policy-core-client/<name>-<n>`
 * and always removes it afterwards, so a failing test leaves nothing behind.
 */
export async function withTmpDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  counter += 1;
  const dir = join(SCRATCH_ROOT, `${name}-${process.pid}-${counter}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
