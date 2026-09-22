/**
 * Vite/Rolldown plugin: give `import.meta.url` a browser-valid value in CJS/UMD
 * output. The browser sibling of `import-meta-url-cjs.mjs`.
 *
 * THE DEFECT. Vite 8's Rolldown polyfills `import.meta.url` for a `cjs`/`umd`
 * output format only when the build platform is `node`. A `platform: 'browser'`
 * library build instead lowers `import.meta` to the empty object and emits the
 * literal token `{}.url`, so every shipped call site is broken at runtime:
 *
 *   new URL('./worker.ts', import.meta.url) -> new URL('./worker.ts', '' + {}.url)
 *                                              -> new URL(..., 'undefined')
 *                                              -> TypeError: Invalid URL
 *
 * WHY NOT THE NODE SHIM. `import-meta-url-cjs.mjs` rewrites the same token to
 * `require('node:url').pathToFileURL(__filename).href`. That expression is
 * correct under Node and wrong in a browser chunk: neither `require` nor
 * `__filename` exists there, so wiring it into a `platform:browser` package
 * would trade `undefined` for `ReferenceError` at the call site. The two
 * plugins therefore rewrite the same token to two different, environment-correct
 * expressions, and each is gated to the build platforms where its expression is
 * valid.
 *
 * WHY A `renderChunk` HOOK AND NOT A `define`. Rolldown lowers `import.meta`
 * during code generation, before `renderChunk` runs, so the hook sees the
 * literal token and rewrites it. A format-agnostic `define`/`transform` would
 * corrupt the ES bundle, where `import.meta.url` is genuinely valid — hence the
 * strict `cjs`/`umd` gate: this plugin is a no-op for `es` output and for any
 * chunk that never referenced `import.meta.url`.
 *
 * WHY THE OUTER PARENTHESES. Rolldown emits the base as the expression
 * `` `` + {}.url ``. A bare `a || b` replacement would parse as
 * `('' + a) || b` — `'' + null` is the truthy string `"null"`, so the fallback
 * would never run. Wrapping the whole shim in parentheses keeps it a single
 * operand of the surrounding `+`.
 */

/** The exact token Rolldown emits for `import.meta.url` in a browser-platform CJS/UMD chunk. */
const EMPTY_IMPORT_META_URL = '{}.url';

/**
 * A browser-valid `import.meta.url` replacement. The `<script src>` of a UMD
 * bundle is the closest analogue to a module URL; `document.currentScript` is
 * null once the script has finished executing (e.g. inside a React render), so
 * `location.href` is the guaranteed fallback. `location.href` is always a real
 * URL in a browser, so `new URL(relative, base)` never throws. The trailing
 * `''` keeps the expression string-typed for non-browser SSR hosts.
 */
const BROWSER_IMPORT_META_URL_SHIM =
  "((typeof document!=='undefined'&&document.currentScript&&document.currentScript.src)||(typeof location!=='undefined'&&location.href)||'')";

/**
 * Vite plugin factory. Add `importMetaUrlBrowserCjs()` to any `vite.config.ts`
 * whose `build.lib.formats` includes `'cjs'`/`'umd'` AND whose package is
 * `platform:browser`. It is inert everywhere else.
 *
 * @returns {import('vite').Plugin}
 */
export function importMetaUrlBrowserCjs() {
  return {
    name: 'adhd-import-meta-url-browser-cjs',
    apply: 'build',
    renderChunk(code, _chunk, outputOptions) {
      if (outputOptions.format !== 'cjs' && outputOptions.format !== 'umd') {
        return null;
      }
      if (!code.includes(EMPTY_IMPORT_META_URL)) return null;
      return {
        code: code.replaceAll(
          EMPTY_IMPORT_META_URL,
          BROWSER_IMPORT_META_URL_SHIM
        ),
        map: null,
      };
    },
  };
}
