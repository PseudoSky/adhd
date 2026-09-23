# TEST-SELECTION — fail-safe file-level test selection

**State:** `test-changed-optin` (phase: final, terminal) · **Date:** 2026-09-22
**Branch / worktree:** `perf/nx-upgraded`, `/Users/nix/dev/node/adhd/.worktrees/nx-perf-upgraded`
**Deliverable:** `test:related` / `test:changed` workspace scripts + this record.
**Evidence:** `TEST-SELECTION-PROBE.md` (the revalidation that pinned the hazard on this toolchain).

---

## 1 · The design, stated as an inversion

The obvious way to make tests fast is to change the **default** to "only run what
changed." This plan does the opposite, deliberately:

- **The full suite stays the default.** The standard `test` target (`nx test <p>`,
  `nx affected -t test`, `test:all`, the commit gate, CI, and the release path) is
  **unchanged** — no `changed`/`related` option is wired into `targetDefaults`, the
  commit gate, CI, or the release path.
- **The narrow path is explicit opt-in.** A developer types `pnpm run test:related`
  (or `pnpm run test:changed`) to run a subset.

The reason is the failure asymmetry. If a developer forgets the override, the full
suite runs — a **wall-clock cost**. If the override were the default and a developer
forgot to widen it, tests would silently be skipped — a **correctness cost**. The
fast path only earns its keep when a human asks for it. This is
`[inv:fail-safe-selection]`.

## 2 · What was measured, and why the guard exists

`TEST-SELECTION-PROBE.md` revalidated the prior (Nx 18 / vitest 1.6) verdict on the
upgraded toolchain (Nx 23.2.1 / vitest 4.1.9) and found:

- **D3 CONFIRMED — the selector is fail-open.** `vitest related <file>` (and
  `vitest run --changed`) exits **0** having selected **zero** specs, printing
  `No test files found, exiting with code 0`. Through the Nx target it is worse:
  `NX Successfully ran target test` on a run that executed nothing. A green gate
  that ran nothing is the single most dangerous outcome this feature could produce.
- **D2 REFUTED** — the old *hang* is gone (vitest 4's `tinyexec` swallows the fatal
  git invocation), which **removes an accidental safety net**: the failure is now
  indistinguishable from success to any caller that trusts the exit code.

So the toolchain will **not** fail a zero-selection run on its own. The guard has to
be added by the caller. That is what `test:related` / `test:changed` do.

## 3 · The scripts

```jsonc
// package.json
"test:related": "node -e '<wrapper>'",            // pnpm run test:related -- <files...>
"test:changed": "pnpm run test:related -- --changed" // pnpm run test:changed
```

`test:changed` is a thin alias: it delegates to `test:related` in `--changed` mode so
the fail-safe behaviour has exactly one definition (DRY). With no `--changed` token,
`test:related` treats every positional argument as a source path and runs
`vitest related <files...>`.

**Why the wrapper is inline (`node -e`) rather than a file.** This state's reservation
permits exactly four paths (`package.json`, this record, and the two check scripts);
a standalone helper script would have been a new file outside the reservation. The
wrapper is a guard around an existing command, not a subsystem (TOOLS.md §4, G1/G2
verdict: *extend/wrap*), so inlining it keeps the whole contract in the one file the
reservation allows. If the reservation is widened later, lifting the `node -e` body
into `tools/` is a pure move.

### What the wrapper does

1. Runs the real `./node_modules/.bin/vitest` (repo-local anchor, `[inv:tool-resolution-pinned]`)
   with `--config vitest.config.ts` and `--passWithNoTests=false`. The root config's
   `test.projects` glob makes the selection **workspace-wide**, so it crosses package
   boundaries (see §5).
2. Prints vitest's own output verbatim (verbose reporter, so selected spec paths —
   and therefore their owning packages — are visible).
