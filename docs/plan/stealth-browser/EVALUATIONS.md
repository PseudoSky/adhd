# Design evaluations - @adhd/stealth-browser (plan 8468f7b1-8adc-4237-9986-21ea1e27c537)

The two architect evaluations requested by the user are recorded verbatim in this directory and folded into the `capture-upgrade` and `chrome-lifecycle` criteria.

| File | Content |
|---|---|
| `SPEC-capture-and-lifecycle.md` | the original architect spec (capture-upgrade section 5, chrome-lifecycle section 6, harness section 4); EVAL-service-proxy.md supersedes its chrome-lifecycle section and EVAL-store-adapter.md its SQLite sink |
| `EVAL-store-adapter.md` | store-adapter sink, version 2: option B'', criteria CU10, CU11, CU13, CU19, CU24 reworded, CU26 and CU27 new, CU14-CU18 and CU20-CU23 kept |
| `EVAL-store-adapter-v1.md` | version 1, kept because version 2 inherits its contract semantics, schema, envelope and the P/X behaviour tables as FEATURE input |
| `EVAL-service-proxy.md` | `@adhd/sox-service-proxy` as the chrome-lifecycle backbone: feature inventory F1-F26, gaps G1-G5, options A-D, replacement spec, criteria CL1-CL23 |

Dependencies: `@adhd/sox-store-adapter` and `@adhd/sox-service-proxy` are owned packages and allowed dependencies; no approval gate applies. The only constraint is module format under ADR-0003 (CJS-only publish, no `exports` map). The store adapter is ESM-only and is reached through a lazy `import()` (type-only import at the top level); the service proxy is CommonJS and is imported statically. Both are installed and kept external by `port-fixes` (port-fixes.12), the single state that owns `package.json`, `pnpm-lock.yaml` and `vite.config.ts` for this purpose, ordered before `capture-upgrade` and `chrome-lifecycle`.

Constraint that binds both designs ([inv:no-features-removed]): every FEATURE and FAILSAFE of the existing implementation stays, each pinned by a new feature-level unit test. Legacy code, legacy tests, internal names and the heartbeat file as a mechanism are free to change.

## E1. Optional store-adapter sink for the capture recorder

STATUS: recorded
Outcome: option B'' of `EVAL-store-adapter.md`. Ship the `RecordingSink` contract, `MemoryRecordingSink`, `StoreRecordingSink` (store parameter `Pick<StoreAdapter, 'exec' | 'executeRun' | 'transaction'>`, type-only import) and `openStoreRecordingSink({ dbPath, table?, loadAdapter? })` with a lazy `await import('@adhd/sox-store-adapter')`. No env var, no toggle. Persistence goes through the adapter only (ADR-0001 D1, D6); batches use `transaction(..., { mode: 'immediate' })`.
Criteria: `capture-upgrade.1-28` (CU1-CU27; `.28` is the inventory pin set).
Why not a static import: Node 22.5 - 22.11 (the package floor is 22.5) has no unflagged `require(esm)`, so a static import would throw ERR_REQUIRE_ESM when the entry loads and break every consumer, not only sink users.

## E2. @adhd/sox-service-proxy as the backbone for chrome-lifecycle

STATUS: recorded
Outcome (final, single-pass: `SPEC-single-pass-lifecycle.md`, superseding the phase-1 hybrid of `EVAL-service-proxy.md` section 5): presence is one held `dialBackend` connection per client to a reaper host served with `@adhd/sox-service-proxy` 0.6.0 (`serveBackend` connection callbacks, `createIdleRetirer`, `createCircuitBreaker`); the policy engine (`decideReap`, the three safety tiers, the breaker, isolated pages, exit hooks) stays in-package behind one port, `ReaperLink`. There is no presence or lease registry, no heartbeat file and no interim code. The service proxy is not the whole backbone: it contains no idle policy and no reaper, and when the host cannot start the manager runs in degraded mode (D1: `ready()` succeeds, nothing is auto-reaped).
Criteria: `chrome-lifecycle.1-27` (CL1-CL23, CL24 legacy heartbeat reader, CL25 B-036..B-039 definitions, CL26 manager shape, CL27 inventory pins). Gaps G1 (targets leak, CL13), G2 (exit hooks wired by `surface-hosts.14`, which now depends on `chrome-lifecycle`), G3 (CL25), G4 (per-process records, CL16 and CL22).
Seam rule (CL22): `lifecycle/sp.ts` is the only module that imports `@adhd/sox-service-proxy`; `ReaperLink` is the single port and a fake link is substitutable in every manager test.

