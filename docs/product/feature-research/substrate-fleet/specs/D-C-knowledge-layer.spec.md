# D-C — Knowledge layer (substrate layer)

> **Plane:** substrate. Repos: **`sox-ecosystem`** (`libs/memory-core`, `libs/data/graph/graph-store`,
> the `sox-memory-bundle` host) and the **researcher** extension (`sox-ecosystem/extensions/agents/
> researcher`, `claude-agents/categories/10-research-analysis`). Ticket `c35319fa-225e-4677-a939-8c2e849e29cb`.
> Consumes **SR-1..SR-4, SR-5, SR-7, SR-9** and **SR-3/SR-4/SR-6/SR-8**; implements SR-5, SR-7, SR-9.
>
> **Governing ADRs (sox):** ADR-0010 (open `node.kind`/`edge.rel` typing; D3 requires an
> **operator-invoked offline migration** before a live store accepts new kinds/rels) is **accepted and
> binding** — it is the extension point for `REFUTES` and for the facet registry, and it is a
> **dependency**, not a free pass. ADR-0012 (multi-process write invariant; supersedes ADR-0007) is
> **accepted and binding** — claim-upsert correctness comes from an atomic store primitive, never a lock.
> ADR-0013 (no env-var feature toggles; thresholds are typed config) is **accepted and binding** — every
> threshold below is a typed field. ADR-0014 (retention) is **PROPOSED/design-only** and does not touch
> this layer. The `docs/plan/case-library-storage-model/case-library-storage-spec.md` storage model is
> **plan material with no durable home** — §6 proposes the ADR that fixes that (propose, do not write).

## DoR

- **Owner repo:** `sox-ecosystem` (`libs/memory-core`, `libs/data/graph/graph-store`) + the researcher extension. · **Wave:** 4 (substrate) — assigned here; the pass-2 design left it unstated. · **Dependencies:** **blocked by sox SR-7 (`memory_claim_upsert`) and SR-9 (observable `recluster`)** — both substrate-side; the adhd plane cannot close them (adhd ADR-0002 D4). The `REFUTES` relation additionally depends on the **ADR-0010 D3 operator-invoked offline migration** before a live store will accept it. · **Evidence requirement:** default-running tests for the claim/outcome split, the tiered verdict, facet promotion plus the term-stability refusal, and coverage abstention — each with its negative control; concurrency proven with two real processes or latches, never sleeps.

## Summary
Split the knowledge record into an **immutable claim** (native `claim` node kind, already in
`MEMORY_NODE_KINDS`) and **append-only outcomes** (each a new `episode` node with a `meta.outcome`
envelope, `DERIVED_FROM` the claim — no new node kind, so **no ADR-0010 D3 migration is required** for
the split). The verdict is **derived on read** and **tiered** — `unverified | self-reproduced |
independently-reproduced | replicated | stale | refuted | unknown` — never one boolean. Facets are an
**open, orthogonal vocabulary**: terms are minted unpromoted, promoted by a governed demand gate, and a
term is **never redefined — a new id is minted** (ADR-0010 open typing + a typed registry). Retrieval is
**coverage-aware**: it carries an obligation to report absence and **abstains + logs the gap** rather
than returning the nearest held row. A `memory_back` read exposes a finding as decision-backing with the
citation contract. The storage-model spec gets a real home as a **proposed sox ADR-0023**.

## Grounding (read this session)
`libs/memory-core/src/ontology.ts:4` (`MEMORY_NODE_KINDS` includes `claim`; `MemoryOntologyPolicy`
accepts an `OntologyExtension` at `:27-30`), `:7-10` (`MEMORY_EDGE_RELS` — no `REFUTES`);
`libs/memory-core/src/write.ts:549` (`memoryWrite`), `:680-699` (`memoryWriteBatch` — the SR-8
silent-drop surface), `:576-618` (`memoryInvalidate`); `libs/memory-core/src/update.ts:76-115`
(`UpdateParams`), `:351` (`memoryUpdate`); `libs/memory-core/src/recall.ts:467-497` (`RecallResult`
carries `score_breakdown {vec,bm25,temporal,total}` — SR-4 partially met; no `_semantic_score`/
`_bm25_score` field names, no fusion method/range), `:670` (`memoryRecall`); `libs/memory-core/src/
memory-filters.ts:17-40` (`MemoryFilter` — no `metadata` predicate; SR-3 gap), `:53`
(`buildFiltersClause`); `libs/memory-core/src/curate.ts:238-309` (`memoryCurate`; `case 'recluster'`
`:261` → global path enqueues, SR-9 gap); `libs/memory-core/src/config.ts:21-140` (`BackupConfig`,
`EnrichHealthConfig` — the typed-config precedent); `libs/data/graph/graph-store/src/index.ts:560-571`
(`EdgeRel` union — no `REFUTES`), `:818` (`writeNode` — no expected-revision arg; no per-node CAS).
`extensions/agents/researcher/agent.md:290-303` (hardcoded Tools/Patterns/Use-Cases);
`docs/plan/case-library-storage-model/case-library-storage-spec.md` (the un-homed storage model).

