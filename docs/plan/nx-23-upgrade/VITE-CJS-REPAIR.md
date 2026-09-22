# Vite 8 CJS `import.meta.url` repair (BUG-BUILD-002)

The `vite ~6.4.3 -> ^8.3.0` bump is inseparable from the fix that makes it safe. This
document records what the defect was, the measured before/after evidence, the exact set
of configs wired, and why the rejected alternative stays rejected.

## The defect

Vite 8 replaced Rollup with **Rolldown**. Rolldown polyfills `import.meta.url` for a `cjs`
output format **only when the build platform is `node`**. Vite 8's library build defaults to
`platform: 'browser'`, so Rolldown instead lowers `import.meta` to the empty object and emits
the literal token `{}.url`. Every shipped `import.meta.url` call site is then a broken
expression at runtime:

| source expression | Rolldown CJS emission |
|---|---|
| `createRequire(import.meta.url)` | `createRequire({}.url)` → `createRequire(undefined)` → **`ERR_INVALID_ARG_VALUE` at module load** |
| `fileURLToPath(import.meta.url)` | `fileURLToPath({}.url)` |
| `import.meta.url === argv1Url` (bin guard) | `{}.url === argv1Url` — guard never fires |
| `new URL('./x', import.meta.url)` | `new URL('./x', '' + {}.url)` |

`createRequire(undefined)` throws **at module load**, so every CJS entrypoint that touches it
(`apigen-cli`, `backlog`, `agent-mcp`, the agent registry stores, …) dies on import — before
any command runs.

## Measured evidence

A/B on the same tree, same sources, only the `vite` version differing
(`entrypoint/apigen-cli`, `nx test apigen-cli`):

| toolchain | result |
|---|---|
| vite 6.4.3 (Rollup, pre-bump) | **28 files / 188 tests green** |
| vite 8.3.0 (Rolldown, defect unmitigated) | **26 failed / 162 passed** |

The 26 failures were all module-load `ERR_INVALID_ARG_VALUE` from the built CJS artifact —
not logic failures. Post-fix the built CJS artifact loads and runs (see acceptance spec
below), restoring the vite 6 behaviour on the vite 8 toolchain.

## The fix

`tools/vite-plugins/import-meta-url-cjs.mjs` — a Vite/Rolldown plugin whose `renderChunk`
hook rewrites the Rolldown-emitted `{}.url` token back to Rollup's CJS shim:

```js
require('node:url').pathToFileURL(__filename).href
```

Rolldown lowers `import.meta` during code generation, **before** `renderChunk` runs, so by the
time the hook sees the chunk `import.meta.url` is already the literal token `{}.url` (the ES
chunk still carries `import.meta.url` untouched). The plugin is **strictly format-gated** on
`outputOptions.format === 'cjs'`, and is a no-op for any chunk that never referenced
`import.meta.url` — so it is inert in the ESM bundle and in packages that don't use it.

`require('node:url')` is safe because every CJS build in this repo externalizes Node builtins
(`tools/vite-plugins/externalize.mjs`), so `require` is the real CommonJS loader at runtime.

## Why 54 configs, not just the call sites

`importMetaUrlCjs()` is prepended to the `plugins` array of **every** CJS-emitting
`vite.config.ts` (54 of them). The plugin is inert where a chunk never referenced
`import.meta.url`, so broad wiring costs nothing at runtime and stops the defect returning
the next time someone adds an `import.meta.url` to a currently-clean package.

The two browser-only packages (`packages/ui-react/ui-react-base-hooks`,
`packages/ui-react/ui-react-base-storybook`) are **deliberately left unwired**: their CJS
output is never run under Node, where `require('node:url')`/`__filename` are not defined.
The base generator spec asserts this exclusion.

### The 54 wired configs

