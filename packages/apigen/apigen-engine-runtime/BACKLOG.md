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

### DEBT-APIGEN-LINT-001 — `@nx/dependency-checks` false-positive on `ajv`/`ajv-formats`

See `packages/apigen/apigen-core-client/BACKLOG.md` DEBT-APIGEN-LINT-001 for
full detail (same root cause, same fix direction — this package's
`package.json` `ajv`/`ajv-formats` deps are only reachable from
tsconfig-excluded test files, so `nx run apigen-engine-runtime:lint` (and
transitively `:build`/`:test`) fails with "package is not used by project").
Filed 2026-07-18 during BUG-APIGEN-CORE-002 verification (apigen-core-client).