## Ordering guarantees (invariants — each has a test)
1. **K-I1 — claim immutable.** A claim's `content`/`meta.claim`/`meta.expectation` are frozen at first
   write. The only mutation permitted against a claim is attaching an outcome (a *new* node). A direct
   `memory_update` that would change a frozen claim field is refused with a typed error.
2. **K-I2 — outcomes are append-only.** Every `memory_outcome_append` mints a **new** node; an existing
   outcome is never rewritten. Re-recording appends.
3. **K-I3 — verdict is derived, never stored.** The tier is computed on read from the outcome set +
   `REFUTES` edges + the claim's `revision`; it is not a field and cannot drift.
4. **K-I4 — tiered, never boolean.** Two records differing only in independence level must yield
   different tiers (SR-... AC5). A single `verified` boolean is a refuted design (DESIGN.md §3).
5. **K-I5 — term stability.** A facet term's `definitionHash` is immutable once minted. A semantic
   change is a **new term id**; an in-place redefine is refused with `E_TERM_REDEFINED`.
6. **K-I6 — abstain on no coverage.** A query whose candidate set shows no coverage abstains and logs
   the gap; it never returns the nearest held row as an answer.
7. **K-I7 — correctness is the store primitive, not a lock.** `memory_claim_upsert` is atomic via a
   documented CAS; a concurrent non-cooperative writer cannot produce two claims (ADR-0012).
8. **K-I8 — success implies persistence.** Every batch/knowledge write reads back each supplied
   structured field before returning success (SR-8).

## Files
| Repo | Path | Change |
|---|---|---|
| sox-ecosystem | `libs/data/graph/graph-store/src/index.ts` | modify (`REFUTES` rel; per-node CAS primitive) |
| sox-ecosystem | `libs/memory-core/src/ontology.ts` | modify (register `REFUTES`; facet registry rel) |
| sox-ecosystem | `libs/memory-core/src/knowledge.ts` | create (claim/outcome/verdict types + derive) |
| sox-ecosystem | `libs/memory-core/src/claim.ts` | create (`memoryClaimUpsert` — SR-7) |
| sox-ecosystem | `libs/memory-core/src/outcome.ts` | create (`memoryOutcomeAppend`) |
| sox-ecosystem | `libs/memory-core/src/facets.ts` | create (open vocabulary + promotion gate) |
| sox-ecosystem | `libs/memory-core/src/coverage.ts` | create (abstention signals) |
| sox-ecosystem | `libs/memory-core/src/write.ts` | modify (freeze claim; SR-8 verify-after-write) |
| sox-ecosystem | `libs/memory-core/src/update.ts` | modify (refuse frozen-claim mutation) |
| sox-ecosystem | `libs/memory-core/src/memory-filters.ts` | modify (metadata predicate — SR-3) |
| sox-ecosystem | `libs/memory-core/src/recall.ts` | modify (coverage envelope; count — SR-3/SR-4) |
| sox-ecosystem | `libs/memory-core/src/config.ts` | modify (`KnowledgeConfig` typed) |
| sox-ecosystem | `libs/memory-core/src/stats.ts` | modify (report resolved knowledge config) |
| sox-ecosystem | `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` | modify (new tools) |
| sox-ecosystem | `extensions/agents/researcher/agent.md` | modify (open facets, no mandatory package schema) |
| claude-agents | `categories/10-research-analysis/researcher.md` | modify (mirror) |
| sox-ecosystem | `docs/decisions/0023-knowledge-record-storage-model.md` | create (**PROPOSED — propose only**) |

## Interface / type changes

