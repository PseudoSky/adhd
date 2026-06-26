# enrichment-pipeline — deterministic component auto-filing (embed → links → summary)

**Phase:** enrichment · **Kind:** work · **Depends on:** embedding-substrate · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/enrichment-pipeline.test.ts`

---

## Goal

`@adhd/agent-registry` now has a single write-path enrichment function,
`enrichComponent(content)` (`enrich/enrich-component.ts`), that auto-files a
component the moment its content lands: (1) **embed** the content via the
`EmbedFn` substrate, (2) **resolve weighted use-case links** by cosine against the
seeded use-case anchors and write the `ComponentUsageRow`s automatically — the
job an authoring agent previously had to do by hand via
`UseCaseStore.linkComponent`, and (3) derive an **extractive `summary`**
(`enrich/summarize.ts`). The agent supplies content only; use-cases, weights, and
summary are all derived (SPEC §5.3, Decision D). The pipeline is deterministic and
idempotent: re-running it on byte-identical content produces the identical vector,
identical links, and identical summary, so re-defining an unchanged component does
NOT churn the index (`inv:enrichment-deterministic`). This lives entirely in the
registry (`inv:additive-registry`); agent-mcp only calls it through a thin wrapper
in `component-define`.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [enrichment-pipeline.1] enrichComponent embeds+resolves weighted use-cases+summarizes; identical content is idempotent (no index churn)

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry/src/enrich/enrich-component.ts", "packages/ai/agent-registry/src/enrich/summarize.ts", "packages/ai/agent-registry/src/store/usecase-store.ts", "packages/ai/agent-registry/src/index.ts", "packages/ai/agent-registry/src/__tests__/enrichment-pipeline.test.ts"]
```

---

## Notes for executor

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
- **Summary is extractive, not generative** — no LLM call, so it stays
  deterministic and offline. Derive it from the content itself (e.g. leading
  salient sentence/clause).
- **Registry-only** (`inv:additive-registry`): nothing in agent-mcp changes in
  this state. Depends on `embedding-substrate` (the `EmbedFn` + anchors) being
  exported first.
