---
name: "Use case: PseudoSky public-repo secret audit (60 repos, gitleaks, batch 2)"
topic: tool-catalog
tags: [use-case:reference, public-repo, gitleaks, audit, pseudosky]
project_path: /Users/nix/dev/ai/scratch
importance: 7
source: prior memory episodes (01M3MWWNDVMFGB7HX1RE9K1XDF, 01M3MWWNWQ091ZSVGXKFYRGBJH)
data_quality: verified
type: production-implementation
summary: "A prior ~60-repo PUBLIC-repo audit of the PseudoSky GitHub owner already ran offline: gh api enumeration, per-repo tree flagging on 38,258 blobs, gitleaks 8.30.1 git --log-opts=--all over 29 clones, plus fork analysis. Verdict: effectively clean (two 2016 Google Maps keys + a placeholder session secret). It proves the method scales to ~70 repos and supplies the reusable techniques."
---

name: Use case — PseudoSky public-repo audit (the ~70-repo precedent)
description: The closest existing precedent for this exact engagement: an offline secret/PII audit across the PseudoSky GitHub owner's public repos.
context: ~60 own repos + a fork set, scanned 2026-09-28.
approach:
  - "Enumerate via gh api users/<owner>/repos (authenticated 5000/hr)."
  - "Per-repo git/trees/HEAD?recursive=1; filename+size flagging across 38,258 blobs."
  - "gitleaks 8.30.1 `git --log-opts=--all` over all-branch clones of own repos."
  - "Fork 'untouched?' test = compare fork default vs parent via `.../<parent_owner>:<branch>` (full_name:branch 404s); sweep EVERY branch tip author for the operator's identities (default-branch compare misses other branches)."
  - "zsh does NOT word-split unquoted vars — run loops from a bash script file, not inline."
key_takeaway: The method scales to ~70 repos at low cost and is already proven. REUSE it, and layer the reputation categories (3/4) that a secrets-only audit did not cover: profanity/abuse lexicons, toxicity classifiers, and the local-LLM subjective pass. Fork/branch scope matters — a default-branch-only scan misses operator commits on other branches.
evidence: memory episodes 01M3MWWNDVMFGB7HX1RE9K1XDF and 01M3MWWNWQ091ZSVGXKFYRGBJH (verified prior runs).
