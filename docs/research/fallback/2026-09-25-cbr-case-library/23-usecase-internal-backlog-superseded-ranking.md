---
name: "Use case: internal backlog superseded-ranking (rankByFusedRelevance + dropSupersededResults)"
topic: "cbr-use-cases"
tags: ["use-case:reference", "internal-prior-art", "supersession", "hybrid-search", "ranking"]
summary: "An in-repo production instance of ranked hybrid retrieval over a supersession-aware store: `queryIssues` drives `rankByFusedRelevance` (query/views/semantic.ts), which ranks via @adhd/sox-hybrid-search's StoreSearchBackend and applies `dropSupersededResults`. The spec documents the exact defect that occurs when the rank path lacks the supersede predicate. This is our own working blueprint."
importance: 9
type: production-implementation
data_quality: verified
---

# content

name: Internal backlog superseded-ranking
description: The `entrypoint/backlog` query engine consumes `@adhd/sox-hybrid-search`'s `StoreSearchBackend` to rank issues by fused relevance, and applies a supersession filter so an edited issue appears once (as its successor). The accompanying spec is a worked account of the failure mode when that filter is missing on the rank path.

context: The store is a Turso (SQLite) graph + vector store. `bootstrapSemanticStoreMembers(adapter, graph, {embedding})` (write/bootstrap.ts) builds the real `search` (StoreSearchBackend) and `embedding` members — the SAME seam `api.ts` uses. `queryIssues` is driven exactly as the mounted `query` verb drives it. Embeddings are the only mocked boundary.

approach:
  - `rankByFusedRelevance` (query/views/semantic.ts) ranks candidates via `@adhd/sox-hybrid-search`'s `StoreSearchBackend`.
  - Every OTHER read path pushes `isSuperseded: false` into `graph.queryNodes`'s NodeFilter. The fused-rank path cannot: `searchRanked` belongs to sox-hybrid-search's StoreSearchBackend — a DIFFERENT filter contract with no `isSuperseded` member.
  - Without candidate-id narrowing, the rank path filtered on `{kind:'issue'}` alone → a superseded (frozen pre-edit) row stayed rankable forever, and `view:'similar'` returned the SAME logical issue twice (live row + frozen copy). The stale copy routinely outranks the live one because its text is what the anchor query resembles.
  - Fix: `dropSupersededResults` excludes the frozen row after fused ranking (exclude-then-rank / narrow-then-rank).
  - Test has teeth: both assertions fail if `dropSupersededResults` is removed from `rankByFusedRelevance`.

key_takeaway: We already have a working, tested pattern for "rank hybrid results over a store that has supersession, with a different-package filter contract" — and a documented failure mode. The case library should reuse exactly this: rank via @adhd/sox-hybrid-search, and thread the supersede/eligibility predicate through the rank path rather than assuming the store's contract carries it.

source: /Users/nix/dev/node/adhd/entrypoint/backlog/src/query/superseded-ranking.spec.ts (read 2026-09-25); query/views/semantic.ts (`rankByFusedRelevance`, `dropSupersededResults`); write/bootstrap.ts; docs/sox/CAPABILITY-CATALOG.md §2.5.
data_quality: verified
type: production-implementation
tags:
  - use-case:reference
  - internal-prior-art
  - supersession
  - hybrid-search
  - ranking
summary: "In-repo blueprint: rankByFusedRelevance ranks via sox-hybrid-search's StoreSearchBackend and applies dropSupersededResults. The spec documents the exact failure when the rank path uses a different filter contract with no isSuperseded member (stale copy outranks live row). Reuse this pattern for the case library."
---

## Evidence (verified by direct read)
- `entrypoint/backlog/src/query/superseded-ranking.spec.ts` lines 1-120 (the defect narrative +
  the production bootstrap seam + the teeth).
- `docs/sox/CAPABILITY-CATALOG.md` §2.5 lines 231-251 (sox-hybrid-search capabilities) and line 418.
- `pnpm-lock.yaml:1576` pins `@adhd/sox-hybrid-search@0.4.6`; npm shows 0.4.9 current.
