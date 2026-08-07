# authoring-design — design gate + agent-mcp modification manifest

**Phase:** architecture · **Kind:** work · **Depends on:** none · **Guard:** `python3 docs/plan/agent-mcp-authoring/scripts/audit_authoring.py --phase architecture`

See `contexts/_shared.md` for invariants, the caller map, and source-of-truth pointers.

---

## Goal

`decisions.md` exists and resolves the four binding design questions BEFORE any
agent-mcp src is touched (D1 embedding source, D2 name↔slug seam, D3 the agent-mcp
**modification manifest** + the recorded `baseline-ref`, D4 agent_define transaction
+ Plan-6 sequencing). The planner has already drafted these; this state CONFIRMS
each against the real tree — every `UseCaseStore`/`ComponentStore`/`AgentStore`
slug-bearing surface in the caller map is verified, and the `baseline-ref`
placeholder is replaced with the actual git SHA of agent-mcp HEAD immediately before
this plan's first agent-mcp src commit. After this state the back-out guarantee is
mechanically armed: `check_manifest.py` fails any agent-mcp src change outside the
manifest.

This is a WRITE-`decisions.md`-only gate — no `.ts` changes. The forcing function is
`audit_authoring.py --phase architecture` (greps the four `def:` markers + the
baseline-ref/non-regression line).

> **Do NOT change any agent-mcp `.ts` here.** Re-verify D1: no embedding dep crept
> into the workspace and the memory-server is still not a local importable path. If
> a Plan-6 detail blocks a decision, record the assumption + escalate (planner
> amendment); do not invent registry internals.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [authoring-design.1] decisions.md records the embedding-source decision (reuse memory-server vs deterministic in-package) + determinism/idempotence requirement

- [authoring-design.2] decisions.md records the name<->slug translation-seam policy (no slug on any MCP wire schema/output/guide)
- [authoring-design.3] decisions.md records the agent-mcp modification manifest (exact src files, pre-plan baseline ref, non-regression guard) — the opt-in reversible gate
- [authoring-design.4] decisions.md records sequencing-after-Plan-6 + agent_define transactional-upsert ownership across registry+tool+provider+policy stores
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-mcp-authoring/decisions.md", "docs/plan/agent-mcp-authoring/contexts/authoring-design.md"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
