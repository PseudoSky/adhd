# browser-cjs-umd-repair — The browser package's bundles carry no empty-import-meta token

**Phase:** intake · **Kind:** work · **Depends on:** browser-package-build-repair · **Guard:** `./node_modules/.bin/nx build ui-react-base-hooks && ./node_modules/.bin/vitest run --config packages/ui-react/ui-react-base-hooks/vite.config.ts packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/import-meta-url.spec.ts && node -e "const fs=require('fs');for(const f of ['packages/ui-react/ui-react-base-hooks/dist/index.js','packages/ui-react/ui-react-base-hooks/dist/index.umd.js']){const t=fs.readFileSync(f,'utf8');if(t.includes('{}.url')){console.error('EMPTY_IMPORT_META_URL in '+f);process.exit(1)}if(t.includes('__filename')||t.includes('node:url')){console.error('NODE_SHIM_IN_BROWSER_BUNDLE in '+f);process.exit(1)}}console.log('BROWSER_BUNDLES_CLEAN')"`

---

## Goal

Both `dist/index.js` (the package's `main` / `exports.require` entry) and
`dist/index.umd.js` are free of Rolldown's empty-import-meta token, and free of the Node-only
shim that would trade one runtime error for another. `useFileDownload`'s worker path resolves
a real base URL in a browser context.

---

## Semantic distillation

- **The node shim is not a valid answer here, and the guard enforces that.** The shared
  plugin's replacement expression needs `require` and `__filename`, neither of which exists in
  a browser chunk — wiring it into a `platform:browser` package would trade `undefined` for
  `ReferenceError`. Criterion `.1` therefore asserts the shim's *absence* (`__filename`,
  `node:url`) alongside the token's absence, so the wrong fix fails the gate as loudly as no
  fix at all.
- **The failure.** `src/lib/use-file-download/index.ts:130` constructs
  `new Worker(new URL('./worker.ts', import.meta.url))`. Under vite 8 with the browser
  platform, `import.meta.url` becomes `{}.url` → `undefined`, so the base URL is undefined
  and the constructor throws `TypeError: Invalid URL`. The package's `main` and
  `exports.require` both point at the broken CJS entry, so the defect reaches every
  CommonJS consumer.
- **The mechanism is yours to resolve; the outcome is pinned.** Two viable families are on
  the table — remove the `import.meta.url` dependency from the hook entirely (the worker path
  is a `useMemo` branch behind `typeof Worker !== 'undefined' && size > MAX_FILE_SIZE`), or
  add a browser-appropriate, format-gated replacement that is valid without `require`/
  `__filename`. Record which you chose and why in `BROWSER-BUNDLE-REPAIR.md`.
- **`platform: 'node'` is rejected — do not reach for it.** Verified: it changes the ESM
  bundle and the module-resolution conditions, and it is not a single-line change.
- **Out of scope, with reason.** `packages/ui-react/ui-react-base-storybook` also emits
  `cjs`/`umd` and is deliberately unwired, but it is `private: true` — it is never
  published, so a token in its bundle reaches no consumer. Leave it alone.
- **The spec must drive the BUILT bundles.** The defect is created by the bundler; a
  source-level unit test would pass while the shipped artifact is broken. Criterion `.3`
  enforces that the spec reads `dist/`.

---

## Contract promise

```text
added:    ["packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/import-meta-url.spec.ts", "tools/vite-plugins/import-meta-url-browser-cjs.mjs", "docs/plan/nx-23-upgrade/scripts/neg-control-browser-bundle.mjs", "docs/plan/nx-23-upgrade/BROWSER-BUNDLE-REPAIR.md"]
modified: ["packages/ui-react/ui-react-base-hooks/vite.config.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/index.ts", "tools/vite-plugins/README.md"]
deleted:  []
```

---

## Commit points

- `fix(ui-react-base-hooks): stop emitting Rolldown's empty import.meta token in the
  browser bundles` — the hook/config change, the browser acceptance spec, the plugin (if the
  replacement family is chosen), the tools README, and `BROWSER-BUNDLE-REPAIR.md`.
- Do **not** stage `packages/ui-react/ui-react-base-hooks/dist/**` — build output is
  gitignored and must never be committed.

---
## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [browser-cjs-umd-repair.1] Both browser CJS and UMD bundles are free of the empty-import-meta token and of the node-only shim

- [browser-cjs-umd-repair.2] The default-running browser acceptance spec exists
- [browser-cjs-umd-repair.3] The spec asserts against the BUILT bundles, not the source, because the defect is created by the bundler
- [browser-cjs-umd-repair.4] The ESM bundle still carries native import.meta.url and is left untouched
- [browser-cjs-umd-repair.5] The decision record states why the node shim is not a valid browser fix
- [browser-cjs-umd-repair.6] Injecting the empty-import-meta token into a built browser bundle makes the bundle assertion fail
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "packages/ui-react/ui-react-base-hooks/package.json", "packages/ui-react/ui-react-base-hooks/project.json", "docs/plan/nx-23-upgrade/BROWSER-BUILD-REPAIR.md"]
mutates:    ["packages/ui-react/ui-react-base-hooks/vite.config.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/index.ts", "packages/ui-react/ui-react-base-hooks/src/lib/use-file-download/import-meta-url.spec.ts", "tools/vite-plugins/import-meta-url-browser-cjs.mjs", "tools/vite-plugins/README.md", "docs/plan/nx-23-upgrade/scripts/neg-control-browser-bundle.mjs", "docs/plan/nx-23-upgrade/BROWSER-BUNDLE-REPAIR.md"]
```

---

## Notes for executor

`packages/ui-react/ui-react-base-hooks` is `platform:browser` and was deliberately NOT
wired into the node CJS shim — its bundle never runs under Node. Under vite 8 that leaves both
`dist/index.js` (the package's `main` / `exports.require` entry) and `dist/index.umd.js`
carrying Rolldown's empty-import-meta token, so `useFileDownload`'s worker path
(`new URL('./worker.ts', …)`) throws `TypeError: Invalid URL`. This blocks publishing the
package.

**The node plugin is NOT a valid fix here.** Its shim needs `require`/`__filename`, which do
not exist in a browser chunk. Criterion `.1` asserts the node shim is absent from the browser
bundles for exactly this reason — a naive "wire the plugin everywhere" pass fails the gate.

**Observation caveat, recorded honestly.** The token's presence in these bundles was verified by
the reviewing pass, which built the package by bypassing the `vite-plugin-dts` type-check. It
was **not** independently reproduced during the 2026-09-21 plan-repair pass, because
`nx build ui-react-base-hooks` fails earlier on the React-19 type errors — which is why
`browser-package-build-repair` exists and must land first. Re-confirm the token's presence
(and the guard's red) as your first step, and record the result in `BROWSER-BUNDLE-REPAIR.md`.

**Spec must drive the BUILT bundles** — the defect is created by the bundler, so a
source-level test proves nothing. Read `dist/index.js`, `dist/index.umd.js` and
`dist/index.mjs`, and assert:
1. no `{}.url` in either CJS or UMD bundle;
2. no `__filename` and no `node:url` in either (the node shim was not misapplied);
3. `dist/index.mjs` still carries native `import.meta.url`.

**`ui-react-base-storybook` is explicitly out of scope** — it is `private: true` and never
published. Do not wire it.
