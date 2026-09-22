# TOOLS — `nx-23-upgrade`

The capability catalog for this plan. Executors consume this and **must not
re-derive it**. Every claim carries evidence and a `valid-as-of` stamp; re-validate
when the staleness window is exceeded (see §7).

**`valid-as-of`: 2026-09-21** · branch `perf/nx-upgraded` @ `f03b9aef` · Node v24.11.1

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

**Deliberately not used** (present but rejected, so an executor does not reach for them):

| Provider | Why rejected |
|---|---|
| `vitest --changed` as a *global* default | Measured fail-open: a clean tree selects zero, exits 0, and the task reports success. Also crashes graph construction when added under a target-name key. |
| `server.deps.inline` (regex form) | Refuted by measurement — it controls externalization, which runs *after* module resolution, so it cannot change the resolved id. |
| `--skip-nx-cache` | Banned by repo rule; it leaves a stale cache entry that a later build restores over fresh output. |
| `@monodon/rust` removal | No Rust project exists; zero value, and out of scope. |
| Direct `tsc` invocation | Banned by repo rule; bypasses path aliases and the cache. |

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
```

Read it as: **C9 gates C7**, and **C7 gates C8** — the selection contract cannot be
delivered before the module graph is continuous, and the fail-safe guard is
meaningless before there is a selection to guard. That ordering is why
`test-resolution-absorbed` precedes `test-changed-optin` in the DAG.

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
| `validate_demo.py` | `python3 <demo-creator>/scripts/validate_demo.py docs/plan/nx-23-upgrade/demo` exits 0 | every demo edit | `DEMO.md` or `UNRESOLVED.md` changes |

**Staleness rule.** A `valid-as-of` older than its window is not evidence. Re-run
the smoke test before relying on the contract; a drifted contract is worse than a
missing one, because executors build against it without checking.
