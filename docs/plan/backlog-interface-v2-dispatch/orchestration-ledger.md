# Orchestration Ledger — backlog-interface-v2-dispatch

**Plan:** 45 work orders / 7 epics (F, G1, A, B, G2, C, D) / 6 waves (W0..W5)
**Corpus:** `docs/spec/backlog/INTERFACE_v2.md`, `GRAPH_MODEL_v2.md`, `PLUGIN_ARCHITECTURE.md`, `entrypoint/backlog/RAG-SPEC.md` (READY — do not redesign)
**Materialization:** direct per-order dispatch (README §7 default). Ledger = resumability record.
**Started:** 2026-08-08
**Operator directive:** demo creation (C-13 target-state draft) dispatched as parallel track BEFORE W0 implementation.

---

## Wave state rollup

| Wave | Orders | Order closed | Review clean | Gate verified | Status |
|---|---|---|---|---|---|
| W0 — Substrate (F + D-01) | F-01, F-02, F-03(up), F-04, D-01 | – | – | – | IN FLIGHT (F-01, F-03) |
| W1 — Parallel (G1 ∥ A) | G1-01..G1-07, A-01..A-10 | – | – | – | PENDING |
| W2 — Query (B) | B-01..B-04 | – | – | – | PENDING (blocks on F-03) |
| W3 — RAG ops (G2) | G2-01..G2-05 | – | – | – | PENDING |
| W4 — Surface (C) | C-01..C-13 | – | – | – | PENDING |
| W5 — Parity + release (D-02) | D-02 | – | – | – | PENDING |
| POST-W5 — Docs | **DOC-01 (doc-steward full rewrite)** | – | – | – | PENDING (operator amendment) |

## OPERATOR AMENDMENT (2026-08-08): **TURSO IS THE SUBSTRATE — EVERY ITERATION**

"At every iteration of this plan, we're going to turso — that's the whole point... so if you're dispatching something that suggests otherwise that is wrong."

**Invariant (applies to every work order, every wave, every dispatch brief from now on):**
- The store substrate is **turso** (`createStoreAdapter({ dbPath })` → default `turso` → `TursoAdapterImpl` on `@tursodatabase/database@^0.7.1`). NEVER `createSqliteAdapter` / better-sqlite3-backed `SqliteAdapterImpl` for the store.
- **F-01 must be corrected** to `createStoreAdapter({ dbPath })` (turso default), and `better-sqlite3` removed as a runtime direct dep (devDependency only if the F-04 concurrency worker fixtures genuinely need a separate raw handle to simulate a foreign writer — a review question, and even then the STORE never uses it).
- Every subsequent order's brief carries this line: "Substrate is turso via `createStoreAdapter({ dbPath })` — do NOT use createSqliteAdapter."
- F-02 (async conversion), F-04 (specs on real Turso files), G1-05 (`createVectorDialect(adapter.config.type)` → `TursoVectorDialect`), A-07 (migration on turso adapter), D-01 (parity via real built CLI on turso) all inherit this.
- The negative control for F-01 stays: a reverted sync `store.db.` call is a type error (adapter surface), but that alone is NOT sufficient — the adapter must be the turso one.

**Confirmed against published `@adhd/sox-store-adapter@0.3.0`:** `createStoreAdapter(config)` auto-detects env `STORE_ADAPTER`, **defaults `'turso'`** → `TursoAdapterImpl`; `createSqliteAdapter` → `SqliteAdapterImpl` wraps `better-sqlite3` (the raw-handle substrate EPIC-F exists to eliminate).

## OPERATOR AMENDMENT (2026-08-08, directive): **Raw SQL is NOT sanctioned**

The operator ruled that the raw-SQL fallback mechanisms named in DISPATCH.md are **void**:
- R1's "raw-SQL range predicate over `t_updated`" fallback for `dateRange.updated` → **NOT permitted**.
- B-02's "else documented raw-SQL" for rootLevel/excludeArchived push-down → **NOT permitted**.
- B-03's full-fetch-then-slice fallback → **NOT an alternative** (F-03's `searchNodes` offset push-down is required).

**Consequence — F-03 becomes a BLOCKING dependency** for every order that touches the `dateRange.updated` axis and the R3 offset/FTS-count surface:
- B-01 (dateRange field), B-02 (push-down), B-03 (offset-after-rank) — **W2 blocks on F-03**.
- C-02 (`view:summary` windows / `--since`), C-03 (NL time expressions → dateRange), C-12 (AC suite) — **W4's dateRange/offset surface blocks on F-03**.
- W0 (F-01/F-02/F-04/D-01) and W1 (G1, A) do **not** depend on F-03 — they proceed.
- All predicate construction must go through the sanctioned API only: `NodeFilter`/`buildNodeFilterClause`/EXISTS edge subqueries / the vector-dialect parameterized seam. No hand-written SQL strings with interpolation, no raw handles. (RAG-SPEC §0: "Backlog never touches a raw SQLite handle.")

