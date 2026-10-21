# search-port-guards — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** search-errors · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-guards`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Provider cooldown, concurrency cap and tripwire are ported as typed-config modules over the tripwire package, with the namespace decision recorded and every former `SEARCH_*` environment toggle replaced by `SearchHostConfig`.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/src/lib/{guard,tripwire,config}.ts`, `entrypoint/stealth-search/src/test/unit/guards/*.spec.ts`. READ `search-guard.ts`, `search-tripwire.ts` of the source repo and `packages/resilience/resilience-core-tripwire/src/index.ts` (its public API).

- **Reference Pattern:** inventory rows I-05..I-07 (guard side), I-15, I-19..I-21; `SPEC-tripwire.md` D3/F7/F16; `SPEC-stealth-search.md` section 2.5.

- **Delta Spec:** (1) FIRST STEP (decision O8): the tripwire namespace is `stealth-search` (constant `TRIPWIRE_NAMESPACE`); locks written under the old `agent-search` namespace expire within 2 h and are accepted as lost. Record it in a comment on the constant and in the spec title. (2) `SearchHostConfig` replaces `SEARCH_MAX_CONCURRENT`, `SEARCH_*` cooldown and TTL toggles and the data dir env: every value is a typed field with the spec defaults (TTL 7200000, cooldowns 30000/20000/60000, maxConcurrent 2, maxSiblings 4, data dir under `adhdDataDir`, default root `~/.adhd/reverse/data` so the shared `audit.log` survives). (3) `InteractionPort` (tripwire gate prompt, solved confirmation) is declared here; the CLI host (later state) supplies the TTY implementation, the MCP host none. (4) `tripwireStatus` is a sparse string-keyed record; `TripwireRecord` is a concrete non-generic interface (apigen extraction).

- **Invariants:** [inv:typed-errors] [inv:tests-cite] [inv:search-over-core] [def:tripwire-pkg]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-port-guards]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-port-guards` — runs every acceptance criterion below (red until the work is done); `--only search-port-guards.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/search_a.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-port-guards --only search-port-guards.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-port-guards.1] src/lib/config.ts exports the typed `SearchHostConfig` (dataDir, auditPath, auditMaxBytes, tripwireTtlMs, cooldownCaptchaMs, cooldownRateMs, cooldownBannedMs, maxConcurrent, maxSiblings, sessionId) and a `DEFAULT_SEARCH_HOST_CONFIG` with the defaults 7200000, 30000, 20000, 60000, 2 and 4 and a data dir derived from `adhdDataDir` (default root ~/.adhd/reverse/data), plus the `InteractionPort` interface (tripwire gate prompt and solved-confirmation methods) used by `configureSearch({ interaction })`.
- [search-port-guards.2] guard.ts ports the provider cooldown and the concurrency cap: cooldown state is written atomically (temp file then rename) to `<data>/guard/<provider>.json`, expired cooldowns are removed lazily on read, a `hitl` outcome never arms a cooldown while `success` and `empty` disarm it, unreadable state raises PROVIDER_STATE_IO, and `maxConcurrent` (default 2, <= 0 disables) is a per-process FIFO queue; specs simulate three concurrent callers (third waits, FIFO release order), the three cooldown durations, lazy removal and the hitl exclusion.
- [search-port-guards.3] tripwire.ts builds the tripwire from the tripwire package with `createTripwire` using namespace `stealth-search` (decision O8, constant `TRIPWIRE_NAMESPACE`, existing `agent-search` locks expire in 2 h), `clearPolicy: 'open'`, the TTL from config (default 7200000), stateDir/auditPath/maxAuditBytes from `SearchHostConfig`; it maps fire, gate with blocked-count, cleared, resolved, read and isTripped, keeps `TripwireRecord` a concrete non-generic interface, and `tripwireStatus` returns a sparse string-keyed record; unreadable state raises TRIPWIRE_STATE_UNREADABLE and a failed clear TRIPWIRE_CLEAR_FAILED; specs simulate fire, blocked gate, clear of a tripped provider, clear of an untripped one (false), an expired lock and a corrupt lock.
- [search-port-guards.4] No state or behaviour is read from the environment: guard.ts, tripwire.ts and config.ts have no `process.env` and take every setting from `SearchHostConfig` (ADR-0001), proven by a spec that builds two different configs in one process.
- [search-port-guards.5] Every inventory row owned by search-port-guards is cited by id in the source or specs, and the specs (at least three files: guard, tripwire, config) cite ticket 8468f7b1 and a search-port-guards.N id.
- [search-port-guards.6] Hygiene of the owned files: no `process.env`, no bare Error, no `@adhd/stealth-browser` string, no deep import into the core's src/, no own WebSocket.
- [search-port-guards.7] The state gates are green: `nx run stealth-search:typecheck`, `:lint` and `:test` exit 0.
- [search-port-guards.8] Only owned paths changed by [psm:search-port-guards] commits.

