# embedding-substrate — deterministic in-package embedding + seeded use-case anchors

**Phase:** enrichment · **Kind:** work · **Depends on:** authoring-design · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/embedding-substrate.test.ts`

---

## Goal

`@adhd/agent-registry` now owns a deterministic, dependency-free embedding
substrate — the first embedding capability anywhere in the workspace (D1). A
single injectable `EmbedFn = (text: string) => Float32Array` interface
(`enrich/embedding.ts`) with a fixed-dimension hashed-n-gram + L2-normalized
default vectorizes any text identically across Node/CI, plus a `cosine(a,b)`
helper. Every seeded use-case carries an anchor embedding (`enrich/usecase-anchors.ts`)
derived at seed time from its name+description, giving `component_search` and the
enrichment pipeline a target to resolve against. The substrate is exported from
`src/index.ts` for the agent-mcp discovery/authoring lanes to consume. The
behavioral bar holds: cosine over these vectors ranks a query against a matching
use-case anchor *above* an unrelated one — sufficient for SPEC §7's relative
ordering. No `sqlite-vec`/transformers/onnx dependency is introduced; the package
stays `platform:shared`-pure.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [embedding-substrate.1] embedding(text) deterministic + use-case anchors rank a match above an unrelated one

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry/src/enrich/embedding.ts", "packages/ai/agent-registry/src/enrich/usecase-anchors.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/embedding-substrate.test.ts"]
```

---

## Notes for executor

- **Pure TS, zero deps, no memory-server coupling.** Re-verify D1 still holds at
  execution: no embedding dependency may be added to any `package.json`, and the
  memory-server stays out of the import graph. Coupling enrichment to a network
  embedder would make `component_define` non-deterministic and break
  `platform:shared` purity — that is the whole reason this is in-package.
- **The injectable `EmbedFn` seam is the generalization point, not extra scope.**
  Ship the deterministic default behind the interface so a later plan (FEAT-008)
  can swap a model-backed embedder without touching `enrichComponent` or the
  discovery tools. Do NOT build the model-backed path here.
- **Determinism is load-bearing downstream.** Idempotent re-define
  (`inv:enrichment-deterministic`) reduces to: same content → identical vector →
  identical use-case links → no index churn. Gate idempotence on a content hash so
  identical input never recomputes/rewrites. Keep the embedding side-effect-free.
- **Anchors are seeded once at seed time**, from each use-case's name+description —
  not recomputed per query. The query side embeds at call time and compares against
  these fixed anchors.
- **Cross-plan anchor provenance (explicit linkage to Plan 7).** This plan ships a
  small fixed SEED set of use-case anchors — enough for the discovery/composition
  proofs to run on fixtures (SPEC §7's "rank a match above an unrelated one" bar).
  These seed anchors are the ANCHOR VOCABULARY that `component_define`'s enrichment
  (SPEC §5.3 step 2 / §10.2) resolves component content against. **Plan 7
  (`agent-registry-migration`) BACKFILLS the real corpus-derived anchors**: its
  sonnet-consolidation state produces the canonical use-case vocabulary from the 46
  00-active agents + workflow-plugin agents, and the dataset-build state writes those
  use-cases (with anchor embeddings via THIS substrate) into the registry. So the
  enrichment seam is identical; only the anchor SET grows from seed → corpus when
  Plan 7 runs. Keep the seed set minimal and clearly marked as seed (not corpus) so
  Plan 7's backfill is additive, not a conflicting rewrite.
- **Additive only** (`inv:additive-registry`): new files under `src/enrich/` + an
  index export. Do not disturb the Plans 1–5 store vocabulary or their green audits.
