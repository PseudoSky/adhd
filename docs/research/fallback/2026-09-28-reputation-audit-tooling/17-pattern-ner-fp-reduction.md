---
name: "Pattern: NER false-positive reduction levers (make Presidio usable as a second stage)"
topic: tool-catalog
tags: [pattern:recommended, pattern, ner, false-positives, precision]
project_path: /Users/nix/dev/ai/scratch
importance: 8
source: Presidio docs + kit's measured FP tuning
data_quality: estimated
type: best-practice
summary: "Presidio NER over full repos is unusable as a gate (~5,200 FP/repo, ~92s/repo) but becomes viable as a CANDIDATE-ONLY second stage once you apply seven levers: prose-only scope, code-fence stripping, entity narrowing, score threshold, allow-lists, deny-lists/name dictionaries, and gibberish/code filtering. The kit already implements the first five."
---

name: Pattern — NER false-positive reduction levers
description: The concrete controls (measured by the kit) that turn spaCy/Presidio from a 5,200-FP firehose into a triageable second-stage signal.
how_it_works:
  - "1. SCOPE to prose only — extension allowlist (.md/.txt/.rst/.adoc). NER on .json/.jsonl/config/minified files is slow AND a false-positive factory (camelCase identifiers → PERSON)."
  - "2. STRIP CODE before NER — remove fenced code blocks and inline code spans in markdown, or identifiers get tagged as PERSON."
  - "3. NARROW entities — keep only the 4 regex can't do (PERSON/EMAIL/PHONE/LOCATION); SSN/card/IBAN/IP are the checksum layer's job, so NER need not re-derive them."
  - "4. SCORE THRESHOLD — raise score_threshold (kit default 0.7; raise further) to trade recall for precision."
  - "5. ALLOW-LISTS — Presidio supports allow_list per analyze() call and allow-list recognizer config; add repo-specific terms (project names, common nouns misread as names)."
  - "6. DENY-LISTS / name dictionaries — Presidio deny_list recognizers let you target the specific person/organization names you actually care about, instead of accepting every NER PERSON guess. This inverts the problem: precision-first by construction."
  - "7. GIBBERISH / CODE filter — drop candidate strings that are not natural language (has no spaces, mixed case+underscores, high symbol ratio) before judging them a name."
strengths:
  - Converts a probabilistic firehose into a bounded, tunable signal; the deny-list/name-dictionary lever is the single biggest precision win.
weaknesses:
  - Each lever trades recall; over-filtering hides a real name. Requires a labelled sample to calibrate — do not tune blind.
  - Model cost is unchanged (still per-chunk), so gating on candidates remains mandatory.
references:
  - Presidio allow-list tutorial: https://github.com/data-privacy-stack/presidio/blob/main/docs/tutorial/13_allow_list.md
  - Presidio deny-list tutorial (data-privacy-stack/presidio); spaCy NER FP discussion: https://github.com/explosion/spaCy/discussions/11131
evidence: kit presidio-batch.py implements levers 1–5 (measured); Presidio docs confirm allow_list/deny_list APIs; spaCy discussion confirms the FP-reduction framing.