### New: `libs/memory-core/src/knowledge.ts`
```ts
export type VerdictTier =
  | 'unverified' | 'self-reproduced' | 'independently-reproduced'
  | 'replicated' | 'stale' | 'refuted' | 'unknown';

export type Independence = 'self' | 'independent';   // recorded on each outcome

/** The immutable half. Frozen at first write (K-I1). */
export interface ClaimView {
  uid: string; text: string; facet: string; project_path: string;
  expectation: { expected_outcome: string; confidence: 'low'|'medium'|'high' };
  revision: number; t_created: string;
}

/** One append-only outcome. Never rewritten (K-I2). */
export interface OutcomeView {
  uid: string; claim_uid: string; observed_result: string; observed_by: string;
  method: string; observed_at: string; independence: Independence;
  attestation_revision: number;          // the claim revision this outcome speaks to
}

/** Derived on read, never stored (K-I3). Precedence: refuted > stale > replicated >
 *  independently-reproduced > self-reproduced > unverified > unknown. */
export function deriveVerdict(claim: ClaimView, outcomes: OutcomeView[],
  opts: { refutedBy: string[]; currentRevision: number }): { tier: VerdictTier; basis: string[] };

export interface BackResult { claim: ClaimView; outcomes: OutcomeView[]; verdict: { tier: VerdictTier; basis: string[] };
  citations: Array<{ file?: string; uid?: string; context?: string }>; coverage?: CoverageEnvelope; }
```

### `libs/data/graph/graph-store/src/index.ts`
```ts
// BEFORE
export type EdgeRel = 'MENTIONS'|'SUPPORTS'|'RELATES_TO'|'DERIVED_FROM'|'SUPERSEDES'
  |'SAME_AS'|'ASSIGNED_TO'|'MEMBER_OF'|'PART_OF'|'DEPENDS_ON'|(string & {});
export function writeNode(content: string, meta: NodeMeta, opts?: WriteNodeOpts): ...;   // no CAS

// AFTER
export type EdgeRel = /* … as above … */ | 'REFUTES' | (string & {});   // SR-5; widening is
// source-breaking for exhaustive switches (ADR-0010 §Consequences) — release as a minor 0.x bump
// with the break named in the release note. REFUTES requires the ADR-0010 D3 open-schema migration
// on an existing store before it is writable (see Migration).
/** Documented per-node CAS (SR-6): succeeds iff the live node's revision equals expectedRevision. */
export interface CasResult { ok: boolean; currentRevision: number; }
export function compareAndSwapRevision(uid: string, expectedRevision: number): CasResult;
```

### New: `libs/memory-core/src/claim.ts` (SR-7)
```ts
/** Claim a node for `caller`, or update it if already held by `caller`, atomically (K-I7).
 *  Correctness is compareAndSwapRevision; no advisory lock may carry it. */
export async function memoryClaimUpsert(adapter: StoreAdapter,
  params: { uid: string; caller: string; expectedRevision: number; patch?: Partial<...> }
): Promise<{ ok: true; revision: number } | { ok: false; code: 'E_CLAIM_HELD'|'E_REVISION_CONFLICT'; currentRevision?: number }>;
```

### New: `libs/memory-core/src/outcome.ts`
```ts
export interface OutcomeAppendParams { claim_uid: string; observed_result: string; observed_by: string;
  method: string; observed_at?: string; independence: Independence;
  client_request_id?: string; }   // idempotency key
/** Mints a NEW episode node carrying meta.outcome, DERIVED_FROM claim; never a memory_update (K-I2). */
export async function memoryOutcomeAppend(adapter: StoreAdapter, params: OutcomeAppendParams): Promise<OutcomeView>;
```

### New: `libs/memory-core/src/facets.ts`
```ts
export interface FacetTerm { id: string; facet: string; term: string; definitionHash: string;
  status: 'unpromoted'|'promoted'; origin: string; demand: { count: number; distinctClaims: number } }
/** Admit: new → unpromoted; existing id with a DIFFERENT definitionHash → throw E_TERM_REDEFINED (K-I5). */
export async function memoryFacetAdmit(adapter, p: { facet: string; term: string; definition: string; origin: string })
  : Promise<FacetTerm>;
/** Promotion gate: demand ≥ config.facetPromotion.minDistinctClaims AND a non-empty origin tag. */
export async function memoryFacetPromote(adapter, p: { term_id: string }): Promise<FacetTerm>;
```

