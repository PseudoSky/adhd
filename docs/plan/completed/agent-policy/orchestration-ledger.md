# Orchestration ledger — agent-policy

Driven by `workflow:plan-orchestrator` (execute mode) in worktree
`/Users/nix/dev/node/adhd-agent-registry` (branch `agent-registry-execution`).
`$SKILL` = installed cache `…/workflow/0.8.22/skills/plan-state-machine/scripts`.
Foundation plan 4 of 7 — running in PARALLEL with agent-provider.

## Preflight (2026-06-23)

| Check | Result |
|---|---|
| `compile-task --board` | 10-state chain; wave 0 = `policy-design` (architecture ADR), wave 1 = scaffold |
| `gap-check` | **PASS** — 0 warnings |
| `env-pin-check --strict` | exit 0 |
| human-blockers | none (`human-blockers.json` = `{}`) |
| F2 audit-phase membership | **CLEAN** — architecture/foundation/schema/enforcement/seed/audit; seed criteria in `seed` phase, none mis-filed |
| tsconfig.base.json | `@adhd/agent-policy` **already registered** (scaffold at wave 1 is verify-only; cross-plan flag with provider is benign) |

## Dispatch rows

| wave | slug | executor | tier | tokens | guard | retries | outcome | notes |
|---|---|---|---|---|---|---|---|---|
| 0 | policy-design | architect-reviewer | **opus** | byte-proxy | `--phase architecture` 3/3 PASS | 0 | **ADVANCE** | commit `6b81009` (only decisions.md, agent-mcp untouched). Decisions: (1) LAZY inheritance @query (inherited_from=category slug); (2) EnforcementEvent pre:model_request-only, rest observational. Clean single cycle |
| 1 | scaffold-package | typescript-pro | sonnet | byte-proxy | build exit 0 + test-target exit 0 | 0 | **ADVANCE** | commit `5ceb259` (agent-mcp/tsconfig/agent-provider untouched). **F-TR6 preempted** (vite test target at scaffold). Clean single cycle |
| 2 | policy-type-and-template-schema | typescript-pro | sonnet | byte-proxy | guard exit 0 | 0 | **ADVANCE** | commit `1190b44` (within reservation; boundary clean); policy_policy_types+policy_policy_templates, PolicyTemplateStore + typed errors. Clean single cycle |
| 3 | agent-policy-junction | typescript-pro | sonnet | byte-proxy | guard exit 0 (9) | 0 | **ADVANCE** | commit `79de123`; policy_agent_policies junction + AgentPolicyStore.attach/listForAgent/resolveEffectiveRules; close+reopen + phantom-slug no-FK proof; boundary clean. Clean single cycle |
| 4 | policy-inheritance | typescript-pro | sonnet | byte-proxy | guard exit 0 (5) | 0 | **ADVANCE** | commit `a031b83`; lazy resolveForAgent (query-time join, inherited_from=category slug, override wins) per ADR; boundary clean. **F-TR7 benign:** +2 negative-control scripts (nc_break/restore_inheritance.mjs) for audit teeth-check |
| 5 | enforcement-plugin | typescript-pro | sonnet | byte-proxy | guard exit 0 (14) | 0 | **ADVANCE** | commit `9d5006a`; real HookRegistry drives real throw propagation; nc_break_enforcement → 4 red tests (teeth). **agent-mcp + agent-mcp-types UNTOUCHED (imports only).** +2 nc_*.mjs (expected). Clean single cycle |
| 6 | audit-schema (GATE) | orchestrator-driven | — | n/a | `--phase schema` 22/22 PASS | 0 | **ADVANCE** | verified green before completing; advanced to seed-and-roundtrip |
| 7 | seed-and-roundtrip | typescript-pro | sonnet | byte-proxy | guard exit 0 (4) | 0 | **ADVANCE** | commit `d5e0842`; idempotent double-seed + reopen + teeth; +nc_break/restore_seed.mjs (expected); boundary clean. Clean single cycle |
| 8 | code-review (GATE) | code-reviewer | **opus** | byte-proxy | review_gate exit 0 | 0 | **ADVANCE** | **VERDICT: APPROVED** (review `bc9efb8`); 37 tests pass, build clean; 1 non-blocking note (no-override hardening). Clean single cycle |
| 9 | audit-final (DoD GATE) | orchestrator-driven | — | n/a | `--phase final` 36/36 PASS incl dod.1-5 | 0 | **PLAN BODY COMPLETE — awaiting human `--confirm-dod`** | 10/10 complete, terminal. `dod_confirmed:False` → human DoD sign-off pending |
