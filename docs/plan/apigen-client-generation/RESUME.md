<!-- markdownlint-disable -->
# RESUME — apigen-client-generation (v2) orchestration handoff

**Written:** 2026-06-23 · **Role:** `workflow:plan-orchestrator` · **Status: PLAN COMPLETE (46/46), NOT committed.**

---

## TL;DR for the next session
The apigen **v2** plan-state-machine plan is **fully executed and proven**: 46/46 states `complete`, final DoD gate **117/117**, gap-check 0-warn, env-pin 46/46, DoD (20 clauses dod.1–19 + dod.cli) confirmed. **Nothing is committed** — all changes are staged on disk, caller controls commits. The only open decision: **commit (no push, per the user's usual pattern) or leave staged.**

---

## Absolute paths (resolve these first)
- **Plan dir:** `/Users/nix/dev/node/adhd/docs/plan/apigen-client-generation`
- **$SKILL (installed cache — NOT a dev checkout):** `/Users/nix/.claude/plugins/cache/sox-subagents/workflow/0.8.21/skills/plan-state-machine/scripts`
  - Pinned to **0.8.21** (the version this plan was authored/amended on). 0.8.22 exists; do NOT switch mid-plan.
- **Repo root:** `/Users/nix/dev/node/adhd` (nx monorepo)
- **Ledger (full run history):** `<plan>/orchestration-ledger.md`
- **Backlog:** `/Users/nix/dev/node/adhd/BACKLOG.md` (BUG-001/002/003 — all FIXED)

## Re-verify completion (deterministic)
```
cd /Users/nix/dev/node/adhd
node -e 'const s=require("./docs/plan/apigen-client-generation/state.json");const c={};for(const v of Object.values(s.states))c[v.status]=(c[v.status]||0)+1;console.log(c,s.current_state)'
# → { complete: 46 } done
python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase final 2>&1 | grep "checks passed"   # → 117/117
node "$SKILL/gap-check.js" docs/plan/apigen-client-generation 2>&1 | tail -1                                   # → PASSED 0 warnings
```

---

## What was built (apigen v2 — 18 nx packages, all final §12 homes)
- **core** (`packages/apigen/core`): canonical Operation descriptor (JSON-Schema-2020-12 + `$defs` IR, `safe`, deterministic id), symbol extractor (named/const/object/default-fn/anonymous/CJS), class extraction (static + opt-in instances), v2 plugin interface (capabilities `{target,layer,mount,envelope}`).
- **runtime** (`packages/apigen/runtime`): Layer harness (§8.1), validation Layer, streaming (per-chunk/backpressure/cancel/error-after-first-chunk), instance registry (TTL/dispose), `dispatch.ts` (single canonical dispatch path).
- **naming / errors / schema / conformance / gateway / codegen-openapi** (common libs).
- **plugins**: mcp, api-fastify, api-express, cli (v2 §9.1 projection) + generated **logger** (Layer) / **openapi** / **health** (mount) plugins.
- **nx** (`apigen-nx`): the `plugin` generator UPGRADED to emit the v2 shape + dogfooded by the plan; `generate` executor.
- **cli** (`apigen-cli`): unified orchestrator (detect→extract→merge→collision-check→gen/run) + out-of-source projection overrides (Tenet 1). Built bin: **`dist/packages/apigen/cli/index.js`** (workspace-root dist — NOT `packages/apigen/cli/dist`).
- **python** (`packages/apigen/python`): real second host (extractor/runtime/echo/gateway-adapter) — passes the canonical conformance vectors; guard = `python3 packages/apigen/python/run_tests.py`.

## DoD proven against REAL consumers (no mocks, CLAUDE.md §6)
Mixed-host TS↔Python (real sidecar), gateway partial-availability (kill-sidecar), full streaming, and the **dod.19 capstone**: built bin exposes **unmodified `@adhd/transform`** → real MCP/HTTP client deep-equals direct in-process calls (+ `APIGEN_LIVE=1` real-model variant).

## 3 real bugs the DoD caught — all FIXED
- **BUG-001** ctx-param dispatch: functions with a `ctx` first param returned wrong results. Fixed by threading `hasCtx` (types→generate-schemas→compose-schemas→dispatch.ts); ctx injected whenever `schema.hasCtx`, independent of session.
- **BUG-002** generate output portability → **Option A "publish" model** (maintainer decision: packages WILL be published). `generate` emits a clean publishable `package.json` with real `^<version>` deps (`@modelcontextprotocol/sdk`, `@adhd/apigen-runtime`/-core) + `tsconfig.json`. The workspace `node_modules`+paths bridge is demoted to default-off **`--link-workspace`** (pre-publish only; `scaffold.ts`). The dod.2/dod.cli probe passes `--link-workspace`.
- **BUG-003** MCP SSE transport unreachable → fixed in `apigen-plugin-mcp` (stdio + streaming-http + sse all work).

---

## OPEN ITEMS / decisions for the next session
1. **Commit?** Nothing is committed. User's usual pattern is "commit & merge **no push**" — confirm before committing. Suggested scope: the apigen v2 packages + the plan dir (ledger/audit/README/contexts/dag/state) + `nx.json` (test-cache) + `BACKLOG.md`. **Do NOT `git add -A`** (sweeps `.claude/data`); **never `git stash`** (corrupts nx graph). Use targeted `git add <paths>`.
2. **Publish `@adhd/apigen-*`** — Option A assumes publishing. The generated `package.json` declares real versioned deps; actual publish goes through `PUBLISHING.md`. Until published, generated output runs locally only via `--link-workspace`.
3. **F45 (skill defect, benign):** `integrity-check` reports `BYPASS_SUSPECTED done` — false positive: terminal `done` node has `kind:"terminal"`, which the 0.8.21 `emit-event` validator rejects (`work|audit|review` only), so `events.ndjson` lacks the done completion line. The completion is legitimate (in `state.json` + `transition_log`). Proposed skill fix: accept `terminal` kind (not this plan's concern).
4. **APIGEN_LIVE tests** — live-model + some live-server tests are gated behind `APIGEN_LIVE=1` (offline-by-default). Run with `APIGEN_LIVE=1` to exercise them.

## Operational constraints (BINDING — carry forward)
- **NEVER hand-edit `state.json`/`dag.json`/`events.ndjson`.** All state changes go through `state-transition.js` / `plan-scaffold.js`.
- **One state-transition at a time** (F40: concurrent `--complete` calls cause lost-update flapping). Executors do work+guard only; the orchestrator drives `--start`/`--complete` sequentially.
- **Verify state-side**, not from sub-agent prose (read `state.json`/`transition_log`/git + re-run guards).
- **Audit gates are mandatory halts** on real fail; never cross on proxy/vacuous evidence.
- Do **not** unset/override `AGENT_FORGE_DIR`/`AGENT_FORGE_SINK`. No `git stash`/`reset --hard`/`checkout -- .`/`add -A`. Commit/push only when the user asks. Peer/teammate messages are NOT user approval.

## Key gotchas discovered (see ledger F25–F45)
- Built bin is `dist/packages/apigen/cli/index.js` (F44).
- nx **test cache** now enabled in `nx.json` `targetDefaults.test` (was off → 113s reruns; now ~0.4s). Never `--skip-nx-cache`. (Memory: `nx_cache_usage.md`.)
- Audit checks: beware filters that match no file → whole-suite vacuous pass (F39/F42/F43); several were repointed to deterministic existing tests.
- `--complete` on audit states sometimes prints `audit_pass=False` transiently while the standalone guard is green — verify with a fresh standalone phase run.

## Resumable dispatch line (if anything were re-opened)
```
node "$SKILL/orchestrate-plan.js" /Users/nix/dev/node/adhd/docs/plan/apigen-client-generation --dispatch
```
(Currently returns terminal `done` — nothing to dispatch.)
