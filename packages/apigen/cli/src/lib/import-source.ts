import { pathToFileURL } from 'node:url'

/**
 * Dynamically import a (possibly TypeScript) source module, registering the tsx
 * ESM loader for the duration of the import so that `.ts` entry files resolve in
 * a plain `node` process. The loader is unregistered afterward so no global hook
 * leaks into the rest of the run.
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
  const url = pathToFileURL(absSource).href

  // Lazy import keeps tsx out of the module graph when the entry is plain JS.
  let unregister: (() => void | Promise<void>) | undefined
  try {
    const { register } = await import('tsx/esm/api')
    // register() with no namespace returns a callable Unregister; honor an
    // explicit tsconfig when one was resolved.
    unregister = register(tsconfig ? { tsconfig } : undefined)
  } catch {
    // tsx unavailable — fall back to a bare dynamic import below.
  }

  try {
    return (await import(url)) as Record<string, unknown>
  } finally {
    await unregister?.()
  }
}
