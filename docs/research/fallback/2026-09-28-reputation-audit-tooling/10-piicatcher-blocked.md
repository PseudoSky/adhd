---
name: "piicatcher — DB/data-warehouse PII scanner (Apache-2.0, BLOCKED)"
topic: tool-catalog
tags: [agent:blocked, tool, pii, database]
project_path: /Users/nix/dev/ai/scratch
importance: 5
source: tool_output
data_quality: verified
summary: "piicatcher (Apache-2.0, 0.21.2, only ~391 downloads/mo) is a PII scanner for DATABASES and data warehouses — it profiles table columns, not source repos. Blocked: wrong target (structured stores, not code/docs/commit messages) and inherits spaCy's cost/FP profile."
metrics_source:
  version_license: "https://pypi.org/pypi/piicatcher/json"
  downloads: "https://pypistats.org/api/packages/piicatcher/recent"
---

name: piicatcher (tokern)
category: single-suite candidate (cat. 1/2)
description: An open-source scanner for PII/PHI that finds PII in DATABASES, data warehouses, and file systems, using regex on column names + NLP (spaCy) on sample column data. Often pitched as an "open-source Amazon Macie".
why_blocked: it targets STRUCTURED DATA STORES (databases, warehouses, CSV column profiling), not SOURCE-CODE REPOSITORIES. Its unit of analysis is a table column, not a line of code, a comment, or a commit message — the exact surfaces a reputation audit cares about. It also inherits the same spaCy NER cost/FP profile. Adoption is very low (~391/mo).
evidence: pypi piicatcher → 0.21.2, Apache 2.0; pypistats month 391 / week 69; DDG/PyPI description confirms database/file-system column profiling.
