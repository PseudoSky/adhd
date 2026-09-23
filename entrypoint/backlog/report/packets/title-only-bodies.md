# Title-only item bodies — retrieved live

**Source:** `adhd-backlog` production store `~/.adhd/backlog/production/data/backlog-v2.db`
(confirmed via `adhd-backlog sandbox-path`). **Retrieved:** 2026-09-22.
**Method:** one `batch action` (`operation: backlog/get`, `mode: parallel`, `onItemError: continue`),
29/29 fulfilled, `fields: [uid,title,body,status]`.

Packet 4 (`4-store-criticals-waves.md`) lists 27 title-only uids; packet 1 (`1-live-deploy-ci.md`)
lists 2 unread uids. Packets 2 and 3 declare **no** title-only/unread items (packet 2 states all 23
domain uids were retrieved live; packet 3's inputs are all spec/uid-anchored, not title-only).

## Short-uid → full-uid map

| short | full uid | status |
|---|---|---|
| `4b65f64e` | `4b65f64e-32b6-4b77-b64c-257dadd7e617` | OPEN |
| `1e023495` | `1e023495-16f3-4b5e-9e4e-20a04034206b` | OPEN |
| `d8f0c34b` | `d8f0c34b-2d9f-4e60-91c4-ec3971825b1e` | OPEN |
| `7df3d566` | `7df3d566-6e23-4c6c-9042-691b4f11d871` | OPEN |
| `a40056fb` | `a40056fb-3d7e-415f-9579-e41b55d12cb3` | OPEN |
| `4295ad2b` | `4295ad2b-666c-48cc-b5de-2a358c2297ab` | OPEN |
| `6242cb2a` | `6242cb2a-47a1-4e04-be35-19308f3016f2` | OPEN |
| `aa70a2c2` | `aa70a2c2-ce9e-4da1-b6ed-dabe2a967c32` | OPEN |
| `0f05e81b` | `0f05e81b-8242-4237-817c-7bad410ae146` | OPEN |
| `15d6c878` | `15d6c878-a3c0-44d6-9f90-9c96012b198e` | OPEN |
| `ad333b3e` | `ad333b3e-2fea-40e2-8765-de8478bdb0a3` | OPEN |
| `76a9c2f2` | `76a9c2f2-17fb-4c8b-b413-69c47029f56e` | OPEN |
| `2f196e3e` | `2f196e3e-dae2-40b8-95c3-7dca163365ba` | OPEN |
| `59f22cbd` | `59f22cbd-7889-48ab-9fdd-324351a563b8` | OPEN |
| `851c89bc` | `851c89bc-72ab-427e-af87-d07bbcb7830b` | OPEN |
| `f83e727f` | `f83e727f-ae77-4c8e-853b-f720703b3418` | OPEN |
| `d1064dc2` | `d1064dc2-650e-48f7-a873-60f71905c0ef` | OPEN |
| `bee49391` | `bee49391-60e3-4173-8980-c7711c8ed57b` | OPEN |
| `a9a7deff` | `a9a7deff-7ce3-4c81-8097-7b6aa91ad50e` | OPEN |
| `e6799f8f0` | `e679f8f0-617e-4532-8a83-562a082c43ed` | open |
| `82470ae8` | `82470ae8-05d4-4e73-980a-3176d8148c40` | open |
| `2b1d8a22` | `2b1d8a22-ce94-474b-a85c-5c53bc6ce29d` | open |
| `a934e089` | `a934e089-0c23-4144-88bb-e60a04f44015` | open |
| `1e12507f` | `1e12507f-6d1d-4f8c-9234-12f7261da309` | open |
| `8a09824c` | `8a09824c-cf59-438a-9fc0-eaeb599d7c36` | DUPLICATE |
| `92b82a73` | `92b82a73-6fab-42ad-8c30-1830374ce940` | open |
| `2e117b1a` | `2e117b1a-0263-4b87-b1fd-6fd0ffb7607c` | open |
| `2039bb80` | `2039bb80-2a1a-4996-b2ff-3531a510aba5` | open |
| `87799e1d` | `87799e1d-0dfc-41ba-b2cd-919513d7a7b6` | open |

> **Typo corrected:** packet 4 lists `e6799f8f0` (9 hex chars, does not resolve). The real uid is
> `e679f8f0-617e-4532-8a83-562a082c43ed` (`e679f8f0`). Recorded here under the packet's spelling.

---

## `4b65f64e` — A native turso panic leaks BOTH the lease file and its .openmark — every crash permanently narrows the quiescence gate

- **uid:** `4b65f64e-32b6-4b77-b64c-257dadd7e617`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
OBSERVED LIVE 2026-08-14, twice, with direct evidence.

WHAT HAPPENS: when the store is corrupt, `backlog version` panics inside turso's pager (`core/storage/pager.rs:190: index out of bounds: the len is 4096 but the index is 20546`). The process dies without unwinding, and its lease files remain in `backlog.db.sox-lease.d/`.

EVIDENCE: after a panicking `backlog version`, the lease dir contained `c589cc91-1a84-4525-810b-f1e5f272e154` and `c589cc91-....openmark`, both stamped 2026-08-14T22:14:33Z, naming pid 12910. `ps -p 12910` confirmed that pid was DEAD. A second, earlier leak from the same cause was present on arrival (`c2987ebb-...`, 13:07).

WHY THIS IS HIGH:
- The lease dir is the quiescence gate. Orphaned leases make the store look permanently BUSY, so every operation that is correctly gated on quiescence — reconcile, migration, checkpoint — is blocked forever, by a process that no longer exists.
- The counter-pressure is worse: it motivates the destructive sweep path, and that sweep currently misreads EPERM as death (see sox-ecosystem BUG-STOREADAPTER-EPERM-READ-AS-DEAD-PEER-001). So a leak-then-sweep cycle can end up clearing a LIVE peer's lease.
- A native Rust panic cannot be caught by a JS `finally`. Cleanup that lives only in a JS unwind path is structurally unable to run here.

REQUIRED: lease liveness must not depend on orderly cleanup. Make the lease self-invalidating — record the pid AND process start time, treat a lease whose pid is dead (ESRCH, never EPERM) as stale on READ rather than requiring a sweep, and add a crash-path test.

ACCEPTANCE (red->green): a test spawns a child that takes a lease and is SIGKILLed (simulating a panic, since SIGKILL is likewise uncatchable); the parent must observe the store as quiescent WITHOUT a destructive sweep. Must fail before the fix.

Citations: [main, architect-reviewer, claude, backlog-turso-integration, 1: /Users/nix/.adhd/backlog/production/data/backlog.db.sox-lease.d, 2: libs/data/store/store-adapter/src/store-lease.ts]
```

## `1e023495` — Retry loop re-logs the ORIGINAL error every attempt and retries with zero state change

- **uid:** `1e023495-16f3-4b5e-9e4e-20a04034206b`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
REFILED after the 2026-08-14 store corruption (formerly DEBT-003). The T2 heal for this landed on main in a5ba900c — verify then resolve.

Two problems:
(1) Each retry attempt logs the FIRST error again rather than the error that attempt actually produced. Operator-visible logs therefore show N copies of one error, hiding the fact that the failure mode CHANGED mid-loop (e.g. contention -> corruption). During the BUG-014 incident this actively misled diagnosis.
(2) Nothing about the attempt differs between iterations — no backoff state, no reconnect, no re-read of the header. A retry that changes nothing cannot succeed for any error that is not spontaneously self-clearing, so the loop burns its budget for no benefit while holding contention on a store that is already struggling.

ACCEPTANCE: a test asserts the logged error on attempt N is the error thrown BY attempt N, and that some state (backoff/reconnect) demonstrably differs between attempts.

Citations: [main, architect-reviewer, claude, bug014-store-hardening, 1: libs/data/store/store-adapter/src/turso-adapter.ts:631-668]
```

## `d8f0c34b` — errors.ts SQLITE_*-code helpers never match against the live Turso driver — code is always GenericFailure

- **uid:** `d8f0c34b-2d9f-4e60-91c4-ec3971825b1e`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
**Discovered while building SPEC-CONN-RECYCLE (BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001's fix), 2026-08-08.** Pre-existing, separate defect — not introduced by that packet.

## What I found

I probed the real `@tursodatabase/database@0.7.1` driver directly (script run against a throwaway local store, issuing five representative statement-local failures) and read the actual error shape:

```
bad SQL syntax      -> code=GenericFailure  message="failed to consume stmt: near \"SELEKT\": syntax error"
unknown table        -> code=GenericFailure  message="prepare failed: Parse error: no such table: nope"
unknown column        -> code=GenericFailure  message="prepare failed: Parse error: no such column: nope"
unique constraint       -> code=GenericFailure  message="step failed: Runtime error: UNIQUE constraint failed: t.name (19)"
type mismatch bind       -> code=GenericFailure  message="step failed: Runtime error: datatype mismatch"
```

**Every one of these is `code: 'GenericFailure'` — including the UNIQUE constraint violation.**

This directly contradicts `errors.ts`'s own docstring (`libs/data/store/store-adapter/src/errors.ts:1-9`, `:80-88`), which claims `isUniqueConstraintError`/`isForeignKeyError`/`isBusyError` "duck-type across both" adapters via a shared `SQLITE_*`-prefixed `code` field. For the live `@tursodatabase/database` driver, `code` carries zero discriminating information — it is `GenericFailure` for parse errors, constraint violations, and (per the incident log for BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001) the fatal I/O error alike.

`isDatabaseError()` (`err.code.startsWith('SQLITE_')`, errors.ts:154-157) and every helper built on that prefix (`isUniqueConstraintError`, `isForeignKeyError`, `isBusyError`, `isConcurrentConflict`, `dbErrorCode`) are **silently no-ops against Turso** — they were only ever true for `SqliteAdapterImpl`'s driver (`better-sqlite3`, which does emit real `SQLITE_CONSTRAINT_UNIQUE` etc). Any caller relying on these helpers to detect e.g. a UNIQUE violation against a Turso-backed store will never see `true`, even on a genuine violation.

## Regression coverage documenting the gap (already added, not a fix)

`libs/data/store/store-adapter/src/errors.spec.ts` (new file, part of the SPEC-CONN-RECYCLE packet) asserts:

```ts
isUniqueConstraintError({ code: 'GenericFailure', message: 'step failed: Runtime error: UNIQUE constraint failed: t.name (19)' }) // === false
```

named after this item's id in the test description. This is deliberately RED-as-shipped — it documents the gap so the next reader doesn't have to rediscover it.

## What this is NOT

SPEC-CONN-RECYCLE's own `isFatalConnectionError` classifier does NOT use these helpers or `code` at all — it matches Turso's own message-category vocabulary (`I/O error:`, `database disk image is malformed`) instead, precisely because this gap makes `code`-based classification unusable for Turso. That fix is scoped correctly and does not depend on this item being resolved.

## Suggested direction, not prescribed

The fix likely needs Turso-specific message-pattern matching analogous to `isFatalConnectionError`'s approach — e.g. `Runtime error: UNIQUE constraint failed` in the message — layered alongside (not replacing) the existing `SQLITE_*`-code path for `SqliteAdapterImpl`, since that driver's codes are genuinely correct and should not be touched. Any caller across the codebase currently relying on `isUniqueConstraintError`/`isForeignKeyError`/`isBusyError`/`isConcurrentConflict`/`isDatabaseError` against a Turso-backed adapter should be audited once this is understood — this item does not attempt that audit.

## Acceptance

A regression test (already the one in errors.spec.ts, or a replacement) asserting `isUniqueConstraintError` (or its Turso-aware successor) returns `true` for a genuine Turso UNIQUE-violation shape, red today, green once fixed. Do not fix by loosening `isDatabaseError`'s `SQLITE_*` prefix check to something that also matches `GenericFailure` generically — that would make it indistinguishable from every other Turso error, the same "too broad" failure mode SPEC-CONN-RECYCLE's own classifier was built to avoid.

Citations: [feat/adapter-connection-recycle @ implementer session 2026-08-08, implementer, claude, SPEC-CONN-RECYCLE, 1: libs/data/store/store-adapter/src/errors.ts:1-9,79-88,154-157 (docstring claim + isDatabaseError SQLITE_* prefix check), 2: libs/data/store/store-adapter/src/errors.spec.ts (new, documents the gap with a named-after-this-item assertion), 3: SPEC-CONN-RECYCLE.md §2 (the probe output and ruling), 4: libs/data/store/store-adapter/src/errors.ts new isFatalConnectionError (message-marker classifier built specifically because code is unusable here)]
```

## `7df3d566` — No shared classifier for Turso's benign integrity_check noise — SHIPPED (51f57410), red arm never witnessed

- **uid:** `7df3d566-6e23-4c6c-9042-691b4f11d871`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
RE-FILED 2026-08-17 (original lost to BUG-BACKLOG-PHANTOM-WRITES-ACKED-NOT-DURABLE-001). State is CURRENT.

store-adapter documented which integrity_check output is benign (preflight.ts:56-90, errors.ts:23-33) but exported no way to ACT on it, so every caller hand-rolled a regex. Three authors hit this in one week: a corruption investigation flagged all four of its runs as 'corrupted' purely on the benign Tantivy dir-index artifact and caught it only by reading preflight.ts afterwards; the AC3 spec carried a hand-written caveat; memory-core's own probe hand-filtered it.

SHIPPED in 51f57410: classifyIntegrityMessages() (integrity.ts:2385) splits real damage from the known FTS false positive and from page-accounting noise, and reports `truncated` so a caller can tell 'clean' from 'clean as far as we could see'. Wired into the AC3 spec and the vacuum rehearsal.

THE DESIGN POINT THAT MATTERS: filtering runs BEFORE the message cap. That ordering IS the fix — 100 benign page messages saturated integrity_check's 100-message cap and consumed the budget real damage needed (BUG-INTEGRITY-CHECK-BLINDED-BY-PAGE-NOISE). The test covers exactly that, and also asserts a synthetic REAL damage message still classifies as damage — a classifier that called everything benign would sail through a benign-only suite, which is the dangerous direction.

8/8 tests, verified EXECUTED not skipped; store-adapter 545/545.

NOT RESOLVED per BL-225: the implementing agent was stopped before reporting a WITNESSED red arm. Tests pass now; nobody watched them fail. Someone should either witness it or accept the gap explicitly.

Citations: [main, architect-reviewer, claude, sox-ecosystem, 1: libs/data/store/store-adapter/src/integrity.ts:2385, 2: libs/data/store/store-adapter/src/__tests__/classify-integrity-messages.debt-no-shared-turso-integrity-filter-001.test.ts]
```

## `a40056fb` — Remote turso store silently skips fts5-residue drop, BL-506 recurs with no diagnostic (F3, review 2026-08-12)

- **uid:** `a40056fb-3d7e-415f-9579-e41b55d12cb3`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
RECOVERED 2026-08-12 from orphaned WAL frames (extraction ses_00b60a558ffekr7rRWiHyiPkQg; original filing lost to the BL-512-class phantom write). REVIEW FINDING F3 (review task ses_00c1adfb8ffejh5rR1uGKsoS8t, post-merge 7bc7960c): dropFts5ResidueBeforeRebuild returns SILENTLY for remote turso stores (cfg.dbPath === undefined, libsql:// URL): the heal skips the residue drop, the rebuild still ALTER-RENAMEs edge past any residue, and BL-506 recurs on remote stores with zero diagnostic. The fix is inherently local-only (better-sqlite3 cannot open a URL), but the skip must not be silent. FIX: log.warn when cfg.type === turso && cfg.dbPath === undefined inside the rebuild branch (or return a reason from the helper). Review verdict: APPROVE-WITH-NITS — low severity, filed at merge per gate. Original priority LOW, createdAt 2026-08-12T03:06:24.631Z, uid 8bb64ef1-ae38-4514-9893-e9805210e9d5.
```

## `4295ad2b` — FK-heal duplicate fts_node_ai trigger dedupe is not directly tested (F2, review 2026-08-12)

- **uid:** `4295ad2b-666c-48cc-b5de-2a358c2297ab`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
RECOVERED 2026-08-12 from orphaned WAL frames (extraction ses_00b60a558ffekr7rRWiHyiPkQg; original filing lost to the BL-512-class phantom write). REVIEW FINDING F2 (review task ses_00c1adfb8ffejh5rR1uGKsoS8t, post-merge 7bc7960c): the BL-507 duplicate-fts_node_ai-trigger claim is documented but never directly exercised — buildLegacyFkHealFixture creates each trigger exactly once, so expect(catalog.ftsResidue).toEqual([]) covers the dup-trigger case only implicitly. A regression that stops removing duplicates (e.g. a future name-scoped delete taking only the first row) would not be caught. FIX: in the fixture, db.exec(FTS5_TRIGGERS[0]) a second time before db.close() so the heal must delete a genuine duplicate; keep the existing assertion. Review verdict: APPROVE-WITH-NITS — low severity, filed at merge per gate. Original priority LOW, createdAt 2026-08-12T03:06:23.933Z, uid aa20b3f7-edaa-4e74-b733-53d97664a761.
```

## `6242cb2a` — turso 0.7.2 native panic btree.rs:1172 page should be loaded (SIGABRT) under WAL-truncation concurrency — upstream defect

- **uid:** `6242cb2a-47a1-4e04-be35-19308f3016f2`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
MEDIUM, upstream tracking. debug-triage proven 2026-08-12: 3/20 live writers SIGABRT with thread unnamed panicked at core/storage/btree.rs:1172:17 turso_assert page should be loaded in BTreeCursor::process_overflow_read (line+col verified against tag 046e9cb = shipped @tursodatabase/database-darwin-arm64 0.7.2). Mechanism: WAL short-read leaves overflow page unloaded (read_frame returns ShortReadWalFrame without loading, wal.rs 0.7.2:3502); overflow reader dereferences it before VDBE completion-error check (vdbe/mod.rs:1853) observes the failure — uncatchable from JS. Reproduced byte-identically in isolation at 8-way concurrency with a 1-frame WAL. Later turso revisions added read-tx-before-page1 fix + defensive unloaded-page error checks (pager.rs:4213-4221). Action: evaluate driver upgrade past 0.7.2; track upstream.
```

## `aa70a2c2` — `cp` of a live Turso/WAL-mode SQLite store does not capture recent writes — every forensic row count taken from a plain-cp snapshot during today's incident is a lagging read

- **uid:** `aa70a2c2-ce9e-4da1-b6ed-dabe2a967c32`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
Filed on the store owner's authorization to record a process/tooling gap surfaced during the live incident. **The empirical proof is relayed from team-lead's own report, not independently reproduced by this agent** (reproducing it would mean writing a probe row to the live store and taking a live cp snapshot, both outside this agent's scope — investigation/filing only, no store mutation): team-lead reports writing a probe that moved `total_episodes` 4410→4411 live, then copying `memory.db` WITH its `-wal`/`-shm` sidecar files (`cp memory.db memory.db-wal memory.db-shm <dest>` or equivalent, exact invocation not captured in the relay) and finding the COPY still showed the pre-probe state (4410), i.e. the copy did not observe the write that had already committed against the live file.

**Why this is plausible and not surprising, verified independently by reasoning about WAL mechanics (general SQLite knowledge, not a claim requiring a citation into this repo's source):** in WAL mode, a plain filesystem `cp` of the main db file plus its `-wal`/`-shm` sidecars is not guaranteed to be transactionally consistent unless the copy is taken while no writer holds the WAL, or via a mechanism that establishes a read transaction across all three files atomically (e.g. `sqlite3 .backup`, `VACUUM INTO`, or holding a shared lock during the copy). A `cp` invoked while the source is open for writes can read the main file and WAL/SHM at different instants relative to a concurrent checkpoint or write-transaction commit, producing a copy that is neither the pre-write nor fully the post-write state — exactly the 'copy still showed the pre-probe state' symptom reported.

**Real cost this session:** per the mission brief for this triage round, "every forensic row count taken from a cp snapshot today is therefore a lagging read" — several forensic comparisons this incident (backup-vs-live diffs, missing-node counts) may have been performed against `cp`-based snapshots whose freshness relative to the live store was not verified, meaning some of today's own forensic conclusions (including ones already filed as backlog items, e.g. `BUG-MEMORY-DATALOSS-716-NODES-001`'s and `BUG-VECTOR-COVERAGE-COLLAPSE-PRE-SWAP-001`'s db-repair-agent forensics) may themselves rest on stale snapshots — not because the analysis was wrong, but because the ground truth it compared against may have moved. This item does not itself invalidate those findings (this agent has no evidence either way and was instructed not to touch the store to check) — it exists so a review pass can happen with the correct snapshot method once store access is authorized.

**Fix sketch:**
1. Document (in this repo's incident/runbook docs, or a CONTRIBUTING.md section) the CORRECT way to take a consistent point-in-time snapshot of a live `~/.memory/*.db` store: prefer the existing `backupStore()` utility (`libs/memory-core/src/backup.ts`, which per `BUG-STOREADAPTER-MIGRATE-UNSAFE-001`'s citation already uses `VACUUM INTO` + `PRAGMA integrity_check`) over a raw `cp`, OR use `sqlite3 <db> ".backup <dest>"` / a WAL checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`) immediately before any `cp`-based snapshot if `backupStore()` isn't invokable in context.
2. Add a lightweight verification step to any future forensic snapshot: compare a cheap, monotonic marker (e.g. `SELECT MAX(rowid) FROM node` or a dedicated heartbeat counter) between the live store and the snapshot immediately after copying, and warn/abort if they diverge in a way inconsistent with the elapsed time.
3. Retroactively flag which specific forensic counts taken today used a raw `cp` (vs. `backupStore()`/`.backup`) so `BUG-MEMORY-DATALOSS-716-NODES-001` and `BUG-VECTOR-COVERAGE-COLLAPSE-PRE-SWAP-001` can be re-verified against a freshly, correctly taken snapshot before their restore work is considered final.

**Acceptance criteria (red→green test naming this item's ID):** a test/script that (a) opens a WAL-mode SQLite store, starts a write transaction that is held open (or writes then immediately re-writes without a checkpoint), takes a raw `cp`-based snapshot mid-sequence, and asserts today's behavior can produce a snapshot missing the latest committed write (red, reproducing the reported symptom mechanically rather than relying solely on the relayed incident); (b) repeats the same sequence using the recommended snapshot method (`backupStore()`/`.backup`/checkpoint-then-copy) and asserts the snapshot always reflects the latest committed write at the instant the backup call returns (green).

Citations: [wip/turso-live-metrics, triage, claude, DEBT-PROCESS-CP-SNAPSHOT-STALE-WAL, 1: team-lead's report — wrote a probe moving total_episodes 4410→4411 live, cp'd memory.db+sidecars, copy still showed 4410 — relayed, NOT independently reproduced by this agent (no store mutation performed); 2: libs/memory-core/src/backup.ts (backupStore() utility using VACUUM INTO + PRAGMA integrity_check) — cross-referenced from BUG-STOREADAPTER-MIGRATE-UNSAFE-001's own citations, read directly in this triage round as evidence a correct snapshot mechanism already exists in-repo but was apparently not used for today's forensic cp; 3: general SQLite WAL-mode consistency semantics (plain filesystem cp of main+wal+shm files is not guaranteed atomic relative to a live writer) — general domain knowledge, not a repo-specific citation]
```

## `0f05e81b` — Anomalous backup-slot write: backup-20260730-120020/backlog.db rewritten 19:57:53 local on incident day with Jul-30-era content — author unverified

- **uid:** `0f05e81b-8242-4237-817c-7bad410ae146`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
FORENSIC FINDING 2026-08-11: during the incident window (19:57:53 local) the file backup-20260730-120020/backlog.db was rewritten with Jul-30-era content (594 nodes / 273 edges, sha 9908fe6e — differs from the frozen original sha 13a7b00a). A backup slot should be write-once; something overwrote it with much older content mid-incident. Author and mechanism UNIDENTIFIED. Not harmful to the live store (which is intact and superset), but it indicates an unexpected writer touching the backup directory during the incident — the same unknown-writer question as the Aug-11 19:31:29 stock-SQLite -shm opener. Worth correlating: could be the same unidentified process. Keep this open until the writer is identified or proven impossible.
```

## `15d6c878` — Deferred investigation: scale-dependent real SQLite corruption reproduced in bug-memory-001 AC3 under always-on heal churning a 3000-row vectorless backlog (F2, strip review 6cff35ea)

- **uid:** `15d6c878-a3c0-44d6-9f90-9c96012b198e`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
STRIP REVIEW F2 (2026-08-11, reviewer independently confirmed): with the owner-mandated always-on heal active, a 3000-row vectorless episode backlog (created by seedPopulatedStore bypassing the write path) churned by healMissingVectors inside beforeAll leaves the store in a state where parallel writes hit REAL page corruption: 'Corrupt database: Invalid page type: 0' at iteration 0, byte-identical to the injected-fault failure. Only reproducible under the artificial large-vectorless-backlog fixture state, never in steady state — but it is real corruption, not a test artifact (integrity_check clean except the known Turso FTS false positive after churn). Root cause attribution: fixture-state interaction with always-on heal, NOT strip logic; only reachable because heal was disable-able pre-strip. DEFERRED INVESTIGATION (documented in commit 6cff35ea): merits a dedicated investigation when the backlog graph is writable — whether a genuine production store could ever reach a large-vectorless-backlog + parallel-writes state, and whether heal needs a backpressure/rate-limit guard beyond the existing time-budget. This item is that deferral, now filed. Linked: strip branch fix/bl373-sidecar-staleness, F2 finding.
```

## `ad333b3e` — integrity_check was blinded by 100 leaked pages saturating its message cap — FIXED by offline VACUUM; cap-before-filter ordering still unguarded

- **uid:** `ad333b3e-2fea-40e2-8765-de8478bdb0a3`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
RE-FILED 2026-08-17 (original lost to BUG-BACKLOG-PHANTOM-WRITES-ACKED-NOT-DURABLE-001). State is CURRENT — the operational problem is FIXED; a regression guard is not.

== THE ORIGINAL DEFECT ==
The live memory store reported integrity.overall='unknown', healthy=false, pragma_integrity_check validated=FALSE. Its own words: 'integrity_check output hit the 100-message cap (101 messages seen)... Truncated output cannot show the store is clean'. 100 allocated-but-unreachable pages saturated the cap, so any real damage message after them was never emitted. The check was not passing or failing — it was BLINDED, while being read as acceptable.

== FIXED 2026-08-15 ==
Offline VACUUM executed on the live store (8m04s downtime, runbook in docs/reporting/memory/findings/2026-08-15-offline-vacuum-runbook-integrity-cap.md):
    page_count 34,454 -> 24,913  (-9,541 pages, -27.7%)
    file 134.59MB -> 97.31MB     (37.28MB reclaimed)
    payload 36.81MB unchanged, rows identical
Post-restart deep probe: integrity.overall='ok', healthy=true, pragma_integrity_check validated=TRUE, 'clean after filtering 1 known Turso FTS false positive', damaged:[] unknown:[]. NO hidden damage appeared once the cap cleared — the 100 messages were exactly the leaked pages.

Leak split, discriminated by second-pass idempotency: 37.2MB was leaked and reclaimable (stays gone on a repeat VACUUM); 60.5MB is legitimate structural cost (26 indexes, FTS5 shadow tables, vec0 over 6,033 vectors) and does not move.

== STILL OPEN ==
1. NO REGRESSION GUARD. Nothing prevents the cap from being saturated again. The classifier shipped in 51f57410 (classifyIntegrityMessages) filters BEFORE the cap, which is the right ordering — but assert it stays that way, or this recurs silently.
2. THE LEAK CAUSE IS UNKNOWN. VACUUM reclaimed the pages; it did not fix whatever leaks them. A 48h follow-up measured +0 pages, but that measurement is VOID — the machine was closed, episodes/nodes/write-queue all unchanged, so nothing could leak. Pages cannot leak when none are allocated.
3. BASELINE for a valid re-measure (write-anchored, not wall-clock): page_count 24,913 / episodes 5,879 / nodes 11,786 at 2026-08-17T16:43Z. Report pages_leaked_per_episode and ALWAYS publish the denominator; mark VOID if small.
4. The Aug 8->14 anomaly (+35MB across 13 episodes) is only partially explained by the 37.2MB leak and may indicate a second growth mechanism.

NOT RESOLVED per BL-225: no red->green test names this ID. The natural one asserts the probe filters noise BEFORE applying its cap.

Citations: [main, architect-reviewer, claude, sox-ecosystem, 1: docs/reporting/memory/findings/2026-08-15-offline-vacuum-runbook-integrity-cap.md, 2: libs/data/store/store-adapter/src/integrity.ts (classifyIntegrityMessages, 51f57410)]
```

## `76a9c2f2` — Episode-count metric contradiction: memory_stats claims 622→645 episodes but ground truth is 5,945/5,951 kind='episode' — metric reconciliation needed

- **uid:** `76a9c2f2-17fb-4c8b-b413-69c47029f56e`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
TRIAGE FINDING 2026-08-11: memory_stats reported episode counts of 622→645 while a direct graph query counts 5,945/5,951 rows with kind='episode'. One of these is wrong (or they measure different things — e.g. non-invalidated vs all-time, or a hardcoded/filtered count). The 622→645 claim came from the dead pre-recovery instance per the read-path debugger; the 5,945/5,951 ground-truth count is from the live store. Reconciliation required: determine what memory_stats actually counts, which number is authoritative, and fix whichever is lying. Do NOT file as resolved until the discrepancy is explained with evidence. This matters for capacity planning, retention, and any dashboarding that trusts memory_stats.
```

## `2f196e3e` — memory_update accepts a user-asserted importance, reports success, then the batch enrichment pass silently reverts it - update.ts never stamps the user_override marker the C2.1 guard checks

- **uid:** `2f196e3e-dae2-40b8-95c3-7dca163365ba`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
**Summary.** `memory_update` accepts `importance`, writes the column, and returns `updated_fields: [importance]` - but it never stamps the `enrich_ver` `user_override` marker. The batch enrichment pass only skips rows carrying that marker, so it recomputes importance from link-degree/access-count/word-count/tag-count and silently overwrites the caller's asserted value. The write is acknowledged, then reverted.

**Mechanism.**
1. `memoryUpdatePhaseA` handles `importance` with a bare column write (`setClauses.push('importance = ?')`) and writes no `enrich_ver` anywhere in `update.ts` [1]. The field's type doc is only 'Replace node.importance' [2].
2. The batch pass's `processEpisode` returns early ONLY when `enrich_ver` parses to a note of `user_override`; otherwise it recomputes via `computeImportance(...)` and runs `UPDATE node SET importance = ?, enrich_ver = ?` [3].
3. A row edited via `memory_update` therefore keeps whatever `enrich_ver` it had (typically `{pass, ts}` with no note, or the legacy watermark), fails the guard, and is re-scored on the next batch pass.

**The asymmetry** - two paths protect the value, one does not:
- `memory_write` with explicit `importance` stamps the `user_override` note; its contract test asserts both the value and the note [5].
- `memory_curate` op `set_importance` writes the note explicitly [4].
- `memory_update` - the documented in-place editor - accepts a user-asserted importance and leaves it unprotected.

**Reproduction (live, real store, this session).**
- `memory_update` with importance 9 -> returned `updated_fields: [summary, importance]`.
- A later `memory_recall` on that uid returned `importance: 6`.
- `memory_curate` op `set_importance` with importance 9 -> returned old_importance 6, new_importance 9; a re-read returned `importance: 9`.
This is a real silent data-loss event, not synthetic: the value was written, acknowledged, then overwritten by the batch pass; only the curate path's marker made it stick.

**Why the suite misses it - a missing-integration-test seam.**
- `update.spec.ts` 'updates importance' asserts `importance === 8` immediately after `memory_update`, but never runs the batch pass [6] - it asserts the value before the overwrite can occur.
- The C2.1 guard test seeds its `user_override` row with RAW SQL (`UPDATE node SET importance = 9.5, enrich_ver = ?`), never by calling `memory_update` [7] - so the update->batch interaction is never exercised.
Neither test drives the consumer-visible outcome (does an importance set via `memory_update` survive enrichment?); each proves one half of the mechanism in isolation.

**Contract.** C2.1 is titled 'memory_write - MODIFIED' and states that user-set importance is respected, with the batch pass skipping re-scoring when `enrich_ver` carries the `user_override` marker [8]. `memory_update` is not covered by C2.1's letter, but the batch pass's own comment states the intent generally - 'the caller explicitly asserted this importance value and the batch pass must preserve both the value and the note' [3] - and `memory_update`'s MCP schema advertises importance as 'User-asserted importance (1-10)'. The principle is violated for the update path.
Secondary doc drift: the contract describes the marker as a boolean key `user_override: true`, but every implementation writes a string note `user_override` [4][5]; the batch guard checks the note field [3]. A reader implementing to the contract text would write a marker the guard ignores.

**Fix.** In `memoryUpdatePhaseA`, when `importance` is among the changed fields, write `enrich_ver` with note `user_override` in the same UPDATE - mirroring `curate.ts:397` [4]. Add a regression test that (a) sets importance via `memory_update`, (b) runs `runBatchEnrich`, (c) asserts the value survived - a test that fails against today's code.

**Impact.** Silently discards an explicit caller instruction while reporting success. Any agent or operator raising an item's importance through `memory_update` loses it on the next enrichment tick, with no signal. The only working workaround is `memory_curate` op `set_importance`, which is not discoverable from the `memory_update` schema.

**Citations**
[1] libs/memory-core/src/update.ts:248-253
[2] libs/memory-core/src/update.ts:90-91
[3] libs/memory-core/src/enrich-batch.ts:350-391
[4] libs/memory-core/src/curate.ts:396-401
[5] libs/memory-core/src/write.spec.ts:525-542
[6] libs/memory-core/src/update.spec.ts:316-332
[7] libs/memory-core/src/enrich.spec.ts:1070-1101
[8] docs/plan/memory-enrichment/CONTRACTS.md:773-784
```

## `59f22cbd` — memory_scope is populated on the live store today, but nothing populates it for a store the MCP server creates itself — two production readers silently no-op if it ever goes empty (split from BUG-MEMORY-DATALOSS-716-NODES-001)

- **uid:** `59f22cbd-7889-48ab-9fdd-324351a563b8`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
**Split from BUG-MEMORY-DATALOSS-716-NODES-001** per its 2026-08-08 note: "STILL UNEXPLAINED regardless of which way [the node-count question] resolves... memory_scope reportedly holds ZERO rows in the live store, masked by a sox_store_meta fallback rather than surfaced as an error. That is an independent defect... it should be split out rather than closed with the node count."

**Verified today (2026-08-08), read-only, against the actual live store `/Users/nix/.memory/memory.db`** (confirmed via `memory_ping` to be the exact path the running memory-server pid 78407 has open) using `openDbReadOnly()` from `libs/memory-core/src/db.ts:916` (the codebase's own established read-only path — no `db_path` override through `openDb()`, no write, no `openedPaths` registration, so BL-412 does not apply):

```
memory_scope rows: [{"scope":"user","scope_id":"default","embed_model":"bge-base-en-v1.5","embed_dim":768,"schema_ver":1,"created_at":"2026-06-21T21:38:05.536Z"}]
sox_store_meta rows: [{"key":"schema_version","value":"1"},{"key":"writer_artifact","value":"@adhd/sox-memory-core"},{"key":"embed_model","value":"unknown"},{"key":"embed_dimensions","value":"768"}]
```

**Finding 1 — the ZERO-rows claim is false today.** `memory_scope` holds exactly one row, created 2026-06-21 — well before the 2026-07-28/29 go-live incident that produced the original report, and consistent with the plan-orchestrator's finding on the parent item that the live store has grown past both forensic backup snapshots. The original 'ZERO rows' observation most likely came from db-repair's inspection of an intermediate/corrupt artifact during the incident, not the current live store. This part of the parent item's finding is REFUTED by direct measurement.

**Finding 2 — the invisibility is real and still live, independent of Finding 1.** Read `libs/memory-core/src/db.ts:865-892` (`initScope`) and `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts:173-203` (`cmdInit`, the ONLY caller of `initScope` in the entire repo — confirmed via `grep -rln initScope`). `initScope` is what INSERTs the one allowed `memory_scope` row; it is called exclusively by the `sox-memory init` CLI verb, a manual one-time step. The live MCP server (`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1145`, `:938`, `:2465`, `:2743`, `:3023`) opens stores exclusively via `getDb(dbPath)` -> `openDb(dbPath)` (`libs/memory-core/src/db.ts:288`), which calls `stampStoreMeta()` (`db.ts:745`) to populate `sox_store_meta` but NEVER calls `initScope`. A brand-new store created purely by the live server (e.g. the first `memory_write` against a never-before-seen `project_path`/`db_path`) gets the `memory_scope` TABLE via `CREATE TABLE IF NOT EXISTS` in the DDL (`schema.ts:38-45`) but never gets a ROW in it, permanently, unless someone separately runs `sox-memory init` against that exact file. The one existing row on the live store is incidental to a manual init step from six weeks ago, not a guarantee the current write path provides.

**Finding 3 — two production readers branch silently on this.** (a) `libs/memory-core/src/enrich-batch.ts:237-246` — the BL-406 legacy `embed_model` backfill step (`runBatchEnrich`, called by the live periodic batch-enrich pass) queries `SELECT embed_model FROM memory_scope LIMIT 1` inside a try/catch; on empty/missing it silently sets `scopeEmbedModel = null` and the entire backfill of pre-BL-88 legacy-vector rows is skipped with no log, no counter, no error — `embed_model_backfilled` in the result just reads 0, indistinguishable from "nothing needed backfilling." (b) `libs/memory-core/src/stats.ts:314-328` — `degradedRecordCount` (surfaced in `memory_stats`) does the identical query/try-catch; on empty it silently reports `0` degraded records, again indistinguishable from "nothing is degraded." Neither reader emits a warning distinguishable from the true-negative case. Confirmed no test exercises the empty-`memory_scope` branch of either function against a store shaped like the live server's own write path (i.e. `openDb()` only, no `initScope()`).

**Finding 4 — no integrity probe covers it.** The six probes in `libs/data/store/store-adapter/src/integrity.ts` (`wal_identity`, `adapter_meta_unique`, `btree_index_populated`, `fts_index_live`, `json_column_valid`, `json_empty_array_null` — confirmed via live `memory_ping`) are all generic, adapter-level checks with no knowledge of memory-core's `memory_scope` table; that project cannot own a memory-core-specific probe without a layering violation. Nothing else checks this table's population on open.

**Fix direction (architecture ruling, full spec in the linked worktree — see citation):** do NOT invent scope semantics to auto-populate `memory_scope` from the live server's write path — the server has no `ScopeKind` concept at all (resolves stores purely by `store` name / `db_path`, confirmed `memory-server/index.ts` has zero references to `ScopeKind`), so any value it wrote for the `scope` CHECK-constrained column would be a guess, not a fact. Instead: (1) migrate both readers (enrich-batch.ts step 1b, stats.ts degradedRecordCount) from `memory_scope.embed_model` onto `sox_store_meta`'s `embed_model` key, which IS populated unconditionally by every write-open via `stampStoreMeta()` regardless of scope, making the try/catch-silent-empty branch structurally unreachable; (2) add a `memory_scope_populated: boolean` (or equivalent) field surfaced in `memory_stats`/`memory_ping` output for observability, so a future empty table is visible without being a hard-fail; (3) leave `memory_scope` and `initScope` exactly as-is for the CLI's multi-scope-file (`project.db`/`user.db`/`org.db`/`local.db`) design — that usage is unaffected and still correct.

**Acceptance:** a regression test on `enrich-batch.spec.ts` and/or `stats.spec.ts` that (a) builds a store via `openDb()` alone (no `initScope`), i.e. exactly the live server's write path, (b) asserts the BL-406 backfill / degradedRecordCount logic still functions correctly against `sox_store_meta` even though `memory_scope` is empty — RED before the migration (currently both silently no-op / report false-negative 0), GREEN after. Plus a `memory_stats` snapshot assertion that `memory_scope` emptiness is now visible in the output.

Citations: [feat/memory-scope-empty, architect-reviewer, claude, memory-scope-empty spec, 1: libs/memory-core/src/db.ts:865-892 (initScope), 2: libs/memory-core/src/db.ts:288,745 (openDb calls stampStoreMeta, never initScope), 3: extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts:173-203 (cmdInit, sole initScope caller), 4: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:938,1145,2465,2743,3023 (getDb call sites, no initScope), 5: libs/memory-core/src/enrich-batch.ts:237-246 (BL-406 silent-empty backfill guard), 6: libs/memory-core/src/stats.ts:314-328 (degradedRecordCount silent-empty guard), 7: libs/memory-core/src/schema.ts:38-45 (memory_scope DDL), 8: live memory_ping/memory_stats 2026-08-08 output (six integrity probes, none covering memory_scope) captured via openDbReadOnly() read against /Users/nix/.memory/memory.db]
```

## `851c89bc` — memory_recall advertises token_budget default 4000 in its MCP schema but applies 32000 — an agent that trusts the schema and passes a larger-looking value silently shrinks its own result set

- **uid:** `851c89bc-72ab-427e-af87-d07bbcb7830b`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
`memory_recall`'s advertised `token_budget` default disagrees with the value the handler actually
applies — an 8x difference, in the direction that silently truncates results.

- The MCP tool's declared JSON schema advertises `default: 4e3` (4000) to every host that introspects
  the tool[1]. This is what an agent reads when deciding whether to pass the parameter at all.
- The handler's own destructuring default is `token_budget = DEFAULT_TOKEN_BUDGET`, and
  `DEFAULT_TOKEN_BUDGET = 32e3` (32000)[2][3]. `memory_entity_episodes` destructures the same
  constant[4].

So an agent that omits `token_budget` — reasonably, having read the schema and concluded 4000 is the
default — actually gets 32000. The inverse is the harmful case: an agent that reads `default: 4000`
and explicitly passes a "generous" 8000 believing it is doubling the budget is in fact CUTTING it to
a quarter of the real default, and the recall assembler stops adding results once the budget is spent.
The result set silently shrinks and nothing reports that a budget truncation occurred.

Discovered while verifying that memory-server's README documents real behaviour: the README repeated
the schema's 4000 rather than the effective 32000, and was correct only about the tool's
self-description, not about the tool.

FIX: make one of the two authoritative and derive the other from it — declare the schema default from
`DEFAULT_TOKEN_BUDGET` rather than a hand-written literal, so the advertised and applied defaults
cannot drift again. Then correct the README to whichever value survives.

Citations: [main, claude, claude, sox README truth pass,
1: extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js:84680,
2: extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js:77553,
3: extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js:77571,
4: extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js:78199,
5: extensions/bundles/sox-memory-bundle/members/memory-server/README.md:110]
```

## `f83e727f` — memory-server, memory-flush and memory-cli ship no type declarations and declare no types field, so any TypeScript consumer importing them under noImplicitAny fails with TS7016

- **uid:** `f83e727f-ae77-4c8e-853b-f720703b3418`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
None of the three code packages in sox-memory-bundle emits a .d.ts into dist/, and none declares a `types`/`typings` field in package.json — they are built as esbuild executable bundles.

Reproduced as a real consumer failure: installing @adhd/sox-extension-memory-server into a scratch
project and running tsc against the documented import with a bare strict/noImplicitAny tsconfig (the
default in Next.js, Vite react-ts, NestJS, Angular strict) yields
`error TS7016: Could not find a declaration file for module '@adhd/sox-extension-memory-server'`
and tsc exits 2.

Mitigated in docs for now (published 2026-09-04): each README's examples are JavaScript and each
states plainly that no declarations ship and that the CLI/MCP interface is the intended seam. That
keeps the docs honest but does not make programmatic TypeScript use possible.

The real fix, if programmatic import is meant to be supported, is to emit declarations for the
handful of exported entrypoints (handleToolCall/TOOLS/resolveDbPath, handler/setExportConfig, runCli)
and add the `types` field. If it is NOT meant to be supported, the packages should say so in
package.json rather than exporting a module surface at all.

Citations: [main, claude, claude, sox README truth pass, 1: extensions/bundles/sox-memory-bundle/members/memory-server/package.json, 2: extensions/bundles/sox-memory-bundle/members/memory-flush/package.json, 3: extensions/bundles/sox-memory-bundle/members/memory-cli/package.json]
```

## `d1064dc2` — memory-core recall.ts/extensions.ts still assemble FTS SQL above store-adapter — adopt ftsSearch after A2 lands

- **uid:** `d1064dc2-650e-48f7-a873-60f71905c0ef`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
memory-core is the last FTS-SQL-writing consumer above store-adapter: recall.ts:588-635 and extensions.ts:1116-1128 hand-write the two-branch SELECT (FTS5 shadow-table join + turso direct-table with n. alias stripping), the exact A1 pattern the operator banned (no custom SQL above store-adapter, 2026-08-08). After FEAT-SOXGRAPH-001 lands store-adapter ftsSearch/ftsCount, memory-core should delegate: recall.ts/extensions.ts shrink to adapter.ftsSearch calls, deleting the fragment assembly + alias-stripping. NON-GATING for backlog F-01 redo (backlog is already clean); recommended follow-up so store-adapter is the single FTS owner. Segment H in architect A2 spec (session ses_01bb04030ffev2r1aq1brwiTvA).
```

## `bee49391` — memory-core openDb() FTS setup block still hand-rolls dialect residue-check + createIndexDDL instead of adapter.ensureFtsIndex

- **uid:** `bee49391-60e3-4173-8980-c7711c8ed57b`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
Follow-up flagged by P5 (DEBT-SOXGRAPH-001 adoption, worktree .worktrees/debt-soxgraph-001). After recall.ts/extensions.ts delegated to adapter.ftsSearch, db.ts openDb() (libs/memory-core/src/db.ts:536-630) remains the last FTS-management block in memory-core that does NOT go through store-adapter ensureFtsIndex: it hand-assembles the residue-presence check (SELECT COUNT(*) FROM sqlite_master WHERE name IN (...)), residue-drop loop (ftsDialect.dropLegacyDDL, plus the close()+dropFtsResidueViaBetterSqlite3()+reopen detour), the BL-461 resolveExistingFtsIndexName lookup, and ftsDialect.createIndexDDL(...) with weights + [FTS_DDL, FTS_TRIGGERS] — all routed through createFTSDialect(adapter.config.type) directly (db.ts:332,541,564). ensureFtsIndex (store-adapter fts-ops.ts:224) now owns exactly this sequence (adopt-existing BL-461, per-statement already-exists skip, fts5 backfill gating, residue cleanup + residueNeedsOutOfBand) — openDb should call adapter.ensureFtsIndex(node, [content,name,summary], {weights, sqliteDDL: [FTS_DDL, FTS_TRIGGERS]}). The residueNeedsOutOfBand path (turso residue requires a better-sqlite3 pass + reopen) is the part that needs care — openDb already has dropFtsResidueViaBetterSqlite3 for that. Out of scope for DEBT-SOXGRAPH-001 (which names recall.ts + extensions.ts only); P6 candidate.
```

## `a9a7deff` — `vector-store` carries 4 live `sox/no-storage-backend-leak` warnings — on the exact rule guarding the BL-380 bug class, in the package where that class keeps recurring

- **uid:** `a9a7deff-7ce3-4c81-8097-7b6aa91ad50e`
- **status:** OPEN
- **source:** packet 4 (title-only)

```
**`npx nx lint vector-store --skip-nx-cache` → 4 problems (0 errors, 4 warnings), all
`sox/no-storage-backend-leak`:**

```
src/index.ts
  132:10  warning  '.unwrap()' reaches through StoreAdapter to a backend-specific raw handle
                   outside libs/data/store/store-adapter/**. On SqliteAdapter this is sync; on
                   TursoAdapter (the default) it is async — a bare unwrap() silently returns the
                   wrong shape on the default backend. BL-377, BL-380, BL-385
  132:11  warning  'as SqliteAdapter' asserts a specific storage backend outside
                   libs/data/store/store-adapter/**. BL-377, BL-380
  415:16  warning  '.unwrap()' — same rule, same reason
src/lancedb.ts
  3:27    warning  'better-sqlite3' is a raw storage-driver import outside
                   libs/data/store/store-adapter/**. BL-380
```

**Why this is worth an item rather than four `eslint-disable`s.** This rule was written *for* this
package. BL-377 found the first two `unwrap()` sites here. BL-380 found more and capability-gated
them. BL-364 traced the resulting `TypeError` into `hybrid-search`. BL-411 found the identical shape
in `analysis.spec.ts`, dead for 8 days. BL-389 covers `LanceDbVectorBackend` taking a raw
`better-sqlite3` handle in its constructor — which is what the `lancedb.ts:3` import serves. The
package is the repeat offender and the rule is the tripwire, and the tripwire is currently set to
`warning`, which in a repo that gates on `0 errors` means it is advisory only and can be ignored
indefinitely.

The three `src/index.ts` sites are the deliberately capability-gated ones from BL-380's fix — they
are *guarded*, not unguarded, so they are not live bugs today. That is precisely why they are still
warnings and not errors. But it leaves the rule permanently unable to go clean, so a **new**
violation lands in a file that already has three and nobody notices.

**Fix sketch — the goal is a rule that can reach zero, not a quieter rule:**
1. For the three capability-gated `src/index.ts` sites, replace the blanket warning with a narrow,
   documented, per-site suppression that names the capability gate and the item that blessed it
   (`eslint-disable-next-line sox/no-storage-backend-leak -- BL-380: gated on adapter.capabilities.nativeVectors`).
   A suppression that states its justification is auditable; a standing warning is not.
2. `lancedb.ts:3`'s raw driver import is the same root cause as BL-389 — fix it there, or cross-link
   and let BL-389 own it, but do not suppress it, since it is a real unresolved boundary violation.
3. Once the file is clean, promote the rule to `error` for `libs/data/**` so the next violation is a
   build failure rather than line five of a warning list.

**Severity:** MEDIUM — no live defect (the gates hold), but the detective control for a bug class
that has produced five separate backlog items is currently non-blocking and permanently non-zero in
the one package that keeps producing them.

**Related:** BL-377, BL-380 (RESOLVED — the gating that made these three warnings acceptable),
BL-364/BL-411 (the downstream `TypeError` this class produces), BL-389
(`LanceDbVectorBackend`'s raw handle — same root cause as the `lancedb.ts:3` warning),
BL-385 (async `unwrap()` on Turso).

Citations: [wip/turso-live-metrics, backlog-filing agent, claude, multi-agent findings sweep,
1: `npx nx lint vector-store --skip-nx-cache` → "✖ 4 problems (0 errors, 4 warnings)", 2026-08-04,
2: libs/data/vectors/vector-store/src/index.ts:132 (two warnings — `.unwrap()` and `as SqliteAdapter`),
3: libs/data/vectors/vector-store/src/index.ts:415 (`.unwrap()`),
4: libs/data/vectors/vector-store/src/lancedb.ts:3 (raw `better-sqlite3` import),
5: tools/eslint-local/no-storage-backend-leak.cjs (the rule, which names BL-377/BL-380/BL-385 in its
own messages)]
```

## `e6799f8f0` — Orphaned-row visibility gap: v1-bin test rows written into production are invisible to the v2 API's view:list (no registered project node) — contamination is silent

- **uid:** `e679f8f0-617e-4532-8a83-562a082c43ed`
- **status:** open
- **source:** packet 4 (title-only)

```
Test rows written into production by the v1 bin are invisible to the v2 API's `view:list` because they have no registered project node — contamination is silent[1]. This also explains the earlier count discrepancy (1670 live vs raw totals)[2].

Citations: [PseudoSky/adhd, filing-pass, deepseek/deepseek-v4-pro, 2026-09-22 config-isolation debug triage, 1: v2 API view:list vs raw production rows, 2: 1670 live vs raw totals]

---

## Scope refinement (2026-09-22 deployment triage)

Two distinct visibility facts, previously conflated:

- The 23/40 test/probe-authored PROJECT registrations DO surface in `view:projects` — they are visible, just junk[1].
- The `cli.spec` ITEM rows are the orphaned class: they are invisible to the v2 API's `view:list`/`lookup` (no registered project node) — silent contamination[2].

So the invisibility is row-level, not project-level: project-level contamination is loud in `view:projects`, item-level contamination is silent. Both are live. Cross-links: the contamination-count item and the historical-scratch-project item filed in the same pass.

Citations: [2026-09-22 live-deployment triage, production graph, 1: view:projects census 2026-09-22 (23/40 test/probe-authored, all listed), 2: cli.spec item rows absent from view:list/lookup while present in raw rows]
```

## `82470ae8` — backlog spawned-bin specs: the HOME-redirect isolation invariant is duplicated across 10 spec files with no shared helper and no regression guard — a new spawn site silently reintroduces the production-store bleed

- **uid:** `82470ae8-05d4-4e73-980a-3176d8148c40`
- **status:** open
- **source:** packet 4 (title-only)

```
Follow-up to the 2026-09-22 production-store contamination fix (commit 59b08868, branch fix/backlog-test-isolation). The fix is correct and complete for the store-leak class, but it hard-codes the isolation invariant in 10 spec files across 15 spawn sites as a copy-pasted env literal plus a copy-pasted 6-line comment, with no shared helper and no automated guard. Any NEW spawned-bin spec, or any copy-paste that drops the temp cwd or the scope override, silently re-opens the production store — exactly the failure this commit fixed.

WHY HOME ALONE IS NOT THE INVARIANT: resolveRoots routes storage through HOME only for global/system scope; project scope resolves under <projectRoot>/.adhd/<project>/<namespace>/ and ignores HOME entirely[5]. The working redirect is therefore the PAIR (ADHD_BACKLOG_SCOPE=project + a temp cwd with no ancestor .git/.adhd marker) AND HOME=<temp>. That pair is already proven load-bearing by 4d4b4029, where a fake-HOME-only override in main-entry-symlink.test.ts was silently defeated by cwd-based project-scope auto-detection and wrote a real DB into the repo tree. A future author who copies only the HOME line reintroduces the bleed.

NO TEETH: the commit verification was a manual RED/GREEN probe of the store-free sandbox-path verb plus a manual production live-item count (1683 -> 1683). No automated test fails if the redirect is removed, so the invariant is unenforced at 15 sites[1][2][3][4].

FIX SKETCH: extract one helper (entrypoint/backlog/src/test/helpers/spawn-isolated-bin.ts) that owns the whole env construction (spread process.env, ADHD_BACKLOG_SCOPE=project, HOME=<tempRoot>, cwd=<tempRoot>, optional extraEnv) and have all 15 sites call it; add a guard spec that drives the store-free sandbox-path verb through the helper and asserts dbPath startsWith the temp root, with a negative control that omits HOME and must go red.

DEDUPE: the abort scan surfaced c68ce863 / 7b821ac6 / 82468ca7 / 4d4b4029 / e7595669; all are distinct root causes (resolver layer, sandbox telemetry/IR cache, a documented skip, the agent-mcp test, the CLI default), none is this backlog-suite enforcement follow-up. Related: 82468ca7 (open environment-builder root cause), 4d4b4029 (the HOME-only proof), 40d9da12 (cli-envelope tmpRoot leak).
```

## `2b1d8a22` — backlog review-fix batch: unify the 3x path-known predicate, give create-issue.spec.ts:256's "nothing is written" claim teeth, unit-test projectHasKnownPath, log the isVectorSpacePopulated capability miss

- **uid:** `2b1d8a22-ce94-474b-a85c-5c53bc6ce29d`
- **status:** open
- **source:** packet 4 (title-only)

```
Combined review-fix batch item from the 2026-09-22 blind review of branch feat/backlog-hard-replacement (worktree .worktrees/backlog-v2). Four related cleanups, all in entrypoint/backlog:

1. Triplicated path-known predicate. catalog.ts:613 defines projectHasKnownPath (`typeof path === 'string' && path.length > 0`); the same predicate is re-implemented inline at create-issue.ts:333 and transition.ts:240 (`typeof projectPath !== 'string' || projectPath.length === 0`) — 3 copies total, unify on the catalog.ts helper [1][2][3].
2. create-issue.spec.ts:256 title claims "nothing is written" but the test only asserts `rejects.toThrow(CitationUnverifiableError)` (lines 262-270) — no write-absence assertion (no read-back / node-count check) [4]. Add the assertion or drop the title claim.
3. projectHasKnownPath has no direct unit test: zero references to it in any *.spec.ts under entrypoint/backlog/src [5]. Add boundary tests: undefined / empty / whitespace / non-string / valid.
4. isVectorSpacePopulated's capability-miss branch is silent: bootstrap.ts:184-186 returns false when hasVectors is absent (`typeof probe.hasVectors === 'function' ? probe.hasVectors(modelId) : false`), with no log [6]. Optional one-time log.

Citations: [branch feat/backlog-hard-replacement, .worktrees/backlog-v2, blind-review-filing-pass:oc-2026-09-22, blind review 2026-09-22 (3 commits), 1: entrypoint/backlog/src/write/catalog.ts:613-616, 2: entrypoint/backlog/src/write/create-issue.ts:332-334, 3: entrypoint/backlog/src/write/transition.ts:239-241, 4: entrypoint/backlog/src/write/create-issue.spec.ts:256-271, 5: rg 'projectHasKnownPath' over entrypoint/backlog/src/**/*.spec.ts (zero hits), 6: entrypoint/backlog/src/write/bootstrap.ts:179-187]
```

## `a934e089` — citationRequiresSha path-less waiver is a silent no-op in create/transition — add a warning/debug log on the waiver branch (observability only; permissive behavior stays)

- **uid:** `a934e089-0c23-4144-88bb-e60a04f44015`
- **status:** open
- **source:** packet 4 (title-only)

```
Blind review 2026-09-22, branch feat/backlog-hard-replacement (worktree .worktrees/backlog-v2).

The citationRequiresSha gate is silently waived for path-less projects:
- createIssue: the `sha === 'unverified' && preResolvedPolicy.citationRequiresSha && projectHasKnownPath(preResolvedProject)` gate at entrypoint/backlog/src/write/create-issue.ts:664-668 (projectHasKnownPath call at :667) [1].
- transition: the identical gate at entrypoint/backlog/src/write/transition.ts:363-367 (call at :366) [2].
- The waiver is documented and deliberate at SPEC.md:134-143 — "citation_requires_sha ... applies ONLY where verification is possible — when the owning project has a non-empty metadata.path" [3].

The permissive behavior is SETTLED (verdict A) and stays. The remaining work is OBSERVABILITY: emit a warning/debug log on the waiver branch. Do NOT add an audit node: SPEC §4a requires an audit node + audits edge for every state change, written inside the same immediate transaction (SPEC.md:870-897), so a second audit row for the waiver conflicts with that contract [4].

Verified silent today: neither create-issue.ts nor transition.ts contains any log./logger/console. call — the waiver branch emits no signal at all [5].

Fix rides the review-fix batch (see related item).

Citations: [branch feat/backlog-hard-replacement, .worktrees/backlog-v2, blind-review-filing-pass:oc-2026-09-22, blind review 2026-09-22 (3 commits), 1: entrypoint/backlog/src/write/create-issue.ts:664-668, 2: entrypoint/backlog/src/write/transition.ts:363-367, 3: entrypoint/backlog/SPEC.md:134-143, 4: entrypoint/backlog/SPEC.md:870-897, 5: entrypoint/backlog/src/write/create-issue.ts and entrypoint/backlog/src/write/transition.ts (no log/logger/console calls)]
```

## `1e12507f` — entrypoint/backlog/src/write/CONTRACT.md line-reference table is systematically stale — all six errors.ts anchors drifted (up to 75 lines)

- **uid:** `1e12507f-6d1d-4f8c-9234-12f7261da309`
- **status:** open
- **source:** packet 4 (title-only)

```
The line-reference table in entrypoint/backlog/src/write/CONTRACT.md is systematically stale: every errors.ts anchor drifted DOWN the file, and the drift grows with the anchor's position. Verified on branch feat/backlog-hard-replacement (worktree .worktrees/backlog-v2) by opening both files at the cited and the actual lines.

  CONTRACT.md:595  ClaimHeldError                      cited errors.ts:182  -> actual errors.ts:217 [1][2]
  CONTRACT.md:608  SingleValuedRelationConflictError    cited errors.ts:214  -> actual errors.ts:274 [1][3]
  CONTRACT.md:629  CitationUnverifiableError            cited errors.ts:244  -> actual errors.ts:313 [1][4]
  CONTRACT.md:644  NoteRequiredError                    cited errors.ts:254  -> actual errors.ts:325 [1][5]
  CONTRACT.md:657  CitationRequiredError                cited errors.ts:264  -> actual errors.ts:337 [1][6]
  CONTRACT.md:686  classifyDriverError                  cited errors.ts:331  -> actual errors.ts:406 [1][7]

Fix: re-anchor the table, or switch to symbol-only anchors plus a tiny drift check.

Citations: [branch feat/backlog-hard-replacement, .worktrees/backlog-v2, blind-review-filing-pass:oc-2026-09-22, blind review 2026-09-22 (3 commits), 1: entrypoint/backlog/src/write/CONTRACT.md:595,608,629,644,657,686, 2: entrypoint/backlog/src/write/errors.ts:217, 3: entrypoint/backlog/src/write/errors.ts:274, 4: entrypoint/backlog/src/write/errors.ts:313, 5: entrypoint/backlog/src/write/errors.ts:325, 6: entrypoint/backlog/src/write/errors.ts:337, 7: entrypoint/backlog/src/write/errors.ts:406]
```

## `8a09824c` — @adhd/sox-embedding-provider version skew in entrypoint/backlog: ^0.4.1 declared while the resolved graph needs ^0.5.0 — two copies installed (dual-package hazard)

- **uid:** `8a09824c-cf59-438a-9fc0-eaeb599d7c36`
- **status:** DUPLICATE
- **source:** packet 4 (title-only)

```
Blind review (2026-09-22) of branch feat/backlog-hard-replacement found a latent dual-package hazard in entrypoint/backlog: TWO copies of @adhd/sox-embedding-provider are installed.

- Declared range: entrypoint/backlog/package.json:38 (optionalDependencies) pins "@adhd/sox-embedding-provider": "^0.4.1" [1].
- The resolved graph needs 0.5.0: pnpm-lock.yaml:1571 shows @adhd/sox-hybrid-search@0.4.6 requiring '@adhd/sox-embedding-provider': 0.5.0 [2]; pnpm-lock.yaml:1582 shows @adhd/sox-semantic@0.1.3 requiring the same [3].
- Both resolve: /@adhd/sox-embedding-provider@0.4.1 at pnpm-lock.yaml:1531 (nested under entrypoint/backlog; optional:true; depends on @adhd/sox-telemetry 0.2.1) [4], and /@adhd/sox-embedding-provider@0.5.0 at pnpm-lock.yaml:1542 (root; depends on @adhd/sox-telemetry 0.3.0) [5].
- Confirmed on disk in .worktrees/backlog-v2: node_modules/@adhd/sox-embedding-provider/package.json:3 = "0.5.0"; entrypoint/backlog/node_modules/@adhd/sox-embedding-provider/package.json:3 = "0.4.1" [6].

Impact: backlog's own runtime resolution from entrypoint/backlog/src loads the nested 0.4.1, while @adhd/sox-hybrid-search / @adhd/sox-semantic load the root 0.5.0 in the SAME process — two module instances, hence separate getSharedOnnxWorker() singletons and two distinct TransientEmbeddingError class identities (both symbols exist in both copies' dist/index.js) [7]. This is the same class as the telemetry-singleton incident, BUG db88fb0d: "backlog CLI telemetry is a permanent no-op after @adhd/backlog 0.1.8: store-adapter@0.7.0 emits through a second sox-telemetry@0.2.1 instance that initTelemetry never configures" [8].

The 0.5.0 API is declaration-compatible: createEmbeddingProvider / metadata / embedSingle are declared identically in both copies' dist/index.d.ts (createEmbeddingProvider at :150, metadata at :19, embedSingle at :20) [9].

Fix: bump entrypoint/backlog/package.json:38 to "^0.5.0", regenerate pnpm-lock.yaml, and re-run the real-model suite. Cross-linked to db88fb0d.

Citations: [branch feat/backlog-hard-replacement, .worktrees/backlog-v2, blind-review-filing-pass:oc-2026-09-22, blind review 2026-09-22 (3 commits), 1: entrypoint/backlog/package.json:38, 2: pnpm-lock.yaml:1571, 3: pnpm-lock.yaml:1582, 4: pnpm-lock.yaml:1531, 5: pnpm-lock.yaml:1542, 6: node_modules/@adhd/sox-embedding-provider/package.json:3 and entrypoint/backlog/node_modules/@adhd/sox-embedding-provider/package.json:3, 7: node_modules/@adhd/sox-embedding-provider/dist/index.js and entrypoint/backlog/node_modules/@adhd/sox-embedding-provider/dist/index.js, 8: backlog item db88fb0d-12ea-475f-880a-ee748c0bdac0, 9: node_modules/@adhd/sox-embedding-provider/dist/index.d.ts:19,20,150 and entrypoint/backlog/node_modules/@adhd/sox-embedding-provider/dist/index.d.ts:19,20,150]
```

## `92b82a73` — gitContext renders raw into the markdown Citations: block - a value containing ] or a newline can break or forge the disclosure evidence block, and it is unbounded

- **uid:** `92b82a73-6fab-42ad-8c30-1830374ce940`
- **status:** open
- **source:** packet 4 (title-only)

```
- **Where:** `entrypoint/backlog/src/query/markdown.ts:45-51` (`renderCitationLines` interpolates `card.gitContext` straight into `Citations: [${gitContext}]` with no sanitization); written verbatim at `entrypoint/backlog/src/write/create-issue.ts:598-603` and `entrypoint/backlog/src/write/transition.ts:551-556`; surfaced at `entrypoint/backlog/src/query/card.ts:308-312`.
- **Discovered:** 2026-09-22, review of commits 111c19bd..05ebbd6f on branch `feat/backlog-hard-replacement` (feature F3, item-level gitContext provenance). ALL line numbers here are against that branch tip (05ebbd6f), not `main` - a structured citation against `main` would compute the wrong sha, so this item carries prose citations only.
- **Detail:** `gitContext` is caller-controlled free text. `renderCitationLines` builds the item evidence block as a literal bracket - `Citations: [<gitContext>]` - followed by one `- [<target> sha:<sha>]` line per structured citation. A `gitContext` containing `]` or a newline therefore escapes the bracket and can inject an extra citation-looking line into the rendered block; e.g. `gitContext = "x]\n- [src/evil.ts sha:deadbeef"` renders an apparent second citation. The same principal files the item, so this is not a privilege boundary, but the block is the artifact the repo disclosure contract exists to make independently verifiable, and a forgeable line defeats that purpose. There is also no length cap: a multi-KB value is stored verbatim on the issue node metadata and re-read on every card fetch.
- **Fix direction:** (1) sanitize at render time - collapse whitespace (`\s+` -> a single space) and strip or escape `[` / `]` from `gitContext` before interpolation in `renderCitationLines`; (2) cap length at write time in `create-issue.ts` / `transition.ts` (e.g. 512 chars, throwing `InvalidArgumentError("gitContext", ...)`) so a caller cannot bloat every card read.
- **Status:** OPEN.
- Citations: [feat/backlog-hard-replacement @ 05ebbd6f, review, deepseek, F3 item-level gitContext provenance review, 1: entrypoint/backlog/src/query/markdown.ts:45-51; 2: entrypoint/backlog/src/write/create-issue.ts:598-603; 3: entrypoint/backlog/src/write/transition.ts:551-556; 4: entrypoint/backlog/src/query/card.ts:308-312; 5: entrypoint/backlog/src/query/markdown.spec.ts + markdown-format.spec.ts (gitContext render tests added in 05ebbd6f)]
```

## `2e117b1a` — LIVE production store index desync: `integrity.damaged` on `ix_edge_dst_live` (19376 index entries vs 19374 rows, -2) and `ix_node_kind_live` (-1) at 13:33:46, self-healed 13:33:47 by per-index reindex — rows invisible to every planner-routed query while desynced; cause = concurrent better-sqlite3 + turso writers, recurrence-prone

- **uid:** `2e117b1a-0263-4b87-b1fd-6fd0ffb7607c`
- **status:** open
- **source:** packet 4 (title-only)

```
## Occurrence (2026-09-22 13:33:46, production store)

`integrity.damaged` fired for two live indexes[1]:

- `ix_edge_dst_live`: 19376 index entries vs 19374 rows (-2)
- `ix_node_kind_live`: -1

BL-335's stated consequence applies: while an index is desynced, "row(s) are invisible to every query the planner routes through it" — a silent wrong-results window, not a crash. It self-healed one second later (13:33:47) via individual reindex, with no operator action, but the window is real and the trigger is recurrence-prone.

Log: `~/.adhd/sox-ecosystem/backlog/logs/backlog.cli-2026-09-22.jsonl`[2].

## Cause

Concurrent better-sqlite3 + turso writers against one store. The classic-SQLite `-shm` sidecar is the forensic fingerprint of a better-sqlite3 open (turso coordinates through `-tshm` and never creates `-shm`); the 2026-08-26 WAL replacement (`0a2c3b5e`, RESOLVED) root-caused to exactly this fingerprint[3]. Documented candidate openers — none confirmed for this occurrence:

- graph-store's `dropFts5ResidueBeforeRebuild()` -> `deleteSchemaRowsViaBetterSqlite3` at open (`5740b8b2`, `18400bf5`)[4][5]
- `semantic.spec.ts`'s raw better-sqlite3 handle (`6f6184c7`)[6]
- a preflight schema reader

OPEN QUESTION: WHO the better-sqlite3 writer was at 13:33:46 is not established. Until it is, the desync can recur.

## Cross-links

- `0a2c3b5e` (RESOLVED): turso `-wal` unlinked/replaced under live connections — same concurrent-writer root class[3]
- `f94a7810` (RESOLVED): a graph-store index rebuild made the live store worse[7]
- `1acbd738` (OPEN): integrity verdict blind to semantic completeness[8]
- `3e402ac8` (OPEN): classic SQLite cannot parse a turso schema, so `PRAGMA integrity_check` is unavailable on exactly these stores[9]
- WAL-unlink live warning item filed in the same pass — the two symptoms share one incident window

Citations: [2026-09-22 live-deployment triage, production store, 1: integrity.damaged ix_edge_dst_live 19376 vs 19374 (-2) and ix_node_kind_live (-1) at 13:33:46; self-healed 13:33:47, 2: ~/.adhd/sox-ecosystem/backlog/logs/backlog.cli-2026-09-22.jsonl, 3: item 0a2c3b5e-9127-466e-b0fc-ca0ddd94125c, 4: item 5740b8b2-d491-4bd9-87be-98bb87e89b53, 5: item 18400bf5-8611-4703-b0f0-b3f7da6db29c, 6: item 6f6184c7-f6f1-4672-8f94-17a495f2ddab, 7: item f94a7810-edc7-468e-a044-dd2e4c59e05f, 8: item 1acbd738-1de4-4f03-a315-764cb1380c93, 9: item 3e402ac8-70f0-4162-8b7c-59500fbd278c]

---

## TRIAGE 2026-09-22 — root cause is in `@adhd/sox-store-adapter`'s probe, not the store

**The 13:33:46 `integrity.damaged` was a false positive from a torn read in the probe, and the "repair" was a racing write.** `probeBtreeIndexes` (`libs/data/store/store-adapter/src/integrity.ts:1362`) counts the base table via `tableCount` (`:1319`, called at `:1388`) and then counts through the index in a **second, separately-committed `executeGet`** (`:1450`). No transaction and no quiescence gate spans the two reads, so a commit landing between them inflates the later index count — exactly the `index > table` sign observed (`ix_edge_dst_live` 19376 vs 19374; `ix_node_kind_live` 13812 vs 13811). A skipped-index-maintenance defect would show the opposite sign (index entries missing). `verifyAndRepair` (`:2914`) then REINDEXes the reported index with **no re-probe** (`:2839-2842`), turning a false positive into a write that races live peers.

Evidence (both in `~/.adhd/sox-ecosystem/backlog/logs/backlog.cli-2026-09-22.jsonl`):
- `:3684-3685` — 13:33:46.914Z, pid 14116: the two `integrity.damaged` findings.
- `:3691-3692` — 13:33:47.430Z, pid 14116: `integrity.repaired` "reindexed individually" for both indexes.

Fix (sox side): make the probe atomic (both counts in one transaction) + re-probe immediately before repair + add a quiescence gate. Owner/component moves to `libs/data/store/store-adapter` (project `sox-ecosystem`).

Open question: torn-read false positive vs genuine Turso multiprocess-WAL divergence. Discriminator: run both counts inside one transaction, or quiesce the store — if the mismatch disappears under either, it is a probe artifact.

### Correction: the suspected external better-sqlite3 writer is the adapter's own readonly preflight

The `-shm` forensic fingerprint does not require an external writer. `TursoAdapterImpl._openReal()` → `hasUncleanShutdown()` → `preflightSchemaSanity` (`turso-adapter.ts:1833`) → `openSchemaReader` → `new Database(dbPath, {readonly: true})` (`preflight.ts:396-403`) is the adapter's **own** better-sqlite3 opener on the open path; it materialises the classic `-shm` (BUG-026's trigger) for the life of the connection but writes no rows. The only writable better-sqlite3 path in the package — `deleteSchemaRowsViaBetterSqlite3` (FTS5 repair, `preflight.ts:540`) — did not run on production. `@adhd/sox-store-adapter@0.9.2`'s own BUG-031 fix commit (`6f9ec560`) states this explicitly: "This package's OWN sanctioned hatches are such openers: preflightSchemaSanity's readonly openSchemaReader runs on the open path itself".

