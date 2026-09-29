---
name: "Utility problem — learned/added knowledge can DEGRADE system performance (EBL and CBR)"
topic: "failure-modes"
tags: ["pattern:antipattern", "utility-problem", "explanation-based-learning", "retrieval-cost", "marginal-return", "failure-mode"]
summary: "The utility problem is the foundational, named counter-evidence to 'more knowledge is always better': knowledge learned to improve performance can raise retrieval/match cost enough to degrade overall performance. Originates in explanation-based learning (Minton, AAAI) and recurs in CBR. It gives a measurable criterion (utility = benefit − cost) for a Retain/promote gate and explains how an append-only catalog can hit diminishing/negative returns."
project_path: /Users/nix/dev/ai/sox-ecosystem
importance: 9
type: best-practice
data_quality: estimated
---

# content

name: Utility problem (EBL / CBR)
description: In learning systems, adding knowledge (EBL macro-rules, or more cases) has two effects: it can reduce the work to solve a problem, and it increases the work to find/apply the right knowledge. When the second outweighs the first, system performance DEGRADES as it "learns". Minton's AAAI work on PRODIGY/EBL names and analyses this; the same phenomenon recurs in CBR.

how_it_works:
  - Each learned (macro-)rule is simultaneously a potential speedup (skips search steps) and a cost (one more rule to match per decision).
  - Utility = net of benefit minus cost; utility can be negative.
  - Mitigations: filter/reorder learned knowledge by measured utility; cap the number/scope of learned rules; validate a new rule against an outcome metric before promoting it.
strengths:
  - A precise, measurable criterion for whether to RETAIN/promote a case or rule — not "did it come from an experience" but "does it improve outcomes net of retrieval cost".
  - Directly models the caller's observed skew (1,509 tool entries vs 62 technique entries ≈ 24:1): volume without retrieval benefit is the utility problem.
  - Aligns with the sibling vstash NEGATIVE result (extra ranking terms must be validated against NDCG, not assumed).
weaknesses:
  - Utility is workload-dependent: knowledge that helps one problem set can hurt another.
  - Measuring utility needs a problem distribution and an outcome metric — both expensive to maintain.
  - Classical EBL assumes a crisp domain theory; LLM-extracted insights are fuzzier, so the classical bounds may not transfer directly.
references:
  - Minton, S. (1990). "Why PRODIGY/EBL Works." AAAI. (Google snippet: The Association for the Advancement of Artificial Intelligence)
  - "The Effect of Rule Use on the Utility of Explanation-Based Learning" (UT Austin PDF, via Google snippet).
  - "A statistical approach to solving the EBL utility problem" — Google snippet: "as transformations that improve performance on one set of problems can degrade performance on other sets".
  - "A comparative utility analysis of case-based reasoning and [rule-based]" — Google snippet quote below.
  - "The Utility Problem in Case-Based Reasoning" (Georgia Tech PDF, via Google snippet).
  - Tadepalli & Natarajan, "A Formalization of Explanation-Based Macro-operator Learning" (IJCAI) — Google snippet: "the best way to address the utility problem in EBL is to implement a bias which exploits the problem-space structure".
source:
  - EBL/CBR utility-problem literature (titles/venues via Google search 2026-09-25)
data_quality: estimated
tags:
  - pattern:antipattern
  - utility-problem
  - explanation-based-learning
  - retrieval-cost
  - marginal-return
  - failure-mode
summary: "The utility problem (Minton, EBL; recurs in CBR) is the named counter-evidence to 'more knowledge is better': added knowledge raises retrieval/match cost and can degrade overall performance. It yields a measurable Retain/promote gate (utility = benefit − cost) and explains write-volume-without-reuse (the 1509:62 skew)."

## What the source SAID vs what I INFERRED
- SAID (comparative-utility-analysis PDF via Google snippet): "The utility problem in learning systems occurs when knowledge learned in an attempt to improve a system's performance degrades performance". (Direct quote.)
- SAID (Google snippets, titles): Minton "Why PRODIGY/EBL Works" (AAAI); "The Effect of Rule Use on the Utility of Explanation-Based Learning" (UT Austin); "A statistical approach to solving the EBL utility problem"; "The Utility Problem in Case-Based Reasoning" (Georgia Tech); Tadepalli IJCAI.
- INFERRED: the general form (benefit − cost, workload-dependence, filtering/reordering as mitigation) and its application to a case library's Retain gate.

## Confidence
- The phenomenon + its name + a direct definitional quote: **HIGH** (multiple independent PDFs/titles + a verbatim definition).
- Exact numeric results from Minton's experiments: **MEDIUM** (paywalled/PDF not read — fetch backend down).

## Verdict: ADOPT AS A DESIGN CONSTRAINT (adopt)
Require a measured utility (benefit vs retrieval cost) for promoting/keeping knowledge, and
validate added ranking terms against an outcome metric (cf. the vstash negative result in sibling
file `11-...multi-signal-retrieval-scoring.md`). This is the principled answer to "the catalog is
write-only and huge".
