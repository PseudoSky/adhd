# ⛔ SUPERSEDED — do not resume this plan

**Date:** 2026-07-18

This plan-state-machine corpus (`SPEC_0.0.x`, `SCOPE.md`, `dag.json`, `state.json`,
`scripts/criteria.json`, `TOOLS.md`, …) describes the **original** `@adhd/environment`
design authored by DeepSeek. That design **missed the actual use case** and has been
**superseded** by a zero-config, live-resolve redesign.

## Do not execute or resume

- `state.json` shows `refactor-agent-mcp` / `audit-final` / `docs-steward` as `pending`.
  **Do not run them.** The refactor was completed differently (see below); resuming would
  overwrite the corrected implementation.
- `scripts/criteria.json` still asserts the existence of `environment-core-py` /
  `environment-core-rs` and a YAML/CLI-set-store model. Those packages were **deleted** and
  that model was **abandoned**. Running the audit gates will (correctly) fail against reality.

## What replaced it

- **Authoritative design:** `packages/environment/ARCHITECTURE.md` (zero-config by default,
  Claude-Code-style optional-layer cascade, code-first `Environment<T>(project, spec, options?)`,
  optional snapshot, Node-only, configurable multi-instance collision).
- **Implementation branch:** `feat/environment-zero-config` (Wave 1 `59b07ec6` = the three TS
  packages; Wave 2 = agent-mcp refactor + py/rs deletion + CLI demotion).
- **Preserved original WIP:** branch `wip/adhd-environment-old-api` (kept for reference/salvage).
- **CHANGELOG:** see `CHANGELOG.md` → DEBT-ENV-REDESIGN-001/002, BUG-AGENTBASE-TSC-001.

If a future effort wants the cross-language (Python/Rust) clients back, they read the optional
snapshot — they are not part of this initiative.

## Restoration note (2026-08-05)

This file was authored in commit `8b462c14` ("Wave 2") but never landed on `main`: `8b462c14` is not an ancestor of `HEAD`, and the subsequent manual content-commit `b38369f3` ("Cleanup", which IS on main) captured the rest of Wave 2's file changes but silently dropped this one file. Its absence is why the plan's own dag/criteria/DoD gates kept being treated as live and re-triaged as CONFIRMED bugs (ENV-PLAN-007, ENV-PLAN-010, ENV-PLAN-016, ENV-PLAN-017, ENV-PLAN-018, ENV-PLAN-019, BUG-ENV-PY-001) between 2026-07-18 and 2026-08-06. Restored verbatim (plus this note) as part of that backlog cluster's repair. See `docs/plan/adhd-environment/state.json`'s `abandoned` block for the formal closure record.
