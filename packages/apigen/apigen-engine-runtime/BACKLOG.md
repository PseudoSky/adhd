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
same file) — `ajv`/`ajv-formats` ARE real, non-test dependencies
(`src/lib/validate-layer.ts:34-36`) at the exact version installed, but this
package has zero importer entries in `pnpm-lock.yaml`, so
`@nx/dependency-checks` can't see the edge regardless of what `package.json`
declares. **Do not let an ESLint `--fix` run delete `ajv`/`ajv-formats` from
`dependencies`** — it will "fix" the lint error by deleting a genuinely-used
runtime dependency (this happened once already, caught and reverted by hand,
during BUG-APIGEN-CORE-002's own commit on 2026-07-18). Filed 2026-07-18
during BUG-APIGEN-CORE-002 verification (apigen-core-client).
