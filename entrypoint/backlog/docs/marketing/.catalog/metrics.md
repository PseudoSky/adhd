# Metrics — `entrypoint/backlog`

<!-- Append one block per run. Never overwrite. -->

## run 9df2a5c7 — 2026-09-23T19:52:30-04:00   [BEFORE]

metric_1_eliminated_reader_searches: 0
  # Estimate from the skill doc. A fresh consumer can answer every onboarding question from
  # README.md + skill/SKILL.md without opening raw source: command surface (14 verbs + batch),
  # calling convention (`--input`), all 5 special commands, envelope + exit-code table, the
  # citationRequired=false / transitionRequiresNote=true defaults, body-edit→successor-uid
  # semantics, the `view` enum, the three library-only exports, and the global-build `gitContext`
  # caveat. Raw-source reads in this run were for INVENTORY AUTHORING (api.ts/cli.ts/types.ts),
  # not consumer fallbacks, so they do not count.
  per-file breakdown (consumer fallbacks): (none)

metric_2_feature_delta: discovered=25 added=25 deprecated=0
metric_3_doc_junk_ratio: junk=18% redundant=0% undocumented=0%

notes: Docs are unusually strong — README and SKILL.md are version-stamped to 9df2a5c7 and
self-correct prior stale designs. The junk is concentrated in two non-authoritative artifacts
(STATE.md stale rollout tracker; BACKLOG_BACKLOG.md dead audit). Three status/version stamps
(SPEC, DESIGN, RAG-SPEC) lag the shipped 1.0.0.

## run 9df2a5c7 — 2026-09-23T19:52:30-04:00   [AFTER]

metric_1_eliminated_reader_searches: 0
  # Re-measured on the current docs (verified_at 2026-09-24T00:29:06Z). A fresh consumer can
  # answer every onboarding question from README.md + skill/SKILL.md without opening raw source:
  # the 18-operation table (17 verbs + batch), the `--input` calling convention, all 5 special
  # commands, envelope + exit-code table, and now the "Rollup & stats views" section (README) /
  # §8 (SKILL) documenting priority-matrix / part-of-rollup / open-curve as CLI+MCP+library with
  # real captured outputs. Raw-source reads this run were for INVENTORY AUTHORING (api.ts /
  # index.ts / server.ts receipts) and to confirm the mount, not consumer fallbacks.
  per-file breakdown (consumer fallbacks): (none)

metric_2_feature_delta: discovered=25 added=0 deprecated=0
  # No capability added/removed. Three capabilities CHANGED SURFACE, not count:
  # priority-matrix / part-of-rollup / open-curve moved `library-only` → `cli+mcp+http+library`
  # (mounted verbs confirmed in `dist/index.js --help`, rebuilt 20:20). Mounted operations
  # 15 → 18 (14 verbs + batch → 17 verbs + batch). library-only subset: 3 → 0.

metric_3_doc_junk_ratio: junk=17% redundant=0% undocumented=0%
  # 2 of 12 docs junk (STATE.md, BACKLOG_BACKLOG.md); denominator grew by LICENSE, which is clean.

notes: SPEC status stamp fixed (PROPOSED → IMPLEMENTED); README gained the 18-operation table and
the "Rollup & stats views" section; SKILL §1 header is "17 verbs" and §8 documents the views as
mounted AND importable; CONTRIBUTING carries a 2026-09-24 status callout; LICENSE added (MIT).
CHANGELOG.md is now stale (still says "14 verbs") — newly flagged. DESIGN (0.2.0) and RAG-SPEC
(0.4.0) version stamps still lag the shipped 1.0.0.
