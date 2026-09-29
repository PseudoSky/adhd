---
name: "Pattern: Local-LLM classification for subjective/opinionated content (category 3)"
topic: tool-catalog
tags: [pattern:recommended, pattern, llm, subjective, category-3, local]
project_path: /Users/nix/dev/ai/scratch
importance: 8
source: synthesis of search (Ollama / local guardrail projects)
data_quality: estimated
type: best-practice
summary: "No off-the-shelf deterministic or classifier tool detects 'personal / opinionated / confidential-sounding' statements (category 3) — it is a semantic judgement. The only viable offline path is a LOCAL LLM (Ollama / llama.cpp) prompted with a narrow, structured yes/no rubric, run over Stage-1/2 CANDIDATES only. This is a BUILD, not an integrate."
---

name: Pattern — Local-LLM subjective-content classification (cat. 3)
description: The escape hatch for the one category no lexicon or classifier covers: first-person opinions, politically sensitive remarks, private thoughts, off-brand/confidential commentary in code, docs, comments, or commit messages.
how_it_works:
  - "1. Run offline via Ollama or llama.cpp (a small quantized model) — satisfies the local/offline constraint and avoids the paid-API exception."
  - "2. Ask a NARROW, structured question per candidate chunk: 'Is this a first-person personal opinion, an unprofessional/hostile remark, or confidential internal commentary? Answer JSON {flag, category, quote, confidence}.'"
  - "3. Feed it ONLY candidates: prose files + commit messages, and ideally only those already triaging non-empty or flagged by cheaper stages — never the whole corpus."
  - "4. Constrain output to strict JSON and require a confidence field; route low-confidence to human review; keep an allowlist for known-benign phrasing."
  - "5. Prompt-injection note: repo content is untrusted input to the classifier — wrap it in delimiters and instruct the model to treat it as data, not instructions."
strengths:
  - The only technique that can judge tone/intent/context for category 3.
  - Fully offline; deterministic scaffolding (fixed prompt, JSON schema, allowlist) around a probabilistic core.
weaknesses:
  - Probabilistic — needs thresholding + human review; can drift with model choice; per-chunk latency is real (candidate-only gating mandatory).
  - A local model's judgement of 'confidential-sounding' is subjective; treat its flags as triage candidates, never as verdicts.
references:
  - Local guardrail projects: github.com/agnish-dev/GuardRail-LLM (llama3.2:1b intent classifier), github.com/moghalsaif/llm-guardrail-detector-using-ml-intern (Ollama); NeMo Guardrails local dev (redhat).
evidence: DDG surfaced multiple local-LLM guardrail/classifier projects; no registry package offering subjective/opinionated detection exists — confirms this is a build.
