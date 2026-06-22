export type AnyFn = (...args: unknown[]) => unknown

/** Wrapper keys produced by ESM/CJS interop that we unwrap rather than treat as fn names. */
const WRAPPER_KEYS = new Set(['default', 'module.exports', '__esModule'])

/**
 * Build a `name → function` table from an imported module namespace, matching how
 * schema extraction names functions so `dispatch` can always resolve them.
 *
 * Robust to every export + interop shape:
 *  - **named exports** (`export function f` / `export const f = …`) → keyed by name.
 *  - **single default-exported function** (`export default f`) → keyed by the
 *    function's declaration name (ESM keys it `default`; CJS-compiled deps double-
 *    wrap it as `default.default` / `module.exports.default`). We unwrap those
 *    layers and key every function found by its `.name`.
 *  - **default object** (`export default { a, b }`) → each function keyed by name.
 *
 * Earlier keys win; explicit named exports are never overwritten by unwrapped ones.
 */
export function buildFnTable(
  mod: Record<string, unknown>,
): Record<string, AnyFn> {
  const fns: Record<string, AnyFn> = {}
  const visit = (obj: Record<string, unknown>, depth: number): void => {
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'function') {
        // A real named export → key by its export name.
        if (!WRAPPER_KEYS.has(key) && !(key in fns)) fns[key] = val as AnyFn
        // Any function → also key by its declaration name. This recovers
        // default-exported and CJS-interop-wrapped functions whose export key is
        // `default` but whose schema/route name is the declared identifier.
        const declName = (val as { name?: string }).name
        if (declName && !(declName in fns)) fns[declName] = val as AnyFn
      } else if (
        val &&
        typeof val === 'object' &&
        depth < 2 &&
        WRAPPER_KEYS.has(key)
      ) {
        // Unwrap default / module.exports / CJS-interop nesting (bounded depth).
        visit(val as Record<string, unknown>, depth + 1)
      }
    }
  }
  visit(mod, 0)
  return fns
}
