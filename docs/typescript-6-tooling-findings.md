# TypeScript 6 Tooling Findings

Two non-obvious bugs discovered while migrating this repo to TypeScript 6.0.2.

---

## 1. Cypress 13 + ts-loader: `rootDir` in tsconfig has no effect

**Symptom**

```
[tsl] ERROR
      TS5011: The common source directory of 'tsconfig.json' is './src/support'.
      The 'rootDir' setting must be explicitly set to this or another path
      to adjust your output's file layout.
```

Cypress's bundled `@cypress/webpack-batteries-included-preprocessor` uses ts-loader
**9.4.4** with `transpileOnly: true`. Inside that path, ts-loader intentionally clears
`rootDir` before calling `ts.transpileModule()`:

```js
// node_modules/ts-loader/dist/index.js : ~398
compilerOptions: { ...instance.compilerOptions, rootDir: undefined }
```

TypeScript 6 fires TS5011 whenever `outDir` is set **and** `rootDir` resolves to
`undefined` — even when you've explicitly written `"rootDir": "."` in your tsconfig,
because ts-loader overwrites it after parsing.

**Fix** — `apps/adhd-e2e/tsconfig.json`

Remove `outDir` (and `rootDir` — it was only there to fight this) and add `noEmit: true`.
Without `outDir` the precondition for TS5011 is never met; `noEmit` provides a belt-and-
suspenders skip of all output-path validation.

```diff
-   "rootDir": ".",
-   "outDir": "../../dist/out-tsc",
+   "noEmit": true,
```

The Cypress webpack preprocessor writes its own output to the Cypress cache; the tsconfig
`outDir` was never used by the actual compilation anyway.

---

## 2. Nx 18 `@nx/js:tsc` executor: temp-tsconfig breaks TypeScript 6 `paths` resolution

**Symptom** (only when building via the Nx executor, not via plain `tsc --noEmit`)

```
error TS5090: Non-relative paths are not allowed when 'baseUrl' is not set.
Did you forget a leading './'?
```

**Root cause**

`@nx/js:tsc` generates a temporary tsconfig at `tmp/…/tsconfig.generated.json` that
looks like:

```json
{
  "extends": "<original-tsconfig>",
  "compilerOptions": {
    "paths": { "@adhd/transform": ["../../packages/transform/src/index.ts"], … }
  }
}
```

The `paths` map is injected into a **new** `compilerOptions` block. TypeScript 6 requires
`baseUrl` to be present **in the same block** as `paths`; it no longer resolves `baseUrl`
from the extends chain when validating `paths`.

**Fix** — the affected package's own tsconfig (e.g. `packages/decompile/tsconfig.json`)

Add `moduleResolution: "bundler"`, `baseUrl`, and `ignoreDeprecations` together so the
inherited values are always present at the same resolution level as the injected `paths`:

```json
{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "baseUrl": "../../",
    "ignoreDeprecations": "6.0"
  }
}
```

`ignoreDeprecations: "6.0"` is required because `baseUrl` itself is deprecated in
TypeScript 6 (TS5101). Keep it **scoped to this package only** — do not add it to
`tsconfig.base.json`. The shared base should stay clean so every other package opts in
deliberately.
