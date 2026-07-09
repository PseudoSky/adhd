# Orchestration ledger — adhd-environment

Orchestrator: `plan-orchestrator` (execute mode).
`$SKILL` = `~/.claude/plugins/cache/sox-subagents/workflow/0.8.25/skills/plan-state-machine/scripts` (installed cache, not a dev checkout).
Plan `authored_with`: workflow 0.8.25, hash `961c3053dfab`.

## Run 1 — 2026-07-08 — request: "dispatch adhd-environment parallel"

### Outcome: HALTED AT PREFLIGHT. Zero executors dispatched.

Two independent reasons the requested parallel dispatch could not proceed:

1. **Preflight hard-fails.** `env-pin-check.js --strict` exits **4** (4 unpinned guards). The skill's rule is
   explicit: an unpinned guard is a plan defect, and on a plan-level preflight error the orchestrator does not
   start dispatching.
2. **The current wave is serial anyway.** `current_state` is `contract-base-spec` = **wave 1, a single state**.
   The first parallel wave is wave 2 = `{builder-engine, runtime-py, runtime-rs}` — and two of those three
   (`runtime-py`, `runtime-rs`) are precisely the unpinned guards from (1).

### Preflight results (real exit codes; pipelines re-run without `| tail` masking)

| check | exit | verdict |
|---|---|---|
| `compile-task.js --board` | 0 | 13 tasks, critical-path cost 9, 9 waves. **`Tiers: unrated:13`** |
| `gap-check.js` | 0 | PASS with 1 WARN (`docs-steward` in no DoD `delivered-by:`) |
| `env-pin-check.js --strict` | **4** | **FAIL** — 4 of 13 guards unpinned |
| `cross-plan-check.js <plan-dir>` | 2 | invocation error on my part — wants the **plans-root** |
| `cross-plan-check.js <plans-root>` | 0 | clean |

### Human blockers rendered (both `status: needed`)

| blocker | required_by | wave | live check |
|---|---|---|---|
| `cargo-registry-token` | `runtime-rs` | 2 | `CARGO_REGISTRY_TOKEN` unset — **but publish-only per its own description → misbound (F6)** |
| `agent-mcp-deployment-secrets` | `refactor-agent-mcp` | 6 | `ADHD_AGENT_OPENAI_SECRET`, `ADHD_AGENT_DATABASE_PATH` **both unset** → will halt wave 6 |

### Findings (F1–F7)

- **F1 / ENV-PLAN-002** — `env-pin-check --strict` exit 4. `runtime-py` guard `python -m build` (bare `python` →
  miniconda base 3.13.11; executed: exit 1). `runtime-rs` guard `cargo build` (bare cargo → homebrew 1.95.0).
  `docs-steward` unpinned. `scaffold-workspace` unpinned but `complete` → moot this run, bites on re-run.
- **F2 / ENV-PLAN-003** — all 13 states `model: null, effort: null`. Routing tier would have to be invented.
- **F3 / ENV-PLAN-004** — `gap-check` WARN: `docs-steward` bears criteria, claimed by no DoD outcome.
- **F4 / ENV-PLAN-001** — **`docs-steward`'s guard is a no-op.** `test -f packages/environment/environment-core-node/README.md`
  targets a file **no state declares as an artifact**, which **already exists on disk**. Executed while
  `docs-steward` is `pending` → **exit 0**. Green before the work; can never go red→green. Proven by execution,
  not inferred. Trap for the fix: its real artifacts `demo/DEMO.md` and `USE_CASES.md` **also already exist**,
  so an existence check is the same bug in a new coat.
- **F5 — WITHDRAWN (my error).** In the preceding `list` run I reported `state.json schema_version: 2` as a
  "proven migration lag" because `migrate-plan.js` sets `TARGET_SCHEMA_VERSION = 3`. I never checked what the
  scaffolder writes. `plan-scaffold.js` emits `schema_version: 2`, and **nothing at runtime rejects it**. No
  migration is needed. This is exactly the root-cause-confabulation failure mode the orchestrator spec warns about.
- **F6 / ENV-PLAN-006** — `cargo-registry-token` bound `required_by: [runtime-rs] / blocks_at: per-state` though its
  own description says publish-only. Would spuriously halt wave 2. User approved retarget.
- **F7 / ENV-PLAN-005 (upstream skill defect)** — `isEnvPinned()` accepts only `./node_modules/.bin/`, `npx --yes|-y`,
  a python **script** invocation, or a set `PLAN_ENV_LABEL`. Therefore (a) a genuinely pinned
  `rustup run 1.95.0 cargo build` still reports UNPINNED — no Rust marker exists; (b) `PLAN_ENV_LABEL` blanket-passes
  **every** guard regardless of content, i.e. it can turn the gate green without improving determinism. Repair is
  explicitly forbidden from using it.

### Process errors I made this run (recorded so they aren't repeated)

1. Wrote `node <check> | tail -N; echo "exit=$?"` — reports **`tail`'s** exit code. This masked
   `env-pin-check --strict`'s exit **4** as a apparent `0`. Re-ran with `>/dev/null 2>&1; echo $?`.
2. Reported a `schema_version` migration lag without checking the scaffolder (F5, withdrawn).
3. Did not render `human-blockers.json` in the first preflight pass — the exact "late-surfacing blocker"
   failure mode. Caught before dispatch; `cargo-registry-token` would have halted wave 2.
4. Proposed `rustup run <toolchain>` as the Rust pin before checking that `rustup` was installed (it was not)
   and before checking that `env-pin-check` has no Rust marker (it does not).

### Actions taken

| # | action | detail |
|---|---|---|
| 1 | logged defects | `BACKLOG.md` ENV-PLAN-001..007 + `docs/plan/adhd-environment/BACKLOG.md` |
| 2 | installed rustup | user-approved external tool. keg-only at `/opt/homebrew/opt/rustup/bin/rustup`; toolchain `1.95.0` installed; `rustup run 1.95.0 cargo --version` → `cargo 1.95.0`, exit 0 |
| 3 | dispatched plan-builder | update mode, **opus** (repair tier ≥ authoring tier). Brief: F1, F2, F3, F4, F6. `PLAN_ENV_LABEL` bypass explicitly forbidden. Must prove new `docs-steward` guard RED by execution |

### Dispatches

| slug | wave | executor | tier | tokens(in/out) | guard-exit | retries | outcome | wave_pack | preloaded_bytes | budget_est |
|---|---|---|---|---|---|---|---|---|---|---|
| _(none — halted at preflight)_ | — | — | — | — | — | — | — | — | — | — |
| `<plan repair>` | n/a | `plan-builder` | opus | pending | pending | 0 | running | n/a | n/a | n/a |

### Resume line (after repair verifies)

```
node "$SKILL/orchestrate-plan.js" /Users/nix/dev/node/adhd/docs/plan/adhd-environment --dispatch
```
Then: wave 1 `contract-base-spec` (guard already pinned: `npx --yes`), then wave 2 in parallel
`{builder-engine, runtime-py, runtime-rs}` via `compile-wave.js --stats` (pack iff `reduction_ratio ≥ 0.08`).
