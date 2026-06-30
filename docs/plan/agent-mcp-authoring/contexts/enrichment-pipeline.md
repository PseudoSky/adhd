# enrichment-pipeline — deterministic component auto-filing via sox primitives

**Phase:** enrichment · **Kind:** work · **Depends on:** embedding-substrate · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/enrichment-pipeline.test.ts`

---

## Goal

`@adhd/agent-registry` now has a single write-path enrichment function,
`enrichComponent(content)` (`enrich/enrich-component.ts`), that auto-files a
component the moment its content lands: (1) **embed** via the `EmbeddingProvider`
from `embedding-substrate` wrapping `@adhd/sox-embedding-provider`, (2) **resolve
weighted use-case links** by cosine against the seeded use-case anchors (persisted
via `@adhd/sox-vector-store`) and write the `ComponentUsageRow`s automatically,
and (3) derive an **extractive `summary`** via `@adhd/sox-ingest`'s
`extractiveSummary()`. The agent supplies content only; use-cases, weights, and
summary are all derived (SPEC §5.3, Decision D). The pipeline is deterministic and
idempotent: re-running it on byte-identical content produces the identical vector,
identical links, and identical summary, so re-defining an unchanged component does
NOT churn the index (`inv:enrichment-deterministic`). This lives entirely in the
registry (`inv:additive-registry`); agent-mcp only calls it through a thin wrapper
in `component-define`.

**This replaces the original plan of writing all enrichment logic from scratch.**
The sox-ecosystem's `@adhd/sox-ingest` provides `extractiveSummary()` (lead-N
sentence extraction, zero LLM), and `@adhd/sox-analysis` provides near-dup
detection and importance scoring if needed. The only new code in
`@adhd/agent-registry` is the registry-specific orchestrator that wires these
primitives against the component schema.

---

## Interface design

```
┌─────────────────────────────────────────────────────────────┐
│  enrichment-component.ts  (registry orchestrator)            │
│                                                               │
│  enrichComponent(params):                                     │
│    1. content-hash check (idempotent skip on identical)      │
│    2. embed(content) via @adhd/sox-embedding-provider        │
│    3. knn(embedding, useCaseAnchors) via @adhd/sox-vector-store│
│    4. linkComponent above threshold (write ComponentUsageRow) │
│    5. summary = extractiveSummary(content)                   │
│       via @adhd/sox-ingest                                   │
│    6. write summary + provenance to component row             │
│                                                               │
│  deps:                                                        │
│    @adhd/sox-embedding-provider  — embedSingle               │
│    @adhd/sox-vector-store       — knn, upsert                │
│    @adhd/sox-ingest             — extractiveSummary          │
└──────────────────────────────────────────────────────────────┘
```

### Module: `@adhd/agent-registry/src/enrich/enrich-component.ts`

```ts
import { createRegistryEmbedder } from './embedding.js';
import { extractiveSummary } from '@adhd/sox-ingest';
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

- **Idempotent check**: SHA-256 content hash stored on the component row. If hash
  matches, return `changed: false` with no writes.
- **Embed**: `embedder.embedSingle(content)` → `Float32Array`.
- **KNN**: `vecDb.knn(embedding, anchorSpace, k=topK)` → get nearest use-case
  anchors with cosine scores. Set `weight = cosineScore` for each above threshold.
- **Link**: write `ComponentUsageRow` via `UseCaseStore.linkComponent` (additive
  — the manual method stays available).
- **Summary**: `extractiveSummary(content)` → first N salient sentences.
- **Version**: increment component version only when `changed: true`.
- Errors: wrap embedding failures as `PermanentEmbeddingError` / `TransientEmbeddingError`
  from `@adhd/sox-embedding-provider`; never silently degrade.

### Module: `@adhd/agent-registry/src/enrich/summarize.ts` (thin wrapper)

```ts
import { extractiveSummary as soxExtractiveSummary } from '@adhd/sox-ingest';

export function summarize(content: string): string {
  return soxExtractiveSummary(content);
}
```

- Delegates to `@adhd/sox-ingest`'s lead-N extractive summary.
- Pure function, zero LLM, deterministic.

---

## Acceptance criteria

- [enrichment-pipeline.1] enrichComponent embeds + resolves weighted use-cases (cosine scores above threshold) + extractive summary; identical content returns changed:false and no index churn
- [enrichment-pipeline.2] extractive summary delegates to @adhd/sox-ingest and returns lead-N sentences; content < 100 chars returns as-is
- [enrichment-pipeline.3] use-case weights = cosine similarity score; unrelated use-cases fall below threshold and are not linked

---

## Reservations

```text
read_only:  []
mutates:    [
  "packages/ai/agent-registry/package.json",
  "packages/ai/agent-registry/src/enrich/enrich-component.ts",
  "packages/ai/agent-registry/src/enrich/summarize.ts",
  "packages/ai/agent-registry/src/store/usecase-store.ts",
  "packages/ai/agent-registry/src/index.ts",
  "packages/ai/agent-registry/src/__tests__/enrichment-pipeline.test.ts"
]
```

---

## Notes for executor

- **Consume, don't build.** Import `extractiveSummary` from `@adhd/sox-ingest`.
  Import `createEmbeddingProvider` from `@adhd/sox-embedding-provider`. Import
  `openVectorStore`/`knn` from `@adhd/sox-vector-store`. The new code is the
  registry-specific orchestrator wiring them against the component schema.
- **Idempotence is THE tooth.** The proof must demonstrate that a second
  `enrichComponent` on identical content rewrites nothing — assert the use-case
  link rows are byte-stable (same set, same weights, same summary) across two
  runs, ideally by reopening/re-reading the store. Gate the rewrite on a content
  hash so identical input short-circuits before any insert/delete. A test that
  passes while the index silently churns proves nothing.
- **This REPLACES the manual `linkComponent` call as the authoring path.** Keep
  `UseCaseStore.linkComponent` available (it is part of the store's public API and
  other plans may use it), but the enrichment pipeline is now the one that writes
  links on `component_define`. The mutation to `usecase-store.ts` is the additive
  hook the pipeline writes through — do not rip out the manual method.
- **`weight` = the cosine similarity score**, not a hand-tuned constant. Only link
  use-cases above a sensible threshold so unrelated use-cases don't accrue noise
  links; document the threshold choice inline.
- **Summary is extractive, not generative** — `@adhd/sox-ingest`'s
  `extractiveSummary` is lead-N sentences, zero LLM, deterministic.
- **Registry-only** (`inv:additive-registry`): nothing in agent-mcp changes in
  this state.
- **Publishing prerequisite.** `@adhd/sox-ingest` (`private: true`) is NOT on npm
  and NOT publishable. See `_shared.md` § sox-ecosystem dependency for options:
  either make it publishable (`"private": false`) or use a local path/link.
