# Agent Governance Gaps — Solution Specs

**Date:** 2026-07-04 | **Status:** Deferred

## Resolution

All governance concerns identified in the agent-governance-gaps analysis are
covered by the **`@adhd/workspace-standard`** architecture defined in
[`docs/workspace-base/SCOPE.md`](../../workspace-base/SCOPE.md). Specifically:

| Governance Gap | Covered By | Mechanism |
|---|---|---|
| Boundary enforcement between areas/groups | SCOPE.md §9 | `.adhd/workspace.json` depConstraint matrix, enforced by `@adhd/eslint-plugin-workspace` |
| Post-change enforcement (CHANGELOG, DEMO, README updates) | SCOPE.md §6, `FEAT-CHANGE-ENFORCE-001` | Git-diff-driven rule engine in `@adhd/workspace-standard` |
| Change provenance / traceability | SCOPE.md §7, `FEAT-PROVENANCE-001` | Commit trailers + CHANGELOG projection |
| Required files existence + section checks | SCOPE.md §5 | README, CLAUDE.md, DEMO.md, CHANGELOG.md, PLAYBOOK.md — gated by lint |
| Required targets (build, lint, test, typecheck, demo, verify) | SCOPE.md §4 | Enforced by `@adhd/eslint-plugin-workspace` |
| Managed region markers (upgrade safety) | SCOPE.md §8 (upgrade) | `@workspace:managed` markers; core engine in `@adhd/workspace-standard` |
| Per-package metadata (routing source of truth) | SCOPE.md §3 | `.adhd/meta.json` — ecosystem-neutral, not package.json |
| Agent task routing (discover -> scope -> execute) | SCOPE.md §0 | Five-layer reframe: routing index + CLAUDE.md hierarchy + impact graph + memory + intent router |

## Delegation

No separate implementation is planned. The `@adhd/workspace-standard` +
`@adhd/workspace-nx` packages (tracked under `FEAT-WORKSPACE-001` in
BACKLOG.md) are the single implementation for all governance gaps.

If a gap is discovered that is NOT covered by the workspace-standard scope,
file a new backlog item referencing this document.