### New: `libs/memory-core/src/coverage.ts`
```ts
export interface CoverageEnvelope {
  abstained: boolean;
  reason?: 'no-coverage' | 'flat-distribution' | 'high-entropy' | 'fast-decay';
  signals: { max_similarity: number; distribution_flatness: number; topk_entropy: number; decay_rate: number };
  threshold_source: string;   // names the typed config field that decided it (ADR-0013)
}
/** Pure over the candidate set; abstains when nothing is in scope (K-I6). */
export function assessCoverage(candidates: RecallResult[], cfg: KnowledgeConfig): CoverageEnvelope;
```

### `libs/memory-core/src/config.ts` (typed, default-explicit, reported — ADR-0013)
```ts
export interface KnowledgeConfig {
  coverage: { minMaxSimilarity: number; maxFlatness: number; maxEntropy: number; maxDecay: number };
  facetPromotion: { minDistinctClaims: number };
}
export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig;   // every field has a documented default
```
`memory_stats` reports the resolved `KnowledgeConfig` so the active policy is visible in one call
(ADR-0013 D2). No env-var toggle for any of it.

### `libs/memory-core/src/memory-filters.ts` / `recall.ts` (SR-3, SR-4)
```ts
// BEFORE  MemoryFilter: project_path, topic, tags, tags_match_all, importance_min,
//         t_created_after, t_created_before
// AFTER   + metadata?: { path: string; in?: unknown[]; eq?: unknown };   // meta.* predicate (SR-3)
// recall gains: count?: { value: number; exactness: 'eq'|'gte' };        // SR-3
//         + coverage: CoverageEnvelope;                                  // K-I6
//         + score_breakdown gains fusion_method + per-channel range      // SR-4
```

### `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` (new tools)
`memory_claim_upsert`, `memory_outcome_append`, `memory_back`, `memory_facet_admit`, `memory_facet_promote`;
`memory_recall`/`memory_update` extended. **SR-8 verify-after-write** on `memory_write_batch` and every
new write.

## Behavioral changes
- **`write.ts` `memoryWriteBatch` (:680):** after each item lands, read back `topic`/`tags`/
  `importance`/`summary` and **fail the item naming the absent field** (SR-8); a success envelope is
  never emitted over a partial record.
- **`update.ts` `memoryUpdate` (:351):** before mutating, if the node is a claim whose frozen fields
  would change (K-I1), throw `E_CLAIM_IMMUTABLE`. `metadata_merge` on a claim's `meta.outcome` is
  refused — outcomes are not mutable metadata.
- **`recall.ts` `memoryRecall` (:670):** compute `assessCoverage`; when abstaining, return
  `results: []`, `abstained: true`, `coverage.reason`, and **log a gap** (a topic-`coverage-gap`
  episode + a telemetry event). Never silently return the nearest row.
- **`ontology.ts`:** `REFUTES` and the facet rel registered through `MemoryOntologyPolicy`'s
  `OntologyExtension`; on an existing store the SQL CHECK still rejects them until the ADR-0010 D3
  migration runs — `translateStoreVocabularyError` (:61) already converts that to a named error; the
  migration is a **prerequisite** for writing `REFUTES` on the live store.
- **`curate.ts` `recluster` (:261):** the global pass returns an observable job handle (`{job_id,
  status: 'pending'|'completed'|'failed', partition?}`) and the caller can poll/await — "enqueued" is
  never the final answer (SR-9). The filtered subset path stays synchronous.
- **researcher (`agent.md:290-303`):** the fixed Tools/Patterns/Use-Cases buckets are replaced by the
  open facet vocabulary; a non-tool finding (process/technique/evidence) is recordable with **no
  mandatory package schema**; findings are emitted as cited records through the new ops.

## Migration
1. **Field-level only, no node-kind migration for the split.** Claim = native `claim` kind; outcome =
   `episode` + `meta.outcome`. Existing `claim` nodes without `meta.expectation` derive `unverified`.
2. **`REFUTES` + facet rel** need the **ADR-0010 D3** operator-invoked offline migration (PKT-61) on
   any existing store before they are writable; fresh stores get them from new DDL. Ship the rel behind a
   capability check that reports `unknown` rather than a wrong verdict when the store lacks it.
3. **CAS (SR-6)** is additive (`compareAndSwapRevision`); `memory_claim_upsert` degrades to
   `E_CLAIM_HELD`-on-conflict until it lands.
4. **Coverage abstention** ships with a **permissive** default (abstains only on the clearest
   no-coverage case) and a reported `threshold_source`, then is tuned against a labeled query set — never
   via an env var (ADR-0013). The tunability is a typed config field, logged.
