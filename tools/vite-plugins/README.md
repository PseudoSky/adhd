# vite-plugins

Vite plugins (loaded by vite, NOT Nx). `externalize.mjs` = externalizeRealDeps bundling policy. `source-resolution.mjs` = `nxViteTsPathsPre()` — a pre-ordered (`enforce: 'pre'`), serve-scoped (`apply: 'serve'`) copy of Nx's tsconfig-paths plugin, so workspace `@adhd/*` imports resolve to `src` during tests (Vite's built-in `vite:resolve` otherwise wins first and resolves them to `dist`). `import-meta-url-cjs.mjs` = restores Rollup's `import.meta.url` CJS shim under Vite 8/Rolldown (BUG-BUILD-002; wire it into every **node/shared** CJS-emitting config). `import-meta-url-browser-cjs.mjs` = the `platform:browser` sibling: rewrites the same Rolldown `{}.url` token to a browser-valid base (`document.currentScript.src` → `location.href`) for cjs/umd output, WITHOUT the node shim's `require`/`__filename` (which do not exist in a browser chunk). Wire exactly one of the two per config — never both. `copy-readme.mjs` = transitional (to be retired once @adhd/nx-assets covers it).

## BUG-062 exception — real-Node child-process projects

`nxViteTsPathsPre()` only reorders the vitest **parent** graph. A test that spawns a **real Node child process** (e.g. `spawnSync(process.execPath, [<built dist entry>])`, or an esbuild bundle that keeps `@adhd/*` external) resolves `@adhd/*` through `node_modules` to the dependency's built `dist`, and **cannot** be made to follow the parent's tsconfig paths. Applying the plugin to such a project would run the parent against `src` and the child against `dist` — one test run, two builds of one package. Those projects therefore deliberately **do NOT** use the plugin and stay consistently all-`dist`, keeping `^build` in their test `dependsOn`:

- `entrypoint/agent-mcp` (`src/__tests__/main-entry-symlink.test.ts`)
- `entrypoint/dispatch-cli` (`src/test/cli-smoke.spec.ts`, compiled bin)
- `packages/agent/agent-engine-compiler` (`src/__tests__/compile-cli*.test.ts`)
- `packages/apigen/apigen-engine-conformance` (`src/test/gate-workspace-root.spec.ts`)

Every generated `vite.config.ts` carries a `NOTE (test resolution)` caution at the `plugins:` site, and `@adhd/workspace-codegen-nx`'s `source-resolution-optout.spec.ts` pins the invariant repo-wide (every `vite.config.ts` either uses the plugin or is a known opt-out — never both, never neither). Do not re-add the plugin to an opted-out project.

**Generator caveat:** this file is listed in `nx.json` `namedInputs.sharedGlobals`, so *any* edit to it (even a comment) marks all ~63 projects affected and makes the pre-commit hook run a full-workspace `nx affected -t test`. Correct a comment here only when you are prepared for that.