Evidence: 4 `preflight_triggered_unclean` events on `backlog-v2.db` on 2026-09-22 (15:18:43 pid 64239, 18:01:26 pid 73417, 19:33:15 pid 28313, 19:40:22 pid 96235) in `backlog.cli-2026-09-22.jsonl`, each on the open path; the same log records the corresponding `-shm.stale-*` renames (e.g. `shm.stale-2026-09-22-1518` at 15:18:01-15:18:31, immediately before the 15:18:43 preflight), and the production data dir retains the later `-shm.stale-2026-09-22-20*` sidecars.

Residual unknown: exhaustive exclusion of an external better-sqlite3 opener. Capture plan: instrument `openSchemaReader` to log `{pid, intent, readonly}`, or `sudo opensnoop -f <db>-shm`.
```

## `2039bb80` — The store never records which backlog version (binary/skill) wrote it — only the sox engine/adapter versions are stamped

- **uid:** `2039bb80-2a1a-4996-b2ff-3531a510aba5`
- **status:** open
- **source:** packet 1 (unread)

```
Gap from the health/versioning audit: _sox_engine stamps sox_version (store-adapter) and driver_version, _adapter_meta stamps adapter_version — but nothing records the BACKLOG entrypoint version or the deployed skill version that wrote the store. Consequence: the skill/binary drift (268790d3, 8fb08ec8, 56865633) is invisible from the store; a consumer cannot tell which CLI generation wrote a row or whether the reading binary matches the writing one. Ask: stamp the entrypoint version (+ skill sha) on first open / on version change, and warn (never refuse) on mismatch, mirroring the _sox_engine pattern. Relates to 46951936 (a version command reports the running system; this is the store-side record).
```

## `87799e1d` — No persisted health record: the store knows its identity + crash state but not its health — integrity/coverage/version are computed per-call or emitted as telemetry, never stored

- **uid:** `87799e1d-0dfc-41ba-b2cd-919513d7a7b6`
- **status:** open
- **source:** packet 1 (unread)

```
Gap found while answering the health/versioning audit. Stored today: PRAGMA application_id (SOXT/SOXS) + _sox_engine (engine, sox_version, driver_version, first/last_opened_at) + _adapter_meta (adapter_type, adapter_version, created_at, clean_shutdown marker) — identity, version, and crash state, all layered and sound. NOT stored: any health verdict. Health is (a) computed on demand (embedding_health), (b) emitted as store.integrity.* telemetry events (sink, not store), (c) blind to semantic completeness (1acbd738: a store missing 34% of its vectors reads healthy), and (d) has no history — no consumer can ask what the backlog health was, or when it was last verified. Ask: a persisted health record (integrity verdict + vector coverage + engine/version + last-verified timestamp, bounded history) that the integrity check and embedding_health both write and consumers can read in one call.
```