5. **Storage-model durable home:** the `case-library-storage-model` plan gets an owner-gated
   **sox ADR-0023** (next number after 0022). This spec **proposes** it; per the ADR revision loop it is
   **not written** until the owner approves. (Precedent for a proposed-only ADR: ADR-0014.)
6. **Rollback:** all new ops are additive; the immutable-claim and abstention changes are the two
   behavior changes, each behind a typed config default that preserves today's behavior until opted in.

## Acceptance criteria → test → negative control
| AC | Test (real entrypoint, real store) | Negative control (must go RED) |
|---|---|---|
| AC1 non-tool finding, no package schema | Record a process/technique finding via `memory_write` + `memory_facet_admit`; retrieve it. | Assert a package schema is mandatory (re-introduce the npm-package requirement) ⇒ the technique finding is refused → RED. |
| AC2 open facet, no code change | `memory_facet_admit` a new term; it appears in the readable catalog via `filters.metadata`. | Restore the frozen 3-bucket enum ⇒ the new term is refused → RED. |
| AC3 never redefine — mint new | `memory_facet_admit` an existing id with a changed definition ⇒ `E_TERM_REDEFINED`; the same definition under a new id succeeds. | Allow in-place redefine ⇒ the meaning change is accepted → RED. |
| AC4 outcome is a separate append | Attach two outcomes to one claim; assert two distinct outcome nodes, claim bytes unchanged, `deriveVerdict` sees both. | Implement outcome as a `memory_update` on the claim ⇒ claim bytes change / only one survives → RED. |
| AC5 tiered verdict | Two records, identical except outcome `independence`, yield `self-reproduced` vs `independently-reproduced`; two independent agreeing outcomes ⇒ `replicated`; a live `REFUTES` ⇒ `refuted`. | Collapse to one `verified` boolean ⇒ the two records become equal → RED. |
| AC6 abstain on no coverage | Fixture whose held rows are all out of scope ⇒ `abstained:true`, `results:[]`, a gap logged. | Retriever always returns the nearest held item ⇒ it returns a row → RED. |
| AC7 low-confidence revisitable | Assert the claim's `expectation.confidence` is recorded and low-confidence claims surface as first revisit candidates. | Drop the confidence field ⇒ the query cannot distinguish them → RED. |
| SR-7 one claim under race | Two **real OS processes** call `memory_claim_upsert` on one uid with a `SharedArrayBuffer` latch; exactly one wins, loser gets `E_CLAIM_HELD`/`E_REVISION_CONFLICT`; same caller re-claim idempotent. | Remove the CAS ⇒ both claims succeed → RED. |
| SR-8 batch field loss | `memory_write_batch` with `topic`/`tags`/`importance`/`summary` round-trips every field on a **fresh process**; an injected drop fails naming the field. | Keep the current silent-drop path ⇒ a dropped field returns `ok:true` → RED. |
| SR-9 observable recluster | Trigger a global `recluster`; poll the job handle to a terminal state with a partition. | Revert to `{enqueued:true}` ⇒ the handle never reaches a terminal state → RED. |
| SR-3 metadata predicate + count | `filters.metadata{path:'case.outcome.result', in:['success']}` returns only matching rows; `count` matches an independent recomputation and reports `gte` when capped. | Client-side join instead of store predicate ⇒ superseded rows leak / count is corpus-wide → RED. |
| ADR-0003 (not this layer) | — | — |

## Concurrency proof standard
SR-7 and the AC4 append race use **two real OS processes** with a `SharedArrayBuffer`/`Atomics.wait`
latch (or a file-signal barrier); assertions key on **process exit codes** and on a `memory_count`
before/after — never `sleep`. A non-cooperative writer that bypasses `memory_claim_upsert` must not
yield two live claims (K-I7).

## Blast radius
- **High:** `graph-store` `EdgeRel` widening is **source-breaking** for exhaustive `switch`es
  (ADR-0010 §Consequences) — every in-repo consumer of `EdgeRel` compiles against the new union; ship as
  one 0.x minor with the break named. `memoryUpdate` immutability (K-I1) is behavior-breaking for any
  caller that mutates a `claim` node. `memory_recall` envelope additions are additive.
- **Medium:** `memory_write_batch` SR-8 change (failing where it used to "succeed"); new tools in the
  bundle host; `filters.metadata`/`count` (SR-3) affect the read path used by C7's envelope work.
