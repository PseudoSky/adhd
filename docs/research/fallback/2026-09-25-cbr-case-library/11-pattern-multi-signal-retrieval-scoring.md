---
name: "Multi-signal retrieval-time scoring: weighted sum of relevance + recency + importance (+ outcome/confidence)"
topic: "cbr-patterns"
tags: ["pattern:recommended", "ranking", "recency-decay", "scoring-formula", "retrieval-time"]
summary: "The canonical production formulation is Park et al. 2023 (Generative Agents): score = α·recency + β·importance + γ·similarity, where recency = exponential decay over time since LAST RETRIEVED, importance = normalized salience, similarity = cosine, and equal weights are the strong baseline. Outcome/confidence terms are added in the same additive family. Computed at RETRIEVE time over a bounded candidate set — never materialized at write time."
importance: 9
type: best-practice
data_quality: estimated
---

# content

name: Multi-signal retrieval-time scoring (weighted sum + exponential recency decay)
description: A retrieve-time re-ranker that combines several normalized signals into one score over a bounded candidate set recalled by the store's hybrid search. The canonical form is the Generative Agents retrieval function.

how_it_works:
  - Two-stage: coarse recall (vector + BM25, K_recall ≈ 20-50) → rerank with extra signals → top N_final ≈ 3-10 (the 4:1 oversampling ratio is the standard pattern).
  - Park et al. (2023) §A.1: score = α·recency + β·importance + γ·similarity. Equal weights (α=β=γ) is the empirical baseline and beats any single signal by a wide margin.
  - Recency = exponential decay over time since the episode was LAST RETRIEVED (not last written): the paper uses 0.995 per sandbox hour. Generalized and preferable: recency = exp(-Δt/τ) with τ set so recency(half_life)=0.5, i.e. recency = 0.5^(Δt/half_life); a defensible default half-life is 7-30 days of wall-clock time, set explicitly.
  - Importance = anchored 1-10 salience normalized to [0,1] (divide by 10). Optional LFU fold-in: importance' = importance + δ·log(1 + retrieval_count), δ small (≈0.05) to avoid lock-in.
  - Similarity = cosine(query, episode); no normalization needed but min-max rescale over the recalled candidate set if the embedding model's cosine band is tight (e.g. everything in [0.7,0.9]).
  - Normalize every signal (min-max over the candidate set) BEFORE the weighted sum — the blend is otherwise dominated by whichever signal has the largest dynamic range.
  - Read-driven state updates on retrieval: advance `last_read` (LRU), increment `retrieval_count` (LFU), and bounded importance boost when the retrieved entry is cited/followed by a success (max ~5% per read; unbounded boosts make the ranker unstable).
  - Outcome/confidence terms (the CBR addition) enter the same additive family: score = α·recency + β·importance + γ·similarity + η·outcome_success + θ·provenance_strength, each normalized.
  - Alternative decay families from the literature: MemoryBank S = S_0·exp(-t/η) with η extended by each retrieval (Ebbinghaus; retrieval lengthens the half-life). FadeMem eviction score: importance·exp(-(now-last_access)/half_life[category])·(1 + δ·recently_verified).
  - Diversity: after score-and-rank, run an MMR pass so a top-K is not 5 near-duplicates of one case (deduct a fraction of a candidate's score per higher-ranked textually-similar candidate).

strengths:
  - Equal-weights multi-signal beats every single-signal baseline (Park et al. ablation) — cheap, large win.
  - Every term is measurable and locally tunable; failure modes are localized and inspectable.
  - Computed at read time over a bounded candidate set, so cost does not grow with corpus size the way an eager full-corpus rerank would.

weaknesses:
  - Tuning the weights is workload-specific and the marginal gain over equal-weights is small; over-tuning is a real trap.
  - The decay constant is the load-bearing knob: too aggressive and old-but-important cases drop out; too gentle and recency becomes constant (policy collapses to importance+similarity).
  - Recency can be actively wrong for temporal queries ("what did we decide three months ago") — needs an explicit temporal-intent flag that inverts or drops the recency term.
  - Additive blending is scale-sensitive; without per-candidate normalization it silently degenerates.
  - IMPORTANT NEGATIVE RESULT: vstash (arXiv 2604.15484) found that post-RRF scoring with frequency+decay, history-augmented recall, and cross-encoder reranking all FAILED to improve NDCG on 5 BEIR datasets — evidence that extra ranking terms must be validated against an outcome metric, not assumed to help.

references:
  - Park, J.S. et al. (2023). "Generative Agents: Interactive Simulacra of Human Behavior", arXiv:2304.03442, §A.1 (retrieval function, 0.995/hr decay, equal weights). https://arxiv.org/abs/2304.03442
  - Zhong, Guo et al. (2024). "MemoryBank", AAAI, arXiv:2305.10250 (Ebbinghaus S = S_0·exp(-t/η), η extended by retrieval).
  - FadeMem (2026), arXiv:2601.18642 (score-and-evict with per-category half-lives).
  - Chhikara et al. (2025). "Mem0", ECAI, arXiv:2504.19413 (3-channel hybrid recall + channel fusion).
  - vstash (2026), arXiv:2604.15484 (adaptive RRF + per-query IDF; the post-RRF negative result).
source:
  - Park et al. 2023 §A.1 (primary), via https://jatinbansal.com/ai-engineering/memory-retrieval-policies/ (secondary, exact form)
data_quality: estimated
type: best-practice
tags:
  - pattern:recommended
  - ranking
  - recency-decay
  - scoring-formula
  - retrieval-time
summary: "score = α·recency + β·importance + γ·similarity (+ η·outcome + θ·confidence), with recency = exp(-Δt/τ) / 0.5^(Δt/half_life), all signals min-max normalized per candidate set, computed at retrieve time over a 20-50 candidate recall. Equal weights is the baseline. Park et al. 2023 §A.1; MemoryBank adds Ebbinghaus strengthening; vstash's negative result says validate extra terms against an outcome metric."
---

## Confidence
- Park et al. 2023 formula shape + equal-weights baseline: **HIGH** (two independent secondary
  accounts + the primary paper's abstract; §A.1 explicitly cited).
- Exact constants (0.995/hr): **MEDIUM** (single secondary source, §A.1).
- MemoryBank / FadeMem / Mem0 formulations: **MEDIUM** (read via a secondary survey, primary
  arXiv IDs recorded but abstracts not fetched this run).
- vstash negative result: **HIGH** (read from the primary abstract, arXiv 2604.15484).
