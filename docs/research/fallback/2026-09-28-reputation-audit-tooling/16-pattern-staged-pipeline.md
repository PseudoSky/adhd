---
name: "Pattern: Precision-first staged sweep (fast-everywhere → heavy-on-candidates)"
topic: tool-catalog
tags: [pattern:recommended, pattern, pipeline, precision, staged, scale]
project_path: /Users/nix/dev/ai/scratch
importance: 8
source: synthesis of measured results + tool docs
data_quality: estimated
type: best-practice
summary: "The make-or-break answer for a 70-repo reputation sweep: run cheap, deterministic, high-precision layers over EVERYTHING, and reserve expensive/probabilistic layers (NER, toxicity transformer, local LLM) for CANDIDATES or SAMPLES only. Every measured cost/FP result in this corpus (regex seconds/repo & low FP; Presidio ~92s/repo & ~5,200 FP/repo) supports this split."
---

name: Pattern — Precision-first staged sweep
description: A four-stage pipeline that keeps the all-repos pass fast and precise, escalating only candidates to heavier analysis.
how_it_works:
  - "Stage 0 — scope: scan the GIT-TRACKED tree (git ls-files / git archive HEAD), never the raw filesystem (gitleaks dir swept untracked .gitnexus/tmp → 382 FPs). Apply path allowlists (lockfiles, vendored, node_modules). History is a separate axis (every blob)."
  - "Stage 1 — deterministic over EVERYTHING (all files + all history blobs + all commit messages): regex/checksum PII (SSN, Luhn card+context, IBAN mod-97, E164, private IPv4, AWS ARNs, connection strings), gitleaks secrets, corporate host/domain context gates, AND a word-boundary profanity/lexicon pass (obscenity/cuss). Cost: seconds/repo, very low FP."
  - "Stage 2 — cheap probabilistic over PROSE ONLY (the subset Stage 1 can't reach): alt-profanity-check (sklearn, near-regex speed) and, for non-US addresses, a regex/context extractor + usaddress/Presidio LOCATION. Candidate/context-gated."
  - "Stage 3 — heavy semantic over CANDIDATES ONLY / SAMPLED: Detoxify (multi-label toxicity) and Presidio NER — prose-only extension allowlist, code-fence stripping, 4-entity narrowing, score threshold, allow/deny lists. Bounded chunk/byte caps, parallel across cores."
  - "Stage 4 — LLM over the residual subjective set only: a local model (Ollama) asked a narrow, structured yes/no per candidate chunk for opinionated/confidential-sounding content (cat. 3). The last resort only because nothing deterministic can do it."
strengths:
  - Precision is preserved because the noisy classifiers never see the whole corpus.
  - Cost scales linearly with the small candidate set, not with repo size.
  - Each stage is independently tunable (threshold/allowlist) and independently skippable.
weaknesses:
  - A cheap Stage-1 miss can hide a real item from the heavy stages (recall risk) — mitigate with a SAMPLED Stage-3 over random clean files, not only candidates.
  - History multiplies Stage-1 volume (acceptable: it stays cheap); Stage 3 should run over HEAD/docs + a history SAMPLE.
references:
  - measured: regex/checksum ~seconds/repo low-FP; Presidio ~92s/repo, ~5,200 FP/repo (this engagement).
  - gitleaks allowlists/baselines (deepwiki); Presidio allow/deny-list tutorials (data-privacy-stack/presidio).
evidence: composed from the measured results in the prompt + kit FP lessons + live tool docs.