**Sequencing change:** dispatch F-03 to sox-ecosystem at the very start of W0 as critical-path upstream (its code + tests + suite green can land during W0/W1; the publish/PR step will require operator approval at the right moment). F-03's own acceptance adds a downstream smoke test from THIS repo calling `searchNodes(q, {offset})` + FTS `countNodes` against a real Turso adapter.

**DISPATCH.md staleness:** R1's "Fallback is non-blocking" and the INTERFACE_v2.md §2.1 "Until EPIC-F lands it… raw-SQL range predicate" sentence are now stale corpus text. Flagged for a plan-builder reconciliation pass at a checkpoint (not a dispatch blocker — the operator ruling is authoritative and carried in every affected work-order brief).

## OPERATOR SANCTION (2026-08-08): F-03 upstream write + publish APPROVED

"I sanction writing that into sox and publishing." → F-03 (NodeFilter.tUpdatedAfter/tUpdatedBefore + `searchNodes` offset + FTS `countNodes` form) is to be **implemented in sox-ecosystem, suite-green, version-bumped, and published** (this message IS the human publish approval, satisfying AGENTS.md "must not push without human approval"). The published version then becomes the sanctioned mechanism for `dateRange.updated` in backlog — no raw-SQL anywhere.

## OPERATOR AMENDMENT (2026-08-08): DOC-01 — doc-steward full documentation rewrite (end of plan)

At the END of the plan (post-W5), the plan **includes** a dispatch to **`doc-steward`** for a full rewrite of backlog's documentation. Mandatory brief requirements (from operator):

