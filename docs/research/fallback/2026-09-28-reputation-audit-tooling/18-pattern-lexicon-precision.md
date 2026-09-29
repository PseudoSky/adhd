---
name: "Pattern: Lexicon precision — boundaries, sureness, whitelists (beat the Scunthorpe problem)"
topic: tool-catalog
tags: [pattern:recommended, pattern, profanity, lexicon, false-positives]
project_path: /Users/nix/dev/ai/scratch
importance: 7
source: tool docs (obscenity, cuss, @2toad)
data_quality: estimated
type: best-practice
summary: "A raw profanity wordlist is a false-positive machine (substring matches inside innocent words — the Scunthorpe problem). Three levers make a lexicon pass precise enough to run over everything: word-boundary matching, sureness-graded lexicons, and explicit whitelists."
---

name: Pattern — Lexicon precision levers
description: How to run a profanity/abuse lexicon over all 70 repos without drowning in FPs.
how_it_works:
  - "1. WORD BOUNDARIES always — substring matching is the single biggest FP source; both obscenity (toggle) and @2toad (wholeWord) expose this."
  - "2. SURENESS GRADING — cuss maps each term to a sureness rating; gate pass 1 on high-sureness only, defer the graded middle band."
  - "3. EXPLICIT WHITELISTS — obscenity treats whitelisted phrases as a plain string array; add repo/project-specific exceptions rather than dropping a rule globally."
  - "4. EDITABLE DATASET — remove terms you don't consider a reputation risk (a filter tuned for a chat app over-matches technical prose)."
strengths:
  - Deterministic, offline, microsecond-fast, fully configurable — the ideal all-repos Stage-1 layer for category 4.
weaknesses:
  - Lexicons cannot catch context-dependent or novel abuse (no slur list is complete; sarcasm/implicit threats missed) — needs the toxicity classifier/LLM stage behind it.
  - Multi-language coverage varies; a monolingual repo is fine, a mixed-language one needs per-language lists.
references:
  - https://github.com/jo3-l/obscenity#readme ; https://github.com/words/cuss#readme ; https://github.com/2Toad/Profanity
evidence: READMEs fetched — obscenity whitelist/word-boundary/transformer; cuss sureness map; @2toad wholeWord option.
