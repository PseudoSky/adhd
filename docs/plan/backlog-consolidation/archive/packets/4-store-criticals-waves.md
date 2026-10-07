# Packets — Domain 4: Store / Schema Correctness + Plans / Waves

**Author:** architect (packet-authoring pass), 2026-09-22.
**Base branch:** `feat/backlog-hard-replacement` (worktree `.worktrees/backlog-v2`), the PR #9 cutover candidate.
**Live build today:** `.worktrees/restore-min` (branch `fix/live-restore`) — a temporary hand-port, **not** `main`.
**Frozen rollback build:** ~~`.worktrees/backlog-cutover` @ `ab262d8f`~~ — **deleted 2026-09-23** (redundant; `ab262d8f` is an ancestor of `fix/live-restore`).
**Live store (PRODUCTION):** `~/.adhd/backlog/production/data/backlog-v2.db`. Item bodies written earlier spell it
`backlog.db`; treat `backlog-v2.db` as canonical (the older name is a pre-cutover artifact). Every packet that
touches it is **backup-first + reversible** (see the shared invariants).
**Live packages:** `@adhd/sox-store-adapter@0.9.2`, `@adhd/sox-graph-store@0.10.1`.

**Scan captures read (all at `/var/folders/yg/cfczgtx54bzfh74lx2_mv0z80000gp/T/opencode/backlog-scan/`):**
`opens-by-theme.txt` (all 190 open items by theme), `scoped.jsonl` (full bodies for the items cited below),
`all-items.jsonl`, `root-textpass.txt`. The two governing plan artifacts read in full:
`/Users/nix/dev/ai/sox-ecosystem/docs/plan/store-adapter-batch-0.10.0/SPEC.md` (783 lines) and
`entrypoint/backlog/report/deferral-cleanup-plan.md` (375 lines). Where an item is marked **title-only** below,
its body was NOT in the captures — the executor MUST read it live via `adhd-backlog` before implementing.

## Shared invariants every packet obeys

- **ADR catalog:** the `adhd` repo has **no** `docs/decisions/`. The governing catalog is
  `/Users/nix/dev/ai/sox-ecosystem/docs/decisions/` (0001–0020). Load-bearing here:
  **ADR-0012** (parallel-process enabled is the invariant — **never** reason from single-writer; supersedes
  ADR-0007's claim), **ADR-0013** (feature switches are typed config, **never** env vars — no `SOX_*`/`ADHD_*`
  behavior toggle may be introduced; numeric tuning constants are permitted by D3), **ADR-0008** (SQL projects
  MUST use migration management from day one — Drizzle schema objects + versioned migrations), **ADR-0017**
  (present-but-empty scoped filter selects **nothing**, never "no filter"), **ADR-0014** (snapshot/sidecar
  retention is report-first, `--apply` gated on a proven restore path), **ADR-0020** (embedding funnel is
  peer-spawned + self-reaping — never "daemon"), **ADR-0004** (data-root placement). **ADR-0015 is PROPOSED,
  never accepted — do not adopt it or reason from it.**
- **Live-testing policy (AGENTS.md §7):** behavioural tests run by default, unflagged. An env-gate is legitimate
  **only** for a paid/external third-party service, documented in README + AGENTS.md + the test header with a
  **named owner**. "Spawns a process", "needs a built dist", "slow" are **not** grounds. A missing prerequisite
  must make the test **fail loudly**, never silently skip.
- **No gate bypass:** never `--no-verify`; never `--skip-nx-cache`; never `tsc` directly; pnpm only; no destructive
  git (`reset --hard`, `clean -f`, `stash`). Worktrees under `.worktrees/`; ephemeral artifacts under `tmp/`
  (app layer) / `.adhd/tmp/` (tooling). If the pre-commit hook flakes under concurrent agents, that is **LIVE-11's**
  problem (Domain 1) — escalate, do not bypass.
- **Production store is live and shared.** Any packet that mutates `backlog-v2.db` must: (1) take a verified
  `VACUUM INTO` backup first (research-confirmed: `VACUUM INTO` is a consistent snapshot safe under concurrent
  WAL writers; a plain `cp` of a live WAL store **loses recent writes** — item `aa70a2c2`), (2) run the mutation
  as an explicit operator-invoked action (ADR-0013 D4), (3) re-verify with `integrity_check` + a sentinel read
  afterwards, (4) record the backup path. Repair is never automatic, never a side effect of a routine command.
- **Two repos:** `adhd` = `entrypoint/backlog/**`; `sox-ecosystem` = `libs/**`. A packet whose Scope names `libs/`
  needs the **sox-ecosystem owner's dispatch** (cross-repo). Publish of any sox package is a separate, owner-gated
  release-train step.
- **Disjointness:** Domain 1 owns deploy/CI mechanics; Domain 2 owns the embedding funnel/provider/pool and the
  implementation of `2039bb80`/`87799e1d`; Domain 3 owns citation→component linking; Domain 5 owns the registry
  surface. **This domain owns the store/schema layer (`libs/data/store/**`, `libs/data/graph/**`,
  `libs/data/vectors/**`, `libs/memory-core/**` schema/store paths) and the backlog wave/tooling items.**

---

## PACKET STORE-1: Execute the `store-adapter` 0.10.0 batch SPEC (probe atomicity · WAL fold · close drain · taxonomy)

