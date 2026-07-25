### DEBT-APIGEN-LINT-002 — `apigen-engine-runtime` package.json has no `pnpm-lock.yaml` importer entry at all

**Status:** OPEN

- **Where:** `packages/apigen/apigen-engine-runtime/package.json`
  (`ajv`, `ajv-formats` — both genuinely imported in real, non-test source:
  `src/lib/validate-layer.ts:34-36`, `import Ajv from 'ajv'; import
  addFormats from 'ajv-formats'; import type { ErrorObject } from 'ajv';`).
- **Symptom:** `nx run apigen-engine-runtime:lint` fails with `@nx/dependency-checks`
  "The 'ajv' / 'ajv-formats' package is not used by 'apigen-engine-runtime'
  project" — despite the exact declared version (`^8.20.0` / `2.1.1`)
  matching what's actually installed at the workspace root
  (`node_modules/ajv/package.json` → `8.20.0`,
  `node_modules/ajv-formats/package.json` → `2.1.1`) and the import being
  real, unambiguous, non-test source. NOT the same root cause as
  DEBT-APIGEN-LINT-001 (this file is not tsconfig-excluded, and the version
  specifier matches). Root cause: `grep -n "packages/apigen/apigen-engine-runtime"
  pnpm-lock.yaml` returns ZERO matches — this package has no importer entry
  in `pnpm-lock.yaml` at all, so `@nx/dependency-checks` (which reads the
  lockfile-derived dependency graph, not raw `node_modules` disk state) has
  no edge to find between the project and `ajv`/`ajv-formats` regardless of
  what's declared in `package.json`.
- **Why it matters:** this repo's pre-commit hook runs `nx affected -t lint --fix`
  on every commit. Its auto-fix for "unused dependency" is DELETE THE
  DEPENDENCY FROM package.json — which for this specific false-positive
  deletes a genuinely-used runtime import, silently, on every commit that
  touches an affected project. **Reproduced twice in one session**: once
  during this fix's first commit attempt (`git commit`'s pre-commit hook
  auto-fixed + re-staged the deletion into the commit without prompting),
  and again on the very next commit after I'd manually restored it —
  confirming this isn't a one-off, it will keep recurring on every future
  commit until addressed.
- **Fix applied (containment, not the real fix):** added
  `"ignoredDependencies": ["ajv", "ajv-formats"]` to
  `apigen-engine-runtime/.eslintrc.json`'s `@nx/dependency-checks` override
  (matching the pre-existing `ignoredDependencies: ["zod"]` pattern in
  `apigen-core-client/.eslintrc.json`), and restored `ajv`/`ajv-formats` to
  `package.json` `dependencies`. Verified `nx run apigen-engine-runtime:lint`
  passes AND `nx run apigen-engine-runtime:lint --fix` no longer touches
  `package.json` (both checked directly, not assumed). This was the pragmatic
  call given the deletion loop was actively reproducing in real time and
  blocking every subsequent commit in this session — an earlier draft of
  this entry said "do NOT fix via ignoredDependencies", which was the right
  instinct for a first-pass diagnosis but not survivable in practice once
  the destructive auto-fix reproduced a second time.
- **Fix direction (the REAL fix, still not done):** run `pnpm install` (or
  the workspace's equivalent lockfile-sync command) so `pnpm-lock.yaml`
  gains a real importer entry for `packages/apigen/apigen-engine-runtime` —
  NOT attempted here: this repo mixes `pnpm-lock.yaml` and `package-lock.json`
  at the root (unclear which is authoritative) and a full lockfile resync of
  a monorepo this size is a bigger, higher-risk operation than this
  finding's scope warrants. Once that's done, the `ignoredDependencies`
  entry added above should be removed again (it's a workaround for the
  lockfile gap, not a permanent policy).
- **Status:** OPEN (containment fix applied 2026-07-18; root cause — the
  missing lockfile entry — still needs a deliberate `pnpm install` by a
  maintainer).

### DEBT-APIGEN-CACHE-001 — persistent cache versions the ENTRY file only

**Status:** UNKNOWN

A type imported from another file that changes (entry file untouched) is not detected —
same invalidation semantics the generator cache always had. Fix direction: include the
program's referenced-files set in the version stamp.

### DEFER-APIGEN-PERF-001 — worker_threads parallel extraction (stretch)

**Status:** UNKNOWN

Per-source fan-out across workers for multi-source cold runs. Deferred: bundled-CLI
worker-entry complexity vs. modest gains now that warm runs are ~free.

---