3. Prints `selected=N/M` to stdout, where `N` is the number of selected spec files
   (parsed from vitest's `Test Files … (N)` summary) and `M` is the total spec files
   in the workspace (counted with `fs.globSync`, excluding `node_modules`/`dist`/`.nx`).
4. **If `N === 0` (or vitest reports `No test files found`), prints
   `no tests selected` and exits non-zero.** This is the one guard that must never be
   relaxed.

Exit status is vitest's own on a non-empty run, so a genuine test failure still fails.

## 4 · The contract, clause by clause

`[shape:fast-path-contract]` pins four clauses; each is satisfied and evidenced:

| # | Clause | How it is satisfied | Evidence |
|---|---|---|---|
| 1 | Zero selected ⇒ non-zero exit, message naming zero selected | wrapper step 4 | `pnpm run test:related -- packages/data/data-base-transforms/README.md` → exit **1**, `no tests selected`, `selected=0/362` |
| 2 | A cross-package change ⇒ ≥1 spec in a dependent package | workspace-wide `vitest related` + the source-resolution helper (§5) | `pnpm run test:related -- packages/data/data-base-transforms/src/lib/date.ts` → exit **0**, output includes `data-query-engine` specs |
| 3 | `selected=N/M` on stdout, N < M | wrapper step 3 | date.ts → `selected=4/362` (4 < 362) |
| 4 | Never wired into `targetDefaults` / commit gate / CI / release | `nx.json` untouched; only the two opt-in scripts added | `nx.json` `targetDefaults.test` still `dependsOn: ["lint", "^build"]`, no `changed`/`related` option |

The two check scripts are the executable form of clauses 1–2:

```bash
node docs/plan/nx-23-upgrade/scripts/check-zero-selection.mjs          # [dod.6] fail-safe
node docs/plan/nx-23-upgrade/scripts/check-cross-package-selection.mjs # [dod.7] consumer coverage
```

## 5 · Cross-package coverage

A bare `@adhd/<dep>` specifier resolves through `node_modules/@adhd/<dep>` to the
dependency's **built `dist`**, not its `src`. Vite's built-in `vite:resolve` runs
before normal-order user plugins, so a normal `nxViteTsPaths()` entry never gets a
chance — the dependent's module graph terminates at the package boundary and the
changed source file is invisible to it. Measured consequence on the default branch:
a cross-package change selected **zero** specs and exited 0.

The fix is `tools/vite-plugins/source-resolution.mjs` (`nxViteTsPathsPre()`): a
pre-ordered (`enforce: 'pre'`), serve-scoped (`apply: 'serve'`) copy of the
tsconfig-paths plugin that maps `@adhd/*` to source during tests. It is absorbed and
wired into every project's `vite.config.ts`. With it, `date.ts` — a base-package
source file — selects specs in `data-query-engine`, the package that consumes it.

## 6 · Limitations (documented, not discovered later)

- **Dynamic `import(variable)` edges are invisible.** `vitest related` walks the
  *static* module graph. A module reached only through a computed specifier will not
  be selected. If you touch such a file, run the full suite.
- **Selection is approximate by construction.** "Related" means "in the module graph
  of a spec," which is a superset of "exercised by a spec." The fast path is a
  wall-clock optimisation for the common case, never a replacement for the full suite
  at a release boundary.
- **A spawned child process resolves workspace packages to built output** unless
  `^build` ran first. `^build` stays in the `test` target path for exactly this
  reason (`[inv:test-depends-on-caret-build]`).

## 7 · Invocation sites that must never inherit a narrowed default

`[inv:fail-safe-selection]` names five-plus sites. None may gain a `changed`/`related`
option, and none was touched by this state:

1. `.githooks/pre-commit` — `nx affected --target=test --files=<staged>` (project-granular; deliberately not narrowed, `[shape:commit-gate]`).
2. CI workflows.
3. `test:all` — `nx run-many --targets=test --configuration=production`.
4. The release path (`nx-release-publish` → `test`).
5. `nx.json` `targetDefaults.test` (the default every project inherits).

## 8 · Measured behaviour (this toolchain)

| Input | Exit | `selected` | Selected specs (by package) |
|---|---|---|---|
| `packages/data/data-base-transforms/README.md` (uncovered) | **1** | `0/362` | — (fails loudly) |
| `packages/data/data-base-transforms/src/lib/date.ts` | 0 | `4/362` | `data-base-transforms`, `data-query-engine` ×2, `decompile-cli` |
| `packages/data/data-base-transforms/src/index.ts` (the package barrel) | 0 | `3/362` | `data-query-engine` ×2, `decompile-cli` |
| `pnpm run test:changed` (dirty tree, no covered change) | **1** | `0/362` | — (fails loudly) |

### Note on `src/index.ts`

`[dod.6]` probes `README.md` (a package README no spec covers) as its zero-selection
input. A package barrel is **not** a valid zero-selection input on this toolchain:
`data-query-engine` imports `@adhd/data-base-transforms` (the barrel), and with the
source-resolution helper in place that resolves to `src/index.ts`, so
`vitest related src/index.ts` selects three specs across two dependent packages
(`selected=3/362`, exit 0). That is the **correct and desirable** behaviour — a change
to a package's public surface *is* covered by its consumers' specs, and reporting it as
"no tests selected" would be a false negative that hides a real cross-package blast
radius. The fail-safe clause (zero ⇒ non-zero) is therefore probed against `README.md`,
which is genuinely uncovered.

## 9 · Reproduce

```bash
pnpm run test:related -- packages/data/data-base-transforms/README.md          # expect exit 1 + "no tests selected"
pnpm run test:related -- packages/data/data-base-transforms/src/lib/date.ts    # expect exit 0 + "data-query-engine" + selected=4/362
node docs/plan/nx-23-upgrade/scripts/check-zero-selection.mjs                  # expect exit 0 (PASS)
node docs/plan/nx-23-upgrade/scripts/check-cross-package-selection.mjs         # expect exit 0 (PASS)
```