```
entrypoint/agent-mcp/vite.config.ts
entrypoint/apigen-cli/vite.config.ts
entrypoint/backlog/vite.config.ts
entrypoint/dispatch-cli/vite.config.ts
packages/agent/agent-base-types/vite.config.ts
packages/agent/agent-core-env/vite.config.ts
packages/agent/agent-core-policy/vite.config.ts
packages/agent/agent-core-provider/vite.config.ts
packages/agent/agent-engine-orchestrator/vite.config.ts
packages/agent/agent-generator-plugin/vite.config.ts
packages/agent/agent-plugin-budget/vite.config.ts
packages/agent/agent-plugin-sanitize/vite.config.ts
packages/agent/agent-store-runtime/vite.config.ts
packages/apigen/apigen-base-errors/vite.config.ts
packages/apigen/apigen-base-logical/vite.config.ts
packages/apigen/apigen-base-schema/vite.config.ts
packages/apigen/apigen-base-types/vite.config.ts
packages/apigen/apigen-core-client/vite.config.ts
packages/apigen/apigen-engine-conformance/vite.config.ts
packages/apigen/apigen-engine-gateway/vite.config.ts
packages/apigen/apigen-engine-naming/vite.config.ts
packages/apigen/apigen-engine-runtime/vite.config.ts
packages/apigen/apigen-generator-nx/vite.config.ts
packages/apigen/apigen-plugin-api-express/vite.config.ts
packages/apigen/apigen-plugin-api-fastify/vite.config.ts
packages/apigen/apigen-plugin-batch/vite.config.ts
packages/apigen/apigen-plugin-cli-output/vite.config.ts
packages/apigen/apigen-plugin-health/vite.config.ts
packages/apigen/apigen-plugin-ir-cache/vite.config.ts
packages/apigen/apigen-plugin-java-javalin/vite.config.ts
packages/apigen/apigen-plugin-jsonschema/vite.config.ts
packages/apigen/apigen-plugin-logger/vite.config.ts
packages/apigen/apigen-plugin-mcp/vite.config.ts
packages/apigen/apigen-plugin-openapi/vite.config.ts
packages/apigen/apigen-plugin-py-flask/vite.config.ts
packages/apigen/apigen-plugin-py-grpc/vite.config.ts
packages/apigen/apigen-plugin-ts-types/vite.config.ts
packages/apigen/codegen/openapi/vite.config.ts
packages/apigen/python-env/vite.config.ts
packages/data/data-base-transforms/vite.config.ts
packages/data/data-core-structures/vite.config.ts
packages/data/data-query-engine/vite.config.ts
packages/dispatch/dispatch-base-spec/vite.config.ts
packages/dispatch/dispatch-base-types/vite.config.ts
packages/dispatch/dispatch-core-client/vite.config.ts
packages/dispatch/dispatch-core-optimizer/vite.config.ts
packages/dispatch/dispatch-orchestrator/vite.config.ts
packages/dispatch/dispatch-serializer-json/vite.config.ts
packages/environment/environment-base-spec/vite.config.ts
packages/environment/environment-builder/vite.config.ts
packages/environment/environment-core-node/vite.config.ts
packages/workspace/workspace-base-standard/vite.config.ts
packages/workspace/workspace-base-vite-paths/vite.config.ts
packages/workspace/workspace-codegen-nx/vite.config.ts
```

## ESM untouched — evidence

The format gate means the ESM bundle keeps native `import.meta.url` and carries **no** CJS
shim. Proven by the default-running acceptance spec
`entrypoint/apigen-cli/src/test/e2e/cjs-import-meta-url.spec.ts`, which reads both built
artifacts:

- `dist/index.js` (CJS): contains the `require('node:url').pathToFileURL(__filename).href`
  shim and **no** bare `{}.url`.
- `dist/index.mjs` (ESM): contains `import.meta.url` and **does not** match the CJS shim
  regex.

The spec additionally drives the built CJS artifact as a **real `node` child process**
(`require(dist)` for module-load, and `node dist/index.js --help` for the bin guard +
commander `parseAsync`) — an in-process import would prove nothing, because the defect is
created by the bundler and only manifests in the built artifact.

## Rejected alternative — `platform: 'node'`

Setting `platform: 'node'` on the library builds was tested and **rejected**. It changes the
ESM bundle and the module-resolution conditions (Node-specific condition selection and
builtin handling), i.e. it is not a CJS-only change and it perturbs the ESM output the
package consumers depend on. The format-gated `renderChunk` shim is strictly narrower: it
touches only CJS output and only the `import.meta.url` token. Do not "simplify" back to
`platform: 'node'`.

## Negative control

`docs/plan/nx-23-upgrade/scripts/neg-control-cjs-shim.mjs` mutates the built CJS artifact
only (never a tracked source file), restoring the `{}.url` token over the shim, and restores
it in a `finally` block. With the token restored, the artifact-load proof FAILS — proving the
guard's green is reachable only when the shim is genuinely present. The script fails loudly
(non-zero, no write) when the artifact is absent or carries no shim site, so the control can
never "pass" by no-op.

## Second vite-8 regression surfaced by the same bump — `vite:oxc` duplicate binding

The bump's blast radius is wider than the CJS output. Vite 8 replaces the esbuild
transform with `vite:oxc`, which is a **stricter parser**. `apigen-engine-conformance`'s
`src/test/vectors.spec.ts` imported the identifier `project` **twice** from the same module
(`@adhd/apigen-engine-naming`) — once at line 10, again inside the named-import block at
line 62. Vite 6's esbuild transform tolerated the duplicate binding; vite 8's OXC parser
rejects it with `[PARSE_ERROR] Identifier 'project' has already been declared`, failing the
whole suite at transform time (0 tests collected for that file, `Test Files 1 failed`).

Fixed by dropping the redundant second binding — the value is still imported once and used
at lines 150/213/220. This is a genuine bump regression, not a flaky test: it fails
deterministically, and it only fails under the vite 8 toolchain. It is recorded here because
it is part of the same "make the vite 8 bump safe" change set.

The other pre-commit failure on this commit (`apigen-plugin-java-javalin:test`) is a
**flaky concurrency race**: it and `apigen-engine-conformance:test` both call
`findFatJar()` → `mvn package` against the shared `packages/apigen/java/target` directory,
and under `nx affected -t test` with high parallelism the two Maven builds collide. It
passes in isolation (`mvn package` standalone → BUILD SUCCESS; `nx test
apigen-plugin-java-javalin` alone → green, and Nx itself flags the task flaky). This is not
caused by the bump and is not in this state's reservation.

## Generator anti-drift

`packages/workspace/workspace-codegen-nx`'s shared `patchViteConfig` wires `importMetaUrlCjs()`
for `platform: 'node'` and `platform: 'shared'` tiers, and **skips** `platform: 'browser'`.
The base generator spec asserts both: the node/shared config contains the import + call, and
the browser config does not contain `importMetaUrlCjs`.
