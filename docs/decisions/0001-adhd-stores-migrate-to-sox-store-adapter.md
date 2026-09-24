# ADR-0001 — Every adhd store migrates to the sox store adapter (Turso), multiprocess enabled; disabling it is banned

**Status:** ACCEPTED (2026-09-24; amended 2026-09-24). **Owner directive** — recorded as accepted, not proposed; do not re-open. Amended the same day by a second owner directive (D7/D8): **Turso's multiprocess support is mandatory and must not be disabled, and "the feature is experimental" is banned as a rationale for declining any multiprocess feature.**
**Owner:** pseudosky.
**Supersedes:** nothing in the adhd series (this is adhd ADR-0001). It **revises the direction** recommended by the 2026-09-22 multi-process research corpus and the F11 finding in `docs/dispatcher/FEATURE_COMPARISON_SOX.md`, which recommended keeping `better-sqlite3` and adding a locking contract. This ADR adopts the adapter **and keeps that contract** — see [Alternatives considered](#alternatives-considered) §A and [Consequences](#consequences) §1.
**Drives:** the agent-store substrate migration; the F11 "concurrency flops" finding; the adhd-side implementation of the `AGENTS.md` parallel-process hard rule.
**Grounding:** owner directive 2026-09-24 ("migrate to the sox store adapter on Turso", `docs/dispatcher/FEATURE_COMPARISON_SOX.md:219`); `docs/dispatcher/FEATURE_COMPARISON_SOX.md:217-219`; `packages/agent/agent-core-env/src/open-registry-db.ts:58-60` (WAL + `foreign_keys=ON`, **no `busy_timeout`**); `entrypoint/agent-mcp/src/db/client.ts:31-38`; `entrypoint/backlog` (reference implementation); `sox ADR-0012`; `sox ADR-0013`.

## TL;DR for the next agent

**Every storage system in adhd — `entrypoint/agent-mcp` and the `packages/agent/*` store family, and any future store — is migrated onto `@adhd/sox-store-adapter` (Turso-backed). `better-sqlite3`-as-the-store is retired. `entrypoint/backlog` is the reference implementation and the precedent.**

**Multiprocess support is mandatory and disabling it is banned (D7).** No adhd store may run in a single-writer / multiprocess-disabled posture — no `multiprocessWal:false`-equivalent, no selecting the single-writer fallback, no environment toggle, and no application-level singleton/PID lock standing in for engine-level coordination. Because the SQLite fallback adapter is single-writer by construction, that fallback is **not** selectable for an adhd store.

**"The feature is experimental" is banned as a rationale for declining a multiprocess feature (D8).** Maturity is a note that routes work into the gated-path + locked contract, never a reason to turn coordination off. Objections must be evidence-based and mechanism-specific — a real reproduction, a missing capability, a platform limit — never the word "experimental".

**The substrate swap is not the safety mechanism.** Turso alone does not make concurrent writers safe, and this ADR does not claim otherwise: the **locking contract still applies on top of the adapter** — `busy_timeout` on every connection, `BEGIN IMMEDIATE` for read-modify-write, bounded retry of busy-shaped errors **only** — expressed as **typed config + retry, never an env-var toggle** (`sox ADR-0013`).

The agent family's schema is **relational**. This ADR mandates the **adapter**; it does **not** mandate a `@adhd/sox-graph-store` remap (that is a separate, later decision — D2).

**The trap to avoid:** reading "we moved to Turso" as "concurrency is now handled" and dropping the busy-timeout/immediate/retry contract. That contract is the point of [Consequences](#consequences) §1; the acceptance gate (D5) exists to prove it, with a negative control.

## Context

**The gap.** The agent/registry store family runs `better-sqlite3@12.10.0` + `drizzle-orm@0.45.2`. The shared registry connection factory opens `new Database(path)` and sets only `journal_mode = WAL` and `foreign_keys = ON` (`packages/agent/agent-core-env/src/open-registry-db.ts:58-60`). `busy_timeout` is left at its default of **0** — so any writer contention surfaces as an immediate, raw `SQLITE_BUSY` rather than a bounded wait. The agent-mcp operational DB (`entrypoint/agent-mcp/src/db/client.ts:31-38`, schema `agents`/`sessions`/`messages`/`tasks`/`task_events`/`task_usage`/`composed_prompts`/`experiment_assignments`) is the same construction. The comparison records the consequence verbatim — the observed "concurrency flops" (`docs/dispatcher/FEATURE_COMPARISON_SOX.md:219`).

**Why this is a gap, not a design.** Parallel-process is the repo invariant: multiple processes may hold concurrent write connections to the same store (`sox ADR-0012`, which supersedes `sox ADR-0007`'s single-writer claim; `sox ADR-0015` was never accepted). The agent store's no-busy-timeout open is therefore an **implementation gap under that invariant**, not a settled single-writer design — the comparison says exactly this.

**The precedent already exists in-repo.** `entrypoint/backlog` runs on the sox substrate (`@adhd/sox-store-adapter@^0.9.2` + `@adhd/sox-graph-store@^0.10.1`). Every mutation runs `adapter.transaction(fn, { mode: 'immediate' })` (BEGIN IMMEDIATE) inside a bounded `withImmediateRetry` (5 attempts, 20 ms → 500 ms cap, jitter, retrying **busy-shaped errors only**), with `busy_timeout` default 5000 (`entrypoint/backlog/src/store/immediate-retry.ts`, `graph-backlog-store.ts`). No package outside `entrypoint/backlog` depends on any `@adhd/sox-*` package today.

**The owner's ruling.** Unify every adhd store on the substrate the rest of the ecosystem already runs — the adapter — rather than maintain a second, `better-sqlite3`-specific locking implementation. The prior review's safety argument is **not refuted**; it is retained as a mandatory obligation on top of the adapter ([Consequences](#consequences) §1).

**What is NOT established / carried residual.** Turso's cross-process mechanism is `multiprocess_wal` (`.tshm`). The 2026-09-22 review marked it `decision: blocked` for a production store of record; **that posture is not adopted as this ADR's rationale (D8)** — its *maturity* argument ("experimental") is banned outright, and its remaining, non-maturity evidence (a stale/frozen `.tshm` producing 5/5 fresh-open failures; macOS locking reports) is handled by the gated-path obligation in D7 and the locked contract in D3, **not** by disabling multiprocess support. `sox ADR-0012` §1 warns: *"Do not cite this invariant as evidence that concurrent writers are safe by construction"*, and records upstream races `tursodatabase/turso#7833`/`#8348`. The substrate is selected **knowingly and with multiprocess enabled**; the residual is carried in [Consequences](#consequences) §1 and §6 and the gate in D5 — it is not dropped.

## Decision

### D1 — Scope: every adhd store, present and future

**Every storage system in adhd migrates onto `@adhd/sox-store-adapter` (Turso-backed).** `better-sqlite3`-as-the-store is **retired** for adhd stores. `entrypoint/backlog` is the reference implementation.

Named, in-repo:
- `entrypoint/agent-mcp` — the operational DB (agents, sessions, messages, tasks, task_events, task_usage, composed_prompts, experiment_assignments) and the migration runner.
- `packages/agent/agent-core-env` — the shared registry connection factory (`openRegistryDb` / `resolveRegistryDbPath`).
- `packages/agent/agent-store-runtime`, `agent-store-prompts`, `agent-store-tools`, `agent-core-policy`, `agent-core-provider`, `agent-engine-compiler` — the registry-family consumers.

**New stores MUST start on the adapter.** A new adhd storage surface that begins on `better-sqlite3` is a violation of this ADR, not an implementation detail.

### D2 — The adapter is the concurrency/connection layer; a graph remap is NOT mandated

The agent family is a **relational** schema (`agents`/`sessions`/`messages`/`task_usage`, with `sessions.agent_name → agents.name ON DELETE CASCADE`). `@adhd/sox-store-adapter` is the **concurrency and connection layer**; `@adhd/sox-graph-store` is a **separate node/edge layer**.

**This ADR mandates the adapter.** It does **not** mandate remapping the agent family onto `@adhd/sox-graph-store`. A graph remap is a distinct decision, out of scope here, and must be proposed as its own ADR. Implementers must not conflate "adopt the adapter" with "restructure the schema as a graph."

### D3 — The locking contract survives the swap and is non-negotiable

The substrate swap alone does not confer safety. On every migrated connection:

1. **`busy_timeout`** set on open (default 5000 ms) — a missing busy-timeout surfaces lock contention as an unhandled driver exception.
2. **`BEGIN IMMEDIATE`** for every read-modify-write (`adapter.transaction(fn, { mode: 'immediate' })`).
3. **Bounded retry** of **busy-shaped errors only** (BUSY / BUSY_SNAPSHOT) with exponential backoff + jitter — never `SQLITE_LOCKED` (same-connection, a code bug) and never Turso's same-connection "statements in progress".
4. **One retry implementation for the whole store** — never per-module retry loops that disagree about what is retryable.

**This contract is expressed as typed config + retry, never as an env-var feature toggle** (`sox ADR-0013`). The busy-timeout **value** may be typed config; whether the contract applies is not a switch — it always applies.

### D4 — Sequenced migration order (blast radius)

Migrate **inward-out**, single choke points first, so each step is independently testable:

1. **`packages/agent/agent-core-env`** — the connection/open factory. Replace the `better-sqlite3` open with an adapter-backed handle, preserving the two properties the file exists to guarantee: **no import-time DB open** (lazy) and the same `journal_mode = WAL` + `foreign_keys = ON` semantics. This is the highest-leverage step: every registry-family consumer below inherits the adapter through it.
2. **`entrypoint/agent-mcp/src/db/client.ts`** (operational DB) and `entrypoint/agent-mcp/src/db/migrate-runner.ts` — the second choke point; the `agents` table and the runtime schema both bind here.
3. **`packages/agent/agent-store-runtime`** — re-type the injected handle from `BetterSQLite3Database` to the adapter's DB handle. (These stores do **not** open connections; they receive one. No schema change.)
4. **`agent-store-prompts`, `agent-store-tools`, `agent-core-policy`, `agent-core-provider`, `agent-engine-compiler`** — bind their schema-typed Drizzle instances to the adapter connection obtained from step 1.
5. **`entrypoint/agent-mcp/src/scripts/agent-mcp-tail.ts`** — the read-only tail reader.
6. **Dependency removal** — once no importer remains, remove `better-sqlite3`, `@types/better-sqlite3`, and `drizzle-orm/better-sqlite3` from the migrated packages. A package that still declares `better-sqlite3` after migration is a lint failure to explain.

**Explicitly flagged as needing a scope ruling (not silently included):** `packages/apigen/apigen-engine-runtime` (a *runtime* dependency on `better-sqlite3`) and `packages/dispatch/dispatch-orchestrator` (a *devDependency*). These are not the `agent-mcp`/`packages/agent/*` scope the owner named; whether "any future store" extends the mandate to them is recorded as an open point in the report that accompanied this ADR, and MUST NOT be assumed either way by an implementer.

### D5 — The acceptance gate: a real two-connection concurrency proof, with a negative control

A migrated store is **not** "done" until a test proves the invariant the way a consumer experiences it:

- **Real OS processes, not `worker_threads`.** The existing claim-lease race test uses in-process workers; `process`-scoped locking is not automatically the same thing (`docs/product/dispatcher-platform/ROADMAP.md` §5.6 caveat). Spawn **two real processes**, each with its **own adapter connection** to the same on-disk store.
- **Drive a read-modify-write under contention** (a claim-like CAS), barrier/latch-released, **not** `sleep`-based. Assert the consumer-visible outcome: the operation completes and **no raw `SQLITE_BUSY`/driver error reaches the caller**.
- **Negative control.** Run the identical harness against the **pre-migration `better-sqlite3` build** and confirm it goes **RED** (raw `SQLITE_BUSY` / lost update). The test must FAIL if the bug is reintroduced. Trust the runner's **exit code**, not stdout.
- **Migration-integrity gate.** The schema move is schema-preserving: verify with `integrity_check` and row parity, following the `migrateStore()`/backup-first precedent the sox adapter already establishes. No data loss, no silent column drop.

This mirrors `entrypoint/backlog`'s `withImmediateRetry` proof and the claim-lease pattern — at **process** scope, which is the level the guarantee is actually needed.

### D6 — Dependency posture

adhd gains a dependency on sox-ecosystem's published adapter. This is a **three-link chain** (sox store → adhd agent stores → any future consumer), so the dependency is **pinned deliberately** and conformance is run against the pin. This is the same shape of dependency `entrypoint/backlog` already carries.

### D7 — Multiprocess support is mandatory; disabling it is banned

Every migrated adhd store runs with Turso's **multiprocess support enabled**. Running an adhd store in a single-writer / multiprocess-disabled posture is **banned**. Banned shapes include, non-exhaustively:

1. **A config or typed switch that disables it** — any `multiprocessWal:false`-equivalent, or any option that selects the embedded/SQLite **fallback** mode. Because that fallback is single-writer by construction (`sox ADR-0012` §1), it is **not a permitted backend for an adhd store**.
2. **An environment toggle** — `sox ADR-0013` forbids env feature switches outright; a `*_MULTIPROCESS` / `*_ENABLED` variable is a violation on sight.
3. **An application-level substitute** — a singleton, PID-file lock, elected owner, or "only one process may open this" convention presented *in place of* engine-level coordination. An application lock may **add** safety around a specific path; it may never **replace** multiprocess support.
4. **An import-time or constructor-time default** that can leave a store opened single-writer.

This is **not** softened by the fact that writers serialize. Multiprocess **support** (many processes may hold concurrent write connections to one store) is the requirement; engine-level write serialization is a property of WAL, not a licence to disable access. If a path genuinely cannot run multiprocess-enabled, the remedy is to fix that path — never to disable the feature (`adhd ADR-0002`).

### D8 — A feature's maturity label is never a reason to decline it

**"This feature is experimental" is banned as a rationale for declining the use of any multiprocess feature.** The same applies to "preview", "beta", "unstable", and to the research registers' `decision: blocked` / `agent:blocked` **when the basis is maturity** rather than a mechanism-specific defect.

Maturity is handled by mechanisms, not by avoidance:

1. the **locked contract** on top (D3);
2. the **gated-path obligation** (D7) — the risky path is gated and proven, not disabled;
3. the **acceptance gate** (D5) — a real two-process proof with a negative control;
4. the **re-open trigger** for *observed* corruption ([Consequences](#consequences) §6).

A valid objection is **evidence-based and mechanism-specific**: a reproducible failure, a missing capability, a platform limitation, or a named upstream defect with a reproduction. **"It is experimental" is not an objection.** Citing `09-tool-turso-multiprocess-wal.md`'s `decision: blocked`, or its "explicitly experimental" bullet, as a reason to decline multiprocess support is a violation of this ADR.

## Consequences

1. **Turso alone is not a safety guarantee — the locking contract still applies.** `busy_timeout` + `BEGIN IMMEDIATE` for read-modify-write + bounded `SQLITE_BUSY`-only retry, on top of the adapter (D3). Dropping this because "we're on Turso now" reintroduces the exact "concurrency flops" this ADR exists to fix, and `sox ADR-0012` §1 explicitly forbids reading its invariant as "concurrent writers are safe by construction."
2. **The contract is typed config + retry, never an env-var toggle** (`sox ADR-0013`). No `*_ENABLED`, no `VAR=off`.
3. **The adapter is the mandate; a `@adhd/sox-graph-store` remap is a separate decision** (D2). The agent family stays relational.
4. **Blast radius + sequenced order are named** (D4), with the two out-of-scope consumers flagged rather than assumed.
5. **The acceptance gate is a real two-connection, two-**process** concurrency proof with a negative control** (D5) — not a proxy, not a mock, not in-process threads.
6. **Carried residual — mechanism-specific, never a maturity objection.** `sox ADR-0012` records upstream races and past corruptions under this substrate, and a stale/frozen `.tshm` produced 5/5 fresh-open failures in the 2026-09-22 research. Those are handled by the **gated-path obligation (D7)** and the **locked contract (D3)** — **never** by disabling multiprocess support, and never by citing the feature's maturity label (D8). A future, **observed** corruption under a migrated, multiprocess-enabled store re-opens this ADR's substrate choice — it is not shielded by it.
7. **Positive:** one substrate, one error taxonomy, one retry contract across adhd's stores and `entrypoint/backlog`; the agent family inherits the adapter's bounded retry and driver-agnostic error classification; the `openRegistryDb` no-import-time-open property is preserved by construction (step 1).

## Alternatives considered

### A — Keep `better-sqlite3`; add an explicit multi-process locking contract

**What it was.** Keep the current substrate and add the full contract directly: one `busy_timeout` (e.g. 5000 ms) on every connection at open; `BEGIN IMMEDIATE` for all read-modify-write; bounded exponential-backoff retry of `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT` only; one centralized retry implementation. This was the **explicit recommendation of the prior architecture review** (`docs/research/fallback/2026-09-22-sqlite-multiprocess-failure-modes/08-busy-locked-retry.md`, indexed `pattern:recommended`) and the direction the F11 finding in `docs/dispatcher/FEATURE_COMPARISON_SOX.md` points at.

**Why it was recommended.** The review's argument is that **the substrate swap alone does not confer safety**: `sox ADR-0012`'s multi-process invariant is **Turso-specific by its own terms** (`sox ADR-0012` §1 — the SQLite fallback adapter remains single-writer by construction); `sox ADR-0015` records corruption under the substrate; and Turso's `multiprocess_wal` was itself marked `decision: blocked` for production (`09-tool-turso-multiprocess-wal.md`). On that evidence, the review argued the correct fix is the locking contract, not a substrate change. **Note (D8):** one ingredient of that argument — that `multiprocess_wal` is *experimental* — is **banned as a rationale**; the recommendation is honoured only for its non-maturity evidence (the locking contract), which survives as D3.

**The ruling.** **REJECTED — overridden by the owner (2026-09-24).** The owner ruled that adhd unifies every store on the adapter the rest of the ecosystem already runs, rather than maintaining a second, `better-sqlite3`-specific locking implementation. **This is the deciding ruling and it is final for this ADR.**

**What survives — and is why this is a "no", not an erasure.** The owner's override changes the *substrate choice*; it does **not** refute the review's safety evidence. That evidence is carried forward **as a mandatory obligation**: D3 requires the entire locking contract *on top of* the adapter, and [Consequences](#consequences) §1 states that Turso alone is not a guarantee. The migration is therefore **"adapter AND locking contract"**, never **"adapter instead of locking contract."** The review's **non-maturity** evidence is preserved — it is why D3 is non-negotiable and why the gated-path obligation (D7) exists. Its **maturity** argument ("experimental") is **rejected** under D8, and its `decision: blocked` verdict is **not** adopted as this ADR's position: multiprocess support stays enabled.

### B — Migrate only the agent-mcp operational DB, leave the registry family on `better-sqlite3`

**Rejected.** It splits the substrate: two connection conventions, two retry postures, two error taxonomies. It also leaves the shared registry `openRegistryDb` choke point — the higher-contention surface — unmigrated. The owner's directive is "every storage system."

### C — Migrate but also remap the agent family onto `@adhd/sox-graph-store`

**Rejected / not mandated.** The agent family is relational with a live FK cascade; a graph remap is a schema redesign, not a connection swap. It is a **separate decision** (D2), and bundling it would turn a substrate migration into a data-model migration.

### D — File the agent-store gap as debt and defer

**Rejected.** `docs/product/dispatcher-platform/ROADMAP.md` ruling **D-F** ("fix things, don't file debt") governs; the gap is a concrete, bounded migration with an existing reference implementation.

## What does NOT change

- **The parallel-process invariant itself** — `sox ADR-0012`, superseding `sox ADR-0007`; `sox ADR-0015` never accepted. This ADR **implements** it for adhd's stores; it does not restate or alter it.
- **The agent family's schema** — relational, unchanged (D2). Only the connection/concurrency layer changes.
- **`entrypoint/backlog`** — already on the substrate; it is the reference, and this ADR changes nothing in it.
- **The API surface of the migrated packages** — consumers that receive an injected handle continue to receive one; the handle's producer changes, not its consumers' contract, wherever the injected-type boundary is preserved (step 3).
- **`sox ADR-0013`'s broader env-var policy** — this ADR adds one application of it, not a new policy.
- **The scope of the ban** — D7/D8 bind **adhd stores**. They do not restate or amend sox's own design; sox packages remain governed by their own catalog (`sox ADR-0012` included — its fallback-is-single-writer statement is *why* D7 refuses that fallback for adhd, not a contradiction of it).

## References

- Owner directive, 2026-09-24 — recorded at `docs/dispatcher/FEATURE_COMPARISON_SOX.md:219`.
- `docs/dispatcher/FEATURE_COMPARISON_SOX.md` F11 (agent store: no `busy_timeout`) and §findings.
- `docs/research/fallback/2026-09-22-sqlite-multiprocess-failure-modes/08-busy-locked-retry.md` (the locking contract).
- `docs/research/fallback/2026-09-22-sqlite-multiprocess-failure-modes/09-tool-turso-multiprocess-wal.md` — research finding; its `decision: blocked` posture **and its experimental-status rationale are rejected under D8**. Its non-maturity evidence is carried by D7/D3. (A superseding marker at that file's head is tracked in the backlog rather than applied here, because that artifact is not this session's to edit.)
- `packages/agent/agent-core-env/src/open-registry-db.ts:50-64`; `entrypoint/agent-mcp/src/db/client.ts:31-38`.
- `entrypoint/backlog/src/store/immediate-retry.ts`, `entrypoint/backlog/src/store/graph-backlog-store.ts` (reference implementation).
- `sox ADR-0012` — `sox-ecosystem/docs/decisions/0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md`.
- `sox ADR-0013` — `sox-ecosystem/docs/decisions/0013-feature-switches-are-typed-config-not-env-vars.md`.
- `docs/product/dispatcher-platform/ROADMAP.md` §5.6 (process-vs-thread proof caveat), ruling D-F.
