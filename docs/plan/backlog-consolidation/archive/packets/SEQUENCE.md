# SEQUENCE — convergence pass over the four packet sets

**Role:** architect (review + sequencing). **Date:** 2026-09-22.
**Inputs read in full:** `1-live-deploy-ci.md` (LIVE-1..11), `2-embedding-semantic.md` (EMBED-1..16),
`3-registry-surface-data.md` (RSD-1..26), `4-store-criticals-waves.md` (STORE-1..16 + WAVE-1..3).
**Deliverable:** this file. Read-only on all code; no packet's scope was changed.
**After this pass, dispatchers execute without further design.**

---

## 0. How to read this

- **Wave** = an execution batch ordered by dependency + risk + value. Waves are ordered, but
  packets *within* a wave start together only when they are **file-disjoint**; §4 names the
  serialization lane per file.
- **Light vs heavy (machine constraint):** load is ~258 from other agents' suites. Heavy work —
  any `nx build`/`nx test`/`nx affected`, sox package build/publish, real-model runs, the
  packed-consumer harness, a live-store sweep — **serializes: at most one heavy task at a time.**
  Light work (graph transitions, doc edits, type-only edits, a spike) pipelines around it.
- **Gated** = an owner decision must clear before dispatch. All gates are consolidated in §6.

---

## 1. State verification (what this pass confirmed vs. took on faith)

**Confirmed by reading the worktree / main repo:**

| Claim | Verdict |
|---|---|
| Worktree `report/` lacks `registry-surface-redesign.md`, `citation-component-linking.md`, `deferral-cleanup-plan.md` | **Confirmed** — they live in main and must be moved onto the branch (Wave 0). |
| `src/write/embed-drain.ts` + `src/store/embed-drain.spec.ts` + `embed-drain-real-model.spec.ts` present | **Confirmed** — the in-flight vector-write durability fix is landed (spec header says "IMPLEMENTED, segments A–G"). |
| `src/write/embed-sweep.ts` (EMBED-1), `link-citations.ts` (RSD-6), `dedupe-scorers.ts` (EMBED-6), `src/store/health-record.ts` (EMBED-2), `store-meta.ts` (EMBED-4) | **Confirmed absent** — new files as the packets state. |
| `src/api.semantic-production-seam.spec.ts`, `src/cli.store-check.spec.ts`, `src/query/markdown.ts`, `src/test/helpers/`, `tools/etl/embed-backfill.ts`, `tools/gate/embedding-usage-gate.mjs` | **Confirmed present** — packet file anchors resolve. |
| `2039bb80` / `87799e1d` bodies | **Domain 2 read them in full**; LIVE-9's "absent from captures" is stale relative to Domain 2's live retrieval. |
| `src/store/semantic-readiness-probe.spec.ts` (cited by WAVE-2 `ebb6a733`) | **NOT FOUND** anywhere in the worktree — see Finding F1. |

**Taken on faith from the dispatch brief (not re-derivable read-only):** `main @ 29da1926`,
PR #9 MERGEABLE, live build = `.worktrees/restore-min`, production store 15.08% vectors missing
and growing, load ~258, `97c03dfd` / `6417df20` / `ce98c6c3` / `287c301e` newly filed.

---

## 2. Review findings

### 2.1 Duplicates — the authors' disjointness claims, verified

| Claim | Verdict |
|---|---|
| `ci.yml` mechanics in LIVE-6 vs WAVE-2 | **Not a duplicate — a file contention.** LIVE-6 owns `format:check`/affected-set/CPU-guard; WAVE-2 owns the *parity-check job* wiring. Both edit `.github/workflows/ci.yml`. → **Serialize LIVE-6 → WAVE-2** (Finding C1). |
| `2d88fba7` → EMBED-16; `e769bdc4` → EMBED-12 | **Disjoint, verified.** STORE-12 and WAVE-3 explicitly defer both. |
| `2039bb80`/`87799e1d` → LIVE-9 placeholder vs EMBED-2/4 | **Disjoint, verified.** LIVE-9 is a coordination stub; Domain 2 owns implementation. → **The LIVE-9 orchestrator gate is already answered** (Domain 2 owns) — collapse LIVE-9 to a pointer (Wave 0). |
| `9200ed9e`/`4a3caa9e` owned by Domain 3 (RSD-14/15) though Domain 1's brief lists them | **Confirmed disjoint** — no Domain-1 packet edits them. |
| `aede6810` (EISDIR) | **Covered by WAVE-1 (B1)**, not a gap. |
| STORE-3's embed-durability carve-out vs Domain 2's in-flight fix | **Correctly disjoint** — STORE-3 explicitly excludes `report/embed-durability-fix-spec.md`. |

