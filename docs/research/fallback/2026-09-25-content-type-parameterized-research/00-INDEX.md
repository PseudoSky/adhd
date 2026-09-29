---
kind: index
note: "NOT a finding — navigation + prior-work cross-reference for the run."
project_path: /Users/nix/dev/ai/sox-ecosystem
---

# Content-type-parameterized research pipelines + reusable-library retrieval — fallback index

**Run:** 2026-09-25. **Memory server was DOWN** (memory_ping timed out 3x, `MCP error -32001`),
so ALL findings below are fallback files, NOT yet in memory. Search MCP had two failures too:
`duckduckgo` timed out on every call (substituted `google`); the `fetch` (browser/CDP) provider
timed out on every call (`CDP timeout: Page.enable`) so no deep page reads were possible. All
evidence is from network-provider search snippets + Wikipedia + npm.

## New findings in THIS directory (not duplicated elsewhere)

RQ1 — content-type parameterization prior art:
- `01-apache-uima-type-system-annotators.md`
- `02-apache-tika-content-type-parser-dispatch.md`
- `03-schema-on-read-lakehouse-typed-interpretation.md`

RQ2 — systems that grow a reusable library from experience:
- `04-voyager-skill-library.md`
- `05-expel-experiential-learning.md`
- `06-reflexion-episodic-memory.md`
- `07-memgpt-virtual-context-tiered-memory.md`

RQ3 — failure modes:
- `08-ebl-utility-problem.md`
- `09-lost-in-the-middle-context-degradation.md`
- `10-write-only-knowledge-base-antipattern.md` (LOW confidence / unresolved)

## PRIOR WORK FOUND ON DISK (memory was down; this substitutes for recall)

`docs/research/fallback/2026-09-25-cbr-case-library/` — written by a sibling agent the same day,
same target problem. **Overlaps that I deliberately did NOT duplicate:**
- `09-pattern-4r-cycle-case-representation.md` — Aamodt & Plaza 4R cycle, case = problem+solution+outcome+provenance.
- `10-pattern-verified-outcome-retention-gate.md` — retain on verified outcome (the caller's invariant).
- `11-pattern-multi-signal-retrieval-scoring.md` — **the Generative Agents `score = α·recency + β·importance + γ·similarity` formula, MemoryBank Ebbinghaus decay, Mem0, and the vstash NEGATIVE result** (extra ranking terms failed to beat a baseline on 5 BEIR datasets). This IS the RQ2 ranking-signal answer; cite it, don't rewrite it.
- `15-pattern-case-base-maintenance.md` — **Smyth & Keane 1995 swamping / competence-preserving deletion** (the RQ3 CBR failure mode), Leake & Wilson, Zhu.
- `14-pattern-write-time-conflict-resolution.md`, `16-pattern-supersession-exclusion.md` — write-time and read-time conflict handling.
- `01`–`08` — hybrid-search tool evaluations (sox, fusion-rank, lathrys@ruffle, neo4j, pghybrid, myceliumhq, kurajs, retriv).

`docs/research/fallback/2026-09-25-sqlite-migration-safety/` — unrelated topic (migration tooling).
`docs/research/fallback/2026-09-22-sqlite-multiprocess-failure-modes/` — unrelated topic.
