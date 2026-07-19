import { pathToFileURL } from 'node:url';

/**
 * Dynamically import a (possibly TypeScript) source module, registering both the
 * tsx ESM loader and the tsx CJS `require` patch for the duration of the import so
 * that `.ts` entry files resolve in a plain `node` process. Both loaders are
 * unregistered afterward so no global hook leaks into the rest of the run.
 *
 * Both hooks are required, not just the ESM one: when the target (or a package it
 * imports) has no `"type": "module"` in its nearest package.json — as internal
 * workspace libs commonly don't — Node's ESM loader detects the `.ts` file as
 * CommonJS and routes it through the CJS translator, which drives real
 * `require()` calls for every relative import. Those requires use Node's classic
 * CJS resolver, not the ESM resolve hook, so a source written with the
 * NodeNext-style `./db.js` specifier (resolving to `./db.ts` on disk) fails with
 * `MODULE_NOT_FOUND` unless `tsx/cjs/api` has also patched CJS resolution.
 * Registering only `tsx/esm/api` reproduces exactly this failure; the full `tsx`
 * CLI works because it patches both loaders — this mirrors that.
 *
 * Under a transpiling test runner (vitest) tsx registration is a harmless no-op,
 * so this same path works in-repo and standalone.
 *
 * @param absSource - Absolute path to the source file to import.
 * @param tsconfig  - Optional tsconfig.json path to drive tsx's transpilation.
 * @returns The imported module namespace.
 */
export async function importSource(
  absSource: string,
  tsconfig?: string
): Promise<Record<string, unknown>> {
  const url = pathToFileURL(absSource).href;

  // Lazy import keeps tsx out of the module graph when the entry is plain JS.
  let unregisterEsm: (() => void | Promise<void>) | undefined;
  let unregisterCjs: (() => void) | undefined;
  try {
    const { register } = await import('tsx/esm/api');
    // register() with no namespace returns a callable Unregister; honor an
    // explicit tsconfig when one was resolved.
    unregisterEsm = register(tsconfig ? { tsconfig } : undefined);
  } catch {
    // tsx unavailable — fall back to a bare dynamic import below.
  }
  try {
    // tsx/cjs/api's register() takes no tsconfig option — it resolves tsconfig
    // per-file the same way the tsx CLI does, so this is safe regardless of
    // `tsconfig`.
    const { register } = await import('tsx/cjs/api');
    unregisterCjs = register();
  } catch {
    // tsx unavailable — CJS-format targets will fail to resolve `.js`-mapped
    // relative specifiers, same as before this fix.
  }

  try {
    return (await import(url)) as Record<string, unknown>;
  } finally {
    await unregisterEsm?.();
    unregisterCjs?.();
  }
}
