---
name: "Case-base maintenance — competence/performance dimensions and competence-preserving deletion"
topic: "cbr-patterns"
tags: ["pattern:recommended", "case-base-maintenance", "forgetting", "competence", "scalability"]
summary: "Case-base maintenance (CBM) is the CBR subfield for keeping a growing case base effective. Leake & Wilson give the dimension framework (what/when/how/how-much to change); Smyth & Keane give the canonical competence-preserving deletion policy — remove cases that are redundant/covered, measured by competence (coverage×quality) and performance, not by recency alone. This is the literature answer to 'what triggers reorganization'."
importance: 8
type: best-practice
data_quality: estimated
---

# content

name: Case-base maintenance (competence-preserving deletion; CBM dimensions)
description: CBM is the discipline of maintaining a case base so it stays efficient, competent, and correct as it grows. It supplies principled triggers and policies for reorganizing/removing/adding cases — the alternative to unbounded growth and to naive recency-based eviction.

how_it_works:
  - Leake & Wilson's dimensions framework (what to change; when to trigger; how to choose; how much to change) is the organizing vocabulary. Maintenance can be triggered by: a new case (incremental), a performance drop, a competence gap, or a scheduled pass.
  - Competence = the set of problems the system can solve at an acceptable quality; Performance = the fraction of problems solved to acceptable quality. Maintenance aims to preserve/improve competence while controlling footprint.
  - Smyth & Keane's competence-preserving deletion: remove a case only when the cases that remain can still solve the problems it covered (redundancy/coverage analysis) — i.e. delete covered cases, not merely old ones. This is the "Remembering to Forget" result.
  - Case-addition policies matter symmetrically: adding every case blindly can reduce competence (noise, redundancy); competence-preserving addition selects which cases to keep.
  - Practical triggers: footprint budget exceeded, contradiction density rising, retrieval precision falling on a held-out probe set, or a new case that subsumes existing ones (→ supersede rather than append).
  - Memory-specific port of the same idea: FadeMem's score-and-evict with per-category half-lives + an importance multiplier + a verification boost, evicting to a cold tier (not deleting).

strengths:
  - Gives a principled, non-arbitrary answer to "what triggers reorganization" and "what to delete".
  - Competence/performance are measurable, so maintenance can be evaluated rather than guessed (matches the "no signal without a consumer" rule).
  - Deletion-by-coverage preserves the ability to solve problems while shrinking footprint.

weaknesses:
  - Competence computation is expensive in the general case (requires a problem distribution / coverage analysis), which is why most production systems fall back to cheaper proxies (recency, retrieval count).
  - The classical CBR literature assumes a relatively stable problem distribution; a rapidly drifting case domain weakens coverage-based reasoning.
  - "Deletion" in CBR is often physical; in an append-only/bitemporal store the analogue is invalidation/supersession/cold-tier demotion, so the policy must be translated, not copied.

references:
  - Leake, D. & Wilson, D.C. "Maintaining Case-Based Reasoners: Dimensions and Directions" (CBM dimension framework).
  - Smyth, B. & Keane, M. (1995). "Remembering to Forget: A Competence-Preserving Case Deletion Policy for Case-Based Reasoning Systems." IJCAI 1995.
  - Zhu, J. et al. "Competence-preserving Case-Addition Policies for CBR" (IJCAI) — case-addition side.
  - Leake, D. (2000). "Performance-Guided Case-Base Maintenance" (Springer chapter).
  - FadeMem (2026), arXiv:2601.18642 (score-and-evict port).
source:
  - CBR maintenance literature (citations verified via Google search 2026-09-25: IJCAI/ACM/Springer)
data_quality: estimated
type: best-practice
tags:
  - pattern:recommended
  - case-base-maintenance
  - forgetting
  - competence
  - scalability
summary: "CBM (Leake & Wilson dimensions; Smyth & Keane competence-preserving deletion; Zhu case-addition) is the literature answer to reorganization triggers and safe removal: delete covered/redundant cases, not merely old ones, and measure competence. Port 'deletion' to invalidation/cold-tier in a bitemporal store."
---

## Confidence
- Smyth & Keane 1995 + Leake & Wilson + Zhu: **MEDIUM** (titles/venues verified via Google search
  hits citing them; the papers themselves were not deep-read this run).
- The competence-vs-performance framing: **MEDIUM** (consistent across the surfaced abstracts/venues).
