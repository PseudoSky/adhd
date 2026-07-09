# BACKLOG — adhd-environment

Discovered during plan-orchestrator preflight (2026-07-08). Full detail in the repo-root `BACKLOG.md`.

- **ENV-PLAN-001** — `docs-steward` guard (`test -f .../environment-core-node/README.md`) is already green on disk and targets a file no state produces → no-op guard, proxy evidence. FIXED 2026-07-08 — replaced with `scripts/guard_docs_steward.py`, a behavioral guard that builds the shipped `@adhd/environment` package and asserts the demo's headline command runs (constructable `Environment` with `.get()`) + DEMO/USE_CASES content. Proven RED today (node probe exit 3 → guard exit 1; runtime is a scaffold stub). See decisions.md §F4.
- **ENV-PLAN-002** — 4 unpinned guards (`runtime-py`, `runtime-rs`, `docs-steward`, `scaffold-workspace`); `env-pin-check --strict` exits 4. FIXED 2026-07-08 — each converted to a repo-owned `python3 docs/plan/adhd-environment/scripts/guard_<slug>.py` that resolves its toolchain by absolute path and fails loudly if absent (uv-pinned py build, rustup-1.95.0-pinned cargo build). `env-pin-check --strict` now exits 0 (all 13 PINNED). See decisions.md §F1.
- **ENV-PLAN-003** — all 13 states unrated (no `model`/`effort`). FIXED 2026-07-08 — every state rated (9 sonnet/medium, 4 opus/hard: audit-builder, audit-runtime, audit-final, refactor-agent-mcp). Board: `Tiers: medium:9 · hard:4`, no unrated. Rationale per state in decisions.md §F2.
- **ENV-PLAN-004** — `docs-steward` declared by no DoD outcome (`gap-check` WARN). FIXED 2026-07-08 — attached to existing `[dod.1]` delivered-by (the demo is the end-to-end proof-of-life that the 6 built packages run). `gap-check` now 0 warnings. See decisions.md §F3.

**Not a defect (investigated, withdrawn):** `state.json schema_version: 2` is what the current `plan-scaffold.js` emits (its `SCHEMA_VERSION = 2`); nothing at runtime rejects it and only `migrate-plan.js` bumps to 3. No migration required.
- **ENV-PLAN-005** — `env-pin-check` has no Rust/cargo pin marker, and `PLAN_ENV_LABEL` blanket-passes every guard (upstream skill defect). OPEN (upstream); worked around locally via the python guard scripts above.
- **ENV-PLAN-006** — `cargo-registry-token` bound to `runtime-rs` though it is publish-only; blocks wave 2 spuriously. FIXED 2026-07-08 — `blocks_at` retargeted `per-state → release`; `required_by:["runtime-rs"]` kept as truthful crate-ownership + secret coverage (empty `required_by` is invalid: gap-check rejects it and the skill deletes it). No longer halts wave 2. See decisions.md §F6.
- **ENV-PLAN-007** — `ADHD_AGENT_OPENAI_SECRET` / `ADHD_AGENT_DATABASE_PATH` unset; will halt wave 6 (`refactor-agent-mcp`). OPEN, owner human:ops (correctly retained as a `per-state` blocker; not in scope for this repair).

## Discovered during contract-base-spec build (2026-07-08)
- ADHDENV-BL-1: No state reserves a test file for environment-base-spec (contract is verified out-of-band only). Add a reserved src/index.spec.ts + criterion covering the cross-language vectors (contentHash/inferEnvVar/generateFieldSchema/projectEnvPrefix).
- ADHDENV-BL-2: environment-base-spec vite.config.ts has no node:* externals (unlike sibling packages); moot now (pure SHA-256 impl) but a scaffold inconsistency if a future change needs a Node builtin.
- ADHDENV-BL-3 (FIXED this commit): contentHash test vector was sha256("test") not the real hash of {b:"2",a:"1"}; corrected to sha256-4a73850f... everywhere. Survived 2 gap-audits — audits did not recompute the hash.
- **ENV-PLAN-008** — `npx --yes` anywhere in a guard launders the rest past `env-pin-check` (substring markers). `audit-runtime` keeps bare `python`/`cargo` yet reports PINNED → the gate's exit 0 is a false green. OPEN.
- **ENV-PLAN-009** — `builder-snapshot-api` guard is byte-identical to `builder-engine`'s → green before its work; asserts nothing about the snapshot API. OPEN.
- **ENV-PLAN-010** — plan-builder executed `contract-base-spec` and wrote `runtime-py`'s implementation (untracked, 367 lines) during a *repair* dispatch, then reported `state.json` untouched. `runtime-py`'s guard is now green while `pending`. OPEN.
- **ENV-PLAN-011** — all 3 audit gates are `nx build`; none invokes `run-audit.js` or its own `audit_<slug>.py`. `audit-final` goes green if six packages compile. OPEN — blocks trustworthy completion.
- **ENV-PLAN-012** — `run-audit.js --phase` doesn't filter (phase `contract` runs `audit-final.*`), and criteria resolve vs cwd while check `cmd`s are repo-root-relative → no working cwd. OPEN.

