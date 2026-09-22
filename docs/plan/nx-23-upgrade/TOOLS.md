# TOOLS — `nx-23-upgrade`

The capability catalog for this plan. Executors consume this and **must not
re-derive it**. Every claim carries evidence and a `valid-as-of` stamp; re-validate
when the staleness window is exceeded (see §7).

**`valid-as-of`: 2026-09-21** · branch `perf/nx-upgraded` @ `f03b9aef` · Node v24.11.1

> **Re-validated 2026-09-21 by the repair pass.** C1–C14 are unchanged. C15/C16 were added,
> and with them the measurement that the original catalog lacked: a repo-wide
> `nx run-many -t build` over the 66 JS/TS projects (exactly one failing target —
> `ui-react-base-hooks:build`), a `{}.url` sweep over every built bundle (one hit, a comment),
> and a live negative control on the `apigen-cli` artifact (shim reverted → exit 1 with
> `ERR_INVALID_ARG_VALUE`; restored → exit 0, byte-identical).

---

## 1 · Capability list

Verb-noun. No implementation assumption — a capability is a thing that must be
*possible*, not a thing that must be *built*.

| # | Capability | Required by |
|---|---|---|
| C1 | Resolve the effective toolchain version | `upgrade-baseline` |
| C2 | Enumerate the project graph | all states (precondition) |
| C3 | Enumerate declared task targets across manifests | `graph-*` |
| C4 | Determine whether a target is inferred or declared | `graph-*` |
| C5 | Build a project | `graph-*`, `tsconfig-shim-removal` |
| C6 | Run a project's test suite | `graph-*` |
| C7 | Select the specs covering a changed file | `test-changed-optin` |
| C8 | Fail a run that selected zero specs | `test-changed-optin` |
| C9 | Make the test module graph continuous across packages | `test-resolution-absorbed` |
| C10 | Isolate the task cache per checkout | `cache-isolation` |
| C11 | Merge sibling branches and resolve config conflicts by intent | `config-repair-absorbed`, `test-resolution-absorbed` |
| C12 | Assert compiler-config parity with the default branch | `tsconfig-shim-removal` |
| C13 | Emit a machine-readable per-criterion audit result | all `audit-*` |
| C14 | Assert a guard's tool resolution is environment-pinned | `audit-final` |
| C15 | Prove a built artifact loads and runs, not merely that it was declared | `vite-cjs-import-meta-repair`, `browser-package-build-repair`, `browser-cjs-umd-repair` |
| C16 | Rewrite a bundler-emitted token in one output format only, leaving the others byte-identical | `vite-cjs-import-meta-repair` |

---

## 2 · Existing inventory

For each capability: the provider that already exists, with precise identifiers and
evidence it is live and reachable.

