# sonnet-consolidation — LLM consolidation: canonical use-case vocabulary + weighted component↔use-case links

**Phase:** ingest · **Kind:** work · **Depends on:** haiku-usecase-batch · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/sonnet-consolidation.test.ts`

See `contexts/_shared.md` for definitions and invariants.

---

## Goal

The second LLM stage: **one sonnet agent** reviews the FULL candidate use-case set
from the haiku fan-out and consolidates it into:

- a **canonical use-case vocabulary** (`[def:anchor-vocabulary]`) — the deduped,
  named, de-conflicted set of use-cases the whole corpus actually serves (e.g. the
  10 near-identical "review code for security" candidates collapse to one canonical
  `security-code-review` use-case);
- **weighted `component ↔ use-case` links** — for each component, which canonical
  use-cases it serves and with what weight.

This is the single-pass global view that only a stronger model over the whole
candidate set can produce: haiku saw one component at a time; sonnet sees them all
and imposes a coherent vocabulary. The output is the dataset
`dataset-build` populates the registry from.

**Cross-plan anchor linkage (`[def:anchor-vocabulary]`).** This canonical use-case
set IS the **anchor vocabulary** that Plan 8 (`agent-mcp-authoring`)'s enrichment
(`component_define` → auto use-case resolution, SPEC §5.3 step 2 / §10.2) resolves
component content against. Plan 8 ships a small SEED anchor set so its discovery
proofs run on fixtures; THIS state produces the real corpus-derived anchors that
Plan 7's `dataset-build` backfills into the registry. The two plans are sequenced
(Plan 8 seed → Plan 7 backfill), documented in `CLOSEOUT.md`, not coupled by a
`depends_on_plans` edge.

`[def:llm-stage]` applies: real sonnet model, gated behind `corpus-ingest-llm`,
skip-not-fail offline.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [sonnet-consolidation.1] one sonnet pass consolidates the candidate set into a canonical use-case vocabulary (dedup/merge) + weighted component<->use-case links; the vocabulary is smaller than the raw candidate union
- [sonnet-consolidation.2] LLM stage gated behind AGENT_REGISTRY_INGEST_LIVE: skips (not fails) when the model is unavailable; deterministic fixture/replay covers the consolidation shape offline
- [sonnet-consolidation.3] the consolidated vocabulary is the named ANCHOR vocabulary Plan 8 enrichment resolves against (explicit cross-plan linkage recorded)

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry-migration/src/ingest/sonnet-consolidate.ts", "packages/ai/agent-registry-migration/src/ingest/usecase-vocabulary.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/sonnet-consolidation.test.ts"]
```

---

## References & interfaces

- [def:llm-stage] — real model, gated, skip-not-fail (`_shared.md`).
- [def:anchor-vocabulary] — the canonical use-case set = Plan 8's enrichment anchors (`_shared.md`).

---

## Notes for executor

- **Real sonnet, single global pass, gated.** Drive a REAL sonnet model; gate behind
  `AGENT_REGISTRY_INGEST_LIVE=1` + `corpus-ingest-llm`; skip-not-fail offline.
- **Consolidation has teeth.** Assert the canonical vocabulary is genuinely SMALLER
  than the raw candidate union (dedup happened) and that every canonical use-case
  traces to ≥1 candidate (nothing invented from nothing). The offline replay fixture
  must exercise the same dedup assertion so the shape is proven without the model.
- **Weighted links, not booleans.** Each `component↔use-case` link carries a weight;
  `dataset-build` writes these via the registry's `UseCaseStore.linkComponent(...,
  weight)`. Do not flatten to unweighted membership.
- **Record the anchor linkage explicitly** (`[sonnet-consolidation.3]`): a comment +
  the CLOSEOUT/README note that this vocabulary is Plan 8's enrichment anchor set.
- Assert the consumer OUTCOME (a coherent vocabulary + weighted links), not the
  prompt wording (CLAUDE.md standard #6).
- Append exports to `src/index.ts` (append-only barrel).
