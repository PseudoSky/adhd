---
name: "cuss — graded profanity/slur lexicon (MIT, sureness ratings)"
topic: tool-catalog
tags: [agent:approved, tool, profanity, bad-language, lexicon, false-positives]
project_path: /Users/nix/dev/ai/scratch
importance: 6
source: tool_output
data_quality: verified
summary: "cuss (MIT, 78k weekly, v2.2.0) maps English profanities/slurs to a sureness rating. The graded lexicon is a usable precision gate — high-sureness-only for pass 1. Approved as a lexicon source for category 4."
metrics_source:
  version_license_repository: "npm view cuss version license repository.url"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/cuss"
  sureness_rating: "https://raw.githubusercontent.com/words/cuss/main/readme.md"
---

name: cuss
category: profanity / bad-language (cat. 4)
description: A map of English profanities, slurs, and obscenities to a *sureness rating* — a graded lexicon rather than a flat wordlist. The sureness score is the precision lever: gate on high-sureness terms only for a first pass and defer ambiguous terms to a second stage.
features:
  - Word -> sureness (0..2) map; thousands of entries, incl. slurs.
  - Data-only package (no matcher) — pair with a boundary-aware matcher or use as the lexicon source.
  - Companion packages exist for other languages (e.g. french-badwords-list).
offline: yes. speed: O(1) lookups.
use_cases:
  - Lexicon source for a Stage-1 bad-language pass; sureness lets you set a precision threshold.
language: JavaScript (data package)
evidence: npm view cuss → 2.2.0, MIT, repo github.com/words/cuss; 78,328 weekly downloads; README fetched ("Map of profanities, slurs, and obscenities to a sureness rating").