- **Low:** researcher doc/agent change; `KnowledgeConfig` (new typed surface); `stats.ts` reporting.
- **Cross-plane:** SR-1/SR-2 (registry kinds, node `revision`) are consumed by the work-item plane;
  this spec adds `REFUTES`/CAS to the substrate registries — the work-item `RECOGNIZED_NODE_KINDS` and
  `relate` enum are **unchanged** (SR-1: the new edges are written through the internal path only).

## Segment order (rough token estimates; each independently shippable)
1. **S1 — `knowledge.ts` types + `deriveVerdict` + unit tests.** ~4k read / ~5k write. Dependency: none.
2. **S2 — `graph-store` `REFUTES` + `compareAndSwapRevision`; `ontology.ts` registration.** ~14k read /
   ~6k write. Dependency: none; **blocks S3/S4** and needs the ADR-0010 D3 migration on live stores.
3. **S3 — `claim.ts` + `outcome.ts`; `write.ts` freeze + SR-8 verify-after-write; `update.ts`
   immutability.** ~12k read / ~7k write. Dependency: S1, S2.
4. **S4 — `facets.ts` + `memory-filters.ts` metadata predicate + `config.ts` `KnowledgeConfig`.**
   ~10k read / ~6k write. Dependency: S2 (for the facet rel) and S4's own filter work.
5. **S5 — `coverage.ts` + `recall.ts` envelope + `count` + `stats.ts` reporting.** ~12k read / ~6k write.
   Dependency: S4 (needs `KnowledgeConfig`).
6. **S6 — bundle host tool wiring + researcher doc/agent open-facet rewrite.** ~8k read / ~5k write.
   Dependency: S3–S5.
7. **S7 — propose sox ADR-0023 (do not write).** ~3k. Dependency: owner approval.

## Explicitly not grounded / assumed (do NOT treat as verified)
- **`memory_facet_admit`/`memory_facet_promote` as the exact op names and the `FacetTerm` shape:**
  **not grounded — assumed.** No facet registry exists in the repo; `ontology.ts` has only the kind/rel
  policy. The registry is deliberately stored on existing kinds + the new `filters.metadata` predicate so
  it needs **no** new node kind.
- **Outcome as `episode` + `meta.outcome` (vs a registered `outcome` kind):** grounded as a *choice*
  (native `claim` kind at `ontology.ts:4`; ADR-0010 D3 migration is the cost of a new kind) — the
  node-kind migration avoidance is the design intent, not a verified constraint.
- **`compareAndSwapRevision` on the graph-store `node` table:** **not grounded — assumed.** No CAS/
  `version` field exists (`writeNode:818` takes no expected-revision arg); SR-6 requires it be
  documented in the store's own docs, which do not yet exist.
- **`assessCoverage` signal set + the specific thresholds:** **weakest link, assumed.** The four signals
  are named in DESIGN.md §D4.3; the numeric thresholds are uncalibrated and must be tuned against a
  labeled query set (per the case-library spec §(f)7). Treat abstention as a logged, tunable policy.
- **`memory_back` return shape / the exact `back()` surface:** **not grounded — assumed.** No such read
  exists; the citation contract is the work-item plane's, which this returns verbatim.
- **`REFUTES` being admissible on the live store today:** **not grounded and actively blocked** — the
  live store's CHECK constraint rejects it until the **ADR-0010 D3** migration runs (PKT-61).

## Citations
Citations: [sox-ecosystem @ main (dirty), architect/deepseek-flash, D-C c35319fa,
1: libs/memory-core/src/ontology.ts:4-46, 2: libs/memory-core/src/write.ts:549-699,
3: libs/memory-core/src/update.ts:76-115,351, 4: libs/memory-core/src/recall.ts:467-497,670,
5: libs/memory-core/src/memory-filters.ts:17-53, 6: libs/memory-core/src/curate.ts:238-309,
7: libs/memory-core/src/config.ts:21-140, 8: libs/data/graph/graph-store/src/index.ts:560-571,818,
9: docs/decisions/0010-open-node-and-edge-typing.md, 10: docs/decisions/0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md,
11: docs/decisions/0013-feature-switches-are-typed-config-not-env-vars.md,
12: docs/plan/case-library-storage-model/case-library-storage-spec.md,
13: extensions/agents/researcher/agent.md:290-303,
14: extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts:1184,1793,2155,2585,
15: libs/memory-core/src/index.ts:240]
