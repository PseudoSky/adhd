---
name: "obscenity — precision-first profanity matcher (MIT, 433k wk)"
topic: tool-catalog
tags: [agent:approved, tool, profanity, bad-language, false-positives, typescript]
project_path: /Users/nix/dev/ai/scratch
importance: 7
source: tool_output
data_quality: verified
summary: "Obscenity is a MIT profanity matcher for Node/TS, 433k weekly downloads, v0.4.6. Its transformer design catches obfuscated variants AND its whitelist+word-boundary model is the explicit answer to the Scunthorpe FP problem. Offline, microsecond-fast. Approved as the profanity/bad-language matcher for category 4."
metrics_source:
  version_license_repository: "npm view obscenity version license repository.url"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/obscenity"
  features: "https://raw.githubusercontent.com/jo3-l/obscenity/main/README.md"
---

name: obscenity
category: profanity / bad-language (reputation risk cat. 4)
description: Robust, extensible profanity filter for Node.js/TypeScript. The best-in-class *matcher* for a "bad language" pass: transformer-based pattern matching catches obfuscated variants (fuuuuuuckkk, leet, unicode lookalikes) that plain substring lexicons miss, and is explicitly designed around FALSE-POSITIVE reduction.
key_fp_features:
  - Whitelisted phrases are just an array of strings — the Scunthorpe problem is handled by adding exceptions.
  - Word-boundary matching is a first-class toggle (vital: substring matching is the #1 profanity FP source).
  - Default dataset is removable/editable per word (no lock-in to words you disagree with).
  - Transformations (leet decoding etc.) can be individually disabled when they over-match.
offline: yes (pure JS, no network). speed: per-file string scan, microseconds; no model.
use_cases:
  - Stage-1 lexicon/pattern pass over all tracked files + commit messages + docs + test fixtures.
language: TypeScript/JavaScript
evidence: npm view obscenity → version 0.4.6, license MIT, repo github.com/jo3-l/obscenity; 433,306 weekly downloads (npm downloads API); README fetched (whitelist/word-boundary/transformer features).
