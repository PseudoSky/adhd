---
name: "badwords-list — flat English profanity lexicon (MIT, 232k wk)"
topic: tool-catalog
tags: [agent:approved, tool, profanity, bad-language, lexicon]
project_path: /Users/nix/dev/ai/scratch
importance: 5
source: tool_output
data_quality: verified
summary: "badwords-list (MIT, 232k weekly, v2.0.1-4) is the most-used flat English profanity lexicon. Approved as a lexicon source — but must be paired with word-boundary matching, never substring, or the Scunthorpe FP rate explodes."
metrics_source:
  version_license_repository: "npm view badwords-list version license repository.url"
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/badwords-list"
---

name: badwords-list
category: profanity / bad-language (cat. 4)
description: A consumable list of bad (profanity) English words — a flat lexicon (fork of the abandoned `badwords`). The most-downloaded pure lexicon in this space and the base dictionary that `leo-profanity` is built on.
features:
  - { array, object, regex } exports from one list.
  - Multi-language siblings (french-badwords-list, badwords-ko, etc.).
offline: yes. speed: instant.
caveat: flat list = maximum Scunthorpe FP risk if used with substring matching; use word boundaries.
evidence: npm view badwords-list → 2.0.1-4, MIT, repo github.com/web-mech/badwords-list; 232,455 weekly downloads.
