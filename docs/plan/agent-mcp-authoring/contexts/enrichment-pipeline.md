# enrichment-pipeline — deterministic component auto-filing via sox primitives

**Phase:** enrichment · **Kind:** work · **Depends on:** embedding-substrate · **Guard:** `npx --yes nx test agent-store-prompts --testFile=packages/agent/agent-store-prompts/src/__tests__/enrichment-pipeline.test.ts`

---

## Goal

`@adhd/agent-store-prompts` now has a single write-path enrichment function,
`enrichComponent(content)` (`enrich/enrich-component.ts`), that auto-files a
component the moment its content lands: (1) **embed** via the `EmbeddingProvider`
from `embedding-substrate` wrapping `@adhd/sox-embedding-provider`, (2) **resolve
weighted use-case links** by cosine against the seeded use-case anchors (persisted
via `@adhd/sox-vector-store`) and write the `ComponentUsageRow`s automatically, and
(3) derive a `summary` (and free `tags`) via `@adhd/sox-ingest`'s **`ingest()`**.
The agent supplies content only; use-cases, weights, and summary are all derived
(SPEC §5.3, Decision D). The pipeline is deterministic and idempotent: re-running it
on byte-identical content produces the identical use-case links and identical
summary, so re-defining an unchanged component does NOT churn the index
(`inv:enrichment-deterministic`). This lives entirely in
`@adhd/agent-store-prompts` (`inv:additive-registry`); agent-mcp only calls it
through a thin wrapper in `component-define`.

**This replaces the original plan of writing all enrichment logic from scratch.**
`@adhd/sox-ingest/core` provides `ingest(content, {summaryMaxSentences})` which returns
`{ contentHash, summary, tags }` in one call — the extractive lead-N summary, the
SHA-256 content hash the idempotence gate needs, and free deterministic tags.

> **Import from the `@adhd/sox-ingest/core` subpath — it is dependency-free.**
> `core.ts` imports only `node:crypto` and exports `ingest`, `hexSha256`,
> `splitIntoChunksSentence` (+ `IngestResult`/`IngestOpts`/`IngestChunk`). The root
> barrel `@adhd/sox-ingest` additionally re-exports `AstChunker`, which pulls
> `web-tree-sitter` + `tree-sitter-wasms`; `/core` avoids both native deps. (CAVEAT:
> the `./core` export is currently uncommitted upstream — the `sox-package-publish`
> blocker re-verifies it resolves before this state runs.)

> **`extractiveSummary` is NOT exported by `@adhd/sox-ingest` (AMA-002, D-summary).**
> It is module-private (no `export`). The original plan's
> `import { extractiveSummary } from '@adhd/sox-ingest'` (in **both**
> `enrich-component.ts` and `summarize.ts`) does not compile. Use the public
> `ingest()` from `@adhd/sox-ingest/core` and read `.summary`. `@adhd/sox-analysis`
> (near-dup/importance/clustering) is available but **not consumed** by this state.

---

## Interface design

```
┌─────────────────────────────────────────────────────────────┐
│  enrich-component.ts  (registry orchestrator)                │
│                                                               │
│  enrichComponent(params):                                     │
│    1. { contentHash, summary, tags } = ingest(content, ...)   │
│    2. content-hash check (idempotent skip on identical hash)  │
│    3. embed(content) via @adhd/sox-embedding-provider         │
│    4. knn(embedding, useCaseAnchors) via @adhd/sox-vector-store│
│    5. linkComponent above threshold (write ComponentUsageRow) │
│    6. write summary + contentHash + provenance to component   │
│                                                               │
│  deps:                                                        │
│    @adhd/sox-embedding-provider  — embedSingle                │
│    @adhd/sox-vector-store        — knn (method), upsert       │
│    @adhd/sox-ingest/core         — ingest() → summary/hash/tags│
└──────────────────────────────────────────────────────────────┘
```

### Module: `@adhd/agent-store-prompts/src/enrich/enrich-component.ts`

```ts
import { createRegistryEmbedder } from './embedding.js';
import { ingest } from '@adhd/sox-ingest/core';
import type { VectorBackend } from '@adhd/sox-vector-store';
import type { EmbeddingProvider } from '@adhd/sox-embedding-provider';

export interface EnrichComponentParams {
  rowid: number;
  content: string;
  name: string;
  type: string;
}

export interface EnrichComponentResult {
  summary: string | null;
  useCaseLinks: Array<{ name: string; weight: number }>;
  changed: boolean;
}

export function enrichComponent(
  embedder: EmbeddingProvider,
  vecDb: VectorBackend,
  params: EnrichComponentParams,
): Promise<EnrichComponentResult>;
```

- **Idempotent check**: `const { contentHash, summary } = ingest(content, { summaryMaxSentences: 2 })`.
  Store `contentHash` on the component row. If the stored hash matches, return
  `changed: false` with **no writes** (short-circuit before embed/knn/link).
- **Embed**: `embedder.embedSingle(content)` → `Float32Array`.
- **KNN**: `vecDb.knn(embedding, anchorSpace, k=topK)` → nearest use-case anchors
  with cosine scores. Set `weight = cosineScore` for each above threshold.