| # | Provider | Identifier | Evidence (live) |
|---|---|---|---|
| C1 | Node `require` of each manifest | `require('./package.json')`, `require('vite/package.json')` | ran; returned `23.2.1` / `8.3.0` / `4.1.9` |
| C2 | Nx CLI | `./node_modules/.bin/nx show projects` | ran; returned 68 projects, exit 0 |
| C3 | ripgrep over manifests | `rg -o -N '"@[a-z]+/[a-z-]+:[a-z-]+"' -g '**/project.json'` | ran; returned the 57/47/15/12/5 counts |
| C4 | Nx CLI | `./node_modules/.bin/nx show project <p> --json` | ran; returns the effective target map |
| C5 | Nx CLI (vite + tsc executors) | `./node_modules/.bin/nx build <p>` | ran; `nx build data-query-engine` exit 0 |
| C6 | Nx CLI + vitest | `./node_modules/.bin/nx run <p>:test` | ran; `nx test agent-engine-compiler` 82 tests, `apigen-engine-runtime` 217 tests |
| C7 | Vitest CLI | `./node_modules/.bin/vitest related <files...>` | exists in vitest 4.1.9; **invoked by nothing** (see gap G1) |
| C8 | — | — | **no provider** (see gap G2) |
| C9 | Unmerged branch | `perf/test-resolve-fix` @ `ce9e35c1` → `tools/vite-plugins/source-resolution.mjs` | file exists on that branch; absent on `perf/nx-upgraded` (see gap G3) |
| C10 | Nx `cacheDirectory` config field | `nx.json` → `cacheDirectory` | field supported; **unset today** (see gap G4) |
| C11 | `git merge` + the written conflict policy | `_shared.md` → `[fix:absorbing-a-sibling-branch]` | policy authored; three branches confirmed to touch `nx.json` |
| C12 | `git diff` | `git diff main..HEAD -- tsconfig.base.json` | ran; currently non-empty (the five shims) |
| C13 | Plan-state-machine audit runner | `scripts/run-audit.js` (vendored by `plan-scaffold`), interpreting `scripts/criteria.json` | vendored into the plan; 82 criteria declared |
| C14 | Plan-state-machine pin lint | `scripts/env-pin-check.js --strict`, mirrored by `scripts/check-guards-pinned.mjs` | both present; the plan-owned probe is wired as a criterion |
| C15 | Node itself, plus the project's vitest | `node <dist-entry> --help`; `./node_modules/.bin/vitest run --config <pkg>/vite.config.ts <spec>` | ran; post-fix both entrypoints exit 0; with the shim reverted to `{}.url` the same command exits 1 with `ERR_INVALID_ARG_VALUE` |
| C16 | Vite/Rolldown `renderChunk` plugin hook | `tools/vite-plugins/import-meta-url-cjs.mjs` (`importMetaUrlCjs()`) | wired into 54 `vite.config.ts`; format gate measured — 11 built `.mjs` keep native `import.meta.url`, **0** `.mjs` carry the CJS shim; 22 built CJS bundles carry the shim |

**Deliberately not used** (present but rejected, so an executor does not reach for them):

| Provider | Why rejected |
|---|---|
| `vitest --changed` as a *global* default | Measured fail-open: a clean tree selects zero, exits 0, and the task reports success. Also crashes graph construction when added under a target-name key. |
| `server.deps.inline` (regex form) | Refuted by measurement — it controls externalization, which runs *after* module resolution, so it cannot change the resolved id. |
| `--skip-nx-cache` | Banned by repo rule; it leaves a stale cache entry that a later build restores over fresh output. |
| `@monodon/rust` removal | No Rust project exists; zero value, and out of scope. |
| Direct `tsc` invocation | Banned by repo rule; bypasses path aliases and the cache. |
| `platform: 'node'` on the library builds | Tested and rejected: it changes the ESM bundle and the module-resolution conditions, so it is not the one-line alternative it appears to be. The format-gated `renderChunk` hook is narrower. |
| The node CJS shim in a `platform:browser` package | Its replacement expression needs `require`/`__filename`, which do not exist in a browser chunk — it trades `undefined` for `ReferenceError`. Asserted absent by `browser-cjs-umd-repair.1`. |
| Suppressing `vite-plugin-dts` diagnostics to make a red build green | Would ship a `.d.ts` set that does not match its own sources. The React-19 type errors are fixed in the source, not muted. |

---

## 3 · Gap analysis

