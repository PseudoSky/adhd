# haiku-usecase-batch — LLM fan-out (cheap tier): candidate use-cases per parsed component

**Phase:** ingest · **Kind:** work · **Depends on:** corpus-parser · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/haiku-usecase-batch.test.ts`

See `contexts/_shared.md` for definitions and invariants.

---

## Goal

The first LLM stage of the ingestion pipeline: a **parallel fan-out of haiku
agents** (the cheap tier) processes EVERY parsed component from `corpus-parser` and
emits **candidate use-cases** per component — short phrases naming the tasks the
component serves ("review code for security defects", "enforce default-skeptic
verdict", "emit JSON findings keyed by severity"). One haiku invocation per
component (or a small batch per call), run concurrently, producing a
`CandidateUseCaseSet` keyed by component name.

This is deliberately the cheap, wide pass: haiku is fast and inexpensive, the task
is local (one component → its use-cases), and the output is intentionally
over-generated — consolidation (`sonnet-consolidation`) dedupes and canonicalizes
next. The fan-out is the parallelism the owner asked for: "a fan-out of haiku
agents processes EVERY parsed component."

**`[def:llm-stage]`** — an LLM stage drives a REAL model via the agent-mcp provider
(haiku for this stage). It is gated behind the `corpus-ingest-llm` human-blocker and
SKIPS (does not fail) when the model is unavailable, so CI stays offline
(CLAUDE.md verification standard #5 — live model behind an env flag).

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [haiku-usecase-batch.1] fan-out runs one haiku call per parsed component (parallel), emitting >=1 candidate use-case per component into a CandidateUseCaseSet keyed by component name
- [haiku-usecase-batch.2] LLM stage gated behind AGENT_REGISTRY_INGEST_LIVE: skips (not fails) when the model is unavailable; a deterministic fixture/replay covers the fan-out shape offline

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-registry-migration/src/ingest/haiku-batch.ts", "packages/ai/agent-registry-migration/src/ingest/usecase-candidate.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/haiku-usecase-batch.test.ts"]
```

---

## References & interfaces

- [def:llm-stage] — a pipeline stage that drives a REAL model, gated + skip-not-fail (`_shared.md`).
- [def:eighteen-types] — components carry one of the 18 types (`_shared.md`).

---

## Notes for executor

- **Real model, cheap tier, gated.** Drive a REAL haiku model through the agent-mcp
  provider — never a scripted stand-in on the live path (CLAUDE.md #5). Gate the
  live fan-out behind `AGENT_REGISTRY_INGEST_LIVE=1` + the `corpus-ingest-llm`
  human-blocker; `it.skip` cleanly when unavailable so CI stays offline.
- **Determinism without the model.** The OFFLINE test proves the fan-out SHAPE
  (one call per component, results keyed by name, ≥1 candidate each) against a
  recorded/replayed fixture response — NOT by faking the model on the live path.
  The live path, when enabled, asserts the same shape against real haiku output.
  Keep the two paths behind the same interface so the shape assertion is identical.
- **Parallelism is the point, but assert the OUTCOME not the mechanism.** The owner
  asked for a fan-out; prove "every parsed component gets a candidate set back",
  not "`Promise.all` is present" (CLAUDE.md standard #6). Use a barrier/latch if you
  must prove concurrency, never `sleep`.
- **Over-generation is fine here** — consolidation prunes. Do NOT try to canonicalize
  or weight in this stage; that is `sonnet-consolidation`'s job.
- Append exports to `src/index.ts` (append-only barrel).
