---
name: "LDNOOBW — Shutterstock profanity blocklist (CC-BY-4.0, FLAG)"
topic: tool-catalog
tags: [agent:approved, tool, profanity, bad-language, lexicon, license-flag]
project_path: /Users/nix/dev/ai/scratch
importance: 6
source: tool_output
data_quality: verified
summary: "LDNOOBW/Shutterstock is the canonical multilingual profanity blocklist (3.4k stars) — but its license is CC-BY-4.0, so shipping it carries an ATTRIBUTION obligation and is FLAGGED, unlike the MIT lexicons (cuss, badwords-list). Approved for use with the attribution recorded; prefer an MIT lexicon if attribution-in-product is undesirable."
metrics_source:
  license_stars: "https://api.github.com/repos/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words"
---

name: LDNOOBW (List of Dirty, Naughty, Obscene, and Otherwise Bad Words)
category: profanity / bad-language (cat. 4)
description: Shutterstock's published, multilingual profanity/slur blocklist — the canonical open lexicon for content filtering. Data-only; widely mirrored and forked (e.g. LDNOOBW_V2).
license_caveat: CC-BY-4.0 — requires attribution. NOT a permissive code license; if shipped inside a product the attribution obligation must be honoured and recorded. This is a FLAG item, not a silent dependency (unlike the MIT lexicons cuss / badwords-list).
features:
  - Per-language files (en, de, fr, es, ru, ...).
  - Community-maintained V2 extension (LDNOOBWV2) for the abandoned original.
offline: yes (plain text files).
evidence: GitHub API → license CC-BY-4.0, 3,453 stars; repo github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words.