## OPEN-DECISIONS (provisional defaults applied; the user was asked and has not overruled; all are reversible)

| # | Decision | Default applied | Reverse by |
|---|---|---|---|
| OD-1 | Sink dependency weight | `@adhd/sox-store-adapter` in `dependencies` (types always resolvable; costs the native Turso install for every consumer) | move it to an optional peer dependency; the factory already throws CAPTURE_SINK_UNAVAILABLE when absent |
| OD-2 | ADR-0001 D5 two-process proof for a pure append sink | inherit the adapter's gate | add a real two-connection test to a lane that allows sockets |
| OD-3 | Redaction default and raw-versus-redacted exchanges | identity default; raw in memory; redacted only at the sink and `onExchange` boundary | change the `redact` default in `network-recorder.ts` |
| OD-4 | Capture debounce default (CU8) | `extraWaitMs` 0 with the `bodyFetchPending` guard (was an effective 500 ms) | restore a default in `capture/network.ts`; flagged for the user because it changes a default wait |
| OD-5 | Chrome-lifecycle backbone | single-pass over service-proxy 0.6.0 connections (E2, `SPEC-single-pass-lifecycle.md`) | none needed; degraded mode D1 covers a host that cannot start |
| OD-6 | Reaper scope | `port-occupant` (today's behaviour: may close a Chrome it did not launch, via lsof) with an explicit `launched-only` option; the out-of-process reaper signals only a recorded pid whose start-time matches | change the `reaperScope` default |
| OD-7 | Presence mechanism | per-process record files, not a shared mutable file (fixes the lost-update race, G4) | none |
| OD-8 | Transitional safety | no legacy heartbeat reader and no interim code: the cutover order (lifecycle first, then `surface-hosts`, then the agent-search cutover) makes it unnecessary | none |
| OD-9 | Backlog 19dfb641 acceptance criterion 4 | amend (dispatcher action, not edited here): replace "heartbeat file, IdleShutdown, _doShutdown removed" with "no second lifecycle implementation: one policy function (`decideReap`) is used by both the in-process idle path and the out-of-process reaper; every pre-existing feature is pinned by a feature-level test"; also record that its connection-counted premise was retired by ADR-0022 | keep the original wording |
| OD-10 | service-proxy extension design | the user now wants to extend `@adhd/sox-service-proxy` itself so the lifecycle can build on it; a product agent is designing which features belong there and a no-regression plan: `/private/tmp/claude-502/-Users-nix-dev-ai-scratch/c8273d10-b319-41df-99f1-5458418387f6/scratchpad/service-proxy-extension-design.md` (to be written). The seams above are shaped so that outcome needs no change to the policy engine | fold the result in a later planning pass |
| OD-11 | `dom.ts` Google-SERP walker | kept as a feature, flagged for the user; no decision taken | decide after the inventory shows whether it is only a search-provider leftover |

## Upstream tickets (owned repo, not filed here; see DEFERRED.md)

U1 (connection id and `onClientConnect` / `onClientDisconnect`) and U3 (dial recovery) are delivered by service-proxy 0.6.0 itself; U2 service-proxy housekeeping (stale 72d980e5, README dependency claim, 0.5.0 tarball `dist/package.json`, lock staleness blind to pid reuse); U3 dial recovery after a backend restart (3d5da8f2, already filed).
