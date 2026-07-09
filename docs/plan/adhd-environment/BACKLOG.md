# BACKLOG — adhd-environment

Discovered during plan-orchestrator preflight (2026-07-08). Full detail in the repo-root `BACKLOG.md`.

- **ENV-PLAN-001** — `docs-steward` guard (`test -f .../environment-core-node/README.md`) is already green on disk and targets a file no state produces → no-op guard, proxy evidence. OPEN.
- **ENV-PLAN-002** — 4 unpinned guards (`runtime-py`, `runtime-rs`, `docs-steward`, `scaffold-workspace`); `env-pin-check --strict` exits 4. `runtime-py`/`runtime-rs` are the wave-2 parallel pair. OPEN — blocks dispatch.
- **ENV-PLAN-003** — all 13 states unrated (no `model`/`effort`). OPEN.
- **ENV-PLAN-004** — `docs-steward` declared by no DoD outcome (`gap-check` WARN). OPEN.

**Not a defect (investigated, withdrawn):** `state.json schema_version: 2` is what the current `plan-scaffold.js` emits (its `SCHEMA_VERSION = 2`); nothing at runtime rejects it and only `migrate-plan.js` bumps to 3. No migration required.
- **ENV-PLAN-005** — `env-pin-check` has no Rust/cargo pin marker, and `PLAN_ENV_LABEL` blanket-passes every guard (upstream skill defect). OPEN.
- **ENV-PLAN-006** — `cargo-registry-token` bound to `runtime-rs` though it is publish-only; blocks wave 2 spuriously. IN REPAIR.
- **ENV-PLAN-007** — `ADHD_AGENT_OPENAI_SECRET` / `ADHD_AGENT_DATABASE_PATH` unset; will halt wave 6 (`refactor-agent-mcp`). OPEN, owner human:ops.

## Discovered during contract-base-spec build (2026-07-08)
- ADHDENV-BL-1: No state reserves a test file for environment-base-spec (contract is verified out-of-band only). Add a reserved src/index.spec.ts + criterion covering the cross-language vectors (contentHash/inferEnvVar/generateFieldSchema/projectEnvPrefix).
- ADHDENV-BL-2: environment-base-spec vite.config.ts has no node:* externals (unlike sibling packages); moot now (pure SHA-256 impl) but a scaffold inconsistency if a future change needs a Node builtin.
- ADHDENV-BL-3 (FIXED this commit): contentHash test vector was sha256("test") not the real hash of {b:"2",a:"1"}; corrected to sha256-4a73850f... everywhere. Survived 2 gap-audits — audits did not recompute the hash.