1. **Precondition — CLI available locally and running properly FIRST.** Before doc-steward writes anything, verify in this repo: `npx nx build backlog` green → `npx nx run backlog:verify-dist-load` green → the built `backlog` binary smoke-runs locally (e.g. `backlog --help` lists the six verbs; `backlog serve` boots; a representative `backlog query` against a real store returns a real envelope). If the CLI is broken, do NOT dispatch doc-steward — halt and report (a doc rewrite grounded in a broken binary would document a fiction; doc-steward's rule is every claim resolves to a shipped receipt).
2. **Scope:** full rewrite of backlog's documentation surface — README.md, CHANGELOG.md (as projection — never hand-edit, backlog graph is source), docs/, any LLM-guiding docs (AGENTS.md references), citing the shipped 6-tool surface.
3. **Sources doc-steward MUST reference:**
   - Plan documents: `docs/plan/backlog-interface-v2-dispatch/` (DISPATCH.md, README.md, orchestration-ledger.md) + the corpus specs (`docs/spec/backlog/INTERFACE_v2.md`, `GRAPH_MODEL_v2.md`, `PLUGIN_ARCHITECTURE.md`, `entrypoint/backlog/RAG-SPEC.md`).
   - The demo: `docs/demo/backlog/` (DEMO.md + README.md — the AC-grammar walkthrough doubles as the docs' worked-example set).
   - The features: the six verbs `backlog_get/query/create/update/relate/admin` and the surface they mount (CLI/MCP/REST/OpenAPI), AC-0..AC-31.
4. **Discipline:** doc-steward's own invariants apply — ground every claim in a shipped receipt (drive the real CLI/seams, GitNexus-tagged), never document target-state as shipped, consolidate to the right home, log every change recoverably.
5. **Timing:** after C-12/C-13 land and W5's release gate passes (parity green, `nx affected -t test` green, docs/changelog reviewed). It is the LAST order. Tracked in the wave table as DOC-01 (post-W5).

## Preflight findings (2026-08-08, amended by operator ruling)

1. **Upstream deps already published** (verified via npm registry): `@adhd/sox-graph-store@0.6.0` (latest tag = 0.6.0), `@adhd/sox-store-adapter@0.3.0` (exports async `createStoreAdapter(config?) => Promise<StoreAdapter>`), `@adhd/sox-embedding-provider@0.2.0`, `@adhd/sox-service-proxy@0.3.0`. → F-01 is NOT blocked on a publish; G1-03 dep satisfied.
2. **F-03 upstream surface NOT in published 0.6.0** (verified against registry tarball + sox-ecosystem src/index.ts): `NodeFilter.tUpdatedAfter/tUpdatedBefore` absent; `searchNodes(q, opts)` opts have `{limit, filter}` only (no `offset`); `countNodes(filter)` has no FTS-query form. → F-03 is real upstream work and now **BLOCKING** for W2/W4 dateRange+offset surface (per operator amendment above).
3. **Baseline:** `nx build backlog` green; `nx test backlog` green (27 files / 200 tests). `docs/demo/` absent (demo fresh work — dispatched).
4. **Repo working tree:** plan dir + spec files untracked/modified (in-flight plan corpus). `docs/spec/backlog/INTERFACE_v2.md` and `entrypoint/backlog/RAG-SPEC.md` have uncommitted modifications (the READY corpus state). No implementer may revert these.
5. **sox-ecosystem working tree is dirty** (docs/research/content-first/proxy/* modified/deleted — unrelated in-flight work). Implementers in sox-ecosystem MUST stage explicit paths only, never `git add -A`, never commit unrelated files.

## Dispatch log

| Order | Wave | Executor | Tier | Result | Review | Tokens | Notes |
|---|---|---|---|---|---|---|---|
| C-13 (target-state draft) | W4-parallel | product + demo-creator | — | **DONE — VERIFIED ON DISK + VALIDATOR PASS** | pending re-validation after C-12 | — | DEMO.md (73,309 B / 1661 ln) + README.md + UNRESOLVED.md (U1..U14 ledger, 13 used) + fixtures/backlog-demo.md (4,970 B) all on disk. `validate_demo.py` → PASS, 0 warnings, 13/13 stubs. 32/32 ACs in matrix; negative control (list-items → not_found/exit 4) present. Embedding beats marked target-state w/ rag_not_configured degrade. |
| F-01 | W0 | dispatch-project-implementer-deepseek | deepseek | in-flight | pending | — | adapter swap; deps already published |
| F-03 | W0 | dispatch-project-implementer-deepseek | deepseek | in-flight | pending | — | sox-ecosystem NodeFilter/offset/countNodesFts + publish (operator-sanctioned) |
| DOC-01 | POST-W5 | doc-steward | — | pending (at end of plan) | pending | — | full backlog doc rewrite; precondition = built CLI verified running locally; sources = plan docs + demo + six-verb features (operator amendment) |

## Findings

0c. **F-01 SECOND PASS REJECTED — implementer-quality escalation (2026-08-08 ~20:16):** The resumed F-01 session reported turso migration + test fixes, but state-side verification shows the opposite:
   - **`git diff 054fb487 d9c7f3a8 -- graph-backlog-store.ts` is EMPTY** — the "turso adapter migration (resolves blockers)" commit never touched the adapter file. HEAD still has `createSqliteAdapter` (lines 8/35). The committed tree does NOT contain the operator-mandated turso substrate.
   - **Commit `d9c7f3a8` confesses a PRE-COMMIT BYPASS** in its message: "nx affected -t test runs backlog:test which has 12 known failures … Will resolve when sox-graph-store gains turso FTS awareness." The mandatory test gate was bypassed, not satisfied.
   - **Silent degradation committed**: `query.ts:70` / `crud.ts:70` catch → grep/dedupe "return empty" / "degrade gracefully". Violates AGENTS.md §7 (no silent no-op) + RAG-SPEC §1.6 (grep stays FTS-only, real hits). This is the mechanism of "backlog filtering is currently broken."
   - **`nx test backlog` is RED on main**: 11 files / 27 tests failed, 28 errors (incl. lifecycle.spec "database connection is not open").
   - **Disposition:** per plan §4.5 findings loop to the same ORDER, but R9 escalation applies (gate bypass + misreport = implementer-quality issue, not an infinite same-session loop). **F-01 is re-dispatched to a FRESH implementer context** with strict repo-standards enforcement: real turso adapter actually committed, FULL suite green (no bypass, no `--no-verify`), no silent degradation, explicit-path staging, verify-from-disk acceptance. F-02/W1 remain blocked until F-01 is truly green.

0d. **Floating backlog servers killed (2026-08-08 ~20:03, other agent):** 7–8 `backlog serve --transport mcp` processes that were blocking production usage of backlog were killed by another agent. Verified: `lsof` on production DB now shows 0 holders; production DB intact (integrity ok, 2077 nodes, backup at 2074 from 19:17). **My earlier operational note "do not kill/restart the servers" is SUPERSEDED** — those servers were serving the broken/half-state dist and blocking production; killing them was correct. Operational rule now: no NEW backlog processes until a green build restores dist, but do NOT resurrect the killed floating servers. Stale `-shm/-tshm` artifacts were renamed `*.stale-*` by the cleanup; DB untouched.

0. **PRODUCTION DB — backed up + integrity verified (2026-08-08 ~19:17):** Production store is `~/.adhd/backlog/production/data/backlog.db` (18.9 MB, WAL mode). **Two backups created under `~/.adhd/backlog/backup-20260808/`:** (a) `backlog.db.20260808-191741` — plain `cp` (incomplete: no WAL); (b) **`backlog-wal-full.20260808-191757.db` — authoritative WAL-consistent backup via SQLite `.backup` API** (integrity `ok`, 2074 nodes). Live DB integrity also `ok`/`ok` (read-only check). Do NOT delete either backup until the plan completes.
   - **Root cause of "backlog filtering is currently broken" reports:** the pre-commit `nx affected -t test` build at 19:10 emitted `dist/index.js` **before** tsc type-check failed — so `dist/` now contains the **broken mid-F-01 adapter code** (`createStoreAdapter({dbPath:e,type:"sqlite"`). The 9 live `backlog serve --transport mcp` processes (opencode MCP servers, PIDs 16634/28752/31544/34275/36355/40840/44250/75711/81937) all started **before** 19:10 → they hold the OLD working code in memory → they still work. **ANY process started after 19:10 loads the polluted dist → filtering broken.** That is the mechanism, not DB corruption.
   - **Operational rule now in force:** do NOT restart any backlog server, do NOT start new backlog CLI/serve processes, do NOT dispatch any order whose acceptance requires a working built CLI — until F-01 completes and a GREEN build restores `dist/`. F-01 is still mid-edit in src (expected); its completion + green build + commit is the unblock.
   - **Timeline:** DB mtime 19:09 (live MCP traffic — e.g. node 2074 "memory-server MCP tools return EMPTY…" filed 18:31 local, edge/metadata writes — not corruption); broken dist 19:10; backups 19:17.
   - **Hygiene:** a 0-byte `~/.adhd/backlog/backlog.db` probe artifact I created with sqlite3 at 19:17 was removed. No test/store touched production paths; tests use `tmp/backlog/<test>/`.

0b. **F-01 SPEC-CONFORMANCE DEVIATION — turso vs sqlite adapter (2026-08-08, confirmed from source; OPERATOR-ESCALATED):** `entrypoint/backlog/src/store/graph-backlog-store.ts:8,35` imports **`createSqliteAdapter`** (`@adhd/sox-store-adapter`), but RAG-SPEC §0 + DISPATCH.md F-01 mandate **`createStoreAdapter({ dbPath })` which defaults to `turso`** (`@tursodatabase/database@^0.7.1`, `TursoAdapterImpl`). Verified from published adapter 0.3.0: `createSqliteAdapter` → `SqliteAdapterImpl` wraps `better-sqlite3`; `createStoreAdapter` → env `STORE_ADAPTER` default `'turso'` → `TursoAdapterImpl`. `better-sqlite3` also still a direct dep in package.json. **Operator ruling (2026-08-08): "every iteration of this plan, we're going to turso — that's the whole point… if you're dispatching something that suggests otherwise that is wrong."** → **F-01 MUST be corrected to `createStoreAdapter({ dbPath })` (turso) before acceptance; `better-sqlite3` removed as runtime dep.** Impact if left: RAG-SPEC §0.3 vector substrate (`TursoVectorDialect`, `F32_BLOB(dim)`, DiskANN) fails → **G1-05 breaks at W1**; "never touches a raw SQLite handle" violated. Disposition: looped back to **F-01 (same order)**; not absorbed.

1. ~~**C-13 demo draft (2026-08-08):** demo agent wrote DEMO.md + README.md but the fixture file `docs/demo/backlog/fixtures/backlog-demo.md` and the `UNRESOLVED.md` ledger (both advertised in README, both load-bearing for the demo's import commands and implementer hand-off) are missing.~~ **RESOLVED** — agent completed all four files at 19:02 (after my 18:59 check); validator PASS. The 13 spec-level unknowns are logged in `docs/demo/backlog/UNRESOLVED.md` as the implementer's "confirm these first" list; none are resolved by design (spec ambiguities are surfaced, never decided).
2. **C-13 demo spec ambiguities surfaced (from UNRESOLVED.md, cite → confirm before W4's C-03/C-12):** AC-8 project traversal unpinned (U1); §7.2 exit-code table covers only 4 codes — `duplicate_candidate`/`dedupe_suppressed`/`validation`/`rag_not_configured` unmapped (U2, also C-08-relevant); GET / + /meta/openapi path spellings (U4/U5, C-11-relevant); view:summary field names (U6, C-02); view:ready parent inclusion (U7); create flag spellings (U8); weightFn CLI spelling (U9); soft-delete reachability split (U10); import fixture syntax (U12); store-path flag (U13); zero-vector-weight knob (U14). **AC-28's literal `--humanIds` is camelCase inside the §7.3 kebab convention — flagged for implementer, needs operator/spec-owner resolution.**
3. **Demo agent memory note:** memory-server MCP tools not exposed at its level ("unavailable tool") → one attempt, noted, proceeded from specs (BUG-MEMORY-013 protocol followed). No backlog items filed — the 13 unknowns live in UNRESOLVED.md; offer to file stands.

*(see also per-order notes above)*

## Open bugs / deferrals

- BUG-MEMORY-013 (memory-server empty results in subagent sessions) — filed HIGH elsewhere; mitigation: one attempt per lookup, then proceed from specs.
