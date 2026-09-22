# vite-cjs-import-meta-repair — The vite bump and its CJS fix land as one commit

**Phase:** intake · **Kind:** work · **Depends on:** upgrade-baseline · **Guard:** `test -f tools/vite-plugins/import-meta-url-cjs.mjs && test "$(git log -1 --format=%H -- tools/vite-plugins/import-meta-url-cjs.mjs)" = "$(git log -1 --format=%H -- package.json)" && ./node_modules/.bin/nx build apigen-cli && ./node_modules/.bin/nx build backlog && node entrypoint/apigen-cli/dist/index.js --help | grep -q "Usage: apigen" && node entrypoint/backlog/dist/index.js --help | grep -q "install-skill" && node -e "const fs=require('fs');for(const f of ['entrypoint/apigen-cli/dist/index.js','entrypoint/backlog/dist/index.js']){const t=fs.readFileSync(f,'utf8');if(t.includes('{}.url')){console.error('EMPTY_IMPORT_META_URL in '+f);process.exit(1)}}console.log('CJS_ARTIFACTS_LOAD')"`

---

## Goal

The working tree's in-flight vite 8 CJS work is verified, committed, and inseparable
from the version bump it exists to make safe. After this state, no commit anywhere on the
branch carries `vite ^8.3.0` without also carrying the fix that keeps every built CommonJS
entrypoint loadable.

---

## Semantic distillation

- **The bump and the fix are one commit, by construction.** The guard asserts that the
  plugin file and `package.json` were last touched by the *same* commit SHA. That is the
  whole point of this state: a version-pin guard let `BUG-BUILD-002` hide, so the gate here
  proves *atomicity and loadability*, never a version string.
- **The work is already in the working tree — verify it, do not rewrite it.** The plugin,
  the 54 config wirings, the acceptance spec and the generator anti-drift are uncommitted
  changes. Your job is to confirm they are complete and coherent, then commit them.
- **The defect.** Vite 8 swapped Rollup for Rolldown. Rolldown polyfills `import.meta.url`
  for a `cjs` output format only when the build platform is `node`; Vite 8's library build
  defaults to `platform: 'browser'`, so `import.meta` is lowered to `{}` and every shipped
  `createRequire(import.meta.url)` becomes `createRequire(undefined)`, throwing
  `ERR_INVALID_ARG_VALUE` at *module load*. Measured before the fix: `apigen-cli:test`
  28 files / 188 tests green on vite 6.4.3, 26 failed / 162 passed on vite 8.3.0.
- **The fix.** `tools/vite-plugins/import-meta-url-cjs.mjs` is a `renderChunk` hook,
  strictly gated on `outputOptions.format === 'cjs'`, that rewrites the Rolldown-emitted
  `{}.url` token back to Rollup's `require('node:url').pathToFileURL(__filename).href`.
  A `define`/`transform` would corrupt the ESM build, where `import.meta.url` is genuinely
  valid — hence the format gate, and hence criterion `.8`.
- **Why wiring 54 configs rather than only the call sites.** The plugin is inert where a
  chunk never referenced `import.meta.url`, so broad wiring is deliberate: it stops the
  defect returning the next time someone adds `import.meta.url` to a package that is clean
  today.
- **`platform: 'node'` was tested and rejected.** It changes the ESM bundle and the
  module-resolution conditions — it is not the one-line alternative it looks like. Do not
  "simplify" to it.
- **A grep over built artifacts has one known false positive.** The generator source carries
  the string `{}.url` inside a *comment*, so a naive repo-wide grep reports
  `packages/workspace/workspace-codegen-nx/dist/.../generator.js`. The criteria scope the
  token assertion to real entrypoint bundles for exactly this reason.

---

## Contract promise

```text
added:    ["tools/vite-plugins/import-meta-url-cjs.mjs", "entrypoint/apigen-cli/src/test/e2e/cjs-import-meta-url.spec.ts", "docs/plan/nx-23-upgrade/scripts/neg-control-cjs-shim.mjs", "docs/plan/nx-23-upgrade/VITE-CJS-REPAIR.md"]
modified: ["package.json", "pnpm-lock.yaml", "tools/vite-plugins/README.md", 54 vite.config.ts, "packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts", "packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts"]
deleted:  []
```

---

## Commit points

- **One commit, both halves.** `fix(vite): restore import.meta.url in CJS output under vite 8`
  carrying the plugin + the 54 wirings + the acceptance spec + the generator anti-drift
  **and** `package.json`/`pnpm-lock.yaml` (the `vite ~6.4.3 → ^8.3.0` bump).
- Do not split it. A commit that bumps vite without the fix is precisely the broken state
  this state exists to prevent, and the guard's atomicity leg will refuse it.
- Write `VITE-CJS-REPAIR.md` recording: the measured before/after test counts, the 54 wired
  configs, the ESM-untouched evidence, and the rejected `platform: 'node'` alternative.

---
## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [vite-cjs-import-meta-repair.1] The built CommonJS entrypoints load and run as real processes, not merely declare the bumped version