| # | Capability | Status | Detail |
|---|---|---|---|
| G1 | C7 — file-level selection | **Partial** | `vitest related` exists and works *intra*-package today (measured: 4 of 22 specs for a change to `date.ts`). Cross-package it selects **zero** until G3 lands. Nothing invokes it: the only `--changed` in the repo is a `watch:test` script wired to nothing. |
| G2 | C8 — zero-selection failure | **Absent** | The runner exits 0 having selected nothing. There is no wrapper, no `passWithNoTests: false`, and no invocation site that would notice. |
| G3 | C9 — cross-package module graph | **Unmerged** | The fix exists on `perf/test-resolve-fix` (3 commits, local-only). Measured with it: 6 of 22 specs for a cross-package change, versus **0** without. |
| G4 | C10 — cache isolation | **Absent** | `nx.json` sets no `cacheDirectory`, so Nx 23 pools the cache and its sqlite DB across sibling worktrees. |
| G5 | C4/C5 for tsc-built projects | **Absent** | `@nx/js/plugin` is **not registered** in `nx.json` — only a `@nx/js:tsc` target-defaults key exists. Deleting the 14 explicit tsc build targets without registering it deletes the build target outright. |
| G6 | C11 — conflict resolution | **Judgment** | Three branches touch `nx.json`. The intent-based policy is written; the conflict hunks are unknown until the merge runs. |
| G7 | C15 — artifact loadability | **Absent (was)** | No state asserted that a built artifact *loads*. The bump guard compared `devDependencies.vite === "^8.3.0"` and went green while every built CommonJS entrypoint threw at module load. Closed by `vite-cjs-import-meta-repair`; the mechanism is now a pinned invariant (`[inv:guards-prove-the-artifact-loads]`). |
| G8 | C16 — format-scoped token rewrite | **Absent (new)** | Rolldown exposes no config knob for the `import.meta.url` lowering, and the one apparent alternative (`platform: 'node'`) changes module resolution. A format-gated `renderChunk` hook is the narrow fix. |
| G9 | C15/C16 for the browser package | **Absent** | `packages/ui-react/ui-react-base-hooks` emits `cjs`+`umd` and cannot use the node shim. Two problems, in order: its **build is red** (4 React-19 type errors — `nx run-many -t build` across 66 JS/TS projects reports this as the *only* failing target, so the blast radius is bounded), and once it builds, both CJS and UMD bundles carry the empty-import-meta token. Owned by `browser-package-build-repair` then `browser-cjs-umd-repair`. |

---

## 4 · Build-vs-reuse verdict per gap

Ladder applied in order; first match wins.

| Gap | Verdict | Rationale |
|---|---|---|
| **G1** | **extend/wrap** | The selection engine exists and is measured. What is missing is the *invocation contract* — a wrapper that runs it, counts the selection, and enforces the empty-selection rule. Wrapping beats rebuilding: the module-graph walk is vitest's, and duplicating it would drift. |
| **G2** | **extend/wrap** | Same wrapper, same reason. This is the one piece that is genuinely new behaviour, but it is a guard around an existing command, not a subsystem. |
| **G3** | **reuse-as-is** | The fix is written, measured, and on a local branch. Absorbing it is a merge, not a build. Re-deriving it would repeat a root-cause investigation that already has a verified answer (plugin ordering, serve-scoping). |
| **G4** | **reuse-as-is** | Nx supports a relative `cacheDirectory`. This is a one-key config change with a documented semantics. |
| **G5** | **reuse-as-is** | `@nx/js/plugin` ships with the installed Nx. Registering it is a config edit. The work is not building inference — it is proving the inferred targets reproduce the non-inferable options. |
| **G6** | **build** (tiny) | No provider exists for "resolve *these three* branches' conflicts by intent". It is a written policy plus a judgment call, and it is the difference between keeping and silently losing the publish gate. |
| **G7** | **build** (tiny) | The probe is a real process launch plus a token assertion. Nothing existing does this, and a wrapper around a version read is exactly the proxy that failed. |
| **G8** | **build** (tiny) | ~60 lines behind a one-line format gate. `reuse-as-is` is unavailable: Rolldown has no option for it, and `platform: 'node'` is a different change with a different blast radius. |
| **G9** | **prototype-first** | The build repair is mechanical (conform to the installed types). The bundle repair has two viable families and the fit of each is unknown until built — so the executor prototypes, records the chosen family and its rationale in `BROWSER-BUNDLE-REPAIR.md`, and the guard decides. |

**Nothing in this plan is a "buy/import"** — every capability is either already
installed, already written on a sibling branch, or a thin wrapper.

---

## 5 · Interface contracts

Executors consume these; they do **not** re-derive them.

### 5.1 `vitest related`

```text
vitest related <files...>
```
- **Input:** one or more source file paths, relative to the repo root.
- **Output:** runs the specs that **statically** import the given files.
- **Exit surface:** **0 when it selects nothing** — this is the hazard, not a feature.
- **Quirks:**
  - Dynamic `import(variable)` edges are invisible; a module reached only that way is never selected.
  - A spawned child process resolves workspace packages through `node_modules` to **built output**, so a child's view of a source change is stale unless `^build` ran.
  - Cross-package selection requires the source-resolution helper (G3). Without it the module graph terminates at the package boundary and the selection is **empty, with exit 0**.

