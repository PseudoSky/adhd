---
name: "scrubadub — PII scrubbing library (MIT, BLOCKED: redundant with Presidio)"
topic: tool-catalog
tags: [agent:blocked, tool, pii, ner, redundant]
project_path: /Users/nix/dev/ai/scratch
importance: 5
source: tool_output
data_quality: verified
summary: "scrubadub (MIT, 2.0.1) is a solid free-text PII scrubber whose name/address detection comes from plugin packages (scrubadub_spacy, scrubadub_address via libpostal). Blocked for the primary path because it duplicates the already-integrated Presidio NER layer (same model class, same FP/cost profile) rather than adding a distinct capability. Keep as a documented lighter alternative."
metrics_source:
  version_license: "https://pypi.org/pypi/scrubadub/json"
---

name: scrubadub
category: PII / NER alternative (cat. 1/2)
description: A Python library that removes PII from free text. Core is regex-based; name/address detection come from optional plugins (scrubadub_spacy for names, scrubadub_address which needs libpostal).
license: MIT. offline: yes.
why_blocked: the kit ALREADY integrates Presidio (MIT) + spaCy for names/addresses. scrubadub reaches the same result via the same class of model (spaCy) or libpostal, so it adds a second parallel stack and no new capability for this use case. Its regex core overlaps the zero-dep builtin layer. It is not wrong, just redundant — record it as the fallback if Presidio is ever unavailable.
evidence: pypi scrubadub → 2.0.1, MIT; DDG/readthedocs confirm scrubadub_address + scrubadub_spacy plugin architecture.
