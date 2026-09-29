---
name: "Anti-pattern: ranking signals with no consumer (ranking tags that nothing reads)"
topic: "cbr-antipatterns"
tags: ["pattern:antipattern", "ranking-signals", "dead-signals", "provenance"]
summary: "Producing or storing a ranking signal (a tag, a rank field, a confidence column, a boost) that no read path consumes is pure cost: it is maintained, migrated, and explained but never influences a result. This system already has ranking tags with no downstream reader — a defect to remove or wire up, and a warning against adding a signal before its consumer exists."
importance: 7
type: best-practice
data_quality: estimated
---

# content

name: Anti-pattern — ranking signals with no consumer
description: A signal (tag, score field, boost flag) that is written/maintained but read by nothing. It costs storage, migration effort, cognitive load in reviews, and creates a false impression that ranking uses it.

why_it_fails:
  - No effect on outcomes: by definition the signal cannot change any ranking, so it cannot improve recall/precision — yet it is described as if it does.
  - Maintenance tax: it must be carried through schema/record evolution and reviewed as if load-bearing.
  - False confidence: a reader of the code/store believes the signal is used, mis-modelling the ranking behaviour.
  - Evidence via the inverse: vstash (arXiv 2604.15484) is the cautionary measured case — it added post-RRF signals (frequency+decay, history-augmented recall, cross-encoder rerank) and found they did NOT improve NDCG on 5 BEIR datasets. A signal with a consumer that provably doesn't move the metric is nearly as bad as one with no consumer.

what_to_do_instead:
  - Wire it or delete it: every signal must have (a) a read path that consumes it and (b) ideally a measurement showing it moves an outcome metric.
  - Treat a ranking change as a hypothesis and validate it against an eval set (NDCG/recall/precision) before keeping it (this is the same discipline the "verify the outcome" invariant demands of CASES, applied to FEATURES).
  - Prefer fewer, demonstrably-effective signals over a broad board of plausible ones.
  - If a signal is intended for explainability rather than ranking, label it as such and route it to an explainability consumer — do not call it a ranking input.

strengths: (none — anti-pattern entry)
weaknesses:
  - Nuance: not every stored field is a ranking signal (provenance, audit, display fields legitimately have non-ranking consumers). The anti-pattern is specifically a field that claims to affect ranking but has no ranking reader.

references:
  - vstash (2026) arXiv:2604.15484 — measured negative result on post-RRF signals not improving NDCG.
  - Internal observation: this system has ranking tags with no downstream reader (per the research brief).
source:
  - vstash (primary abstract) + internal observation
data_quality: estimated
type: best-practice
tags:
  - pattern:antipattern
  - ranking-signals
  - dead-signals
  - provenance
summary: "A ranking signal with no reader costs storage/migration/review and misleads, yet cannot change any result. Wire it or delete it; validate every ranking change against an outcome metric. vstash's negative result shows even a WIRED extra signal may not move NDCG. This system currently has ranking tags with no consumer."
---

## Confidence
- vstash negative result: **HIGH** (primary abstract, arXiv 2604.15484).
- The "no consumer" defect as described: **MEDIUM** — asserted by the research brief; not
  independently re-verified in this run's repo reads.