- **Goal:** A false-positive index probe can no longer trigger a racing `REINDEX`, a close can no longer truncate a
  WAL whose identity moved, `close()` drains in-flight ops instead of abandoning them, and the closed-connection
  `TypeError` is legible — all shipped as one `0.9.2 → 0.10.0` changeset.
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/**` only, exactly as `SPEC.md` §3/§7 list. Non-goals:
  `vector-store`/`hybrid-search` (concurrent executors); the backlog pin bump (that is a deployment step, §9.5).
  Plus **one additive fold** (`9a4581f4`): the close-path checkpoint is the *only* supported WAL bound on Turso
  (`wal_autocheckpoint` is a silent no-op; threshold hardcoded 1000 frames) — the SPEC's fix 2 must state this in
  the `_closeCeremony` doc comment and keep the explicit `wal_checkpoint` call as the bound.
- **Inputs:** `docs/plan/store-adapter-batch-0.10.0/SPEC.md` (read in full — fixes 1–4; segments A–G; test plan
  §7/§8 arms A–D). Item bodies read in full: `2e117b1a` (index desync, 19376 vs 19374, self-healed by REINDEX),
  `4ba0d969` (live WAL unlinked/replaced), `d677a575` (`close()` abandons `_inFlightOps`), `0ab0078a`
  (`isDatabaseError` misses the code-less closed-connection `TypeError`), `9a4581f4` (Turso WAL bound),
  `1a95227b` (reusable two-process WAL-contention conformance suite, SPEC T9 — fold as the shared test harness the
  SPEC's arms A/D should be written against; prior art `src/__tests__/fixtures/bl461-open-child.ts`).
- **Acceptance/DoD:** exactly the SPEC's §7/§8 arms, plus:
  1. **A1 red on old code:** a real child fixture writes concurrently while the new single-statement probe runs 200×
     → zero `damaged` findings; on the pre-fix two-statement probe it goes **red** (proves the harness reproduces the
     race).
  2. **A2 discriminating test:** any `damaged` finding must clear on re-probe **and** `integrity_check` report no
     missing index entry, else the test fails naming hypothesis B (genuine multi-process divergence) — do **not**
     merge A1 green without A2 actually exercised.
  3. **A5 repair safety:** with a live peer, `verifyAndRepair` reports `skipped:'live_peers'` and runs **no** REINDEX.
  4. **B1/B2:** `close()` stays pending while a latched transaction is in flight (red on old code); a never-released
     transaction makes `close()` reject with `EStoreAdapterCloseDrainTimeout` — never abandon.
  5. **C1/C3:** a **real** driver error after `db.close()` classifies `isDatabaseError === true`; the negative
     controls (`'file is not open'`, `TypeError('x is not a function')`, non-Error shapes) stay `false`.
  6. **D1/D3/D4:** a deferred PASSIVE does not stamp clean-shutdown; a WAL replaced between pre-check and TRUNCATE
     skips the TRUNCATE; a clean quiescent close still stamps + truncates.
  - **Negative controls are named per-arm in SPEC §7** — run each red arm and record the output.
- **Tests:** SPEC §7 (four new spec files + two child fixtures) + `1a95227b`'s reusable harness; run via the sox
  package's own test target. `npx nx run @adhd/sox-store-adapter:verify-dist-load` **before** publishing.
- **Dependencies:** none internal. Blocks the backlog adapter pin bump (deployment, Domain 1 / LIVE-1). `2e117b1a`'s
  live repair is STORE-14. Cross-repo: needs the sox-ecosystem owner's dispatch + release-train window.
- **Size/tier:** L · executor hint: `typescript` (sox adapter internals) + `test`.
- **Risks/unknowns:** the SPEC's own §10.1 open question — torn read vs genuine Turso multi-process divergence — is
  settled by arm A2, not assumed; do not promote the count probe's authority until A2 is exercised. The bundled
  SQLite version for the classic adapter (§10.6) is a dependency decision, not a code change here.
- **Decision gates:** **sox-ecosystem owner** — approve the 0.10.0 minor + changeset (SPEC §9). Recommendation:
  ship exactly as specified; fold `9a4581f4` as a doc-comment statement (no behavior change), keep `1c9e40d5`/
  `06922862` as the SPEC §4 L1 follow-ups (they are in the deferral plan, not this batch).

---

## PACKET STORE-2: Coordination-path canonicalization + quiescence atomicity (the `280bfb3c` root chain)

- **Goal:** A fresh one-shot CLI open against the live store succeeds while MCP peers hold it — the TRUNCATE gate
  reads the **same** lease directory every other coordination site reads, and the quiescence check cannot be
  defeated by a non-canonical path spelling.
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/src/turso-adapter.ts` (`this.config` vs
  `canonicalDb` at the four raw call sites), `src/store-lease.ts` (the quiescence scan + a lock held across the
  destructive act), `src/preflight.ts`. Non-goals: the SPEC's four fixes (STORE-1 owns them); the `280bfb3c`
  narrative itself.
- **Inputs:** `280bfb3c` (full body — CRITICAL, 5/5 reproduction; the mechanism chain: CLI close TRUNCATEs `-wal`
  to 0 bytes, the stale `-tshm` survives indexing dead frames, a fresh open short-reads, and the lease gate
  **forbids** the reconcile that would fix it), `72be4a19` (full body — lease created under the canonical path,
  but close-time quiescence / openmark-clear / sidecar repair all key on `this.config.dbPath`; the adapter's own
  rule at `turso-adapter.ts:408-413` is violated), `149d96a9` (full body — `storeQuiescence` is a point-in-time
  `readdirSync` with no lock across the gap to the destructive act), `4b65f64e` (title-only — a native panic leaks
  the lease + `.openmark`, permanently narrowing the quiescence gate; read the body before implementing).
- **Acceptance/DoD:**
  1. **Path symmetry:** every coordination call site (`storeQuiescence` at the close-time TRUNCATE gate, the
     openmark clear, the `-tshm` path, the sidecar-repair path) uses the **same** canonical path the lease is
     created under. A test opens via a deliberately non-canonical spelling (relative path / symlinked parent /
     `..` segment / doubled separator) and asserts the gate sees a peer registered under the canonical path.
  2. **No-race WAL destruction closed:** the `72be4a19` failure scenario (non-canonical opener → gate reads the
     wrong dir → TRUNCATE under a live peer) no longer reproduces.
  3. **Quiescence atomicity:** the destructive act is taken only while a lock is held across the check (flock, or a
     single conditional-UPDATE claim), so a peer that has not yet written its lease is not invisible. Honest
     scoping: `149d96a9` is narrower than it first appears (the lease lands early in `connect()`), so this DoD
     proves the deterministic path fix first and the residual window second.
  4. **`280bfb3c` end-to-end:** a real child fixture holds the store (MCP-like), a fresh one-shot open against the
     same file succeeds 5/5 — on the pre-fix code it fails 5/5.
  - **Negative control:** revert the canonicalization at one raw site → the non-canonical-opener test goes **red**.
    Record the red run.
- **Tests:** `1a95227b`'s two-process harness (STORE-1) as the substrate; new specs for path symmetry, the
  non-canonical opener, and the `280bfb3c` 5/5 child-open reproduction. Default-running.
- **Dependencies:** STORE-1 (the `_closeCeremony` split + `storeQuiescence` oracle wiring are prerequisites).
  Cross-repo (sox).
- **Size/tier:** M · executor hint: `debug` (sox) + `test`.
- **Risks/unknowns:** `4b65f64e`'s panic-leak path may require STORE-11's panic containment to be complete before
  the gate is provably not narrowed; if so, sequence STORE-11 first. The lock primitive choice (flock vs claim row)
  is an open design point in `149d96a9` — spike if neither fits the adapter's existing `store-lease.ts` shape.
- **Decision gates:** **sox-ecosystem owner** — the quiescence-lock primitive. Recommendation: reuse
  `store-lease.ts`'s existing claim machinery (single conditional UPDATE, monotonic owner token + TTL) rather than
  introduce flock, so there is one lock implementation.

---

## PACKET STORE-3: Durability — stop ACKing writes that never persist

- **Goal:** A write verb returns success only after a durable commit, and a divergence between allocated ids and
  persisted rows is impossible-to-miss (a loud, verifiable invariant).
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/src/turso-adapter.ts` (the `synchronous` pragma +
  the commit/ACK ordering), plus the **adhd** read-back seam in `entrypoint/backlog/src/write/**`. Non-goals: the
  embed-durability fix (`report/embed-durability-fix-spec.md`, Domain 2 / `ses_f342169b` — do not duplicate).
- **Inputs:** `22e1c4fd` (full body — CRITICAL, ~15 items lost 2026-08-15; success JSON carrying allocated
  `nodeId`s 2347–2358 against a 2,348-node store; several verified by a `get-item` read-back that later vanished;
  the recovery is exonerated by its own preserved original). Research-confirmed mechanism: `synchronous < FULL`
  lets a successful return precede the fsync, and Turso's MVCC docs document a success-then-silently-rolled-back
  window. **Note:** Turso supports only `OFF` and `FULL` (no `NORMAL`/`EXTRA`).
- **Acceptance/DoD:**
  1. The Turso adapter opens with WAL + `synchronous=FULL` (or documents, with a citation, the exact durability
     level and why a stronger one is unavailable) — a write verb's success return follows the `COMMIT`, proven by a
     SIGKILL-mid-write child (STORE-1 arm D2's `sigkill-midwrite-child.ts` fixture) whose last committed row is
     readable after reopen.
  2. **Allocated-id vs persisted-row invariant:** a bounded, cheap check asserts the newest allocated id does not
     run past the persisted row count; a violation is a **loud** typed error, not a silent success. This is the
     durable, independently-verifiable fingerprint the item names.
  3. **Read-back on the critical write path:** the backlog write verbs read back the row they claim to have written
     (a sentinel read), so an ACK that did not persist fails the verb rather than returning `ok:true`.
  4. **Negative control:** force a deferred commit (or stub the commit to no-op) → the "ACK implies durable" test
     goes **red**. Record the red run.
- **Tests:** a real child process writes + is SIGKILLed; parent reopens and asserts the row is present and the
  id/count invariant holds. Default-running. Plus a unit spec for the invariant checker.
- **Dependencies:** STORE-1 (the SIGKILL fixture + close-drain contract). Cross-repo for the adapter half.
- **Size/tier:** M · executor hint: `debug` (sox) + `backend` (adhd write path), `test`.
- **Risks/unknowns:** whether `synchronous=FULL` is already set (the item's fingerprint is consistent with it not
  being); read the live adapter's connect path before changing it. If the loss is instead the WAL-fold class,
  STORE-1's fix 2 covers it — determine which before writing a second fix.
- **Decision gates:** **sox-ecosystem owner** — whether the id/count invariant is adapter-level or memory-core-level
  (ADR-0012 §3: adapter detects, memory-core classifies). Recommendation: detection helper in the adapter,
  enforcement in the consumer.

---

## PACKET STORE-4: Migration safety — backup-first, idempotent, verified, and refusing under live peers

- **Goal:** No migration can run without a verified pre-migration backup, cannot silently skip a table and still
  exit 0, and refuses to run while a live peer holds the store.
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/src/migration.ts`,
  `scripts/migrate-store-to-turso.mjs`, `src/factory.ts` (`migrateOnAdapterChange`). **adhd** `entrypoint/backlog/src/store/graph-backlog-store.ts:58-61` (the `migrateOnAdapterChange: <file exists>` call site).
  Non-goals: the ADR-0008 Drizzle backfill (a separate, larger program); the migration *content*.
- **Inputs:** `0ca73640` (full body — CRITICAL: `migrateStore()` never snapshots; `--mode in-place` opens the Turso
  target on `values.source` while a readonly SQLite adapter reads it; silent per-table failures still exit 0; the
  codebase already has `backupStore()`/`VACUUM INTO` but never calls it), `b886eae4` (full body — `migrateOnAdapterChange`
  fires on any open whose engine stamp mismatches the defaulted `STORE_ADAPTER`; temp-file + rename ordering is
  **correct and must be preserved**; missing: backup-before-rename, sidecar handling), `6ab5dc0e` (full body —
  SPEC T10: refuse under live peers, mandatory verified backup, written playbook; depends on the EPERM fix),
  `e5cf0b7b` (full body — memory-server turso migration readiness; the risk has materialized twice; do not proceed
  until T8 choke point + EPERM + path canonicalization + T10 are in place and proven by T9).
- **Acceptance/DoD:**
  1. **Backup-first:** a verified-readable `VACUUM INTO` snapshot exists **before** any byte is mutated; a failed
     snapshot aborts the migration. A test asserts the backup exists and reopens cleanly before the mutation step.
  2. **Idempotency + verification:** re-running the migration is a no-op; each table's copy is verified (row count +
     `integrity_check`), and a per-table failure is a **non-zero** exit with a named table — never a silent skip.
  3. **Quiescence refusal:** `migrateOnAdapterChange` REFUSES (fail closed) when quiescence cannot be positively
     established — a test starts a real peer and asserts the refusal.
  4. **Sidecar handling:** the rename path reconciles `-wal`/`-shm`/`-tshm` so the new file is never adjacent to a
     previous file's WAL index.
  5. **Negative control:** remove the backup call → DoD-1 goes **red**; remove the quiescence gate → DoD-3 goes
     **red**. Record both.
- **Tests:** a two-process test (real peer) for refusal; a fixture store with a deliberately failing table for the
  verification path; the `VACUUM INTO` backup + reopen assertion. Default-running.
- **Dependencies:** STORE-2 (canonical path + quiescence; `6ab5dc0e` explicitly depends on the EPERM fix).
  `e5cf0b7b` gates the *memory-server* migration, not this packet's code. Cross-repo.
- **Size/tier:** L · executor hint: `backend` (sox) + `test`.
- **Risks/unknowns:** `migration.ts` was read by the filing agent (627 lines) but not by this pass — the executor
  must read it before editing. The playbook (`6ab5dc0e` item 3) is a doc deliverable; process liveness is NOT
  verification of adoption.
- **Decision gates:** **sox-ecosystem owner** — whether the migration playbook lives in `store-adapter` docs or a
  repo-root `docs/` location. Recommendation: `store-adapter/README` + a linked playbook, so consumers (backlog,
  memory) share one.

---

## PACKET STORE-5: One retry implementation, one error classifier

- **Goal:** `maxRetries` means the same thing everywhere, a `maxRetries: 0` caller gets exactly one attempt, and one
  predicate decides whether an error is transient — so a corrupt store is never blindly retried.
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/src/{turso-adapter.ts,sqlite-adapter.ts,retry.ts,errors.ts}`.
  Non-goals: the taxonomy widening (STORE-1 fix 4).
- **Inputs:** `163411b9` (full body — HIGH: (1) off-by-one, `maxRetries+1` attempts in both adapters; (2) three
  disagreeing retry implementations with different backoff, classification, and budget accounting; "a contention
  error can be retried by one layer, classified fatal by another"), `1e023495` (title-only — retry loop re-logs the
  original error every attempt and retries with zero state change), `d8f0c34b` (title-only — `SQLITE_*`-code helpers
  never match the live Turso driver, whose code is always `GenericFailure`; the ADR-0012 §3 grounding item),
  `7df3d566` (title-only — no shared classifier for Turso's benign `integrity_check` noise; shipped but the red arm
  was never witnessed).
- **Acceptance/DoD:**
  1. `maxRetries: 0` performs **exactly one** attempt in both adapters (test asserts attempt count).
  2. All call sites share **one** retryable-error predicate and one backoff; a test asserts the classifier is the
     single source.
  3. The retry loop does not re-log the original error unchanged per attempt, and a retry only happens after a state
     change (reconnect/rollback), not a blind repeat.
  4. **Corrupt ≠ contended:** a genuinely corrupt error is classified fatal (no retry).
  5. **Negative control:** revert the off-by-one → the `maxRetries: 0` test goes **red**; revert the shared
     classifier → the "one predicate" test goes **red**. Record both.
- **Tests:** attempt-count specs for both adapters; a classifier-identity spec; a corrupt-store fixture asserting no
  retry. Default-running.
- **Dependencies:** STORE-1 (fix 4's `isDatabaseError` widening lands in the same files — sequence STORE-1 first).
  Cross-repo.
- **Size/tier:** M · executor hint: `refactor` (sox) + `test`.
- **Risks/unknowns:** the "three implementations" count and locations are asserted by the item; re-confirm by grep
  before consolidating (do not assume exactly three).
- **Decision gates:** none. Recommendation: consolidate into `retry.ts` as the single home.

---

## PACKET STORE-6: Detect and verify DDL that Turso silently no-ops

- **Goal:** A `DROP`/trigger/`CREATE INDEX` that Turso silently ignores is detected and reported, never reported as
  applied; opening graph-store on a Turso adapter never fails on `fts5` DDL.
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/src/turso-adapter.ts` (`exec()` post-condition
  verification), `libs/data/graph/graph-store/src/index.ts` (`applySchema()` FTS dialect). **adhd** consumers that
  hand-roll workarounds in `libs/memory-core/src/db.ts` should migrate to the adapter helper.
- **Inputs:** `3d6df726` (full body — CONFIRMED: Turso never executes fts5 trigger bodies; `DROP TABLE`/`DROP
  TRIGGER` against fts5/vec0 "succeed" but the object remains in `sqlite_master`), `05eb832e` (full body —
  `exec()`'s contract implies DDL is honored; the only guard is ad-hoc caller-side workarounds in `db.ts`), `a40056fb`
  (title-only — remote turso store silently skips the fts5-residue drop), `d93be32a` (full body — `applySchema()`
  unconditionally runs fts5 DDL; a Turso adapter rejects it with `no such module: fts5`; fix `b5c2c50f` is
  dialect-driven via `FTSDialect` — verify it shipped and is consumed).
- **Acceptance/DoD:**
  1. A post-DDL verification helper at the adapter layer asserts the object's presence/absence in `sqlite_master`
     after `exec()`; a no-op drop surfaces a typed finding, never silence.
  2. `graph-store.applySchema()` is dialect-driven (`fts5` on SQLite, Tantivy `USING fts` on Turso, none without an
     FTS capability) — opening a Turso-backed store succeeds; `CREATE INDEX IF NOT EXISTS` on an existing index no
     longer aborts (Turso rejects it).
  3. Consumers use the adapter helper instead of `db.ts`'s hand-rolled `dropVec0ViaBetterSqlite3`/
     `dropFts5ResidueViaBetterSqlite3` (or the hand-rolled path is removed).
  4. **Negative control:** revert the dialect selection → the Turso-open test goes **red** with `no such module:
     fts5`; revert the post-drop verification → the no-op-drop test goes **red**. Record both.
- **Tests:** a Turso fixture store asserting the drop is detected; `apply-schema-turso-fts5-free.spec.ts` (already
  named in `d93be32a` — verify it is green on the installed dist, not only source). Default-running.
- **Dependencies:** none. `3d6df726` is an INVESTIGATION whose latent risk (a future Turso honoring triggers)
  should be filed as a tracked risk, not "fixed" here. Cross-repo.
- **Size/tier:** M · executor hint: `typescript` (sox) + `test`.
- **Risks/unknowns:** source-vs-dist skew — `d93be32a`'s fix may be in source but not in the installed
  `@adhd/sox-graph-store@0.10.1`; verify against the **installed dist** before claiming fixed.
- **Decision gates:** none.

---

## PACKET STORE-7: Connection liveness — a hung connection must reach `poisoned`

- **Goal:** A driver call that neither resolves nor rejects within a per-operation budget marks the connection
  suspect, so a wedged backend is visible instead of reporting `healthy` at 0% CPU.
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/src/turso-adapter.ts` (`connectionHealth` state
  machine + a deadline path), possibly promoting memory-server's `operation-guard.ts` shape
  (`withOperationDeadline` + `StoreOperationTimeoutError`) into the adapter.
- **Inputs:** `3e3ff0ec` (full body — HIGH: `connectionHealth` transitions **only** on a thrown error; the live
  wedge had no rejection, `openDb()` hung past 120s while the health surface reported `healthy` throughout; also
  `connectionHealth` is Turso-only).
- **Acceptance/DoD:**
  1. A call exceeding a per-operation-class budget with neither resolve nor reject transitions the connection to
     `poisoned` (or `suspect`) and is surfaced in the health read.
  2. The budget is a typed tuning constant (ADR-0013 D3), not a toggle.
  3. **Negative control:** a latched driver call that never settles → the health verdict flips (red on the
     error-only machine). Record the red run.
- **Tests:** a fake driver whose call hangs on a latch; assert the health state flips within the budget (bounded
  deadline, no wall-clock sleep). Default-running.
- **Dependencies:** none. Overlaps STORE-1 (same file) — sequence after STORE-1 to avoid a double edit of
  `turso-adapter.ts`.
- **Size/tier:** S–M · executor hint: `backend` (sox) + `test`.
- **Risks/unknowns:** the underlying hung call cannot be cancelled — the honest fix documents that a poisoned
  connection is abandoned + recycled, not unblocked.
- **Decision gates:** none. Recommendation: reuse memory-server's proven `operation-guard.ts` shape.

---

## PACKET STORE-8: `MockAdapter` fails closed on an unresolvable WHERE

- **Goal:** A test double can no longer certify behaviour production does not have — an unresolvable `WHERE` throws
  in the mock.
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/src/mock-adapter.ts` (the fall-through at `:584`).
- **Inputs:** `ceff2b36` (full body — HIGH: unresolvable WHERE falls through to match-all; a migration guard or
  scoped delete written against the mock can be green in CI while production selects a different, unbounded row
  set; combined with `migration.ts:278` it is a data-loss shape, not just a false green).
- **Acceptance/DoD:**
  1. An unresolvable `WHERE` **throws** in the mock.
  2. Every existing spec that relied on fail-open is re-asserted or deleted — none left skipped. A grep-style audit
     enumerates them and records the disposition.
  3. **Negative control:** issue an unresolvable `WHERE` → the mock throws (red on the pre-fix fall-through). Record
     the red run.
- **Tests:** a spec asserting the throw; the audit list committed with the packet.
- **Dependencies:** none. Cross-repo.
- **Size/tier:** S · executor hint: `debug` (sox) + `test`.
- **Risks/unknowns:** the audit may surface specs whose green depended on fail-open — each is a real test bug to fix,
  not to skip.
- **Decision gates:** none.

---

## PACKET STORE-9: Present-but-empty filter scope selects nothing (ADR-0017 conformance)

- **Goal:** `ids: []` (and every set-membership filter) returns **zero** results at every layer — it is never
  dropped as "no filter".
- **Scope:** **sox-ecosystem** `libs/data/graph/graph-store/src/index.ts` (`buildNodeFilterClause`),
  `libs/data/vectors/vector-store/src/{index.ts,turso.ts,lancedb.ts}`, `libs/data/search/hybrid-search/**`.
- **Inputs:** `1b886cec` (full body — HIGH: the three-layer chain; `ids:[]` returns 1 on a single-issue store;
  `ids:[<absent>]` correctly returns 0; the stale inverse claim is written into hybrid-search's
  `package.json sox.invariants`, README, and `COMPILED_INTERFACES.md`), `3392bf48` (full body — the Turso vector
  backend silently drops an unknown `nodeFilter` field; a real cross-repo leak already resulted), `4295ad2b`
  (title-only — FK-heal duplicate fts trigger dedupe not directly tested).
- **Acceptance/DoD:** exactly ADR-0017's decision + the BUG-032 regression pins:
  1. `searchRanked({filters:{kind:'issue', ids:[]}})` → **zero** results (fails pre-fix).
  2. `ids:[<absent>]` → zero; absent ids → unfiltered; non-empty ids → exact. Each layer compiles its own half
     (graph-store → `0 = 1`; vector-store → zero short-circuit; hybrid-search → zero).
  3. A present-but-empty membership array never emits `col IN ()` (invalid SQL).
  4. The stale "empty ids = no filter" wording is removed from the hybrid-search invariant/README/COMPILED_INTERFACES.
  5. **Negative control:** revert one layer's empty-scope handling → that layer's `ids: []` test goes **red**. Record
     each.
- **Tests:** the `bug-032-empty-ids-filter.spec.ts` files (already named in ADR-0017) across the three packages;
  verify they are green on the **installed** dists. Default-running.
- **Dependencies:** none. Cross-repo.
- **Size/tier:** M · executor hint: `typescript` (sox) + `test`.
- **Risks/unknowns:** ADR-0017 is ACCEPTED (2026-09-21) and claims BUG-032 is fixed — `1b886cec` is OPEN. The first
  action is **verify against the installed dists**; if already fixed, close with the dist evidence rather than
  re-implementing.
- **Decision gates:** none.

---

## PACKET STORE-10: Restore the diagnostic of last resort — `integrity_check` on a Turso store

- **Goal:** An operator can verify a Turso-created store's integrity without a classic-`sqlite3` parse failure, and a
  tooling mismatch is never mistaken for corruption.
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/src/integrity.ts` + a documented diagnostic entry
  (Turso-native path); **adhd** docs that tell operators to run `sqlite3` directly.
- **Inputs:** `3e402ac8` (full body — HIGH: classic `sqlite3` fails at SCHEMA LOAD on Turso's
  `__turso_internal_fts_dir_idx_*` (`near "USING": syntax error`), blocking **every** statement including
  `PRAGMA integrity_check`; it works on the already-damaged file but not the healthy one — the worst availability
  pattern), `3e85f98c` (full body — the same gotcha recorded: stock `sqlite3` cannot read these files; use the Turso
  engine; do not report it as damage).
- **Acceptance/DoD:**
  1. A Turso-native integrity entry point (through the adapter / a `store-check`-style command) runs
     `integrity_check` (and the adapter's probe suite) against a healthy Turso store and returns a verdict.
  2. The classic-`sqlite3` failure is documented as a **tooling mismatch**, not corruption — with the exact error
     string — wherever operators are told to verify a store.
  3. **Negative control:** run classic `sqlite3` against a healthy Turso store and assert the documented
     mismatch is detected/handled (not silently reported as damage). Record the run.
- **Tests:** a spec asserting the Turso-native path returns a verdict on a healthy store; a doc/runbook assertion
  that the classic path is labelled a mismatch. Default-running.
- **Dependencies:** STORE-14 (the live verification uses this path). Cross-repo.
- **Size/tier:** S–M · executor hint: `debug` (sox) + `backend` (adhd docs/CLI).
- **Risks/unknowns:** whether the adapter already exposes a sufficient deep probe (SPEC's `pragma_integrity_check`)
  that simply needs a documented entry — check before adding a new primitive.
- **Decision gates:** none.

---

## PACKET STORE-11: Native-panic containment + an upstream-filing ledger

- **Goal:** A Turso native panic (SIGABRT) cannot be confused with another, its trigger is not guessed, and every
  upstream filing is discoverable from the repo so agents stop re-deriving "it's upstream".
- **Scope:** **sox-ecosystem** `libs/data/store/store-adapter/**` (panic containment / restart policy + a
  `docs/` ledger of upstream issues); **adhd** `entrypoint/backlog/**` only if a spawn site needs the containment.
- **Inputs:** `c6e61cc3` (full body — HIGH: `shared_wal_coordination.rs:1644` "shared owner slot released by
  non-owner"; **distinct from `6242cb2a`'s `btree.rs:1172`** — do not merge on the shared "turso panic" symptom,
  that mistake already cost time; trigger NOT established; a powered 8×2400-process experiment showed in-process
  open retry ENABLED → 0 SIGABRT, REMOVED → 4 SIGABRT), `6242cb2a` (title-only — turso 0.7.2 `btree.rs:1172` panic
  under WAL-truncation concurrency, upstream defect), `2977a772` (full body — our upstream filings
  (tursodatabase/turso#8348) are invisible from the repo; two agents re-derived the conclusion from scratch
  (~84k tokens); dedupe-search by symptom/file/error-string, never by identifier), `4b65f64e` (title-only — a
  native panic leaks the lease + `.openmark`, narrowing the quiescence gate; read body).
- **Acceptance/DoD:**
  1. A durable ledger (a `docs/` file or a backlog-linked table) records each upstream filing: issue number, the
     exact panic site, the reproducing harness, and the version matrix — discoverable by symptom search.
  2. The two panic sites are tracked as **two** items, never one; the trigger for `c6e61cc3` is stated as
     NOT established (the retraction is preserved).
  3. Panic-leak cleanup: a panic/crash leaves no orphan lease/`.openmark` that permanently narrows the gate
     (or the gate tolerates a provably-dead owner).
  4. **Negative control:** reproduce `c6e61cc3` via its harness (bypassing the gated path) → the crash is recorded;
     the ledger points at it. Do not claim the gated path reproduces it (STATE.md A17 showed the gated path does not).
- **Tests:** the existing powered harness (or a bounded version) as a documented, default-running containment test;
  the ledger is asserted by a link-check. Default-running for the containment arm.
- **Dependencies:** none. Cross-repo.
- **Size/tier:** S–M · executor hint: `debug` (sox) + `test`.
- **Risks/unknowns:** containment may be impossible inside the Rust engine (it aborts the process); the honest fix is
  a supervisor/restart policy + a ledger, not a code patch in the dependency.
- **Decision gates:** **sox-ecosystem owner** — whether to pin `@tursodatabase/database` to an exact version as
  mitigation (Domain 1's LIVE-10 raises the same pin). Recommendation: coordinate the pin with LIVE-10; keep the
  ledger in `store-adapter` docs.

---

## PACKET STORE-12: `graph-store` transactional soundness + recursive-neighbour performance

- **Goal:** `supersede()` is atomic under concurrent processes (no forked chain, no silent losing write), and a
  depth>1 recursive `getNeighbors` is not pathologically slow on the default SQLite path.
- **Scope:** **sox-ecosystem** `libs/data/graph/graph-store/src/index.ts` (`supersede`, `writeEdge`,
  `getNeighborsRecursive`), the `ix_node_validity` index usage. Non-goals: `2d88fba7` (`transaction()` mode
  widening — owned by **EMBED-16**, Domain 2; coordinate, do not duplicate).
- **Inputs:** `eb2ea56b` (full body — HIGH: three compounding defects in `supersede()`: TOCTOU pre-check outside the
  tx, no CAS guard on the UPDATE, and the SUPERSEDES edge written **outside** the transaction entirely — a
  concurrent pair both commit, silently forking the chain), `b04e4397` (full body — HIGH/MEASURED: recursive
  `getNeighbors` depth 2 is super-linear; the planner picks `ix_node_validity` over the rowid PK on the outer join;
  minimal-schema control: 0.007 s without the index vs 4.331 s with it; the Turso iterative fallback is 8.1 ms),
  `a97568e2` (full body — LOW: `memoryGetSupersessionChain` `canonical_uid` is `t_created`-tie-order dependent;
  engine-divergent on identical data; fix by tie-breaking on rowid/uid).
- **Acceptance/DoD:**
  1. `supersede()` runs the whole operation — pre-check, node write, **and** the SUPERSEDES edge — in one
     transaction; the UPDATE carries a CAS guard (`AND is_superseded = 0`); a two-process test asserts exactly one
     of two concurrent `supersede()` calls commits and the other fails loudly.
  2. `getNeighborsRecursive` uses the rowid PK on the outer join (index-hint or predicate fix); a benchmark asserts
     the tree-only depth-2 case is within a recorded budget (capture the pre-fix 8059 ms number in the test header).
  3. `canonical_uid` is deterministic for tied `t_created` (tie-break on rowid/uid).
  4. **Negative control:** revert the CAS guard → the two-process atomicity test goes **red**; revert the join fix →
     the perf assertion goes **red**. Record both.
- **Tests:** a two-process `supersede()` race test (latch, no sleep); a `getNeighbors` perf spec with the recorded
  budget. Default-running.
- **Dependencies:** STORE-1 (the adapter's `transaction(fn, {mode:'immediate'})` must exist — the SPEC's contract
  already supports it; EMBED-16 widens the graph wrapper). Cross-repo.
- **Size/tier:** M · executor hint: `debug` (sox) + `test`.
- **Risks/unknowns:** the perf fix may require a schema/index change (`ix_node_validity` is shared) — verify it
  does not regress other planner-routed queries; spike if the index cannot be changed without a migration.
- **Decision gates:** none.

---

## PACKET STORE-13: Clear the memory-core spec async-debt (~19 files, ~267 failures)

- **Goal:** `nx test memory-core` is green again after `openDb()` became async — every spec awaits it.
- **Scope:** **sox-ecosystem** `libs/memory-core/src/*.spec.ts` (the unawaited `openDb(...)` call sites).
- **Inputs:** `081bcd7d` (full body — the exact unawaited sites enumerated: `backup.spec.ts:80,139`;
  `db.spec.ts:81,108,129,136,150,161,175,189,204,211,232`; `embed-provenance.spec.ts:70`; `invalidate.spec.ts:39`;
  `compaction.spec.ts:59`; `outbox-queue.spec.ts:41`; `reembed.spec.ts:88,317,352`; ~267 failures reported, not
  independently re-run by the filing agent).
- **Acceptance/DoD:**
  1. Every unawaited `openDb(...)` call site awaits it; `grep -rn '= openDb(' … | grep -v 'await openDb'` returns
     nothing.
  2. `nx test memory-core` is **green** (0 failures) — run it and record the result, do not trust the reported
     count.
  3. **Negative control:** leave one site unawaited → that spec goes **red**. Record the red run.
- **Tests:** the memory-core test target itself; a grep-with-teeth audit as a committed check if practical.
- **Dependencies:** none. Cross-repo. This unblocks every other memory-core packet (STORE-15/16).
- **Size/tier:** M · executor hint: `test` (sox).
- **Risks/unknowns:** the count "~19 / ~267" is the item's report; the executor re-counts. Some failures may have a
  second root cause — fix those too, do not mark the item complete on a partial green.
- **Decision gates:** none.

---

## PACKET STORE-14: Live production store — backup-first integrity sweep + forensic close-out

- **Goal:** The live store is verified healthy (or its damage is named), its vectors are accounted for, and every
  open forensic question is closed with evidence — with a reversible backup taken first.
- **Scope:** the **live store** `~/.adhd/backlog/production/data/backlog-v2.db` (read/verify; repair only if damage
  is found, and only backup-first) + the reporting artifacts. Non-goals: the adapter fixes (STORE-1/2 own them).
- **Inputs:** `d6b49b85` (full body — vector coverage collapsed **before** the Turso swap; the pre-swap 49 MB backup
  has no `vec_node` table; root cause unknown), `ae763675` (full body — CRITICAL, 'Invalid page type: 0' — a
  bisection implicated in-repo embed-heal but it did **not** reproduce across 4 serial configs; UNREPRODUCED, not
  safe), `aa70a2c2` (title-only — `cp` of a live Turso/WAL store does not capture recent writes; every forensic row
  count from a plain-`cp` snapshot is a lagging read), `0f05e81b` (title-only — anomalous backup-slot write,
  author unverified), `15d6c878` (title-only — scale-dependent real corruption reproduced in bug-memory-001 AC3),
  `ad333b3e` (title-only — `integrity_check` blinded by 100 leaked pages saturating its message cap; cap-before-filter
  ordering still unguarded), `76a9c2f2` (title-only — episode-count metric contradiction: `memory_stats` claims
  622→645 while ground truth is 5,945/5,951), `2e117b1a` (full body — verify the live index desync is repaired and
  does not recur).
- **Acceptance/DoD:**
  1. **Backup-first:** a `VACUUM INTO` snapshot of the live store is taken and verified (reopened + `integrity_check`)
     **before** any read-heavy sweep; the backup path is recorded. Plain `cp` is banned (item `aa70a2c2`).
  2. **Integrity verdict:** `integrity_check` + the adapter's deep probes run against the live store; the verdict is
     recorded with the exact engine version. If the message cap can blind the check (`ad333b3e`), the ordering is
     fixed or the cap is raised first.
  3. **Index desync:** `ix_edge_dst_live`/`ix_node_kind_live` verify clean; if a repair ran, it is recorded and
     re-verified.
  4. **Vector accounting:** the live `vec_node` coverage is measured against the embeddable-row predicate and the
     number is recorded (feeds Domain 2's EMBED-1/EMBED-3); the pre-swap collapse (`d6b49b85`) is closed with a
     written root-cause-or-not finding.
  5. **Metric reconciliation:** `memory_stats`' episode count matches a ground-truth `COUNT(*)` of `kind='episode'`
     (`76a9c2f2`).
  6. **`ae763675`:** either a reproducible positive case exists (then a fix) or the item is closed with the
     4-config negative evidence recorded — never silently left "unreproduced, not safe".
  7. **Negative control:** re-take a plain-`cp` snapshot alongside the `VACUUM INTO` one and assert they disagree on
     recent writes (proves the backup method matters). Record the run.
- **Tests:** the sweep is a committed, re-runnable script (report-first, `--apply` gated for any repair); its
  assertions are the recorded verdicts. Repair is operator-invoked (ADR-0013 D4).
- **Dependencies:** STORE-1 (the probe fix + WAL fold), STORE-10 (the Turso-native verification path), STORE-13
  (memory-core green). Domain 2's EMBED-3 supplies the coverage probe; coordinate.
- **Size/tier:** M–L · executor hint: `debug` + `test`, with a `backend` operator for any repair.
- **Risks/unknowns:** this touches PRODUCTION — every mutation is backup-first and reversible; if a repair is
  needed, stop and get owner approval before applying (the `--apply` posture of ADR-0014 D4/D5).
- **Decision gates:** **Repo owner** — authorise any live repair (destructive-ish). Recommendation: take the backup +
  run the read-only sweep now; apply a repair only if damage is found and the owner approves, with the backup path
  recorded.

---

## PACKET STORE-15: memory-core retention + a proven restore path

- **Goal:** Snapshots are restorable, retention is enforced (not just typed), and backups cover the non-server modes
  — so disk stops growing unbounded and a "backup" is actually a backup.
- **Scope:** **sox-ecosystem** `libs/memory-core/src/backup.ts`, `src/config.ts` (`BackupConfig.retentionCount`),
  `tools/snapshot-gc.mjs` (ADR-0014 `--apply`), the `organizer_queue` retention.
- **Inputs:** `354c4206` (full body — ADR-0014 written, report-only GC shipped, `--apply` gated; 1.4 GB accumulated),
  `3e85f98c` (full body — restore PROVEN for 2 of ~15 dirs; `BackupConfig.retentionCount` typed, read by **no
  code**), `f0d6e388` (full body — no backup for ~22 h because auto-backup only runs on clean server start; needs
  pre-service-start + scheduled + non-server-mode coverage; `BackupConfig` skeleton already shipped), `69260ffc`
  (full body — `organizer_queue` retains 4,667 done rows; the **fourth** instance of "retention designed, never
  implemented" — consider one shared retention primitive).
- **Acceptance/DoD:**
  1. `retentionCount` is wired: backups beyond the count are pruned (test asserts N+1 → N kept).
  2. The restore path is exercised for a snapshot directory and verified (`integrity_check` + a real recall read);
     ADR-0014 D5's gate is discharged for the full set (or the remaining dirs are explicitly listed).
  3. `snapshot-gc.mjs --apply` is enabled **only** behind the proven restore path; report-only stays default;
     `--apply --confirm` re-prints the list and refuses to delete a class's most-recent.
  4. Backup coverage extends to non-server modes + a pre-service-start hook (idempotent, failure = serve-with-warning,
     never refuse-to-serve).
  5. `organizer_queue` completed rows are pruned (bounded, reported).
  6. **Negative control:** remove the prune → the N+1 test goes **red**; remove the restore proof → the restore test
     goes **red**. Record both.
- **Tests:** retention count spec; restore spec (offline, against disposable copies — never open the source
  snapshots); GC report/apply specs from ADR-0014's acceptance list (1–10). Default-running.
- **Dependencies:** STORE-13. ADR-0014 is **PROPOSED** — `--apply` requires the D5 prerequisite met. Cross-repo.
- **Size/tier:** M–L · executor hint: `backend` (sox) + `test`.
- **Risks/unknowns:** the retention policy is heterogeneous (four validated classes; non-snapshot dirs are
  permanently excluded per ADR-0014 D1) — do not generalise a policy onto the excluded dirs.
- **Decision gates:** **Repo owner** — enable `snapshot-gc --apply` (destructive). Recommendation: yes once the
  restore path is proven for the full set; keep report-first the default.

---

## PACKET STORE-16: memory-core surface correctness — read-path, contracts, and the entity→community retirement

- **Goal:** The memory read/contract surface stops reporting wrong values (silent override reverts, metric
  contradictions, schema-advertised defaults that differ from the applied value) and the impossible
  entity→community affordance is retired.
- **Scope:** **sox-ecosystem** `libs/memory-core/src/**` (`update.ts`, `list-entities.ts`, `recall.ts`,
  `extensions.ts`, `db.ts`), `extensions/bundles/sox-memory-bundle/**` (type declarations),
  `libs/data/vectors/vector-store/src/{index.ts,lancedb.ts}` (the lint warnings).
- **Inputs:** `2f196e3e` (title-only — `memory_update` accepts a user-asserted importance, reports success, then the
  batch enrichment pass silently reverts it; `update.ts` never stamps the user_override marker the guard checks),
  `59f22cbd` (title-only — `memory_scope` is populated on the live store but nothing populates it for a store the
  MCP server creates itself), `851c89bc` (title-only — `memory_recall` advertises `token_budget` default 4000 but
  applies 32000), `7816dc8b` (full body — HIGH: `memory_list_entities` is O(N) per-entity `getEdges`; 4,238 entities
  × ~23.3 ms ≈ 98.7 s > the 60 s MCP timeout; rewrite as a single-query join, do **not** raise the timeout),
  `439bc22e` (full body — the dead `?? 500` default is FIXED; not resolved per BL-225 because no witnessed red arm —
  close with the red arm), `f83e727f` (title-only — memory-server/flush/cli ship no type declarations; a TS consumer
  fails TS7016), `20b661a2` (full body — PRODUCT RULING: build nothing; retire the advertised entity→community
  capability; the need is served by `memory_entity_episodes`), `d1064dc2` + `bee49391` (title-only — memory-core
  still assembles FTS SQL above store-adapter / hand-rolls dialect residue; adopt `ftsSearch`/`ensureFtsIndex`),
  `a9a7deff` (full body — `vector-store` carries 4 live `sox/no-storage-backend-leak` warnings on the exact rule
  guarding the recurring BL-380 class; the rule is set to `warning` in a repo that gates on 0 errors).
- **Acceptance/DoD:**
  1. `memory_update`'s user-asserted importance survives the enrichment pass (the user_override marker is stamped);
     a test asserts the value is unchanged after an enrichment pass.
  2. `memory_list_entities` returns within the MCP timeout on a 4,238-entity store (single-query join); a perf spec
     asserts the bounded time (red on the N+1).
  3. `memory_recall`'s advertised `token_budget` default equals the applied default.
  4. The MCP-server-created store populates `memory_scope` (or the two readers no longer no-op).
  5. The entity→community affordance is **removed** from the advertised surface (schema description + docs); no new
     resolver is built (`20b661a2`).
  6. `memory-server`/`memory-flush`/`memory-cli` ship type declarations (a TS consumer compiles under `noImplicitAny`).
  7. memory-core uses the adapter's `ftsSearch`/`ensureFtsIndex` instead of hand-rolled FTS SQL.
  8. The `vector-store` lint warnings are fixed at source (not `eslint-disable`d).
  9. **Negative control:** revert the user_override stamp → DoD-1 goes **red**; revert the join → the perf assertion
     goes **red**. Record both.
- **Tests:** per-item specs, default-running; the perf spec uses the real store shape. `npx nx lint vector-store`
  for DoD-8.
- **Dependencies:** STORE-13 (memory-core must be green first). Cross-repo. `d1064dc2`/`bee49391` depend on the
  adapter FTS surface (STORE-6 / the A2 `ftsSearch` ops — verify shipped).
- **Size/tier:** L · executor hint: `typescript`/`backend` (sox) + `test`.
- **Risks/unknowns:** this is a grab-bag; if it proves too large for one dispatch, split into (a) read-path
  correctness (1–4), (b) packaging/contract (5–8). The `20b661a2` retirement is a **removal** — grep for every
  advertised reference first.
- **Decision gates:** none (the entity→community ruling is already made).

---

## PACKET WAVE-1: Backlog source-fix wave — citation robustness, spawn isolation, review-fix batch

- **Goal:** The backlog write/query surface stops silently mishandling citations and test isolation, and the queued
  review-fix batch lands as one wave commit.
- **Scope:** **adhd** `entrypoint/backlog/src/**` + `tools/**` + specs. Non-goals: deploy/CI (Domain 1), embedding
  (Domain 2).
- **Inputs:** the deferral plan `report/deferral-cleanup-plan.md` §3 (B1–B4) read in full; `aede6810` (full body —
  EISDIR citation throws instead of degrading; three copies of the absent-target set), `82470ae8` (title-only — the
  HOME-redirect invariant is duplicated across ~10 spec files with no shared helper; `6ac07aaa` shows the helper
  built for it is incomplete), `2b1d8a22` (title-only — the review-fix batch: unify the 3× path-known predicate,
  give `create-issue.spec.ts:256`'s "nothing is written" claim teeth, log the `isVectorSpacePopulated` capability
  miss), `a934e089` (title-only — `citationRequiresSha` path-less waiver is a silent no-op), `1e12507f` (title-only —
  `src/write/CONTRACT.md`'s six `errors.ts` anchors are systematically stale), `8a09824c` (title-only — the
  `@adhd/sox-embedding-provider` `^0.4.1` vs `^0.5.0` dual-copy hazard in `entrypoint/backlog/package.json`),
  `92b82a73` (title-only — `gitContext` is rendered raw into the markdown `Citations:` block; a newline forges a
  citation line).
- **Acceptance/DoD:** exactly deferral plan §3 B1–B4:
  1. **B1 (`aede6810`):** widen the absent-target set to `ENOENT|ENOTDIR|EISDIR`, extracted into one
     `isAbsentCitationTarget` in `src/write/catalog.ts`, imported by all three copies. Test: cite a real directory →
     the write succeeds and persists `sha:'unverified'`. Negative control: revert the EISDIR branch → both specs red.
  2. **B2 (`92b82a73`):** a `sanitizeGitContext` rejecting/escaping `[`/`]`/CR/LF and capping length, applied at
     write (reject) + render (defence in depth). Test: `]\n- [evil sha:x]` must not produce a second citation line.
  3. **B3 (`82470ae8`):** one shared `spawn-isolated-bin` helper owning the invariant **pair** (HOME + scope) —
     **and** neutralising `ADHD_ROOT`/`ADHD_BACKLOG_DATABASE_PATH`/`SOX_ECOSYSTEM_HOME` (`6ac07aaa`). Migrate the 15
     spawn sites. Test: spawn the real bin, assert the resolved `dbPath` is under the temp HOME even with
     `ADHD_ROOT` exported. Negative control: drop the HOME redirect → red.
  4. **B4 (`2b1d8a22`+`a934e089`+`8a09824c`+`1e12507f`):** the four small edits per plan §3 B4.
- **Tests:** the named specs in plan §3; `npx nx build backlog` + `npx nx lint backlog` + the targeted specs. No
  `--skip-nx-cache`.
- **Dependencies:** none. `8a09824c` may need Domain 2's EMBED-13 (the provider changeset) — coordinate the pin bump.
- **Size/tier:** M · executor hint: `typescript` (adhd) + `test`.
- **Risks/unknowns:** `6ac07aaa` proves the helper built for `82470ae8` is **incomplete** — the helper must be
  extended, not merely introduced. The deferral plan's line references (`create-issue.ts:359-361` etc.) are from an
  earlier tree — re-locate before editing.
- **Decision gates:** none.

---

## PACKET WAVE-2: Backlog test / CI gates — jscpd, parity, store-check, query coverage, teardown, gate hygiene

- **Goal:** The backlog test surface is green and *meaningful*: a duplication ceiling, a blocking parity gate, a
  tested diagnostic, query-layer coverage, a deterministic teardown, and no gate-dirty specs.
- **Scope:** **adhd** `entrypoint/backlog/project.json` (a new jscpd target), `.github/workflows/ci.yml`
  (coordinate with Domain 1's LIVE-6 — see disjointness), `tools/gate/embedding-usage-gate.mjs`,
  `src/query/**` specs, `src/cli.spec.ts` teardown, `src/store/semantic-readiness-probe.spec.ts`.
- **Inputs:** `b63a66fe` (full body — jscpd measured 6.54 % duplicated lines; adopt a 5 % ceiling **after** the
  removal pass, allowlisting teaching mirrors; the standing user directive is "gate wanted" — STATE.md §H5 override),
  `a1ac8194` (full body — promote the backlog parity-check to a blocking CI gate; the proposed spec says its premise
  was NOT verified), `a1c2cbde` (full body — the `store-check` CLI command at `cli.ts:530-570` has no test; add a
  spawned-CLI spec asserting exit 0 / exit 1 with `store_vocabulary_mismatch`), `6ffed6b8` (full body — `src/query/`
  has zero tests plus three known limitations: global `staleAfterMin` default, duplicate `IIssueCard` shapes,
  in-memory priority sort), `2a977118` (full body — `cli.spec.ts` teardown `ENOTEMPTY` race under load; fix by
  awaiting child exit / retrying rm / rename-then-remove — never catch-and-ignore), `6ac07aaa` (full body — the
  spawn helper does not neutralise ambient store-redirect vars; WAVE-1 fixes it, this packet adds the regression
  guard), `ebb6a733` (full body — `semantic-readiness-probe.spec.ts` is undeclared in the embedding gate → `nx test
  backlog` RED), `cd34ba0d` (full body — S-01 Seg G comment rename trips the gate; the full suite is 601 tests, 1
  failed; reword the comment — do not add a false marker), `e6799f8f0` (title-only — orphaned v1-bin test rows are
  invisible to the v2 `view:list`; a visibility gap).
- **Acceptance/DoD:**
  1. jscpd runs as an Nx target (the `vocabulary-gate` target is the precedent shape), fails above 5 %, allowlists
     the teaching mirrors; **activated only after** the removal pass (else it starts red).
  2. The parity gate is blocking (remove `continue-on-error` / wire the exit code); a deliberate divergence makes
     it exit non-zero. (Coordinate with Domain 1: LIVE-6 owns the `ci.yml` affected-set/format fix — this packet
     owns the *parity-check* job wiring; do not both edit the same lines.)
  3. `store-check` has a spawned-CLI test (exit 0 + exit 1 paths).
  4. `src/query/` has coverage for card/get/query/resolve/registry; the three limitations are either fixed or
     explicitly pinned by a test asserting current behaviour.
  5. `cli.spec.ts` teardown is deterministic (no `ENOTEMPTY` under full-suite load; latch/await, no sleep).
  6. The embedding-usage gate is CLEAN; `nx test backlog` is green (the `ebb6a733` + `cd34ba0d` reds cleared).
  7. The orphaned-row visibility gap (`e6799f8f0`) is either fixed (production reads all namespaces / the API
     surfaces registered-project-less rows) or filed as a deliberate, documented limitation with a guard.
  8. **Negative control:** per gate — remove the jscpd ceiling → a seeded clone fails it; revert the gate marker →
     the suite goes red. Record each.
- **Tests:** the gates themselves + the new specs; `npx vitest run` full suite must be 0 failures. No
  `--skip-nx-cache`.
- **Dependencies:** WAVE-1 (`6ac07aaa`'s guard depends on the helper). The removal pass (S-01/S-03/S-04/S-16) must
  land before jscpd activation. Domain 1's LIVE-6 for the CI file.
- **Size/tier:** M–L · executor hint: `test` (adhd) + `backend`.
- **Risks/unknowns:** `a1ac8194`'s premise is explicitly unverified — confirm before wiring. jscpd activation before
  the removal pass makes the gate red — sequence strictly.
- **Decision gates:** none. Recommendation: land the gate-hygiene reds (`ebb6a733`, `cd34ba0d`) and the teardown
  fix first (small, unblock the suite), then the gates.

---

## PACKET WAVE-3: Plan-execution orchestration — run the deferral-cleanup-plan §7 lanes in dependency order

- **Goal:** The consolidated cleanup plan is executed as a sequenced, resumable program: the stale items are closed,
  the deploy lanes run, the sox lanes publish, the backlog wave lands, and the re-cutover carries everything.
- **Scope:** orchestration only — this packet dispatches/sequences the other packets and the Domain 1/2 lanes; it
  writes no source. Non-goals: any code change (owned by the numbered packets).
- **Inputs:** `report/deferral-cleanup-plan.md` §7 (lanes L0–L7 + the recommended order + critical-path deps) read
  in full; `docs/plan/store-adapter-batch-0.10.0/SPEC.md` (the L1 vehicle, STORE-1); §6 (the stale/superseded
  close list — `6d332464`, `c85c820e`, `87ef8bf9`, `40d9da12`, `cd34ba0d`, `2b607b26`, `d2f11ab6`, `e68be52c`,
  `edc4f456`, `6defe186`); §5 (decisions D1–D5); §9 (open questions). `e769bdc4` (title-only — the deleted
  real-model spec) is owned by **Domain 2's EMBED-12** — cross-reference, do not duplicate.
- **Acceptance/DoD:**
  1. §6 stale items are closed with evidence (no code) — the graph transitions are made, not just noted.
  2. The lanes run in the plan's order, honouring the critical path: `D1 → L3`; `L1 publish → backlog pin bump →
     L0-step-2`; `L4 committed → L0-step-2`; `L0 → L6`.
  3. The five decisions D1–D5 are resolved before their dependent lanes dispatch (D5 = the L0 vehicle; D3 = the
     config-isolation posture; D4 = contamination cleanup).
  4. Each lane's completion is verified from the **real artifact** (a deploy's dist sha, a published npm version, a
     green affected run) — never from a subagent report.
  5. **Negative control:** if a lane claims done without its real-artifact evidence, the orchestration halts and
     re-dispatches — the plan is not advanced on a report.
- **Tests:** the plan's own verification steps per lane; the deploy-verify script (Domain 1's LIVE-1).
- **Dependencies:** this packet depends on WAVE-1/WAVE-2 landing and on STORE-1 publishing. It is the top-level
  sequencer for the whole cleanup program.
- **Size/tier:** L · executor hint: `dispatcher` (orchestration) — not a code executor.
- **Risks/unknowns:** the plan's uid list notes several **superseded** hand-off uids; always resolve the live uid
  before acting. Two decisions are user-gated (D4 contamination cleanup, D5 deploy vehicle).
- **Decision gates:** **Repo owner** — D1 (ADR route), D2 (`update`-body-supersedes by design?), D3 (config-isolation
  root fix), D4 (contamination cleanup), D5 (deploy vehicle). Recommendations are in plan §5/§9. **Human approval
  to merge PR #9 / publish `@adhd/backlog` is a hard gate** (excluded from the 2026-09-22 autonomy grant).

---

## Coordination map (disjointness)

| Surface | Owner | This domain does **not** touch |
|---|---|---|
| Deploy / re-cutover / bin / MCP / npm publish | Domain 1 (`LIVE-1…11`) | deploy mechanics; `ci.yml` affected-set/format (LIVE-6) |
| Embedding funnel / provider / pool / lock / embed-durability | Domain 2 (`EMBED-1…16`) | `libs/data/embed/**`; `report/embed-durability-fix-spec.md` (`ses_f342169b`) |
| `2d88fba7` (`transaction()` mode widening) | **EMBED-16** (Domain 2) | the graph-store wrapper signature |
| `e769bdc4` (deleted real-model spec) | **EMBED-12** (Domain 2) | the replacement spec |
| `2039bb80` + `87799e1d` (version/health) | Domain 2 (EMBED-2/EMBED-4) | the store-meta implementation |
| Citation→component linking | Domain 3 | the linker |
| Registry surface redesign | Domain 5 | `registry-surface-redesign.md` |
| `libs/data/store/**`, `libs/data/graph/**`, `libs/data/vectors/**` (schema/store), `libs/memory-core/**` (store) | **this domain** | — |
| `entrypoint/backlog/**` wave + gates | **this domain** (WAVE-1/2) | deploy/CI mechanics (Domain 1) |

**Cross-repo note:** STORE-1…12, STORE-15, STORE-16 live in `sox-ecosystem` (`a1e8f31c`); they need the
sox-ecosystem owner's dispatch + release-train window. STORE-13/14, WAVE-1/2 are `adhd`. STORE-14 touches the
**live production store** — backup-first, operator-gated repair.

## Inputs / gaps

- **Title-only items** (body not in the captures — the executor MUST read them live via `adhd-backlog` before
  implementing): `4b65f64e`, `1e023495`, `d8f0c34b`, `7df3d566`, `a40056fb`, `4295ad2b`, `6242cb2a`, `aa70a2c2`,
  `0f05e81b`, `15d6c878`, `ad333b3e`, `76a9c2f2`, `2f196e3e`, `59f22cbd`, `851c89bc`, `f83e727f`, `d1064dc2`,
  `bee49391`, `a9a7deff` (read), `e6799f8f0`, `82470ae8`, `2b1d8a22`, `a934e089`, `1e12507f`, `8a09824c`,
  `92b82a73`, `2e117b1a` (read).
- `e769bdc4` is deliberately **not** packetised here — Domain 2's EMBED-12 owns it.
- `2039bb80`/`87799e1d` are Domain 2's (EMBED-2/EMBED-4); `LIVE-9` is a coordination placeholder only.
- The live store's canonical path is `backlog-v2.db`; item bodies written earlier say `backlog.db` — the
  pre-cutover spelling. Do not "fix" a path based on the older item text.
- **No code was written by this pass.** All uids were resolved against the scan captures; where a body was absent,
  the item is marked title-only rather than guessed.
