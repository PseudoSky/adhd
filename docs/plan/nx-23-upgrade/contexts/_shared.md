# _shared.md — cross-cutting definitions for `nx-23-upgrade`

Referenced by every context file. Change a term here, not in every context file.

---

## [def:upgrade-branch]

`perf/nx-upgraded`, checked out at `.worktrees/nx-perf-upgraded`. Every state in
this plan commits here. **No state pushes, merges to the default branch, or
publishes.** Landing is a human decision taken after `audit-final`.

## [def:inferred-target]

A task target Nx derives from a registered plugin plus the project's files, rather
than one declared explicitly in the project manifest. The remodelled graph is the
set of targets the plugins infer once the explicit duplicates are gone.

## [def:shadowing-target]

An explicit target whose *name and executor* duplicate what an already-registered
plugin infers. Only these are safe to delete outright. Measured on the branch:

| Executor | Count | Target names | Verdict |
|---|---|---|---|
| `@nx/vitest:test` | 57 | all `test` | shadow — plugin registered |
| `@nx/vite:build` | 47 | all `build` | shadow — plugin registered |
| `@nx/js:tsc` | 15 | 14 `build`, 1 `build-bin` | **not** a shadow — plugin unregistered |
| `@nx/js:release-publish` | 12 | all `nx-release-publish` | bespoke dependency chains |
| `@nx/eslint:lint` | 5 | all `lint` | deprecated; sanctioned codemod |

## [def:empty-import-meta]

The defect vite 8 introduced (`BUG-BUILD-002`). Vite 8 replaced Rollup with Rolldown, which
polyfills `import.meta.url` for a `cjs` output format **only** when the build platform is
`node`. Vite 8's library build defaults to `platform: 'browser'`, so `import.meta` is lowered
to the empty object and the emitted token is literally `{}.url`. Every shipped
`createRequire(import.meta.url)` then becomes `createRequire(undefined)` and throws
`ERR_INVALID_ARG_VALUE` **at module load** — the build still succeeds, only the artifact is
broken. Measured: `apigen-cli:test` 28 files / 188 tests green on vite 6.4.3, 26 failed /
162 passed on vite 8.3.0.

The repair is `tools/vite-plugins/import-meta-url-cjs.mjs`: a `renderChunk` hook, strictly
gated on `outputOptions.format === 'cjs'`, that rewrites the token back to Rollup's
`require('node:url').pathToFileURL(__filename).href`. It is inert on `es`/`iife`/`umd` output
and on any chunk that never referenced `import.meta.url`.

**A grep for `{}.url` over built artifacts has one known false positive** — the generator
source carries the string inside a *comment*, which survives into
`packages/workspace/workspace-codegen-nx/dist/.../generator.js`. Token assertions are
therefore scoped to real entrypoint bundles.

**A browser bundle needs a different answer, not this one.** The node shim's replacement
expression needs `require`/`__filename`, which do not exist in a browser chunk — applying it
there trades `undefined` for `ReferenceError`. `platform: 'node'` was tested and rejected: it
changes the ESM bundle and the module-resolution conditions.

## [def:migration-shim]

A compiler-option relaxation the upgrade added to `tsconfig.base.json` that the
default branch does not carry. The five are `strict`, `types`,
`esModuleInterop`, `noUncheckedSideEffectImports`, `ignoreDeprecations`.

## [inv:fail-safe-selection]

Default = run everything. The narrow fast path is explicit opt-in. **A run that
selects zero tests is a FAILURE, never a success.** Five-plus invocation sites
(the commit gate, two CI workflows, the all-targets script, the release path)
must never inherit a narrowed default.

## [inv:no-cache-bypass]

Never `--skip-nx-cache`. It runs the task without reading or writing the cache, so
a later normal build restores the stale entry over fresh output and a publish
ships the wrong artifact. A clean rebuild is `nx reset` or a changed input.

## [inv:no-direct-tsc]

Never invoke `tsc` by hand. Type-checking goes through the project's Nx build
target so inputs, path aliases and the cache are all honoured.

## [inv:test-depends-on-lint]

`test.dependsOn` keeps `lint`. `publish`/`nx-release-publish` reach lint only via
`test`, so dropping the edge silently disables dependency checks on every release
(BUG-060). The default branch reverted exactly this once already.

## [inv:test-depends-on-caret-build]

`^build` stays in the test path. Measured inconclusive for wall-clock; load-bearing
for the four child-process projects whose spawned `node` resolves workspace
packages to built output.

## [inv:bump-lands-with-its-fix]

A toolchain version bump may only be **committed** in the same commit as the change that keeps
the built artifact working. The guard on `vite-cjs-import-meta-repair` enforces this
mechanically: `git log -1 --format=%H -- <plugin>` must equal `git log -1 --format=%H --
package.json`, i.e. the same commit touched both.

Rationale: `upgrade-baseline` originally committed the `vite ^8.3.0` bump on its own. That
produced a commit where the declared version was correct and every built CommonJS entrypoint
threw on load — and the guard went green, because it compared a version string. The bump now
sits uncommitted through `upgrade-baseline` (measured, recorded as pending) and lands in
`vite-cjs-import-meta-repair` together with the fix.

## [inv:guards-prove-the-artifact-loads]

A guard for a packaging or bundling change must **execute the built artifact**, not inspect a
declaration about it. "`package.json` says `vite ^8.3.0`" is not evidence that anything works;
`node <dist-entry> --help` exiting 0 is. Structural absence checks (`absent` criteria, token
greps) are legitimate for "the old thing is gone", but they never stand in for a load-and-run
probe.

## [inv:guards-are-red-then-green]

A guard must fail before the state's work and pass after. A guard that already
passes carries no information.

## [inv:tool-resolution-pinned]

Every guard resolves its tool through a repo-local anchor
(`./node_modules/.bin/<tool>`) so pass/fail measures the code, not the shell's
`PATH`.

## [shape:commit-gate]

`.githooks/pre-commit` runs four gates in order: mass-deletion guard →
secret scan → affected lint → affected test. Gate 3 is
`nx affected --target=test --files=<staged>` — PROJECT-granular, and it exists
specifically to catch downstream consumers. This plan does not narrow it.

## [shape:fast-path-contract]

The opt-in fast path must satisfy, in order of importance:

1. **Zero selected ⇒ non-zero exit** with a message naming zero selected.
2. **A cross-package change ⇒ at least one spec in a dependent package.**
3. **`selected=N/M` on stdout**, with N strictly below M, on a successful narrow run.
4. Never wired into `targetDefaults`, the commit gate, CI, or the release path.

## [fix:absorbing-a-sibling-branch]

When absorbing `perf/nx-cfgfix` and `perf/test-resolve-fix`, all three branches
touch `nx.json`. Resolve by intent, not by "theirs"/"ours":

- `namedInputs.sharedGlobals` — **union** (the test-resolution entries are additive).
- `targetDefaults.test.dependsOn` — **`["lint", "^build"]`**, never the reduced form.
- `plugins` — **union**.