### 5.2 `nx show project <name> --json`

```text
./node_modules/.bin/nx show project <project> --json
```
- **Output:** the *effective* target map — inferred targets merged with declared ones.
- **Use:** the only reliable way to tell "the target still exists" from "the declaration still exists". A deleted declaration with a live inference looks identical in the manifest and different here.
- **Quirk:** an option carried into inference does not always appear verbatim; assert the *artifact*, not the option echo.

### 5.3 `nx.json` → `cacheDirectory`

```jsonc
"cacheDirectory": ".nx/cache"
```
- **Semantics:** **relative** paths resolve per-checkout. An **absolute** path (or leaving it unset under Nx ≥ 23) pools across sibling worktrees.
- **Error surface:** a path that resolves outside the checkout is not an error — it silently re-opens the shared-cache hazard. Assert resolution, do not assert the string alone.

### 5.4 `run-audit.js` (plan-owned, vendored)

```text
node docs/plan/nx-23-upgrade/scripts/run-audit.js [--phase <a,b>]
```
- **Output:** one `[<id>] PASS|FAIL` marker per criterion on stdout.
- **Exit:** the count of failing criteria (`0` ⇔ green).
- **Phases accumulate:** `--phase config` runs `intake`, `reconcile` and `config`.
- **Quirk:** `custom` criteria spawn `node <script>` with the repo root as cwd and pass iff exit 0 — their stdout is never parsed for markers.

### 5.5 `git diff main..HEAD -- tsconfig.base.json`

- **Output:** empty ⇔ byte-parity with the default branch.
- **Quirk:** parity of *this file* is the claim. A project-level config that also relaxes is a different finding and would need its own criterion.

### 5.6 `importMetaUrlCjs()` — the CJS import.meta.url shim

```ts
// tools/vite-plugins/import-meta-url-cjs.mjs
import { importMetaUrlCjs } from '../../../tools/vite-plugins/import-meta-url-cjs.mjs';
// in a vite.config.ts: plugins: [importMetaUrlCjs(), …]
export function importMetaUrlCjs(): Plugin
```

- **Input:** none. **Output:** a Vite plugin whose only hook is `renderChunk(code, _chunk, outputOptions)`.
- **Behaviour:** when `outputOptions.format === 'cjs'` **and** the chunk contains the literal
  token `{}.url`, replaces every occurrence with
  `require('node:url').pathToFileURL(__filename).href`. Otherwise returns `null`.
- **Why `renderChunk` and not `define`:** Rolldown lowers `import.meta` during code generation,
  *before* `renderChunk` runs — by the time the hook sees the chunk the token is already
  `{}.url`. A format-agnostic `define`/`transform` would corrupt the ESM build, where
  `import.meta.url` is genuinely valid.
- **Quirks:**
  - The rewrite happens **before** minification, so the emitted shim may be single- or
    double-quoted. Any assertion on it must accept both (the shipped spec uses a regex).
  - It is inert wherever a chunk never referenced `import.meta.url`, which is why broad wiring
    is cheap — and why a package with no shim in its `dist` is not evidence of a missing wiring.
  - `require('node:url')` is safe here only because every CJS build in this repo externalizes
    Node builtins (see `externalize.mjs`).

### 5.7 Driving a built artifact as the acceptance proof

```text
./node_modules/.bin/nx build <pkg> && node <pkg>/dist/index.js --help
./node_modules/.bin/nx build <pkg> && ./node_modules/.bin/vitest run --config <pkg>/vite.config.ts <spec>
```

