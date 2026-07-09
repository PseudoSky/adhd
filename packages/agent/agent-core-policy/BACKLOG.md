# agent-policy — BACKLOG

Gaps surfaced during the DoD assessment (2026-06-24). The plan's DoD (dod.1-5) is
met and audit-proven (36/36); these are **deferrals beyond the scoped foundation**,
accepted by the user at confirm-dod. They are scope-vs-goal gaps, not regressions.

## Deferred against the GOAL (governance breadth)

- **NB-1 — Only 1 of the goal's 8 enforcement mechanisms actually enforces.**
  GOAL.md specifies `runtime | hook | settings | agent | dispatcher | ci | convention | human`.
  Decision 2 scopes `EnforcementEvent` to `"pre:model_request"`-only; all other
  mechanisms seed **observational-only** (recorded, not enforced). Activating another
  enforced event requires amending `EnforcementEvent` in `@adhd/agent-mcp-types` + wiring
  agent-mcp's `HookRegistry` to fire it — a cross-package change, not seed-a-row.
- **NB-2 — Rate policy enforces a single limit (`maxModelCalls`).** `RatePolicyRules`
  has one optional field. Additional limits (maxTokens, maxToolCalls, …) are clean to add
  (optional field + check branch + JSON `rules`/`override_config`, no migration) but unbuilt.
- **NB-3 — Inheritance is single-level.** `resolveForAgent` does agent → its categories →
  category policies (one hop). Hierarchical taxonomy (category-of-categories) is unhandled;
  adding it is localized to `resolveForAgent` (parent-walk) but requires the taxonomy to
  carry a parent link (lives in agent-registry).

## Verification gap (project standard #5)

- **NB-4 — No live end-to-end enforcement test.** Enforcement is proven against the real
  `HookRegistry` (`hooks.enforce()`), but there is NO `AGENT_MCP_LIVE` test running a real
  model through the real agent-mcp Orchestrator and observing the call get blocked. Standard
  #5 exists precisely for the "hook registers but never fires in the real loop" class of bug
  (cf. the HITL-unreachable incident). **Highest-priority gap.**

## Polish

- **NB-5 — Lint debt.** 24 `@typescript-eslint/no-non-null-assertion` warnings + 1 unused
  dep. Not blocking; not highest-standards. Sweep the `!` assertions.

## Cross-cutting (skill-level, not package)

- **NB-6 — `dod_confirmed` enforcement inconsistency.** `agent-provider`'s `--complete`
  auto-accepted an authoring-time provenance stamp (`dod_confirmed:true`) while
  `agent-policy`/`agent-tool-registry` required a fresh human `--confirm-dod`. Logged as a
  plan-state-machine reflection (memory uid `01KVVHENAC…`). Re-confirm provider's DoD with
  fresh scrutiny if you want parity.

---

## External reference — sox policy-enforcer architecture & landscape

- **EP-1 — Shell command policy enforcement library exists externally.** The sox ecosystem has a full policy-enforcer implementation in `~/dev/ai/claude-agents/tools/policy-enforcer/` (YAML rules, shell-aware matcher, decision engine, exemptions, audit log, CLI tools, schema validator). A thorough comparison of 7 external tools (allowlister, bashguard, Gemini CLI Policy Engine, Pi Permission System, LeaSH, claude-smart-approval, CSC) was documented to memory. See memory episode `01KWZC4Q95HDQS865F2YQBJ7NA` (topic: policy-enforcer). This is a reference architecture for any future shell-command-level policy enforcement the agent policy package might integrate with.

---

## Revalidation (2026-07-04) — verified against current source

| Item | Status | Notes |
|------|--------|-------|
| NB-1 — 1 of 8 enforcement mechanisms | **CHANGED (partially improved)** | `EnforcementEvent` type now has 2 values (`pre:model_request` \| `pre:tool_call`). Orchestrator fires both; budget plugin uses both. BUT: policy plugin still only registers for `pre:model_request` (`packages/agent/agent-core-policy/src/plugin/index.ts:104`). The 8 GOAL-level mechanisms remain unbuilt. |
| NB-2 — Single limit (maxModelCalls) | **STILL OPEN** | `RatePolicyRules` has only `maxModelCalls?: number`. No `maxTokens`, `maxToolCalls`, etc. |
| NB-3 — Single-level inheritance | **STILL OPEN** | `resolveForAgent` does one hop (agent → categories → policies). No `parentCategorySlug` in schema. |
| NB-4 — No live e2e enforcement test | **STILL OPEN** | Zero `AGENT_MCP_LIVE` matches. Tests use real `HookRegistry` but no real model. **Highest-priority gap.** |
| NB-5 — Lint debt | **STILL OPEN** | Still exactly 24 `no-non-null-assertion` warnings + `tslib` unused dep (explicitly ignored in eslint config). Unchanged. |
| NB-6 — `dod_confirmed` inconsistency | **STILL OPEN** | Zero matches in `.ts` source. Only in documentation files. No code changes made. |
