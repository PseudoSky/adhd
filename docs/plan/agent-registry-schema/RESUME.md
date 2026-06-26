# RESUME — Agent Registry plan-set orchestration

Handoff for restarting the `plan-orchestrator` (execute mode) on the Agent Registry build.
**Last updated:** 2026-06-23, end of the schema close-out resume run (branch HEAD `3fcbb23`).
All background agents stopped; state is at rest.

## How to re-enter
- **Agent:** `workflow:plan-orchestrator`, mode = **execute**.
- **$SKILL (installed cache, NOT a dev checkout):**
  `/Users/nix/.claude/plugins/cache/sox-subagents/workflow/0.8.22/skills/plan-state-machine/scripts`
- **Plans-root:** `docs/plan/` (corpus). Source spec for this initiative: `docs/plan/agent-registry/`
  (GOAL/SCOPE/DATA_MODEL/USAGE/SEED_DATA/REFERENCES/RUNTIME_GAPS — NOT a plan). **Now committed
  on-branch** (was uncommitted on main; recovered this run, commit `5b049e8`).
- **ISOLATION — all execution happens in a git worktree, not main:**
  - Worktree: `/Users/nix/dev/node/adhd-agent-registry`
  - Branch: `agent-registry-execution` (branched from main `34ed69a`)
  - `node_modules` is symlinked → main's; `npx nx` works (nx v18.3.4).
  - Reason: a SECOND session is concurrently driving `apigen-client-generation` on `main`; both
    collide on `tsconfig.base.json`. Keep agent-* work in the worktree; merge to main at the end.