- [search-port-guards.9] (backlog c6d7fbcf, 982ea870, 9487dcd0, d201694e, a3266358, 6ae134b9, 08801f2a, 84e1f7a2, 3aaa855f; 9d05e8b2 is search-hosts.20) The search wiring of the tripwire package (tripwire.ts over `createTripwire`) is proven by one spec set under src/test/unit/guards/ (for example tripwire-wiring.spec.ts) whose titles carry the nine uids: a corrupt lock file fails closed (c6d7fbcf: the provider reads as tripped or raises TRIPWIRE_STATE_UNREADABLE, never as clear); a `SearchHostConfig` data-dir override moves both the lock and the audit file and nothing is written under the default root (982ea870); created lock and audit files are 0600 in 0700 directories (9487dcd0); re-tripping a tripped provider keeps the first cause and counts the re-trip (d201694e); concurrent writes use distinct temp file names (a3266358); N concurrent blocked-count increments yield N (6ae134b9); the audit cap rewrite is atomic and counts lines, with a multibyte case (08801f2a); TTL expiry removal writes an audit line with reason `ttl-expired` (84e1f7a2); the clear path leaves a final record identical to a plain delete, with no dead resolved or reverified write (3aaa855f). A behavior the tripwire package itself fails is not fixed here: the spec states it with `it.fails` naming the uid and the executor records a finding under a `## Findings` heading of this state's context. Titles carry `0600`, `0700`, `ttl-expired`, `multibyte`, and the spec cites [search-port-guards.9]; `nx run stealth-search:test -- src/test/unit/guards` exits 0.
- [search-port-guards.10] (backlog 93dee018) The tripped state tells agents how to clear it: every tripped entry of `tripwireStatus` carries `clearWith: 'clearTripwire'` (the agent-callable verb, `clearPolicy: 'open'`) plus `trippedAt` and `expiresAt`, expired locks are not listed, and `clearTripwire` of a tripped provider returns true, records a cleared audit event and lets the next search proceed. A spec under src/test/unit/guards/ simulates the researcher flow (search returns hitl, tripwireStatus lists the provider with clearWith, clearTripwire is called, the next search succeeds); titles carry `clearWith`, `clearTripwire`, `cleared`, `hitl`, `expiresAt` and the uid 93dee018, and the spec cites [search-port-guards.10].
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/stealth-search/src/lib/guard.ts", "entrypoint/stealth-search/src/lib/tripwire.ts", "entrypoint/stealth-search/src/lib/config.ts", "entrypoint/stealth-search/src/test/unit/guards/"]
```

---

## Contract Promise

Added: three modules and guard specs. Modified: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-port-guards]`:

- [ ] After the guard passes: `feat(stealth-search): port cooldown, concurrency and tripwire guards [psm:search-port-guards]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

## Backlog fold-in (2026-10-14 search bugs)

Backlog-facing: each criterion below is cited by a unit test simulating the real use case; ids are stable (appended, never renumbered).

- Tripwire writer family c6d7fbcf (HIGH), 982ea870 (HIGH), 9487dcd0, d201694e, a3266358, 6ae134b9, 08801f2a, 84e1f7a2, 3aaa855f -> ONE criterion set, [search-port-guards.9]: the old search tripwire is replaced by `@adhd/resilience-core-tripwire`; unit tests prove each behavior in the new wiring. 9d05e8b2 (CLI vs MCP status parity) is [search-hosts.20].
- 93dee018 -> [search-port-guards.10]: `tripwireStatus` tells agents how to clear (`clearWith: 'clearTripwire'`, `clearPolicy: 'open'`).
- If the tripwire package itself fails one of the .9 behaviors, do not change the package here: state the behavior with `it.fails` naming the uid and add the finding below.

## Findings

_(none recorded yet; the executor lists any behavior the tripwire package fails, by backlog uid, before completing the state.)_
