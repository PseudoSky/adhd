---
name: "Write-time conflict resolution — ADD / UPDATE / DELETE / NOOP classifier (Mem0)"
topic: "cbr-patterns"
tags: ["pattern:recommended", "deduplication", "supersession", "conflict-resolution", "concurrency"]
summary: "For every candidate write, compare it against the top-K (≈5-10) closest existing records and classify the operation: ADD, UPDATE (merge), DELETE (mark old INVALID + write new with a supersedes pointer), or NOOP. Bounded cost (one resolver call per write), keeps a continuously-growing KB internally consistent. Under concurrent writers it must be made idempotent."
importance: 8
type: best-practice
data_quality: estimated
---

# content

name: Write-time conflict resolution ADD/UPDATE/DELETE/NOOP
description: A per-write classifier (Mem0's ADD/UPDATE/DELETE/NOOP resolver) that decides how a new fact relates to existing facts, keeping the store consistent without a global re-scan on every write.

how_it_works:
  - Fetch the top-K (K ≈ 5-10) closest existing records to the candidate (by embedding similarity).
  - Classify into exactly one operation:
    - ADD — no semantically equivalent record exists; write the candidate as a new entry (default).
    - UPDATE — a closely related record exists and the candidate augments it; merge into the existing entry.
    - DELETE — the candidate contradicts an existing record; mark the old INVALID (do NOT physically remove) and write the candidate as a separate entry with a `supersedes` pointer to the old.
    - NOOP — the candidate is already represented; discard.
  - Mem0 reports the resolver runs on every memory update and is the primary mechanism by which the store stays consistent. It stays above accuracy threshold up to ~30% contradiction density; beyond that it saturates (queueing "saturation knee").
  - Backup mechanism: a periodic "sleep-time" consolidation pass runs the resolver over every record pair within a category (not just top-K-similar), catching the false-negative cascade the per-write pass missed. Mem0 reports it catching 5-10% additional contradictions per pass on a steady-state store.
  - Three detection modes combined in production: detect-on-write (cheap, obvious cases), detect-on-consolidation (background pass), detect-on-read (safety net when retrieval surfaces two contradictory candidates).

strengths:
  - Keeps the KB consistent at bounded per-write cost — no full O(N) reorganisation.
  - Non-destructive: DELETE is really INVALIDATE + supersedes, preserving history and auditability.
  - Directly answers "what triggers reorganization" — writes themselves, plus a periodic catch-up pass.

weaknesses:
  - Adds an LLM call (or classifier) to every write — a real latency/cost line item.
  - False-negative cascade: if the embedding similarity between old and new is below the candidate threshold, a genuine contradiction is missed until consolidation.
  - Under concurrent multi-process writers the classifier is racy: two writers can each compare against the same pre-state and both decide ADD, producing a duplicate. Needs an idempotency key / dedupe on content hash, or serialize via the store's own conflict primitives.
  - Saturation: at high contradiction density accuracy drops sharply; a queueing-theory knee.
  - User-vs-system arbitration (a new user assertion contradicting a corroborated system belief) needs an explicit policy; defaulting to "always trust the newest/user" accumulates quiet errors.

references:
  - Chhikara et al. (2025). "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory." ECAI 2025. arXiv:2504.19413 (§3 architecture: the four-operation classifier).
  - https://jatinbansal.com/ai-engineering/memory-conflict-and-forgetting/ (secondary, exact operation semantics)
  - MemoryBank arXiv:2305.10250 (read-driven strength updates); FadeMem arXiv:2601.18642 (LLM-guided conflict resolution + fusion pass).
source:
  - Mem0 (arXiv 2504.19413) via secondary survey
data_quality: estimated
type: best-practice
tags:
  - pattern:recommended
  - deduplication
  - supersession
  - conflict-resolution
  - concurrency
summary: "Per-write ADD/UPDATE/DELETE/NOOP classifier over the top-K nearest records; DELETE = INVALIDATE + supersedes pointer (never physical delete). Backup: periodic consolidation pass. Bounded per-write cost but racy under concurrent writers — needs content-hash/idempotency dedupe."

## Confidence
- Operation semantics: **MEDIUM** (Mem0 §3 via a secondary survey; primary abstract not fetched).
- Concurrency caveat: **MEDIUM** by reasoning — the classifier is a read-compare-write and the
  store is explicitly multi-process; no primary source was read that solves it, so this is
  flagged as a design risk needing the store's own dedupe/idempotency primitives.