- **memory-server caveat:** the `memory-server` MCP tools are NOT reachable from the agent/subagent
  runtime (only the human's interactive client). `memory_*` writes (e.g. reflections) must be done
  from the interactive session via `/sox-tools:reflection`, not by the orchestrator. See gotchas.

## The 7-plan set (decomposed from SCOPE.md package boundaries)
Execution DAG: foundations (schema ∥ tool-registry ∥ provider ∥ policy) → compiler → mcp-refactor → migration (last).

| Plan (docs/plan/<slug>) | states | status |
|---|---|---|
| **agent-registry-schema** | 10 | ✅ **COMPLETE & CLOSED OUT** (10/10) · reviewed APPROVED · refactored (Decision 5) · **DoD-confirmed** (`5b7fca7`) · **reflections logged** · re-verified green this run (audit 31/31, build clean, 62/62 tests). **NOT yet merged to main.** |
| agent-tool-registry | 8 | authored + code-review gate · **0/8 executed** · interfaces ✅ recovered+green (`43a7541`) |
| agent-provider | 9 | authored + code-review gate · **0/9** · interfaces ✅ recovered+green (`43a7541`) · has the lmstudio live-guard (bin `/Users/nix/.lmstudio/bin/lms`, model `qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8`, gated behind `AGENT_MCP_LIVE=1`; artifact `agent-provider/scripts/live-lmstudio-roundtrip.sh`) |
| agent-policy | 9 | authored + code-review gate · **0/9** · interfaces ✅ recovered+green (`43a7541`) |
| agent-compiler | 11 | authored + code-review gate · **0/11** (convergence: consumes schema+tools+provider+policy) · interfaces ✅ repaired for Decision 5 + green (`470e835`) |
| agent-mcp-refactor | 8 | authored + code-review gate · **0/8** · interfaces ✅ recovered+green (`43a7541`) |
| agent-registry-migration | 10 | authored + code-review gate · **0/10** (+ removal phase) · interfaces ✅ repaired for Decision 5 + green (`470e835`) |

## What agent-registry-schema shipped (worktree branch)
- `@adhd/agent-registry` at `packages/ai/agent-registry/` (FLAT under packages/ai/, per REFERENCES.md:113 —
  NOT `packages/ai/agents/`). platform:node, better-sqlite3 + drizzle-orm + zod. **Folder org confirmed
  this run:** name `agent-registry`, tags `layer:ai`+`platform:node`, tsconfig.base.json path registered.
- 9 tables, `registry_` prefix, ONE shared SQLite file, NO ATTACH, NO cross-package FKs (decisions.md Decision 1).
- **Decision 5 (head/version split):** `registry_components` (identity, slug PK) + `registry_component_versions`
  (history, surrogate `version_id` PK, UNIQUE(slug,version)). DB-ENFORCED FKs:
  `agent_components.component_slug`, `component_usage.component_slug`, `context_rules.component_slug` →
  `registry_components.slug`; and `agent_components.version_pin` → `registry_component_versions.version_id`
  (nullable enforced FK). Migration `0006_component_head_version_split.sql`. FK-teeth tests prove
  orphan-ref/bad-pin throw `/FOREIGN KEY/i`; dup `(slug,version)` throws unique.
- Composite PKs are real `primaryKey({columns})` (fix d747ad4).
- Build + all 6 suites (62 tests) + audit `--phase final` (31/31, incl. dod.1–5) all GREEN — re-verified this run.
- Code review: `review.md` = **VERDICT: APPROVED**.
- Backlog: `packages/ai/agent-registry/BACKLOG.md` — NB-1 (repo-wide `nx typecheck` tsconfig `composite:true`
  cleanup; surfaces 13 errors, build/test unaffected — do NOT fix in isolation), NB-2 (stale comment in
  seed/index.ts), NB-3 (decisions.md context_rules-merge-location prose drift).
- **Note:** stray partial `packages/ai/agent-registry-migration/src/__fixtures__/` (pre-seed for the
  unexecuted migration plan, no project.json) — harmless, owned by that plan.

## OPEN ITEMS (priority order) — most resolved this run
1. ✅ **Interface-contract recovery — RESOLVED.** Was framed as a "simple copy" but proven a **plan-content
   defect** (F1 in the ledger): the canonical `interfaces.json` is a FLAT `slug → {interface,shape,provenance,
   confidence,source}` map (gap-check Check 12); the Decision-5 refactor agent had rewritten schema's file into
   a non-conforming nested `$note`/`provides` shape (5 hard FAILs). Fix: (a) 4 untouched plans (tool-registry,
   provider, policy, mcp-refactor) mechanically recovered from main's conforming api-designer files → branch
   (`43a7541`); (b) 3 Decision-5-touched plans (schema, compiler, migration) re-authored by **api-designer
   (sonnet)** into conforming format, grounded against shipped code → provenance `vendored-source`/`verified`
   (`470e835`) — also caught that the ORIGINAL contracts had phantom signatures (`openRegistryDb`,
   `findByContentHash` never existed; `ComposedPrompt.id` is `number`). **All 7 plans pass gap-check, 0 warnings**
   (independently verified). Classified as quality defect, NOT migration: all 6 siblings are `schema_version:2`,
   `authored_with:0.8.22` = installed skill → `migrate-plan.js` would be wrong.
2. **DoD-confirm + merge schema.** DoD ✅ **DONE** — human confirmed dod.1–5 verbatim; `--confirm-dod` stamped
   `2026-06-23T20:45:51`, verified state-side (`5b7fca7`). Merge ⏳ **STILL HELD** — only shared-file divergence is
   the 1-line `tsconfig.base.json`; expect a tiny 3-way with apigen's lines. Recommend merging after the
   foundation plans land (or whenever the concurrent apigen session quiesces).
3. ✅ **Reflections (11) → memory — DONE.** Logged via the human's interactive `/sox-tools:reflection` session
   (agent runtime can't reach memory-server). Raw `REFLECTION.md` removed. Ownership map (for reference): self→
   plan-orchestrator (#1 commit-before-dispatch, #2 per-dispatch token budget, #5 steer-live-agents/SendMessage,
   #6 teammate reuse+GC); delegation→workflow-planner (#3 haiku phase reviews, #7 schedule contracts+link
   multiplan deps, #10 stale docs/plan paths); skill→plan-state-machine (#4 footgun channel, #8 worktrees-default,
   #9 multiplan sequencing, #11 minimal-plan variant, DERIVED_FROM #9).
4. **F2 audit-phase defect** (seed criteria mis-filed into `--phase schema`) was fixed in schema (commit 0d92141).
   The 6 sibling plans were checked by planner-add-review-gates; **re-verify at each plan's execution preflight.**

## Process gotchas learned (apply on resume)
- **Executors don't commit deliverables** — `state-transition --complete` commits only `state.json`. Every dispatch
  MUST say "git add reserved files + feat-commit BEFORE --complete"; orchestrator verifies the complete commit's
  file stat. (This run rescued the api-designer interfaces + source spec that had been left uncommitted on main.)
- **memory-server unreachable from agent runtime** — `memory_ping` worked once at session spawn then dropped; a
  fresh subagent spawn saw `mcp__plugin_sox-tools_sox__*` + `mcp__agent-mcp__*` but NO `memory-server`. `/mcp`
  reconnect fixes the interactive client only. Route all `memory_*` writes through the human's interactive session.
- **interfaces.json is a FLAT conforming map** (Check 12): `slug ^[a-z0-9-]+$ → {interface,shape,provenance∈
  {vendored-source,docs,spike,assumed}, confidence∈{verified,vendored,documented,assumed}, source}`. Preserve the
  slug KEYS the contexts cite as `[iface:<slug>]` or you break citations. Validate with `gap-check.js <plan-dir>`.
- **Executors don't report tokens** → metrics fall back to byte-proxy (structural; note in ledger).
- **`state-transition --complete` reports `audit_pass:false (8/23)`** and **`orchestrate-plan --decide` (no slug)
  reports `plan_complete`** — BOTH misleading full-aggregate quirks. Trust `state.json` + the `--phase` guard.
- **SendMessage unavailable** to the orchestrator — cannot steer/reuse live agents; each state spawns fresh.
- **Dispatch minimal context** (`compile-task.js --stats`, reduction_ratio ~0.95), never the whole plan dir.
- **nx cache:** `test` target is cached now — per-`--complete` guard reruns hit the cache. Never `--skip-nx-cache`.

## Ledger
Full per-dispatch ledger + F1–F4 findings: `docs/plan/agent-registry-schema/orchestration-ledger.md`.

## Resumable Dispatch line (next concrete action)
**Schema is closed out except the merge.** Next: **execute `agent-tool-registry`** (next foundation, 0/8) in
this worktree — interfaces now recovered/green; the code-review gate is in place. **Preflight first:**
`compile-task.js --board` + `gap-check.js` + `env-pin-check.js --strict` + render human-blockers, and
**re-verify the F2 audit-phase membership** before dispatching wave 1. Then drive the wave-by-wave loop.
After the foundations (tool-registry, provider, policy) → compiler → mcp-refactor → migration, **merge
`agent-registry-execution` → main** (open item 2).
