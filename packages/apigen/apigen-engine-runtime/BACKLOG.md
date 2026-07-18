# BACKLOG — @adhd/apigen-runtime

Package-scoped log. Repo-wide context lives in the root [BACKLOG.md](../../../BACKLOG.md)
(§ _Extraction performance + memory-leak work (2026-07-02)_).

## Fixed

### EventBus handler leak — RESOLVED 2026-07-02

`EventBus.on()` appended handlers forever with no removal path — hosts creating packages
repeatedly accumulated handlers for the bus's lifetime. Added `off(selector, handler)`,
`clear()`, and `on()` now returns an unsubscribe function; `createApiPackage()` results
gained `dispose()` (clears the package bus). Guard: `src/test/event-bus.spec.ts`.

Note for consumers: `on()`'s return type changed `void` → `() => void` (additive in
practice; only breaking for code that type-asserted the `void` return).

## Open

### DEBT-APIGEN-LINT-002 — `apigen-engine-runtime` missing from `pnpm-lock.yaml` entirely

See `packages/apigen/apigen-core-client/BACKLOG.md` DEBT-APIGEN-LINT-002 for
full detail. NOT the tsconfig-exclusion pattern (DEBT-APIGEN-LINT-001 in that
file) — `ajv`/`ajv-formats` ARE real, non-test dependencies
(`src/lib/validate-layer.ts:34-36`) at the exact version installed, but this
package has zero importer entries in `pnpm-lock.yaml`, so
`@nx/dependency-checks` can't see the edge regardless of what `package.json`
declares. The pre-commit hook's ESLint `--fix` deleted `ajv`/`ajv-formats`
from `dependencies` TWICE during this fix's own commits on 2026-07-18 before
a containment fix landed: `.eslintrc.json`'s `@nx/dependency-checks` override
now has `"ignoredDependencies": ["ajv", "ajv-formats"]` (verified `lint` and
`lint --fix` both leave `package.json` alone). The underlying lockfile gap is
still open — the `ignoredDependencies` entry is a workaround, not the fix;
remove it once a maintainer runs `pnpm install` to give this package a real
`pnpm-lock.yaml` importer entry. Filed + contained 2026-07-18 during
BUG-APIGEN-CORE-002 verification (apigen-core-client).
