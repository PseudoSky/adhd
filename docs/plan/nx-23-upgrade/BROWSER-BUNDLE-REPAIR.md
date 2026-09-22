# Browser bundle repair — `ui-react-base-hooks` cjs/umd `import.meta.url`

**State:** `browser-cjs-umd-repair` (phase: intake)
**Branch:** `perf/nx-upgraded`
**Depends on:** `browser-package-build-repair`

## Symptom

`useFileDownload`'s worker path constructs a worker from a URL relative to
`import.meta.url`:

```ts
new Worker(new URL('./worker.ts', import.meta.url));
```

Under vite 8 the browser-platform cjs/umd bundles emit Rolldown's empty-import-meta
token, so the base becomes `undefined`:

```js
new Worker(new URL(`/assets/worker-<hash>.js`, `` + {}.url));  // '' + undefined
```

`new URL('/assets/…', 'undefined')` throws **`TypeError: Invalid URL`**. The package's
`main` and `exports.require` both point at `dist/index.js`, so the defect reaches every
CommonJS consumer of the hook.

## Red before (re-confirmed)

`{}.url` count = **1** in `dist/index.js` and **1** in `dist/index.umd.js`; the guard's
node check printed `EMPTY_IMPORT_META_URL in …/dist/index.js` and exited 1. The spec did
not yet exist (`vitest` exited 1, "No test files found"). `dist/index.mjs` carried native
`import.meta.url` and **no** token — i.e. only the cjs/umd formats were affected.

## Decision — family (b): a browser-valid, format-gated replacement

Two families were on the table:

- **(a) Remove the `import.meta.url` dependency from the hook entirely.**
- **(b) Add a browser-appropriate, format-gated replacement for the token.**

**Chosen: (b).** Family (a) is ruled out by the acceptance criteria themselves: criterion
`.4` requires the ES bundle to **still carry native `import.meta.url`**. The hook's worker
call site is the package's only `import.meta.url`, so deleting it from the source would
empty the ES bundle too — failing `.4`. The ES output must stay native while the cjs/umd
output gets an environment-correct expression, and that split can only be made at the
bundler boundary, which is exactly what a `renderChunk` hook provides.

`tools/vite-plugins/import-meta-url-browser-cjs.mjs` rewrites the Rolldown token to:

```js
((typeof document!=='undefined'&&document.currentScript&&document.currentScript.src)
  ||(typeof location!=='undefined'&&location.href)||'')
```

- `document.currentScript.src` is the UMD bundle's own URL — the closest browser analogue
  of a module URL. It is `null` once the script has executed (e.g. inside a React render),
  so the live fallback is `location.href`, which is always a real URL in a browser.
- The Vite-emitted worker asset path is **absolute** (`/assets/worker-<hash>.js`), so
  resolving it against `location.href` yields a correct absolute URL.
- The whole expression is wrapped in outer parentheses because Rolldown emits the base as
  `` `` + {}.url ``. Without the wrap, `a || b` would parse as `('' + a) || b`, and
  `'' + null` is the truthy string `"null"` — the fallback would never run.

The plugin is strictly format-gated on `cjs`/`umd` and is a no-op for any chunk that never
referenced `import.meta.url`, so the ES bundle is untouched.

### Why the node shim is NOT a valid browser fix

The sibling `import-meta-url-cjs.mjs` rewrites the same token to
`require('node:url').pathToFileURL(__filename).href`. That expression is correct **only
under Node**: in a browser chunk neither `require` nor `__filename` exists, so wiring it
into this `platform:browser` package would trade `undefined` for a **`ReferenceError`** at
the call site — a different runtime failure, not a fix. The guard therefore asserts the
node shim's *absence* (`__filename`, `node:url`) alongside the token's absence, so the
wrong fix fails the gate as loudly as no fix at all.

`platform: 'node'` on the library build was also rejected (as recorded in
`VITE-CJS-REPAIR.md`): it perturbs the ES bundle and module-resolution conditions, so it is
not a cjs-only change.

## Changes

- `tools/vite-plugins/import-meta-url-browser-cjs.mjs` — new plugin.
- `packages/ui-react/ui-react-base-hooks/vite.config.ts` — wires `importMetaUrlBrowserCjs()`.
- `packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/index.ts` — comment at
  the worker call site recording the split (no behavioural change).
- `packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/import-meta-url.spec.ts`
  — the acceptance spec.
- `tools/vite-plugins/README.md` — documents the browser sibling and the wire-one-not-both rule.

## Verification

The default-running spec `import-meta-url.spec.ts` reads the **built bundles** (not the
source) and asserts:

1. no `{}.url` in `dist/index.js` or `dist/index.umd.js`;
2. no `__filename` and no `node:url` in either;
3. `dist/index.mjs` still carries native `import.meta.url` and no CJS shim.

The guard additionally reads both bundles with `node -e`, and `dist/index.mjs` for the ESM
assertion.

## Negative control

`docs/plan/nx-23-upgrade/scripts/neg-control-browser-bundle.mjs` injects the empty-import-meta
token into a built bundle (`dist/index.js`, `dist/index.umd.js`) as a live statement
(`globalThis.__psmEmptyImportMetaUrl = ({}.url);`), backs each file up beside itself, and
restores it in a `finally` block. With the token restored the guard's node check fails
(`EMPTY_IMPORT_META_URL in …/dist/index.js`), proving the green is reachable only when the
token is genuinely absent. The script exits non-zero and writes nothing when a target
artifact is absent or already carries the token, so the control can never "pass" by no-op.

## Out of scope

- `packages/ui-react/ui-react-base-storybook` also emits cjs/umd and is deliberately
  unwired, but it is `private: true` — never published — so a token in its bundle reaches
  no consumer. Left alone.
- Generator wiring for the `platform: browser` tier (so future browser packages get this
  plugin automatically, mirroring `patchViteConfig`'s node/shared wiring) is not in this
  state's reservation and is left as a follow-up.
