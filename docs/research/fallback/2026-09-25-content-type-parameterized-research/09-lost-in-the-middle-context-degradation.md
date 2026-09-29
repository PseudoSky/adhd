---
name: "Lost in the middle — LLMs use long context non-uniformly; middle-positioned content is recalled worst"
topic: "failure-modes"
tags: ["pattern:recommended", "long-context", "retrieval-degradation", "context-ordering", "failure-mode", "top-k"]
summary: "Liu et al. (arXiv:2307.03172; TACL 2024) show LM accuracy depends on WHERE relevant content sits in the input: U-shaped, best at the start/end and worst in the middle, even for long-context models. This is the LLM-era form of 'retrieval degrades with volume' and the empirical basis for capping top-k and ordering high-relevance cases at the context edges rather than dumping the candidate set."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 8
type: best-practice
data_quality: verified
---

# content

name: Lost in the middle (long-context degradation)
description: Liu et al. (2023, arXiv:2307.03172; published TACL 2024) systematically evaluate how language models use long contexts and find performance is highest when the relevant information appears at the beginning or end of the input and degrades significantly when it is placed in the middle — the "lost in the middle" effect.

how_it_works:
  - Controlled multi-document QA and key-value retrieval, varying the position of the relevant document and the total context length.
  - Accuracy follows a U-shaped curve across positions; mid-context retrieval is worst.
  - Implication for a retrieval pipeline: retrieved items are not interchangeable — position and count matter.
strengths:
  - Empirical, peer-reviewed basis for bounding the number of retrieved cases and ordering them by score.
  - The LLM-era statement of the same failure as the classical "swamping" (sibling file 15): volume hurts.
weaknesses:
  - Measures recall of planted evidence, not the downstream utility of ranked cases.
  - Newer long-context / retrieval-trained models may flatten the curve; the effect size is model-dependent.
  - Says nothing about which ranking formula to use (that is sibling file 11).
references:
  - Liu, N.F. et al. (2023/2024). "Lost in the Middle: How Language Models Use Long Contexts." arXiv:2307.03172; TACL 2024 (ACL Anthology 2024.tacl-1.9).
  - Repo: https://github.com/nelson-liu/lost-in-the-middle
source:
  - arXiv abstract + ACL Anthology + Stanford PDF (via Google search 2026-09-25)
data_quality: verified
tags:
  - pattern:recommended
  - long-context
  - retrieval-degradation
  - context-ordering
  - failure-mode
  - top-k
summary: "Liu et al. (arXiv:2307.03172, TACL 2024) show long-context accuracy is U-shaped by position — worst in the middle. The LLM-era 'retrieval degrades with volume': bound top-k and order by score rather than injecting the whole candidate set. Sibling to classical swamping (file 15)."

## What the source SAID vs what I INFERRED
- SAID (ACL Anthology / arXiv via Google snippet): "Our analysis provides a better understanding of how language models use their input context and provides new evaluation protocols for future long-context [models]."
- SAID (secondary/blog snippets summarising the paper): performance is worst when the relevant information is in the middle of a long context.
- INFERRED: the design consequences — cap top-k, order by relevance, do not whole-corpus-inject.
- DEPENDENCY: exact citation count and the U-shape curve are from the paper's described result; I did not read the full PDF (fetch backend down), but the abstract + ACL venue are verified.

## Confidence
- Paper, venue, and core finding (position-dependent long-context degradation): **HIGH** (arXiv + ACL Anthology + Stanford PDF + repo, all surfaced).
- "U-shaped" precise shape: **MEDIUM** (from secondary summaries; abstract not deep-read).

## Verdict: ADOPT AS A DESIGN CONSTRAINT (adopt)
Bound the retrievable top-k and order by the multi-signal score; never inject the whole candidate
set. Pairs with the utility problem (file 08) and swamping (sibling 15) as the volume-hurts family.