- **Input:** a package whose `test` target depends on its own `build` (e.g. `apigen-cli`).
- **Output:** exit 0 ⇔ the artifact loaded and the command ran.
- **Quirks:**
  - Invoking `vitest` directly with `--config <pkg>/vite.config.ts <spec-path>` works and
    bypasses the target graph, so the proof does not drag `lint` → `sync-deps` (which rewrites
    tracked `package.json` files) into a bundle check. Verified green: the `apigen-cli` spec
    runs 4/4 in ~1.5s.
  - `nx test <pkg>` also works but pulls `lint` and `^build` through `targetDefaults`; prefer
    the direct invocation inside a guard.
  - `dist/` is gitignored, so a guard that asserts on it must build first. A token assertion
    against a missing file reads as "clean" — always build in the same command.

---

## 6 · Dependency graph

Capabilities, not states. Arrows are "needs".

```text
C1 (versions) ─┐
C2 (graph)    ─┼─→ C3 (targets) ─→ C4 (inferred?) ─→ C5 (build) ─┐
               │                                                  ├─→ C13 (audit)
C12 (parity)  ─┘                                                  │
                                                                  │
C9 (module graph continuity) ─→ C7 (selection) ─→ C8 (zero-fail) ─┘
                                       ↑
C6 (suite) ────────────────────────────┘
C10 (cache isolation) ─────────────────────────────────────────────→ C13
C11 (merge policy) ─→ C12
C14 (pin lint) ────────────────────────────────────────────────────→ C13
C16 (format-scoped token rewrite) ─→ C15 (artifact loads) ─────────→ C13
```

Read it as: **C9 gates C7**, and **C7 gates C8** — the selection contract cannot be
delivered before the module graph is continuous, and the fail-safe guard is
meaningless before there is a selection to guard. That ordering is why
`test-resolution-absorbed` precedes `test-changed-optin` in the DAG.

And **C16 gates C15**: the shim has to exist before any built artifact can be
proven to load. That is why `vite-cjs-import-meta-repair` precedes everything else in
the intake phase — a plan that measures a bumped toolchain before proving the artifacts
still load is the exact shape that hid `BUG-BUILD-002`.

**C13 (the audit) is the sink.** Everything else feeds it, which is why the audit
states are hold points rather than optional checks.

---

## 7 · Validation method

Per tool, the smoke test that proves it still behaves as documented, plus a
staleness window.

| Tool | Smoke test | Window | Re-validate when |
|---|---|---|---|
| `vitest related` | `./node_modules/.bin/vitest related packages/data/data-base-transforms/src/lib/date.ts` selects ≥1 spec | 14 days | vitest or vite changes major/minor |
| `nx show project --json` | `./node_modules/.bin/nx show project data-query-engine --json` contains a `test` target | 14 days | Nx changes |
| `cacheDirectory` | the resolution assertion in `criteria.json` → `cache-isolation.2` | 30 days | `nx.json` is edited |
| `run-audit.js` | `node .../run-audit.js --phase intake` emits one marker per intake criterion | every plan edit | `plan-scaffold` vendors a new runner |
| compiler parity | `git diff main..HEAD -- tsconfig.base.json` is empty | 7 days | `main` touches the shared compiler config |
| `check-guards-pinned.mjs` | exits 0 with all guards pinned | every plan edit | a guard is added or edited |
| `importMetaUrlCjs()` | `node entrypoint/apigen-cli/dist/index.js --help` exits 0 **and** `rg -c '\{\}\.url'` over the CJS `dist` entries is 0 | 14 days | vite or Rolldown changes major/minor |
| artifact-load probe | the `apigen-cli` acceptance spec runs 4/4 via the direct vitest invocation | 14 days | the spec, the plugin, or vite changes |
| `neg-control-cjs-shim.mjs` | with the shim reverted, `node entrypoint/apigen-cli/dist/index.js --help` exits non-zero with `ERR_INVALID_ARG_VALUE` | 30 days | the plugin's replacement expression changes |
| `validate_demo.py` | `python3 <demo-creator>/scripts/validate_demo.py docs/plan/nx-23-upgrade/demo` exits 0 | every demo edit | `DEMO.md` or `UNRESOLVED.md` changes |

**Staleness rule.** A `valid-as-of` older than its window is not evidence. Re-run
the smoke test before relying on the contract; a drifted contract is worse than a
missing one, because executors build against it without checking.