- ADHDENV-BL-4: Criteria runnability — several criteria in criteria.json/audit_checks.js invoke `node -e 'require("./packages/.../src/<module>")'` on .ts source WITHOUT extension; Node cannot resolve extensionless .ts (confirmed v24, builder-engine.1/.7 line 111/119, runtime-core-node line 346). Fix: use `npx --yes tsx -e` (tsx resolves .ts + tsconfig paths), verified working by the builder-engine executor. ALSO verify the `require("@adhd/environment")`/`@adhd/environment-builder` criteria (lines 41/49/65/338/370) resolve at audit time — packages must be built AND node_modules-linked (executors noted no @adhd/* workspace symlinks). MUST fix before wave 4 audit-builder + runtime-core-node.
- **ENV-PLAN-013** — `environment-core-py`/`-rs` are not nx projects; `audit-final`'s `--projects=environment-*` covers 4 of 6, skipping both cross-language runtimes. OPEN.
- **ENV-PLAN-014** — `cargo-registry-token` blocker cites an `nx-release-publish` target that exists nowhere in the repo. OPEN.

## Cross-language equivalence defects (code review of adopted work, 2026-07-08)
Full detail: `packages/environment/BACKLOG.md`. All reproduced by execution.

- **ENV-CORE-001** — CRITICAL. `generateFieldSchema`: Python/Rust emit `secret`/`env`/`scope`/`noEnv` that TS strips. Equivalence break **and** secret-metadata disclosure. OPEN.
- **ENV-CORE-002** — CRITICAL. `contentHash`: astral keys sort by UTF-16 code unit in TS, code point in Python/Rust → the same config yields two different digests. OPEN.
- **ENV-CORE-003** — HIGH. `projectEnvPrefix("foo.bar")` → `ADHD_FOO.BAR` (TS/Py) vs `ADHD_FOO_BAR` (Rust). OPEN.
- **ENV-CORE-004** — MEDIUM. `contentHash` `key=value\n` serialization is non-injective; `{"a":"1\nb=2"}` collides with `{"a":"1","b":"2"}` — **and that collision IS the plan's pinned gate vector `4a73850f…`**. Spec defect in `contract-base-spec` (marked `complete`). OPEN.
- **ENV-CORE-005** — LOW. Lone-surrogate key: TS substitutes U+FFFD, Python raises. OPEN.
- **ENV-CORE-006** — LOW. Snapshot path built from `project`/`namespace` with no traversal guard. OPEN.
- **ENV-CORE-007** — TEST-DEBT. Python + Rust suites are pure vector-replay; they cannot fail against ENV-CORE-001/002/003. This is how `runtime-py`/`runtime-rs` reached `complete` on green tests. OPEN.

**Consequence for the state machine:** `contract-base-spec`, `runtime-py`, `runtime-rs` are marked `complete` but do not
deliver cross-language equivalence. Their completions rest on vector-replay suites and build-proxy guards. They require
amendment (`state-transition.js --amend`), not a fresh `--complete`.
- **ENV-PLAN-016** — terminal DoD gate non-functional: README declares 8 `[dod.N]`, `criteria.json` has 0 `dod.*` ids, `audit-dod-mapping.js` is a stub → `current_state` can never become `done`. Negative controls are inert (empty set). OPEN, hard-blocks completion.
- **ENV-PLAN-017** — `runtime-cli` guard greps for `function <name>` ×9; nine empty stubs pass it (proven by negative control). Implementation-shaped proxy. OPEN.
- **ENV-PLAN-018** — `builder-snapshot-api` guard asserts `typeof m === "function"`; no-op methods pass. OPEN.
