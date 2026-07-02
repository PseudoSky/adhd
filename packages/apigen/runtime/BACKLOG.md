# BACKLOG — @adhd/apigen-runtime

Package-scoped log. Repo-wide context lives in the root [BACKLOG.md](../../../BACKLOG.md)
(§ *Extraction performance + memory-leak work (2026-07-02)*).

## Fixed

### EventBus handler leak — RESOLVED 2026-07-02
`EventBus.on()` appended handlers forever with no removal path — hosts creating packages
repeatedly accumulated handlers for the bus's lifetime. Added `off(selector, handler)`,
`clear()`, and `on()` now returns an unsubscribe function; `createApiPackage()` results
gained `dispose()` (clears the package bus). Guard: `src/test/event-bus.spec.ts`.

Note for consumers: `on()`'s return type changed `void` → `() => void` (additive in
practice; only breaking for code that type-asserted the `void` return).

## Open

_(none)_
