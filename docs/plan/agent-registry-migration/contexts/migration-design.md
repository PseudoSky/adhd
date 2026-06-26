# migration-design — RESOLVE THE PARSER/LLM-PIPELINE/ANCHOR/FEAT-007/EQUIVALENCE/BOUNDARY DECISIONS + CHECK IN FIXTURES

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-registry-migration/scripts/audit_migration.py --phase architecture`

See `contexts/_shared.md` for definitions and invariants.

---

## Goal

Before any code, the design questions are RESOLVED and recorded in `decisions.md`,
and the representative FIXTURE files are checked into the package. After this state,
every later state has a binding answer for: the deterministic parser + FULL 18-type
mapping (incl. the unmapped-flag policy), the LLM pipeline contract (haiku fan-out +
sonnet consolidation, live/replay), the anchor-vocabulary linkage to Plan 8, the
FEAT-007 public `importCorpus` entrypoint, the equivalence definition + zero-loss
gate, and the cross-repo removal boundary.

This state exists FIRST because the 18-type coverage proof (`[dod.1]`), the LLM
pipeline (`[dod.2]`), and the removal gate (`[dod.5]`) are meaningless until their
contracts are written down, and the removal phase is unsafe until the gate contract
+ cross-repo boundary are fixed.

> **Runtime framing.** agent-mcp RUNS agents at runtime today. `decisions.md` must
> NOT imply this plan (or Plan 6) newly enables runtime execution — this plan only
> IMPORTS the corpus and crystallizes the methodology.

---

## Semantic Distillation

- **Primitive:** WRITE `decisions.md` + COPY IN the fixtures. No tool code yet.
- **Reference Pattern:** `[fix:frontmatter-mapping]`, `[fix:body-mapping]`,
  `[def:eighteen-types]`, `[def:llm-stage]`, `[def:anchor-vocabulary]`,
  `[def:import]`, `[inv:cross-repo]`, `[inv:zero-loss-before-removal]`.
- **Delta Spec — `decisions.md` must answer, each with a rationale:**
  1. **Parser + 18-type mapping** — the YAML frontmatter parser + markdown section
     splitter; the `## heading → prompt_type` table over the FULL 18-type set
     (`[def:eighteen-types]`); how the un-headed `You are a…` maps to `role`; how
     `position` is assigned (order of appearance, 1-indexed); and the
     **unmapped-flag policy** for the heterogeneous heading long-tail — recognizable
     forms typed deterministically, ambiguous residue recorded in `unmapped[]` for
     the LLM stages, NEVER silently dropped (`[dod.1]`).
  2. **LLM pipeline contract** (`[def:llm-stage]`) — the haiku fan-out (one
     cheap-tier call per component, parallel, over-generate candidate use-cases) →
     the single sonnet consolidation pass (dedup → canonical vocabulary + weighted
     links); the live-vs-replay split (`AGENT_REGISTRY_INGEST_LIVE`, the
     `corpus-ingest-llm` blocker, skip-not-fail offline); and the replay-capture
     format that makes `importCorpus` reproducible offline.
  3. **Anchor-vocabulary linkage to Plan 8** (`[def:anchor-vocabulary]`) — the
     sonnet-consolidated use-case set IS Plan 8's enrichment anchor vocabulary; Plan
     8 ships SEED anchors, this plan's `dataset-build` backfills the corpus-derived
     ones via Plan 8's embedding substrate; documented sequencing, not a
     `depends_on_plans` edge.
  4. **FEAT-007 public entrypoint + equivalence + zero-loss + cross-repo** —
     `importCorpus(...)` as a lib export + CLI bin (`[def:import]`, closes FEAT-007);
     the **default registry target** (F-P6-11) — with no explicit `dbPath`/`--db`/
     `AGENT_MCP_REGISTRY_DB_PATH`, `importCorpus` writes to
     `~/.adhd/agent-mcp/registry.db`, **byte-identical to the path the default-on
     agent-mcp server resolves prompts against** (`agent-mcp/src/index.ts`); writing
     anywhere else leaves the default resolver staring at an empty registry forever
     (`[import-script.4]`); the equivalence definition (byte vs. behavioral + the
     normalization applied and why each is sound); the report shape (per-agent
     PASS/FAIL); the forcing function (`retire()` MUST require all-PASS,
     `[inv:zero-loss-before-removal]`); and the cross-repo removal boundary
     (`[inv:cross-repo]` — guards touch fixtures only; cross-repo removal is an
     operator runbook step).
- **Fixtures (`[def:fixture]`):** copy `code-reviewer.md` (canonical example) and one
  `ticket-creation.SKILL.md` into `src/__fixtures__/` and check them in.

---

## Acceptance criteria

- [migration-design.1] decisions.md exists
- [migration-design.2] parser + FULL 18-type mapping strategy recorded (incl. unmapped-flag, no silent drop)
- [migration-design.3] LLM pipeline contract recorded (haiku fan-out + sonnet consolidation, live/replay)
- [migration-design.4] anchor-vocabulary linkage to Plan 8 recorded (seed here, backfill there)
- [migration-design.5] FEAT-007 importCorpus entrypoint + equivalence/zero-loss + cross-repo boundary recorded
- [migration-design.6] fixture agent .md + fixture SKILL.md checked in

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-migration/decisions.md", "packages/ai/agent-registry-migration/src/__fixtures__/code-reviewer.md", "packages/ai/agent-registry-migration/src/__fixtures__/ticket-creation.SKILL.md"]
```

---

## Commit points

- After writing `decisions.md` + fixtures: `docs(agent-registry-migration): record ingestion-pipeline design decisions + check in fixtures`.
- Post-guard mandatory commit recorded by `state-transition.js --complete`.

## Notes for executor

- This is a judgment state. Read SEED_DATA §0 in full, SCOPE.md "Systems Replaced",
  REFERENCES.md "Superseded Systems — Removal Targets", and Plan 8's
  `embedding-substrate`/`enrichment-pipeline` contexts (the anchor substrate).
- Have `code-reviewer` sign off on `decisions.md` before advancing — especially the
  unmapped-flag policy (load-bearing for `[dod.1]`'s no-silent-drop teeth), the
  live/replay split, and the equivalence normalization list.
- Do NOT assume you can delete files in `~/dev/ai/claude-agents` from this plan's
  guards (`[inv:cross-repo]`). The corpus is read-only; the fixtures are the in-repo
  proxy for the write/remove guards.
