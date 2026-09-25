# ADR-0003 — `@adhd/*` packages publish CommonJS-only

**Status:** ACCEPTED (2026-09-25).
**Owner:** pseudosky.
**Supersedes:** nothing.
**Drives:** `788c57a5` (CJS `yaml` named import leaked into consumers' ESM bundles), `0f12198b` (externalizeRealDeps assumes every externalized dep is dual-format), `b8db4e3c` (`environment-cli` same defect, unswept), `98142eab` (`verify-dist-load` only existence-checks `bin` packages), `a99fe8dd` (module format ungoverned; `type` split across the repo), `2ea64778` and `b6b88a13` (the same class, previously resolved), `f58babc9`/`2f5e64dc` (adjacent schema defects, not this decision).
**Grounding:** owner approval 2026-09-25 ("you have my approval from here on"), given in direct response to this migration + ADR being listed as awaiting approval; the `architect-decision` verdict of 2026-09-25 (CJS-only, risk LOW, ADR required); measured evidence below.

## TL;DR for the next agent

**`@adhd/*` packages publish CommonJS-only**: a single `"main": "./dist/index.js"`, **`type` unset**, **no `module` field**, **no `exports` map**. The ESM (`.mjs`) half of the current dual build is removed and **must not be reintroduced piecemeal** — it is re-opened as a decision only when the runtime-critical third-party dependencies are themselves ESM or dual-format.

**The trap to avoid:** `type` is currently **split** across the repo — ten `agent/*` packages declare `"type": "module"` while every other publisher leaves it unset. Those ten emit **ESM syntax in `dist/index.js`**, so *deleting `"type": "module"` without re-emitting real CJS output produces an immediate `SyntaxError: Cannot use import statement outside a module`*. This migration is **not** a `package.json` edit; those ten packages must be re-emitted.

## Context

**The dual ESM build is the sole source of a recurring breakage class, and has produced four incidents.** Every one is "ESM emitted over a CJS dependency"; none is "CJS too slow" or "CJS too big":

| item | state | what happened |
|---|---|---|
| `2ea64778` | RESOLVED | `@adhd/backlog` ESM entry threw on import — named import from CJS-only dep |
| `b6b88a13` | VERIFIED | published tarball crashed at mount |
| `788c57a5` | RESOLVED (unmerged) | `environment-builder`'s CJS `yaml` named import emitted verbatim into every consumer ESM bundle that externalizes `yaml` |
| `0f12198b` | OPEN | `tools/vite-plugins/externalize.mjs` externalizes by name with no dual-format validation |

**Every runtime-critical dependency is CommonJS-only** (read from each package's own `package.json`): `@modelcontextprotocol/sdk` → `type: "commonjs"`, **no `module` field**; `ts-morph@23.0.0`, `pino@10.3.1`, `express@5.2.1`, `fastify@4.29.1` → CJS, no `module` field; `yaml@1.10.3` → root export is `./index.js` (CJS) with **no `import` condition** (its `./util` and `./types` subpaths do ship `.mjs`). Even `yaml@2.9.1`'s root is CJS.

**The runtime is CJS, and the ESM half does no work for Node.** Sampled publishers set `main: ./dist/index.js` + `module: ./dist/index.mjs` with **no `exports` map** — so Node ignores `module` entirely and always resolves `main` → CJS. The `.mjs` is consumed **only by bundlers** (unless a consumer deep-imports it, which is how the breakage surfaced).

**ESM buys no tree-shaking here — measured, not assumed.** With esbuild against `yaml@2.9.1`: importing **only** `{ parse }` → **198,068 bytes** raw (~100 KB minified); `export * from 'yaml'` → **103,389 bytes** minified. Asking for one function costs the same as the whole library, because a CJS root is one opaque unit to rollup/esbuild. The published `@adhd/apigen-plugin-ir-cache@0.1.1` is the consequence: **309,216 bytes**, ~88% of it that one library, for a call site that uses only `parse` (`environment-builder/src/layer-files.ts:13`). **The headline argument for ESM does not hold in this repo while the deps are CJS.**

**`verify-dist-load` is the mechanism that has been containing this** — it is wired into CI (`.github/workflows/ci.yml:54`, `pull-request.yml:125`) and into `nx-release-publish.dependsOn` (`tools/nx-plugins/build/plugin.js:113`), which is why the broken dist never shipped. It has a hole: `existenceOnly = hasBin` (`tools/nx-plugins/build/executors/verify/verify-dist-load.mjs:163`) means a package that declares a `bin` is only **stat**'d, never **executed** (`98142eab`).

**No ADR governed module format.** This catalog held only `adhd ADR-0001` (stores → sox-store adapter; forbids env feature toggles) and `adhd ADR-0002` (correct the source, never work around). Neither addresses module format, so the `type` split above is ungoverned.

## Decision

### D1 — `@adhd/*` publishes CommonJS-only

Every published `@adhd/*` package declares exactly:
`"main": "./dist/index.js"`, **`"type"` unset**, **no `"module"`**, **no `"exports"` map**.

A single CJS entry is the whole artifact contract. `exports` is deliberately **not** added: adding one would re-introduce a second resolution surface (conditions) and re-open the class this ADR closes.

### D2 — The ESM build is removed, and not reintroduced piecemeal

The `.mjs` emit is deleted from every `vite.config.ts` that produces one (55 of 61 today), and `"module"` is removed from every `package.json`.

**Re-open condition (the ADR is re-opened as a decision, not amended silently):** the runtime-critical dependencies — `@modelcontextprotocol/sdk`, `ts-morph`, `pino`, `express`, `fastify`, `yaml` — are themselves ESM or dual-format. At that point this ADR is superseded deliberately.

**Rationale:** CJS-only **structurally eliminates** the whole incident class in Context. `import { parse } from 'yaml'` failed because ESM was emitted over a CJS dep; CJS requiring CJS has no interop seam to get wrong. This is a removal of the broken mechanism, not a workaround for it (`adhd ADR-0002`).

### D3 — `verify-dist-load` must EXECUTE the entry, never merely check existence

`existenceOnly = hasBin` (`verify-dist-load.mjs:163`) must be replaced so that **every** package's entry — including `bin` packages — is actually loaded (executed) by the gate, not stat'd.

**This is part of this decision, not a follow-on.** Without it, a CJS-only move trades a broken-`.mjs` blind spot for a broken-`.js` blind spot: today `bin` packages are exactly where a broken entry can ship unseen. Tracked as `98142eab`.

### D4 — The migration RE-EMITS; it does not flip `type`

The `type` field is split today: ten `agent/*` packages declare `"type": "module"` (`agent-core-env`, `agent-core-policy`, `agent-core-provider`, `agent-engine-compiler`, `agent-engine-orchestrator`, `agent-plugin-budget`, `agent-plugin-sanitize`, `agent-store-prompts`, `agent-store-runtime`, `agent-store-tools`) while `agent-base-types`, `agent-generator-plugin` and every sampled publisher leave it unset.

Verified: `packages/agent/agent-core-env/dist/index.js` **is genuine ESM** — 6 `import`/`export` statements, 0 `exports.`/`require(`. Therefore normalising the field to `"type"` unset **without re-emitting those packages as real CJS** yields `SyntaxError: Cannot use import statement outside a module`.

**Obligation:** each of the ten is re-emitted as CJS as part of the migration, and the field is normalised to unset everywhere. No plan may treat this as a `package.json`-only edit.

**Not established, stated plainly:** `require()` of `agent-core-env`'s ESM entry **succeeds on Node v24.11.1** (`require(esm)` is unflagged from Node 22.12 / 20.19), so there is **no live break today** on this runtime. The exposure is consumers on Node <20.19/<22.12 — and these packages **are published** (`@adhd/agent-core-env@0.1.1`, `@adhd/agent-store-prompts@2.2.1`, `@adhd/agent-engine-orchestrator@2.3.1`). This is compatibility debt, not a current outage; a prior claim of a live `ERR_REQUIRE_ESM` was **refuted by reproduction** and must not be repeated as fact.

### D5 — Externalization may not assume dual-format

`tools/vite-plugins/externalize.mjs` externalizes every real dependency reachable through bundled `@adhd/*` source, on a documented premise that they are "already properly published, dual-format npm packages" (`externalize.mjs:48-59`). `yaml@1.10.3` falsifies that premise.

**Obligation:** a dependency may be externalized only if its **root specifier resolves under ESM `import` and exposes the named exports the source uses**. A CJS-only dep must be bundled, or upgraded, or the dependency itself replaced — never externalized blind. Tracked as `0f12198b`.

## Consequences

- **The interop class closes at the mechanism, not at each symptom.** Fixes like `788c57a5` (swap to a default import) are correct but per-site; D2 removes the surface that produced four incidents.
- **The bloat is NOT fixed by this ADR, and must not be advertised as fixed.** Tree-shaking remains ~0 for CJS deps (measured above). Reducing `apigen-plugin-ir-cache`'s 88%-one-library bundle requires leaving CJS behind for that dependency — a dependency-choice decision, not this one. This ADR makes ESM impossible; it does not make the bundle small.
- **`verify-dist-load` coverage becomes the load-bearing gate** (D3). Until it executes `bin` entries, the migration is not safe to start.
- **The `.js`-is-ESM surprise is retired.** Today a consumer cannot tell from `type` whether `main`'s `.js` is ESM or CJS; after this, `main` → CJS is unconditional.
- **Cost, accepted:** one reviewed, mechanical migration across 61 `package.json` files and 55 `vite.config.ts` files, plus a genuine re-emit for ten packages. Per `adhd ADR-0002`, the fix belongs at the source rather than in each consumer.

## Alternatives considered

- **Keep dual (status quo).** **REJECTED.** It is the state that produced all four incidents, doubles the artifact surface, and buys no shaking. The `.mjs` entries already measurably **diverge** — `backlog/dist/index.mjs` inlines `yaml` while `apigen-plugin-ir-cache/dist/index.mjs` externalizes it.
- **ESM-only.** **REJECTED.** It would route every CJS dependency through the exact ESM-over-CJS interop that broke four times, for zero tree-shaking gain, and would break `require()` consumers on Node <20.19 outright rather than degrading.
- **Per-package choice.** **REJECTED.** The `type` split *is* per-package choice, and it is ungoverned debt with a silent `SyntaxError` for anyone who normalises it naively.
- **Add an `exports` map instead of removing the ESM build.** **REJECTED.** It would make Node actually resolve the `.mjs` for `import` consumers, widening the blast radius of the broken half rather than removing it.
- **Ship ESM now and fix the deps later.** **REJECTED.** Inverts the causality the four incidents establish.

## What does NOT change

- **`adhd ADR-0001`** (stores → sox-store adapter; no env feature toggles) — untouched. CJS-only is a designed-in format choice, not a feature toggle.
- **`adhd ADR-0002`** (correct the source) — untouched, and **aligned**: this removes the source of the breakage rather than shimming consumers.
- **The `import-meta-url-cjs` shims stay.** `tools/vite-plugins/import-meta-url-cjs.mjs` and `import-meta-url-browser-cjs.mjs` exist to make `import.meta.url` correct in CJS/UMD output — they are **required** by a CJS-only build, not obsoleted by it.
- **The `@adhd/*`-stays-bundled policy** in `externalize.mjs` — this ADR does not settle it. That file's own comment marks it `RE-EXAMINE` and its stated justification is already stale (pnpm **does** link in-repo packages into dependents' `node_modules` today).
- **`environment-cli`'s gate gap** (`b8db4e3c`) — that package declares no `verify-dist-load`, no `publish`, no `nx-release-publish`, i.e. it is not shippable at all (relates `7ef20999`). Its named-import defect is latent and unreachable by consumers; the gate obligation attaches when `7ef20999` closes.
- **The schema-correctness defects** (`3a3e5884`, `6fd8eed5`, `b4cec257`, `f58babc9`, `2f5e64dc`) — orthogonal to module format.

## References

- Owner approval, 2026-09-25 — "you have my approval from here on", in direct response to the CJS-only migration + ADR being listed as awaiting approval.
- `architect-decision` verdict, 2026-09-25 — CJS-only, risk LOW, ADR required.
- `PUBLISHING.md:5,86` — `nx release` is **retired** for this repo; versioning/publishing run through `@adhd/nx-build:version` / `@adhd/nx-build:publish`, driven by `pnpm release`, with the npm registry as source of truth. (A review suggested `nx release` bumps at release time; that premise is stale.)
- `tools/vite-plugins/externalize.mjs:5-10, 48-59, 73-82`; `tools/nx-plugins/build/executors/verify/verify-dist-load.mjs:143,163`.
- `packages/environment/environment-builder/src/layer-files.ts:13`; `entrypoint/environment-cli/src/core.ts:24`.
- `.github/workflows/ci.yml:54`; `.github/workflows/pull-request.yml:125`; `tools/nx-plugins/build/plugin.js:113`.
- Backlog: `788c57a5`, `0f12198b`, `b8db4e3c`, `98142eab`, `a99fe8dd`, `7ef20999`, `2ea64778`, `b6b88a13`.
- Note on ADR numbering: an ADR `0003-bake-ir-at-build.md` was **proposed** (not written) by the architect for the IR-bake decision during the same session. Since neither existed, this module-format decision takes **0003** as the higher-order one; the IR-bake decision, when written, takes **0004**.
