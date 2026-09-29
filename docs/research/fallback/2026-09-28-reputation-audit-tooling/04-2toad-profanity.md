---
name: "@2toad/profanity — multi-language profanity filter (MIT, 116k wk)"
topic: tool-catalog
tags: [agent:approved, tool, profanity, bad-language, multilingual, typescript]
project_path: /Users/nix/dev/ai/scratch
importance: 6
source: tool_output
data_quality: verified
summary: "@2toad/profanity (MIT, 116k weekly, v3.3.0) is a multi-language TS profanity filter with a `wholeWord` precision toggle. Approved — strongest of the JS profanity libs when multi-language coverage matters; obscenity preferred when obfuscated-variant matching matters more."
metrics_source:
  version_license_repository: "npm view @2toad/profanity version license repository.url"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/@2toad/profanity"
  features: "https://raw.githubusercontent.com/2Toad/Profanity/main/README.md"
---

name: @2toad/profanity
category: profanity / bad-language (cat. 4)
description: Multi-language profanity filter with first-class TypeScript support and configurable precision behaviour. A viable alternative matcher to obscenity, stronger on multi-language coverage (English/German/etc).
key_fp_features:
  - `wholeWord` option (default off) — turning it on eliminates substring FPs.
  - Configurable grawlix, per-language enable/disable, custom word lists.
maintenance: published by GitHub Actions OIDC trusted publisher; last release 2026-03 (actively maintained).
offline: yes. speed: microsecond string scan.
evidence: npm view @2toad/profanity → 3.3.0, MIT, repo github.com/2Toad/Profanity; 115,892 weekly downloads; README fetched (wholeWord option).