- [vite-cjs-import-meta-repair.2] The default-running acceptance spec drives the BUILT CJS artifact and passes
- [vite-cjs-import-meta-repair.3] Every CJS-emitting vite config in the workspace is wired to the shared shim
- [vite-cjs-import-meta-repair.4] The shared format-gated shim plugin exists
- [vite-cjs-import-meta-repair.5] The default-running acceptance spec exists
- [vite-cjs-import-meta-repair.6] The package generator wires the shim for node and shared tiers, so a new package cannot re-introduce the defect
- [vite-cjs-import-meta-repair.7] The generator spec asserts the browser tier is deliberately left unwired
- [vite-cjs-import-meta-repair.8] The shim is format-gated: the ESM bundle keeps native import.meta.url and carries no CommonJS shim
- [vite-cjs-import-meta-repair.9] Restoring the empty-import-meta token in the built CJS artifact makes the artifact-load proof fail
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "tsconfig.base.json", "entrypoint/apigen-cli/project.json", "entrypoint/backlog/project.json"]
mutates:    ["tools/vite-plugins/import-meta-url-cjs.mjs", "tools/vite-plugins/README.md", "entrypoint/apigen-cli/src/test/e2e/cjs-import-meta-url.spec.ts", "packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts", "packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts", "docs/plan/nx-23-upgrade/scripts/neg-control-cjs-shim.mjs", "docs/plan/nx-23-upgrade/VITE-CJS-REPAIR.md", "package.json", "pnpm-lock.yaml", "entrypoint/agent-mcp/vite.config.ts", "entrypoint/apigen-cli/vite.config.ts", "entrypoint/backlog/vite.config.ts", "entrypoint/dispatch-cli/vite.config.ts", "packages/agent/agent-base-types/vite.config.ts", "packages/agent/agent-core-env/vite.config.ts", "packages/agent/agent-core-policy/vite.config.ts", "packages/agent/agent-core-provider/vite.config.ts", "packages/agent/agent-engine-orchestrator/vite.config.ts", "packages/agent/agent-generator-plugin/vite.config.ts", "packages/agent/agent-plugin-budget/vite.config.ts", "packages/agent/agent-plugin-sanitize/vite.config.ts", "packages/agent/agent-store-runtime/vite.config.ts", "packages/apigen/apigen-base-errors/vite.config.ts", "packages/apigen/apigen-base-logical/vite.config.ts", "packages/apigen/apigen-base-schema/vite.config.ts", "packages/apigen/apigen-base-types/vite.config.ts", "packages/apigen/apigen-core-client/vite.config.ts", "packages/apigen/apigen-engine-conformance/vite.config.ts", "packages/apigen/apigen-engine-gateway/vite.config.ts", "packages/apigen/apigen-engine-naming/vite.config.ts", "packages/apigen/apigen-engine-runtime/vite.config.ts", "packages/apigen/apigen-generator-nx/vite.config.ts", "packages/apigen/apigen-plugin-api-express/vite.config.ts", "packages/apigen/apigen-plugin-api-fastify/vite.config.ts", "packages/apigen/apigen-plugin-batch/vite.config.ts", "packages/apigen/apigen-plugin-cli-output/vite.config.ts", "packages/apigen/apigen-plugin-health/vite.config.ts", "packages/apigen/apigen-plugin-ir-cache/vite.config.ts", "packages/apigen/apigen-plugin-java-javalin/vite.config.ts", "packages/apigen/apigen-plugin-jsonschema/vite.config.ts", "packages/apigen/apigen-plugin-logger/vite.config.ts", "packages/apigen/apigen-plugin-mcp/vite.config.ts", "packages/apigen/apigen-plugin-openapi/vite.config.ts", "packages/apigen/apigen-plugin-py-flask/vite.config.ts", "packages/apigen/apigen-plugin-py-grpc/vite.config.ts", "packages/apigen/apigen-plugin-ts-types/vite.config.ts", "packages/apigen/codegen/openapi/vite.config.ts", "packages/apigen/python-env/vite.config.ts", "packages/data/data-base-transforms/vite.config.ts", "packages/data/data-core-structures/vite.config.ts", "packages/data/data-query-engine/vite.config.ts", "packages/dispatch/dispatch-base-spec/vite.config.ts", "packages/dispatch/dispatch-base-types/vite.config.ts", "packages/dispatch/dispatch-core-client/vite.config.ts", "packages/dispatch/dispatch-core-optimizer/vite.config.ts", "packages/dispatch/dispatch-orchestrator/vite.config.ts", "packages/dispatch/dispatch-serializer-json/vite.config.ts", "packages/environment/environment-base-spec/vite.config.ts", "packages/environment/environment-builder/vite.config.ts", "packages/environment/environment-core-node/vite.config.ts", "packages/workspace/workspace-base-standard/vite.config.ts", "packages/workspace/workspace-base-vite-paths/vite.config.ts", "packages/workspace/workspace-codegen-nx/vite.config.ts"]
```

---

## Notes for executor

Land the in-flight vite 8 CJS `import.meta.url` fix and the vite bump in ONE commit.
The guard proves atomicity (the plugin file and `package.json` were last touched by the same
commit SHA) **and** that the built CJS artifacts actually load as real processes. A version-pin
guard is what let `BUG-BUILD-002` hide: the old guard read `devDependencies.vite === "^8.3.0"`
and went green while the tree was broken.

**Order matters inside this state.** The guard builds `apigen-cli` and `backlog` before it
loads them. If the build is cache-hit from a pre-fix run, force a real rebuild by changing an
input — never `--skip-nx-cache`.

**Do not touch the 54 wirings' plugin ordering.** `importMetaUrlCjs()` is prepended to each
`plugins` array; `test-resolution-absorbed` later adds `sourceResolution()` to eight of the
same files, and the two are independent.

**The negative-control criterion runs after a criterion that builds.** The harness ignores the
mutate step's exit code, so `neg-control-cjs-shim.mjs` fails loudly when the artifact is
absent or carries no shim site — that is what keeps the control honest.