### 2.2 Gaps — known work with **no packet**, and how each is closed

| # | Item | Gap | Closure |
|---|---|---|---|
| **G1** | `97c03dfd` — stalled server write path (debug root-cause in flight) | **No packet.** Live production issue; must be fixed before the re-cutover ships a stalled writer. | **New packet, Wave 1**, Domain 4 lane (store/write) — `debug` + `test`. If root cause is the embed drain blocking the writer, hand to Domain 2 and cross-link EMBED-1. **Must land before LIVE-1.** |
| **G2** | `6417df20` — dangling `admin` surface | **No packet.** The `admin` grab-bag is rejected by SPEC-v2 §6.6 / SPEC-REG §1 D4 but still exists. | **New packet, Wave 3**, Domain 3 (surface) — fold into **RSD-26** (surface compliance) or RSD-3's retraction set. `typescript`. |
| **G3** | `ce98c6c3` — dead `scheduleEmbed` → no provenance stamp | **No packet.** Sibling of EMBED-4's version/skill stamp and EMBED-1's audit. | **Fold into EMBED-4** (provenance/version stamp) or EMBED-1 — one owner, one `store-meta` edit. Wave 2. |
| **G4** | `287c301e` — no automatic backfill/heal | **No packet** (sibling of EMBED-1's `88b26235`). | **Fold into EMBED-1.** Wave 2. |
| **G5** | `53eb67a7` + `e9a094be` — production contamination cleanup (destructive, owner-gated) | **No packet.** Domain 3's seam note assigns it to Domain 1, but Domain 1 has no such packet. | **New packet, Wave 4**, Domain 1 — report-first, ADR-0014 `--apply`, owner-gated. `backend`. |
| **G6** | `e46b7ca0` — hybrid-search optional loadability (deferral-plan L3, blocked on D1 ADR) | **No packet in any file.** | **New packet**, cross-repo (sox) + a **new ADR** decision (D1). Wave 3; `backend`. |
| **G7** | `82468ca7` — config-isolation leak + root-fix decision D3 | **No packet.** | **New packet, Wave 1/4** — `59b08868` is **already merged** (PR #10 `17236a3a`, follow-up PR #12 `29da1926`); only the D3 root-fix decision remains (§6). `backend`. |
| **G8** | `f80bf841` — `apigen-java` target race (L5) | **No packet.** | **New small packet, Wave 3** (or fold into LIVE-11). `refactor`, LOW. |
| **G9** | `8b05358e` — `registry/index.json` checksum drift armed | **Partially covered** by LIVE-4 (`fa894329`) but the deploy-time registry sync is not named. | **Extend LIVE-4** scope to include the deploy-time registry sync. |
| **G10** | `1c9e40d5` + `06922862` — adapter fixes 5/6 | **Conflict, not gap:** deferral-plan L1 folds them into 0.10.0; **STORE-1's gate says keep them as follow-ups.** | **Resolve in §6 (STORE-1 gate).** |

### 2.3 Conflicts — file contention (cross-domain unless noted)

| # | File(s) | Contending packets | Resolution |
|---|---|---|---|
| **C1** | `.github/workflows/ci.yml` | LIVE-6 (D1) vs WAVE-2 (D4) | Serialize **LIVE-6 → WAVE-2**. |
| **C2** | `src/api.semantic-production-seam.spec.ts`, `src/store/embed-drain-real-model.spec.ts` | **EMBED-12 (D2) vs RSD-4 (D3)** | Serialize **RSD-4 → EMBED-12** (RSD-4's import rewrite first, then EMBED-12's seam assertion). |
| **C3** | `entrypoint/backlog/src/cli.ts` | EMBED-1/2/4/5 (D2) **and** RSD-3/15/16/17/25/26 (D3) | Single-writer file across two domains. Serialize all `cli.ts` edits into one lane: EMBED-5 → EMBED-1 → EMBED-2/4 → RSD-3 → RSD-16/17/26 → RSD-25. |
| **C4** | `entrypoint/backlog/src/api.ts` | EMBED-1/2 (D2) vs RSD-3/16/17/26 (D3) | Same lane as C3 (api.ts moves with cli.ts). |
| **C5** | `src/store/graph-backlog-store.ts` | EMBED-2/4 (D2) vs STORE-4 (D4) | Serialize **STORE-4 → EMBED-2/4** (STORE-4 is the call-site fix at `:58-61`). |
| **C6** | `src/write/create-issue.ts` | **WAVE-1 (D4), EMBED-6 (D2), RSD-7 (D3), RSD-20 (D3)** | 4-way cross-domain. **One lane:** WAVE-1 → EMBED-6 → RSD-20 → RSD-7 (RSD-7 is last; it depends on RSD-6). |
| **C7** | `src/write/catalog.ts` | WAVE-1 (D4, adds `isAbsentCitationTarget`) + RSD-1/5/10 (D3) | Serialize **WAVE-1 → RSD-5 → RSD-1 → RSD-10**. |
| **C8** | `entrypoint/backlog/project.json` | LIVE-5, LIVE-8, WAVE-2, RSD-9 | Serialize **LIVE-5 → RSD-9 → LIVE-8 → WAVE-2**. |
| **C9** | `entrypoint/backlog/package.json` | WAVE-1 (`8a09824c` pin), EMBED-13 (consumer re-point), LIVE-2 (publish) | Serialize WAVE-1 → EMBED-13 → LIVE-2. |
| **C10** | `tools/gate/embedding-usage-gate.mjs` | WAVE-2 vs EMBED-12 | Serialize WAVE-2 → EMBED-12 (or vice-versa; one owner). |
| **C11** | `tools/nx-plugins/build/**` | LIVE-3, LIVE-4, LIVE-11 | Stated by the author: **3 → 4 → 11**. Confirmed no other packet touches it. |
| **C12** | `src/query/types.ts` | RSD-2, RSD-8, RSD-14 | Stated: **RSD-2 → RSD-8 → RSD-14**. |
| **C13** | **14-verb pin** | RSD-16 (`restore`) + RSD-17 (`hard_delete`) vs RSD-3's frozen `BACKLOG_VERBS` (14) | **Design tension, not a file.** Must resolve **before RSD-3 freezes the surface** — §6 gate. Recommendation: both as admin actions (surface stays 14). |
| **C14** | `1c9e40d5`/`06922862` scope | deferral-plan L1 vs STORE-1 gate | Resolve in §6. |

### 2.4 Feasibility

- **Every packet names an executor + tier** except **LIVE-9** (TBD/debug — a placeholder, not a
  packet). ✔
- **Cross-repo (sox-ecosystem) packets need the sox owner's dispatch** — these cannot start on
  the adhd dispatch alone:
  - Domain 1: LIVE-4 (partly — `ddaf7a82`, `fa894329`), LIVE-10 (`524c4bef`, `cc03366b`).
  - Domain 2: EMBED-3, 7, 8, 9, 10, 11, 13, 14, 15, 16.
  - Domain 4: STORE-1..12, 15, 16.
  - Gap packets G5 (sox pin), G6 (sox hybrid-search).
- **Heavy-work serialization is the binding constraint** (load ~258). The wave plan in §3 assumes
  one heavy task at a time and pipelines light work.
- **The single hardest gate is human approval to merge PR #9 / publish `@adhd/backlog`** — it
  blocks the entire deploy chain (Wave 4). Code waves proceed independently.

---

## 3. Wave plan

### Wave 0 — Preflight & hygiene (no code; light; parallel)

| Item | Action |
|---|---|
| Move the three source specs onto the branch | `registry-surface-redesign.md`, `citation-component-linking.md`, `deferral-cleanup-plan.md` — absent from `.worktrees/backlog-v2/report/`; Domain 3 cannot dispatch without them. |
| Retrieve title-only item bodies | Every `title-only` uid (STORE-4/5/6/11/14/16 lists; WAVE-1/2 lists) must be read live before its packet. |
| Graph transitions (one hygiene pass, one owner) | RSD dispositions table (7 items) **+** WAVE-3 §6 close list (10 items) — do **not** split across two agents. |
| Gate-hygiene reds | WAVE-2's `cd34ba0d` (comment reword) + `ebb6a733` (locate the **real** undeclared spec — see F1). Small; unblock `nx test backlog`. |
| LIVE-9 | Collapse to a pointer; the orchestrator gate is pre-answered (Domain 2 owns). |
| **G6 precondition** | Draft the hybrid-search ADR (D1) so L3 is not blocked later. |

**Parallel:** all. **Heavy:** none. **Gates:** none. **Critical path:** none.

### Wave 1 — Correctness / data-integrity (stop the loss)

Two heavy lanes, serialized at the machine level; light coordination in between.

- **Lane 1A — sox store/adapter (cross-repo, heavy, serial):** **STORE-1** → STORE-2 → STORE-3 →
  STORE-4 → {STORE-5, STORE-6, STORE-7, STORE-8, STORE-9, STORE-10, STORE-11, STORE-12 pipeline
  after STORE-1}. **STORE-13** is independent (unblocks STORE-15/16) — run it first inside this
  lane to clear the memory-core reds.
- **Lane 1B — adhd write path:** **G1 (`97c03dfd`, new)** → **WAVE-1** → **EMBED-5** (`_adapter_meta`
  repair + `store-check` assertion). **G7** (root-fix only — `59b08868` already merged) rides here.
- **Lane 1C — in-flight durability:** verify/land the **embed-durability + dedupe over-match** fix
  (already implemented — spec §"IMPLEMENTED"); reconcile **G3 (`ce98c6c3`)** if not deferred to Wave 2.
- **Lane 1D — live store:** **STORE-14** after STORE-1/10/13 — backup-first, owner-gated.

**Parallel (light):** body retrieval, the `_adapter_meta` inspection before EMBED-5's repair.
**Serialized (heavy):** every sox build/test, every `nx build backlog`/`nx test`, the live sweep.
**Gates:** STORE-1 (sox 0.10.0 publish), STORE-2/3/4 (sox design), STORE-11 (sox pin), STORE-14
(live repair), EMBED-5 (live repair).
**Critical path:** `STORE-1 publish → adapter pin bump` and `G1 (write-path stall) → LIVE-1`.
**Do not ship LIVE-1 before G1 lands.**

### Wave 2 — Embedding truth

- **adhd (D2):** **EMBED-1** (+ **G4 `287c301e`**) — *the* fix for the 15.08% loss — then EMBED-2 →
  EMBED-4 (+ **G3 `ce98c6c3`**); EMBED-6; EMBED-12 (after RSD-4, C2).
- **sox (D2):** EMBED-3 (coverage probe) → feeds EMBED-2; EMBED-7, 8, 9, 10, 11, 13, 14, 15, 16.

**Parallel (light):** EMBED-6 (`create-issue.ts` lane — C6), EMBED-12 (spec-only).
**Serialized (heavy):** real-model specs (EMBED-11/12), sox provider tests, EMBED-3's coverage scan.
**Gates:** EMBED-1 (auto-sweep), EMBED-2 (table vs node), EMBED-3 (age threshold), EMBED-7 (lock
path), EMBED-15 (threshold).
**Critical path:** `EMBED-3 → EMBED-2 → EMBED-4`; `EMBED-1` is the highest-value item — pull it
forward if Wave 1's `create-issue.ts`/`cli.ts` lanes are free (note C3: EMBED-1 and EMBED-5 both
edit `cli.ts` — serialize EMBED-5 → EMBED-1).

### Wave 3 — Surface / feature

- **Registry (D3):** RSD-2 → RSD-3 → RSD-4 → RSD-25. (Gate Q1 blocks RSD-2.)
- **Linking (D3):** RSD-5 → RSD-6 → {RSD-7, RSD-8, RSD-10}; RSD-9 only after RSD-11 **and** RSD-12.
- **Registry-data (D3):** RSD-11 → RSD-12 → RSD-9; RSD-13 (after RSD-1/RSD-3); RSD-14 (after RSD-8).
- **Surface (D3):** RSD-1, RSD-16, RSD-17 (after the 14-verb decision, C13), RSD-18, RSD-19, RSD-20,
  RSD-21, RSD-22, RSD-23, RSD-24, RSD-26 (+ **G2 `6417df20`**).
- **Corpus-hygiene (D3):** RSD-14 (case-splits `9200ed9e`), RSD-15 (control-char JSON `4a3caa9e`).
- **Deploy-adjacent adhd (D1):** LIVE-3, LIVE-5, LIVE-6, LIVE-7, LIVE-8; WAVE-2; **G8** (`f80bf841`).
- **G6** (hybrid-search, sox) after the ADR.

**Parallel (light):** type-only RSD-2, doc packets (RSD-25), RSD-15 spike, graph transitions.
**Serialized (heavy):** `nx run backlog:test` after each surface change; LIVE-7's packed-consumer
harness; WAVE-2's jscpd + parity gates (activate jscpd **after** the removal pass).
**Gates:** SPEC-REG Q1–Q8, SPEC-LINK Q1–Q6, OWNER ×11, LIVE-6 (a/b/c), C13 (14-verb).
**Critical path:** `Q1 → RSD-2 → RSD-3 → RSD-4/25`; `RSD-5 → RSD-6 → RSD-7/8/10`;
`RSD-11 → RSD-12 → RSD-9`; **C13 must clear before RSD-3 freezes the surface.**

### Wave 4 — Deploy / cutover & close-out

- **LIVE-1** (re-cutover) → **LIVE-2** (de-worktree) → **LIVE-10** (post-cutover config);
  **LIVE-11** (pre-commit hygiene); **LIVE-4** (publish gate) if not already landed.
- **G5** — contamination cleanup (`53eb67a7`, `e9a094be`), owner-gated.
- **STORE-14** final re-verify; **WAVE-3** orchestration runs across *all* waves as the top-level
  sequencer.

**Gates:** **human** PR #9 merge + publish; **human** global bin/MCP edits; D4/D5.
**Critical path:** `Wave1+2+3 committed → LIVE-1 → LIVE-2 → LIVE-10`.

---

## 4. Immediately startable (unblocked, ungated)

**Truly conflict-free (no shared file with any other starter):**

1. **LIVE-5** — exec-bit + assets cache (adhd tooling; no deps; no gate).
2. **STORE-13** — memory-core async debt (sox; no deps; no gate — *pending sox owner dispatch*).
3. **RSD-15** — CLI envelope strict-JSON (adhd; no deps; no gate; **spike-first**).

**Startable now, but serialize on a contended file (pick the lane order in §2.3):**

4. **WAVE-1** — backlog source-fix wave — first claim on `create-issue.ts`/`catalog.ts` (C6/C7).
5. **EMBED-6** — dedupe scorer seam — after WAVE-1 on `create-issue.ts` (C6).
6. **EMBED-1** (+ G4) — the loss-stopping backfill — after EMBED-5 on `cli.ts` (C3); owner gate is
   a one-line confirm (auto-sweep).
7. **RSD-5** — `implicates` edge row — one-line Q6 confirm; then claims `catalog.ts` (C7).
8. **RSD-20** — near-dup counter — after WAVE-1/EMBED-6 on `create-issue.ts` (C6).
9. **LIVE-6 `81de39f7` sub-item** — CI affected-set fix — the rest of LIVE-6 is gated (a/b/c).
10. **G1 (`97c03dfd`)** — the stalled write path — start the debug now; it gates LIVE-1.

Everything else waits on a dependency (RSD-9 on RSD-11/12; EMBED-2/4 on EMBED-3/2), a gate (§6),
or the sox owner's dispatch.

---

## 5. Owner-decision consolidation (clear in one pass)

| # | Packet(s) | Question | Author rec | Blast radius if deferred |
|---|---|---|---|---|
| D1 | LIVE-1 | Approve PR #9 merge + `@adhd/backlog` publish | merge then deploy as one window | **Whole deploy chain blocked**; live stays on the `restore-min` hand-port |
| D2 | LIVE-2 | Approve machine-global bin/MCP edits | quarantine (rename) bare `backlog`; keep last N releases | Live consumers keep resolving into a worktree |
| D3 | LIVE-6 | `.prettierrc`: `printWidth:100` + ignore generated | both | CI stays red; format step masks affected tests |
| D4 | LIVE-6 | CUDA: provision CPU EP vs disable | **provision, do not disable** (AGENTS §7) | Real-model tests silently gated — a policy violation |
| D5 | LIVE-6 | DeepSource red | fix the `return`s at source | Analyzer gate stays red |
| D6 | LIVE-9 | Assign one owner for `2039bb80`+`87799e1d` | Domain 2 owns | **Already answered** — collapse LIVE-9 |
| D7 | LIVE-10 | Keep `migration.phase` removed? | remove; restore as no-op only if proven | Stale config consumers may break post-cutover |
| D8 | EMBED-1 | Auto-sweep on enable vs report-only | **auto-sweep**, bounded/resumable/audited | 15.08% (growing) stays unvectorized; semantic search ranks a subset |
| D9 | EMBED-2 | Health record: table vs node-kind | dedicated `_backlog_health` table | Health verdict stays historyless/on-demand |
| D10 | EMBED-3 | Coverage-probe age threshold N | N ≈ 10 min, typed constant | Integrity reports `ok` while ~34% unsearchable |
| D11 | EMBED-5 | Run `_adapter_meta` repair on **live** store | yes — bounded, reported, after backup | Duplicate rows survive; `store-check` can't detect |
| D12 | EMBED-7 | Lock path home + last-writer ambiguity scope | data-root path + service label now; file registry lock separately | 792 competing-host events, no service identity |
| D13 | EMBED-15 | Cluster threshold value | **0.65** (measured) | Zero clusters at 0.82 |
| D14 | RSD-2/3/4/25 | SPEC-REG **Q1**: Option A (14 verbs) vs B (~18) | **A** | Blocks RSD-2 → the whole registry wave |
| D15 | RSD-3 | Q2: one generic `registry-upsert` vs three | one generic | — |
| D16 | RSD-1 | Q3: refuse-if-referenced vs `cascade:true` | refuse | — |
| D17 | RSD-1 | Q4: `(root)` never deletable | yes, never | — |
| D18 | RSD-3 | Q5: replace `get --registry`/`query --view` | replace | — |
| D19 | RSD-3 | Q6: `lookup` stays top-level | stays | — |
| D20 | RSD-3 | Q7: hard cut vs one-release alias | hard cut | — |
| D21 | RSD-8 | SPEC-LINK Q1: add `implicatesComponent` vs extend `filter.component` | add | — |
| D22 | RSD-6 | SPEC-LINK Q2: bounded auto-discovery | bounded | — |
| D23 | RSD-6 | SPEC-LINK Q3: human upsert merges + clears `metadata.discovered` | yes | — |
| D24 | RSD-10 | SPEC-LINK Q4: refuse vs cascade-invalidate on delete | refuse | — |
| D25 | RSD-9 | SPEC-LINK Q5: path-less project fails vs warns | fail | — |
| D26 | RSD-5 | SPEC-LINK Q6: `implicates` direction | issue→component | — |
| D27 | **C13** | RSD-16/17: `restore`/`hard_delete` as verbs (15) or admin actions (14) | admin actions (stay 14) | **Must clear before RSD-3 freezes the surface** |
| D28 | RSD-11 | Schema shape (normalize-on-write + alias) + destructive reconciliation approval | normalize + alias now; report-first | Repo fork persists; RSD-9 fragments |
| D29 | RSD-12 | Path-derivation source + reconciliation approval | derive from workspace/git; escalate unresolvable | RSD-9 is a no-op |
| D30 | RSD-13 | Approve destructive orphan cleanup | yes, report-first | 26 orphan components persist |
| D31 | RSD-14 | Normalize data, filters, or both | both | Case-split corpus persists |
| D32 | RSD-16 | `restore` as verb vs admin action | admin action (see D27) | — |
| D33 | RSD-17 | Hard-delete admin-only vs default | admin-only | — |
| D34 | RSD-18 | Gate new-repo writes (with opt-in) vs scratch-only | gate + document scratch | Production pollution continues |
| D35 | RSD-19 | Reporter/author required-for-all vs new-writes-only + backfill sentinel | both required on new writes; `legacy-import` sentinel | Breaking change for ~239 open items |
| D36 | RSD-21 | Is hierarchical rollup in this wave? | defer; split into 3 at dispatch | — |
| D37 | RSD-23 | Plugin system now vs defer | defer until an external consumer exists | — |
| D38 | RSD-24 | Snapshotting in this wave + generalize beyond backlog | backlog-local first | — |
| D39 | RSD-26 | Retire `APIGEN_IR_CACHE_ENABLED` now | yes | ADR-0013 deviation persists |
| D40 | STORE-1 | Approve 0.10.0 minor + changeset; **scope of `1c9e40d5`/`06922862` (C14)** | ship as specified; **fold `1c9e40d5`, split `06922862` to 0.10.1** | Adapter durability stays unfixed; backlog pin bump blocked |
| D41 | STORE-2 | Quiescence-lock primitive | reuse `store-lease` claim machinery | 5/5 child-open failure persists |
| D42 | STORE-3 | id/count invariant: adapter vs memory-core level | detect in adapter, enforce in consumer | Silent write loss possible |
| D43 | STORE-4 | Migration playbook location | `store-adapter/README` + linked playbook | — |
| D44 | STORE-11 | Pin `@tursodatabase/database` exact (coordinate LIVE-10) | coordinate the pin | Future resolve can break `memory_update` |
| D45 | STORE-14 | Authorise live-store repair | backup + read-only sweep now; repair only on approval | Live damage un-named |
| D46 | STORE-15 | Enable `snapshot-gc --apply` | yes once restore is proven for the full set | 1.4 GB keeps growing |
| D47 | WAVE-3 | D1–D5 of the deferral plan + human PR #9/publish | per plan §5/§9 | Program-level sequencing blocked |

**Gate count: 47 consolidated rows** (from 41 gated packets; Q1/Q6 deduped across packets,
C13 and C14 added). Domain tallies: LIVE 5 · EMBED 6 · RSD 22 · STORE 8 — matches the authors.

---

## 6. Back to the packet authors

| # | To | Finding |
|---|---|---|
| **F1** | Domain 4 (WAVE-2) | `src/store/semantic-readiness-probe.spec.ts` (`ebb6a733`) **does not exist** in the worktree. The undeclared-spec target is misnamed; the real candidates are `src/query/query.ready.spec.ts` and `src/write/bootstrap.spec.ts` (which carries the readiness-probe assertion at `:194-199`). Locate the actual gate-undeclared spec before dispatch. |
| **F2** | Domain 1 (LIVE-9) | The two items ARE retrievable live (Domain 2 read them). LIVE-9's "absent from the scan captures" is stale — collapse it to a pointer, don't re-author. |
| **F3** | Domain 3 | `report/registry-surface-redesign.md` + `citation-component-linking.md` are **absent from the worktree**; they must be moved onto the branch before RSD dispatch (Wave 0). |
| **F4** | Domain 4 (STORE-1) vs deferral-plan L1 | Scope conflict on `1c9e40d5`/`06922862` (C14/G10) — resolve via D40 before the 0.10.0 changeset is cut. |
| **F5** | Domain 1 | G5 (contamination cleanup) is assigned to Domain 1 by Domain 3's seam note but has **no packet**; file it before Wave 4. |

---

*No code was written or modified by this pass. The `.worktrees/backlog-v2` tree was read-only
throughout. Findings F1 and F3 were verified by directory listing; all other findings are derived
from the four packet documents and the two source specs read in full.*
