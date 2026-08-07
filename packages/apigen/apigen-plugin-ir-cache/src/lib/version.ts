// version.ts — default `extractorVersion` resolution (FEAT-002 Revision 2,
// design doc R2.2's `IrCacheOptions.extractorVersion` doc comment: "defaults
// to `@adhd/apigen-core-client`'s own `package.json` version"). Same
// mechanism `entrypoint/backlog/src/server.ts`'s `CORE_CLIENT_VERSION`
// already uses (`createRequire` + reading the dependency's `package.json`),
// reused here so both `./index.ts`'s default `irCachePlugin` and
// `./target.ts`'s ARTIFACT-mode `generate()` agree on the same fallback.
//
// BUG-APIGEN-IR-CACHE-VERSION-DIRNAME-LEAK-001: this file previously used
// `typeof __dirname !== 'undefined' ? __dirname : process.cwd()` to detect
// CJS-vs-ESM (the package's own `tsc` project type-checked under
// `module: commonjs`, which rejects `import.meta` syntax — TS1343 — even
// though the shipped bundle also has an ESM `.mjs` build). That heuristic is
// unsound: Node's `node -e "<script>"` CJS eval wrapper sets a GLOBAL
// `__dirname = '.'` (there's no real file backing the eval), and an
// undeclared free variable inside a dynamically-`import()`ed ESM module
// falls through to that same realm global — so `typeof __dirname` reported
// `"string"` (not `"undefined"`) and `base` resolved to the bogus relative
// `"."`, making `path.join(base, 'noop.js')` collapse to the bare string
// `"noop.js"` and `createRequire('noop.js')` throw
// `ERR_INVALID_ARG_VALUE`. Reproduced end-to-end via a real
// `node -e "import(<built .mjs>)"` — the exact shape
// `dist-entry-no-argv-side-effect.spec.ts` drives.
//
// The fix: use `import.meta.url` directly and unconditionally — exactly the
// pattern `entrypoint/backlog/src/server.ts`'s own `CORE_CLIENT_VERSION`
// already uses (`const requirePkg = createRequire(import.meta.url);`, no
// `__dirname` fallback at all). `createRequire` accepts a `file://` URL
// string directly, and Rollup transforms `import.meta.url` correctly for
// BOTH shipped formats — left as-is for the ESM build, shimmed to
// `pathToFileURL(__filename).href` for the CJS build — so there is no
// CJS/ESM branch to get wrong, and (unlike the removed `__dirname` check)
// nothing here can be fooled by a stray global from the caller's own
// execution context. The TS1343 obstacle (`import.meta` needs an
// ESNext-family `module` target) is resolved the same way the proven bin
// entry-point guards resolve it: `module: esnext` + `moduleResolution:
// bundler` scoped to this package's `tsconfig.lib.json` type-check step
// only — Rollup still emits both `dist/index.mjs` and `dist/index.js` per
// this package's own `vite.config.ts` (`formats: ['es', 'cjs']`).

import { createRequire } from 'node:module';

const requirePkg = createRequire(import.meta.url);

let cachedVersion: string | undefined;

/**
 * The installed `@adhd/apigen-core-client` version — the default
 * `extractorVersion` stamped into a cache entry when the caller doesn't
 * supply an explicit override. Memoized: `package.json` doesn't change
 * within a process lifetime.
 */
export function readDefaultExtractorVersion(): string {
  cachedVersion ??= (
    requirePkg('@adhd/apigen-core-client/package.json') as { version: string }
  ).version;
  return cachedVersion;
}
