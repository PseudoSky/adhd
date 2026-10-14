import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IPolicyDecider } from './ports.js';

function assertDecider(value: unknown, what: string): IPolicyDecider {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { decide?: unknown }).decide !== 'function'
  ) {
    throw new Error(`${what}: not an IPolicyDecider (missing decide function)`);
  }
  return value as IPolicyDecider;
}

/**
 * Resolve a decider.
 *
 * - An object is returned as-is after checking `typeof decide === 'function'`.
 * - A string is dynamically imported. A bare package name resolves from this
 *   package's own location; an absolute or relative (`./`, `../`) path resolves
 *   against `baseDir` (default `process.cwd()`). The module must export
 *   `createDecider(options)` returning an `IPolicyDecider` (sync or async).
 *
 * Any failure throws a plain `Error` whose message names the specifier.
 *
 * @param decider A decider object or a module specifier / path.
 * @param deciderOptions Handed to `createDecider` when `decider` is a string.
 * @param baseDir Directory that relative paths resolve against.
 */
export async function loadDecider(
  decider: IPolicyDecider | string,
  deciderOptions?: Record<string, unknown>,
  baseDir?: string
): Promise<IPolicyDecider> {
  if (typeof decider !== 'string') {
    return assertDecider(decider, 'policy decider object');
  }
  const specifier = decider;
  try {
    if (specifier.length === 0) throw new Error('empty specifier');
    const isPath =
      isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../');
    const target = isPath
      ? pathToFileURL(resolve(baseDir ?? process.cwd(), specifier)).href
      : specifier;
    const mod = (await import(/* @vite-ignore */ target)) as {
      createDecider?: unknown;
    };
    if (typeof mod.createDecider !== 'function') {
      throw new Error('module has no createDecider export');
    }
    const made = await (mod.createDecider as (o: Record<string, unknown>) => unknown)(
      deciderOptions ?? {}
    );
    return assertDecider(made, 'createDecider result');
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`apigen-plugin-policy: cannot load decider "${specifier}": ${cause}`);
  }
}
