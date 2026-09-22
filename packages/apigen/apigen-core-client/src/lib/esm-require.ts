// esm-require.ts — environment-agnostic lazy `require` for a dual ESM/CJS build.
//
// WHY THIS EXISTS (review 663d463c / BUG-APIGEN-CORE-CLIENT-ESM-REQUIRE-001):
// The S-20 startup fix lazily loads `ts-morph` / `ts-json-schema-generator`
// with `require(...)` so a caller that never touches the extraction path does
// not pay the ~1–2s module-load cost. That `require` was a bare free
// variable: correct in the CommonJS build (`dist/index.js`, where Node
// provides `require` natively) but a `ReferenceError: require is not defined`
// in the ESM build (`dist/index.mjs`) — Rollup externalizes the dependency
// and emits `require('ts-morph')` verbatim, and ESM has no `require` binding.
// Every newly-gated path (e.g. `collectLocalImportPaths` → `getProjectCtor`)
// therefore threw at runtime while every in-repo test stayed green, because
// tests resolve SOURCE through the CJS/tsconfig-paths loader, never the
// shipped `.mjs`.
//
// THE FIX: synthesize a `require` from this module's own URL with
// `createRequire` — the exact pattern already proven in this repo at
// `apigen-plugin-ir-cache/src/lib/version.ts` and
// `apigen-engine-conformance/src/lib/gate.ts`. `import.meta.url` is left
// as-is for the ESM build and shimmed by Rollup to a
// `pathToFileURL(__filename).href` equivalent for the CJS build, so there is
// no CJS/ESM branch to get wrong and nothing that a caller's stray global can
// fool. (The `module: esnext` + `moduleResolution: bundler` override in
// `tsconfig.lib.json` is what lets the type-check step accept `import.meta`.)
//
// LAZINESS IS PRESERVED: importing this module costs one `node:module`
// builtin require and nothing else — it does not pull either heavy
// dependency. That is the property `startup-lazy-load.spec.ts` guards.

import { createRequire } from 'node:module';

/**
 * A `require` bound to this module's own location — the ESM-safe replacement
 * for a bare `require(...)` in code bundled to BOTH `dist/index.js` (CJS) and
 * `dist/index.mjs` (ESM). Resolves bare specifiers from this package's
 * `node_modules` exactly as the CJS build's native `require` does, and (like
 * the native `require`) exposes `.resolve`, so it is a drop-in for both
 * `require(x)` and `require.resolve(x)` call sites.
 *
 * The `@ts-ignore` below suppresses TS1343 in DOWNSTREAM packages only.
 * `apigen-core-client` is the base of the apigen family, so every consumer's
 * `vite-plugin-dts` type-check follows this package's SOURCE through the
 * tsconfig path mapping — and each consumer pins `module: commonjs` in its own
 * `tsconfig.json`, where `import.meta` is rejected (TS1343). This file is only
 * ever TYPE-CHECKED downstream, never emitted by it (the consumer emits its
 * own declarations; the JS here is bundled by Rollup, which shims
 * `import.meta.url` per output format) — so suppressing the diagnostic is
 * scoped and safe. `@ts-ignore` (not `@ts-expect-error`) is deliberate: this
 * package's own build runs `module: esnext`, where no diagnostic exists, so an
 * expect-error directive would itself fail as unused. The rule-disable above
 * the `@ts-ignore` is the established repo pattern for this exact suppression
 * (see packages/data/data-query-engine/src/lib/expressions.ts).
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
export const lazyRequire: NodeRequire = createRequire(import.meta.url);
