---
name: "Use case: repo-hygiene-kit/audit — the existing internal sensitive-data audit"
topic: tool-catalog
tags: [use-case:reference, repo-hygiene, audit, pii, internal-solution]
project_path: /Users/nix/dev/ai/scratch
importance: 8
source: internal codebase read (read-only)
data_quality: verified
type: production-implementation
summary: "The internal solution already exists: repo-hygiene-kit/audit/ orchestrates gitleaks + a zero-dep builtin PII/corporate/shape scanner + full-history blob scan + Presidio NER (precision-first batch) into one masked report. It fully covers categories 1(partial)/2/5 and is the base to extend; categories 3 and 4 are absent."
---

name: Use case — repo-hygiene-kit/audit (internal)
description: The read-only PII/corporate/secret audit already built at ~/dev/ai/scratch/repo-hygiene-kit/audit/.
context: A bash orchestrator (audit.sh) runs layers into audit-out/<ts>/ and merges via report.py into masked report.json/.md.
approach:
  - "credentials: gitleaks over the git-tracked tree (git archive HEAD) + optional gitleaks git for history."
  - "pii/corporate/shape: builtin_scan.py (zero-dep) — SSN, card(Luhn+context), IBAN(mod-97), email/phone density, person-record dump; corporate internal domains (AUDIT_INTERNAL_DOMAINS), host suffixes (context-gated), RFC1918, AWS ARNs, connection strings; masked output."
  - "history: full-history.py — replays builtin rules over EVERY blob via git cat-file --batch."
  - "NER: presidio-batch.py — prose-only extension allowlist, markdown code-fence stripping, 4 entities, score 0.7, per-file byte+chunk caps, ProcessPoolExecutor parallelism (built precisely because an unbounded scan ran 30+ min)."
  - "output: masked, never raw values; report.py normalizes + ranks."
key_takeaway: This IS the 'single suite' for the audit — no external suite matches it. Extend it: add Stage-1 lexicon profanity (obscenity/cuss), a Stage-2/3 toxicity (alt-profanity-check/Detoxify), commit-message scanning, and a Stage-4 local-LLM subjective pass. Its measured FP lessons (scope to tracked tree; context-gate host rules; drop .local; card context; 456→8 findings) are the reusable tuning rules.
evidence: files read in full — audit.sh, builtin_scan.py, presidio-batch.py, full-history.py, report.py, README.md.
