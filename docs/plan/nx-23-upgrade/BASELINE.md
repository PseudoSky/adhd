# Nx 23 Upgrade — Measured Baseline

**Branch:** `perf/nx-upgraded` · **Worktree:** `.worktrees/nx-perf-upgraded`
**Measured:** 2026-09-22T04:35:27Z · **HEAD at measurement:** `6a6e4176`
**Method:** every value below was produced by *running* the repo-local tool through
`./node_modules/.bin/…` on this branch — not copied from a plan document. Later
states MUST compare against this record, not against a remembered version string.

---

## 1. Resolved toolchain (measured)

| Package | Declared pin (`package.json` devDependencies) | Resolved in `node_modules` | How measured |
|---|---|---|---|
| `nx` | `23.2.1` | `23.2.1` | `./node_modules/.bin/nx --version` → `Local: v23.2.1` |
| `vite` | `^8.3.0` | `8.3.0` | `require('./node_modules/vite/package.json').version` |
| `vitest` | `4.1.9` | `4.1.9` | `require('./node_modules/vitest/package.json').version` |
| `typescript` | `^6.0.2` | `6.0.3` | `require('./node_modules/typescript/package.json').version` |

Declared pins and the resolved tree agree on the majors that matter (`nx 23.2.1`,
`vite 8.x`, `vitest 4.1.9`). `typescript` resolves to `6.0.3` inside the declared
`^6.0.2` range — the resolved value, not the floor, is the baseline.

## 2. The vitest ceiling — evidence, not preference

`vitest 4.1.9` is the **ceiling** imposed by the installed plugin, not a free choice.
Measured peer range from `@nx/vitest@23.2.1`:

```
vitest : ^3.0.0 || ^4.0.0
vite   : ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0
```

So under the current `@nx/vitest` the highest admissible vitest line is `4.x`, and
`4.1.9` is the pinned member of it. This is recorded here so the ceiling is not
re-litigated: raising vitest past `4.x` requires a `@nx/vitest` that peers a `5.x`
range. (Note the peer range already admits `vite 8.x`, which is what unblocked the
`vite 8.3.0` bump.)

### 1a. Known residual — stale `vite` `~5.0.13` pins in `packages/agent/*` (NOT fixed here)

The **root** toolchain pin is clean (`vite: ^8.3.0`), which is what criterion
`upgrade-baseline.3`'s operational check tests (`/^[^0-9]*5\./.test(rootDevDeps.vite)`
→ false → pass). But eight `packages/agent/*` packages still **declare**
`devDependencies.vite: "~5.0.13"`, and pnpm resolves each to a **nested `vite 5.0.13`**:

```
packages/agent/{agent-store-prompts,agent-engine-orchestrator,agent-core-env,
agent-store-runtime,agent-store-tools,agent-core-policy,agent-engine-compiler,
agent-core-provider}/package.json  →  devDependencies.vite = "~5.0.13"
packages/agent/agent-core-env/node_modules/vite  →  5.0.13   (measured, nested)
```

These files are outside this state's reservation (`BASELINE.md` only) and are left
**exactly as found**. They are recorded here so a later state removes them rather
than re-discovering them: a "no vite 5 pin remains" claim is true of the root
toolchain and false of these eight packages. Flagged to the dispatcher.

## 3. Workspace shape (measured)

- **Projects in the graph:** `70` (`./node_modules/.bin/nx show projects --json`)
- **Per-executor target counts** (`nx show projects --with-target <t> --json`):

| Target | Projects carrying it |
|---|---|
| `build` | 63 |
| `test` | 63 |
| `lint` | 62 |
| `typecheck` | 62 |

The build health-sweep below covers the **63** `build`-bearing projects.

## 4. Build-graph health sweep — the honest before-picture

Command: `./node_modules/.bin/nx run-many -t build` · **exit code: 1**

```
NX   Running target build for 63 projects failed
Failed tasks:
- ui-react-base-hooks:build
Output of 62 successful tasks were not shown.
Run duration: 4.7s   Cache: 61/62 hit (98%)
```

- **62 / 63 build targets green; exactly one red: `ui-react-base-hooks:build`.**
- Failure is a React-19 type breakage (`useRef<T>()` now requires an initial
  argument) — owned by the `browser-package-build-repair` state, not by this one.
- Versions alone are not a baseline: a record that stored only version strings is
  what let two broken public packages sit unnoticed. The single failing target above
  is the measurable defect this sweep exists to surface.

## 5. CJS defect cost — measured on the vite bump

`vite 8` emits ESM-shaped CJS output that leaves `import.meta.url` as `{}.url` in
built CJS entrypoints, which breaks `apigen-cli` (and `backlog`) at load.

| Tree | `nx test apigen-cli` |
|---|---|
| vite 6.4.3 (pre-bump) | **28 files / 188 tests green** |
| vite 8.3.0 (bumped, CJS defect unmitigated) | **26 failed / 162 passed** |

The bump is therefore not safe to *rely on* until the CJS repair lands.

## 6. Bump landing — DEFERRED to `vite-cjs-import-meta-repair`

Per invariant `[inv:bump-lands-with-its-fix]`, the `vite 8` toolchain may only be
**committed together with the change that keeps the built artifact working** (the CJS
repair). The state that lands the bump, atomically with that repair, is
**`vite-cjs-import-meta-repair`** — its artifact list includes `package.json` and
`pnpm-lock.yaml` alongside `tools/vite-plugins/import-meta-url-cjs.mjs` and the 54
`vite.config.ts` wirings.

**Measured reality on this branch at measurement time (recorded, not assumed):**

- The declared pins (`nx 23.2.1`, `vite ^8.3.0`, `vitest 4.1.9`) are **already
  committed** at `HEAD` (`package.json`, `pnpm-lock.yaml` clean, no worktree diff).
  The start-transition commit `6a6e4176` swept the previously-staged bump in.
- The **CJS repair is present but UNCOMMITTED** in the working tree (54
  `vite.config.ts`, `tools/vite-plugins/import-meta-url-cjs.mjs`,
  `entrypoint/apigen-cli/src/test/e2e/cjs-import-meta-url.spec.ts`).

A reader must therefore read the two apart: *the bump's declared pins are present in
the branch*, while *the repair that makes vite-8 artifacts load is still in the
working tree* and is what `vite-cjs-import-meta-repair` commits. Whether the bump
should have been committed in the start commit rather than with the repair is a
process deviation flagged to the dispatcher (see the state report).

---

## Acceptance criteria → evidence

| Criterion | Evidence |
|---|---|
| `upgrade-baseline.1` nx binary reports 23.2.1 | §1 — `nx --version` → `Local: v23.2.1` |
| `upgrade-baseline.2` declared pins match measured | §1 table — declared vs resolved |
| `upgrade-baseline.3` no vite 5 major pin remains | **root** `package.json` `vite: ^8.3.0` (criterion's operational check: `/^[^0-9]*5\./` → false). Residual: 8 `packages/agent/*` still pin `~5.0.13` — see §1a |
| `upgrade-baseline.4` baseline record exists | this file |
| `upgrade-baseline.5` names the bump-landing state | §6 — `vite-cjs-import-meta-repair` |
