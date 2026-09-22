/**
 * Vite/Rolldown plugin: restore Rollup's `import.meta.url` polyfill in CJS output.
 *
 * THE BUG (BUG-BUILD-002). Vite 8 swapped Rollup for Rolldown. Rolldown only
 * polyfills `import.meta.url` for a `cjs` output format when the build platform
 * is `node`; Vite 8's library build defaults to `platform: 'browser'`, so
 * Rolldown instead lowers `import.meta` to an empty object and emits
 * `{}.url`. Every shipped `import.meta.url` call site therefore becomes a
 * broken expression at runtime:
 *
 *   createRequire(import.meta.url)  ->  createRequire({}.url)  // undefined arg
 *   fileURLToPath(import.meta.url)  ->  fileURLToPath({}.url)
 *   import.meta.url === argvUrl     ->  {}.url === argvUrl     // bin guard never fires
 *   new URL('./x', import.meta.url) ->  new URL('./x', ''+{}.url)
 *
 * `createRequire(undefined)` throws `ERR_INVALID_ARG_VALUE` at MODULE LOAD, so
 * every CJS entrypoint that touches it (apigen-cli, backlog, agent-mcp, the
 * agent registry stores, …) dies on import. Verified A/B against a pinned
 * vite 6.4.3 (Rollup), which emits the `pathToFileURL(__filename).href` shim
 * these sources were written against and passes.
 *
 * WHY A `renderChunk` HOOK AND NOT A `define`. Rolldown lowers `import.meta`
 * during code generation, *before* `renderChunk` runs — by the time this hook
 * sees the chunk, `import.meta.url` is already the literal token `{}.url`
 * (confirmed empirically for all five call-site shapes; the ES chunk still
 * carries `import.meta.url` untouched). So the shim is applied by rewriting
 * that Rolldown artifact back to the Rollup-equivalent expression. A
 * format-agnostic `define`/`transform` would corrupt the ES build, where
 * `import.meta.url` is genuinely valid — hence the strict
 * `outputOptions.format === 'cjs'` gate: this plugin is a no-op for `es`/`iife`/
 * `umd` output and for any chunk that never referenced `import.meta.url`.
 *
 * `require('node:url')` is safe here because every CJS build in this repo
 * externalizes Node builtins (see `externalize.mjs`), so `require` is the real
 * CommonJS loader at runtime.
 */

/** The exact token Rolldown emits for `import.meta.url` in a browser-platform CJS chunk. */
const EMPTY_IMPORT_META_URL = '{}.url';

/** Rollup's CJS `import.meta.url` shim — what the repo's sources were written against. */
const CJS_IMPORT_META_URL_SHIM =
  "require('node:url').pathToFileURL(__filename).href";

/**
 * Vite plugin factory. Add `importMetaUrlCjs()` to any `vite.config.ts` whose
 * `build.lib.formats` includes `'cjs'`. It is inert everywhere else, so wiring
 * it broadly across CJS-emitting builds (rather than hand-picking the call
 * sites that happen to use `import.meta.url` today) is deliberate — it stops
 * the defect returning the next time someone adds an `import.meta.url` to a
 * package that was previously clean.
 *
 * @returns {import('vite').Plugin}
 */
export function importMetaUrlCjs() {
  return {
    name: 'adhd-import-meta-url-cjs',
    apply: 'build',
    renderChunk(code, _chunk, outputOptions) {
      if (outputOptions.format !== 'cjs') return null;
      if (!code.includes(EMPTY_IMPORT_META_URL)) return null;
      return {
        code: code.replaceAll(EMPTY_IMPORT_META_URL, CJS_IMPORT_META_URL_SHIM),
        map: null,
      };
    },
  };
}
