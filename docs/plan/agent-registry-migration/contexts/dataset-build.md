# dataset-build — populate the registry: components + use-cases + weighted links (the real corpus dataset)

**Phase:** ingest · **Kind:** work · **Depends on:** sonnet-consolidation · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/dataset-build.test.ts`

See `contexts/_shared.md` for definitions and invariants.

---

## Goal

Populate the REAL registry from the pipeline output: write the parsed components
(typed onto the 18-type set), the sonnet-consolidated canonical **use-cases** (with
**anchor embeddings** via Plan 8's embedding substrate), and the **weighted
`component↔use-case` links** — through the published `@adhd/agent-registry` stores
(`ComponentStore`, `UseCaseStore.linkComponent(component, useCase, weight)`,
`AgentStore`, `AgentToolStore`), against a real on-disk SQLite DB. This is the **real
corpus dataset** the discovery lane (Plan 8 `component_search`) searches over.

This stage is the deterministic write of the (LLM-produced) dataset — no model is
called here; it consumes the consolidated artifact and persists it. Persistence is
proven by REOPEN (`[inv:reopen-proves-persistence]`): close the DB handle, reopen
from the same path, and read back the components, use-cases, and weighted links.

**Anchor-embedding backfill.** Each canonical use-case is written with an anchor
embedding computed by `@adhd/agent-registry`'s `enrich/usecase-anchors.ts`
(the Plan 8 substrate). This is the corpus backfill of the anchor vocabulary Plan 8
seeded — the enrichment seam is identical; only the anchor SET grows seed → corpus.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [dataset-build.1] populates the real registry (components+use-cases+weighted links) via the published stores against a real on-disk DB; rows recoverable after DB reopen
- [dataset-build.2] each canonical use-case is written with an anchor embedding via the Plan 8 substrate (enrich/usecase-anchors); component_search can rank a match over the corpus dataset
- [dataset-build.3] weighted component<->use-case links persist with their weights (not flattened to membership) recoverable after reopen

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry-migration/src/ingest/dataset-build.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/dataset-build.test.ts"]
```

---

## References & interfaces

- [fix:store-usage] — write rows via the published `@adhd/agent-registry` stores (`_shared.md`).
- [def:anchor-vocabulary] — the use-cases written here = Plan 8's enrichment anchors (`_shared.md`).
- [inv:reopen-proves-persistence] — prove persistence by REOPEN, not in-memory (`_shared.md`).

---

## Notes for executor

- **No model here.** This is the deterministic persist of the consolidated artifact.
  If the upstream LLM stages were skipped offline, `dataset-build` runs against the
  recorded consolidation FIXTURE so the persistence + reopen assertions stay green
  in CI; the live corpus dataset is produced when the LLM stages run.
- **Real stores, real DB, reopen-proves-persistence** (`[inv:real-deps-not-mocks]`,
  `[inv:reopen-proves-persistence]`). Never mock the stores under test. Close the
  better-sqlite3 handle and REOPEN before asserting (project memory: trust exit
  codes, not stdout `grep -q passed`).
- **Anchor embeddings via the Plan 8 substrate** — import
  `@adhd/agent-registry`'s `enrich/usecase-anchors.ts`; do NOT re-implement an
  embedder here. If Plan 8 is unbuilt at execution, this state's anchor-embedding
  assertion is gated on the substrate's presence (record the dependency honestly;
  it is a documented sequencing relationship, not a `depends_on_plans` edge).
- **Weighted links keep their weights** (`[dataset-build.3]`) — assert the read-back
  weight equals what consolidation assigned, not just that a link exists.
- Append exports to `src/index.ts` (append-only barrel).