- **Link**: write `ComponentUsageRow` via `UseCaseStore.linkComponent` (additive —
  the manual method stays available).
- **Summary**: from the same `ingest()` call — `.summary` (lead-N sentences,
  zero LLM, deterministic).
- **Version**: increment component version only when `changed: true`.
- Errors: wrap embedding failures as the typed errors exported by
  `@adhd/sox-embedding-provider`; never silently degrade.

### Module: `@adhd/agent-store-prompts/src/enrich/summarize.ts` (thin wrapper)

```ts
import { ingest } from '@adhd/sox-ingest/core';

export function summarize(content: string): string {
  return ingest(content, { summaryMaxSentences: 2 }).summary;
}
```

- Delegates to `@adhd/sox-ingest/core`'s `ingest()`; reads `.summary`.
- Pure function, zero LLM, deterministic.

---

## Acceptance criteria

- [enrichment-pipeline.1] enrichComponent embeds + resolves weighted use-cases (cosine scores above threshold) + a summary; identical content returns changed:false and no index churn (byte-stable links + summary across two runs, proven by store reopen)
- [enrichment-pipeline.2] the summary is `@adhd/sox-ingest`'s `ingest().summary`: for content ≥100 chars it is the lead-N (first `summaryMaxSentences`) sentences; for content <100 chars it is the input trimmed (`content.trim()`) — asserted as an observable, not a call-shape
- [enrichment-pipeline.3] use-case link weight = the cosine similarity score; an unrelated use-case falls below threshold and is NOT linked (negative control: a semantically-unrelated component accrues zero links)

---

## Reservations

```text
read_only:  []
mutates:    [
  "packages/agent/agent-store-prompts/package.json",
  "packages/agent/agent-store-prompts/src/enrich/enrich-component.ts",
  "packages/agent/agent-store-prompts/src/enrich/summarize.ts",
  "packages/agent/agent-store-prompts/src/store/usecase-store.ts",
  "packages/agent/agent-store-prompts/src/index.ts",
  "packages/agent/agent-store-prompts/src/__tests__/enrichment-pipeline.test.ts"
]
```

---

## Notes for executor

- **Consume, don't build.** Import `ingest` from `@adhd/sox-ingest/core` (dep-free —
  `node:crypto` only; the root barrel would drag in `web-tree-sitter`). Import the
  embedder from `./embedding.js`. Import `openVectorStore`/use the `knn` method from
  `@adhd/sox-vector-store`. The new code is the registry-specific orchestrator wiring
  them against the component schema.
- **Idempotence is THE tooth.** The proof must demonstrate that a second
  `enrichComponent` on identical content rewrites nothing — assert the use-case link
  rows are byte-stable (same set, same weights, same summary) across two runs, by
  reopening/re-reading the store. Gate the rewrite on `ingest().contentHash` so
  identical input short-circuits before any insert/delete. A test that passes while
  the index silently churns proves nothing.
- **Summary observable ([enrichment-pipeline.2]).** Do not assert "extractiveSummary
  was called" — that function is private and this pipeline never imports it. Assert
  the OUTCOME of `ingest().summary`: a long input returns its first N sentences; a
  `<100`-char input returns exactly `content.trim()`. Drive real `ingest()` on both
  a long and a short fixture and assert both branches.
- **The `.tooth` audit checks are grep-based — a green grep is NOT proof (AMA-017).**
  `enrichment-pipeline.2.tooth` / `.3.tooth` (in both `criteria.json` and
  `audit_authoring.py`) only assert the test file *mentions* `ingest`/`summary`/`100`/
  `trim` and `threshold`/`cosine`/`unrelated`/`negative`. A test that names those tokens
  but asserts nothing passes both the shared `nx test` command AND the grep. **Per repo
  rule §6.2 you MUST prove each behavioural assertion FAILS when the fix is reverted
  (negative control):** revert the `<100`-char trim branch and confirm that assertion goes
  red; disable threshold gating and confirm the unrelated-component negative control goes
  red (it should accrue zero links). The passing grep is a declaration mirror, not a
  behaviour proof.
- **This REPLACES the manual `linkComponent` call as the authoring path.** Keep
  `UseCaseStore.linkComponent` available (public API, other plans may use it), but
  the enrichment pipeline is now the one that writes links on `component_define`.
- **`weight` = the cosine similarity score**, not a hand-tuned constant. Only link
  use-cases above a sensible threshold; document the threshold choice inline.
- **Registry-only** (`inv:additive-registry`): nothing in agent-mcp changes here.
- **Publishing prerequisite (now unblocked).** `@adhd/sox-ingest` is **public**
  (`private:false`) and the former "PRIVATE — only the memory domain composer may call
  this" header invariant is **removed** as of sox-ecosystem commit `f4897aa`, so the
  `@adhd/agent-store-prompts` consumer is sanctioned (the `sox-ingest-publishable`
  human-blocker is `verified`). It still ships in the `sox-package-publish` set —
  re-verify both the package and the `@adhd/sox-ingest/core` subpath resolve before
  this state runs (the change + the `./core` export were concurrent/uncommitted). See
  decisions.md §D5.
