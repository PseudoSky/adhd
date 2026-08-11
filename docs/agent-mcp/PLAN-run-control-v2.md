# Run-Control v2 — Budget Cap Vocabulary & Semantics Redesign

Status: PLAN (approved design) — **Packet A implemented & merged `fa2b3152` (2026-08-11)**; Packets B/C pending dispatch
Author: product + architect, 2026-08-11
Scope: `packages/agent/agent-plugin-budget`, `packages/agent/agent-base-types`,
       `packages/agent/agent-engine-orchestrator` (re-export only)
Supersedes: the flat cap vocabulary shipped pre-2026-08-11 (see §4 migration)

---

## 0. TL;DR

The agent-mcp budget system's cap vocabulary is being redesigned to match how users
actually think, grounded in (a) a live production failure — a deepseek typescript
implementer killed at ~turn 6 by a `tokens: 500000` cumulative cap at $0.03 real
spend (BUG-AGENTMCP-009), (b) competitive research across OpenAI/Anthropic/LangGraph/
CrewAI/Vercel/OpenCode/Devin (2026-08-11, §7), and (c) owner rulings (2026-08-11, §2).

Four packets: **A** fix `cap.mode` enforcement on the model path (prerequisite),
**B** rename `tokens` → `context` with peak semantics + windowed caps retained,
**C** add `errors` + `consecutiveErrors` caps, **D** design-only repeated-actions
guard. Recursion/subagent budget rollup is a spec'd future feature (deferred by
owner ruling, §6).

---

## 1. Problem

- **`tokens` is a liar.** It measures CUMULATIVE input+output volume across a task
  (`getSnapshotValue` case `'tokens'` = `inputTokens + outputTokens` from the
  accumulator; the `task_usage` schema itself warns: "CUMULATIVE… billed spend — NOT
  a context size", schema.ts:142-144). A cache-warm run re-reads the whole
  conversation every turn, so cumulative volume compounds while real spend stays
  trivial: observed 580,700 cumulative input, $0.0313 weighted spend, killed by
  `tokens limit is 500000, current value is 604800` at turn 6.
- **`cap.mode` is ignored on the model path.** `evaluateCap` throws unconditionally
  (`current >= cap.maximum` → `makeEnforcementError`), never reading `cap.mode`.
  Only the tool path honors it (`enforcePreTool` line 796:
  `cap.mode ?? mode ?? 'warning'`). A cap configured `mode: 'warning'` still kills
  the run on the model path. (Verified index.ts:723-732.)
- **No error cap.** A task can accumulate failures (different tools, not a loop) and
  nothing stops it until `calls`/`cost`/`wallClock` — all of which can be low while
  the task is dead.
- **Vocabulary diverges from industry.** Field is `'calls'`, not `'turns'`;
  `max_*` naming implies a single ceiling; users think in money/time/context/errors.

## 2. Owner rulings (2026-08-11, binding)

1. **Rename `tokens` → `context`, NO deprecated alias.** Hard removal; configs using
   `tokens` fail validation with an explicit migration message. Old field names are
   debt — never leave aliases.
2. **`context` = peak single-request input size** (what the model actually sees at
   one moment), NOT cumulative volume. Model-relative option
   (`contextWindowFraction`) against a context-window registry.
3. **Windowed caps are retained and valued.** They answer "across all sessions — or
   one session running many agents — we never burn through resources." The `window`
   field (`PT24H` etc.) and session/agent/global scopes stay first-class. This is
   the *resource-burn* axis; `context` is the *memory* axis. **Do not drop
   `maxTokensPer24h`-class windowed cumulative caps** — re-express them, don't remove.
4. **Catch early: `context` enforcement value = max(provider-reported peak,
   tools-aware estimate of the pending request).** One-request-lag (reported-only)
   is rejected.
5. **Default mode = `warning` for everything.** Mode-less caps warn, they don't
   block. Blocking is opt-in per-cap (`mode: 'block'`).
6. **No hidden code defaults.** Any default the system applies MUST be carried in
   the configuration files (global config), never silently in code. The global
   config is the source of defaults; code has no fallback defaults beyond "warning".
7. **`budget:*` events for BOTH warning and block.** `budget:warning` and
   `budget:block` are emitted; block handling hooks into the event the same way
   warning does. Symmetric treatment.
8. **Recursion/subagent budget rollup = future feature, correctly spec'd** (§6), not
   built now. Depth is already enforced by the policy engine (`MAX_DEPTH_EXCEEDED`).
9. **Plan + research must be persisted** (this doc + §7 research doc) — the backlog
   graph and memory stores were down during design (2026-08-11).

## 3. Packet designs (architect-verified, pending these rulings)

### Packet A — fix `cap.mode` on the model path (S, prerequisite)

> **SHIPPED `fa2b3152` (2026-08-11).** Review gate PASSED; findings folded in
> (commit `1d3b5bd1`): F1 tool-path `budget:block` emission (symmetry, ruling 7),
> F3 stale test comment, F5 typecheck targets on both projects
> (`tsconfig.lib.json` pattern). Operational guard (F4): explicit `mode: "block"`
> added to all mode-less model caps in the untracked repo config
> `.adhd/agent-mcp/config.json` so live behavior is unchanged until Packet B's
> config migration supersedes it. §5.5 resolution recorded in the plan.

- **Change:** `enforcePreModel` honors `cap.mode` — warning caps emit
  `budget:warning` and continue; block caps emit `budget:block` then throw
  `makeEnforcementError`. Default for mode-less caps = **warning** (owner ruling 5 —
  amend architect's 'block' default).
- **Warning surface:** new `BudgetWarningPayload { executionContext; field; maximum;
  current; message }` + `BudgetBlockPayload` (same shape) in `HookEventMap`
  (hooks.ts:70-91); plugin captures registry in `install()` and emits. Hosts opt in
  via handler; no handler = no-op. Do NOT reuse `IToolWarning` (means "block this
  tool call"; orchestrator rethrows it from the model path, orchestrator.ts:321).
- **Symmetric block handling** (owner ruling 7): `budget:block` emitted before the
  throw; orchestrator's existing `IEnforcementError` → `ToolError('BUDGET_EXCEEDED')`
  conversion (orchestrator.ts:318-322) stays; the event is the notification layer.
- **Acceptance (red→green):** warning-mode `calls` cap exceeded → `enforce` resolves
  + handler called; block-mode → rejects `BUDGET_EXCEEDED`; mode-less cap → **warns**
  (was: rejects — this is the behavioral change per ruling 5); run continues after
  a warning.

### Packet B — `tokens` → `context` (M; windowed caps retained per ruling 3)

> **SHIPPED `da3373d2` (2026-08-11).** Review gate PASSED (deviations D1-D4
> accepted; H1 release ordering below). Implementation commit `ccaa661c`
> (5 files): `model-context.ts` registry moved verbatim from the engine (engine
> re-exports, zero API change); `estimateRequestContext` tools-aware estimator in
> the plugin (D1); scoped `context` folds the pending estimate
> `max(db-peak, in-memory peak, estimate)` (D2); fraction limit floored (D3);
> `assertNoLegacyTokensConfig` hard removal; `maxTokensPer24h` → windowed
> `inputTokens`; 59/59 tests green incl. the BUG-AGENTMCP-009-named cache-warm
> regression (red proven on pre-fix source). Configs migrated (repo + global) to
> `context:128000 block` + `inputTokens:500000 PT24H warning`; verified live on
> main after rebuild (`createPlugin` accepts the migrated config — the loader
> skip that silenced budget between config-migration and merge is closed).
> §5.2 resolution (MAX(peak_context_tokens)) confirmed at dispatch.
> **H1 (release-gate):** the plugin's module-level `import { contextWindowFor }`
> makes published base-types a hard prerequisite — the release wave MUST publish
> `agent-base-types` FIRST (with the export) and raise the plugin's peerDependency
> floor, or every npm consumer's budget silently dies at module load. See §9.

- **Semantics:** `context` = `MAX` over model responses of provider-reported
  normalized `inputTokens` (byte-identical to usage-plugin's `peakContextTokens`,
  usage-plugin.ts:143,172-181). Enforcement value =
  `max(acc.peakContextTokens, estimateRequestContext(messages, tools))` — the
  tools-aware estimator (fixes BUG-ORCH-006 undercount) catches an oversized pending
  request pre-flight. No engine measurement change needed (post:model_response
  already carries the total).
- **Registry:** NEW `agent-base-types/src/model-context.ts` carries `CONTEXT_WINDOWS`
  + `contextWindowFor` verbatim (from engine context-window.ts:31-60, 128K fallback);
  engine re-exports — zero public API change. Rationale: plugin's peer dep is
  base-types; importing agent-core-provider would drag drizzle-orm into consumer
  trees.
- **Schema:** remove `'tokens'`, add `'context'` in FIELD_NAMES. capSchema adds
  `contextWindowFraction?: 0..1` + superRefine: `context` requires exactly one of
  `maximum`/`contextWindowFraction`, rejects `window` (a windowed peak is
  meaningless — but windowed *cumulative* caps remain expressible via `inputTokens`/
  `outputTokens` + `window`; see ruling 3 + §5). Non-`context` fields reject
  `contextWindowFraction`.
- **Migration (NO alias):** `assertNoLegacyTokensConfig(raw)` at top of
  `normalizeConfig` (156) throws for structured `caps[].field === 'tokens'`, flat
  `maxTotalTokens`. **`maxTokensPer24h` is NOT dropped** (ruling 3) — re-expressed:
  the flat alias maps to a windowed cumulative cap on a volume field (e.g.
  `{field: 'inputTokens' | 'tokensVolume', window: 'PT24H'}` — see §5 open design
  point; the architect's "deliberately dropped" verdict is overruled). Loader
  catches factory throws and logs (loader.ts:227-233); server doesn't crash.
- **Scopes:** task = in-memory peak; session/agent/global = `COALESCE(MAX(
  peak_context_tokens), 0)` from task_usage (column exists). `context` enforced on
  model path only (extend the line-744 filter that excludes `toolCalls`).
- **Acceptance (red→green, named BUG-AGENTMCP-009):** cache-warm regression — 100
  turns of 8K input each (850K cumulative) with `context: 50_000` → all enforce
  resolve; single 60K turn → next enforce rejects; fraction 0.5 on gpt-4o-mini (128K
  → 64K) trips at 70K not 60K; legacy `tokens`/`maxTotalTokens` configs throw with
  a `context`-mentioning message; windowed cumulative cap (e.g. `maxTokensPer24h`
  re-expressed) still enforces across turns.
- **Config file migration:** repo `.adhd/agent-mcp/config.json` + global
  `~/.adhd/agent-mcp/config.json` — replace `tokens: 500000` caps with the approved
  `context` + windowed + errors posture; defaults carried INTO the files (ruling 6).

### Packet C — `errors` + `consecutiveErrors` (S–M)

- **Count:** at `post:tool_call` from the existing `isError` flag (orchestrator.ts:
  764-772; fires only for executed tools; thrown-errors-only — matches owner lean;
  error-shaped non-throwing results are indistinguishable at this boundary).
- **Fields:** `errors` (cumulative, recommended default 5), `consecutiveErrors`
  (default 3). Both reject `window` (windowed errors: re-express or future).
- **Enforcement:** tool path only (extend the line-744 filter); warning-by-default is
  free (tool path already defaults `'warning'` — consistent with ruling 5).
- **Defaults in config files, not code** (ruling 6): the global config carries
  `errors: 5` / `consecutiveErrors: 3` explicitly.
- **Verified non-self-amplifying:** a warning-mode errors cap fires `IToolWarning` at
  pre:tool_call → orchestrator injects warningResult and skips the call (620-624) →
  no post:tool_call → counters don't feed themselves.
- **Acceptance (red→green):** 3 failures with `errors: 2` block → 3rd rejects;
  consecutive reset on success; no-mode → warning not block; all-success never trips.

### Packet D — DESIGN ONLY: repeated-actions / no-progress guard (not scoped for build)

- Fingerprint `sha256(qualifiedToolName + '\0' + canonicalJson(toolInput))`
  (recursive key-sort, stable stringify, drop undefined); computable at pre:tool_call
  with no payload change.
- Progress = `ExecutionContext.toolCallCount` delta (orchestrator.ts:640); repeated
  fingerprint whose count hasn't advanced = no progress. Content-hash refinement
  deferred.
- Thresholds: K=3 consecutive identical no-progress → warn; N=5 → escalate. Warning
  first; soft-block via `IToolWarning` (call skipped with diagnostic; agent adapts).
- Requires product sign-off on thresholds + no-progress definition before a future
  packet.

## 4. Current state (verified 2026-08-11, path:line)

| Fact | Evidence |
|---|---|
| Cap field is `'calls'`; no `'turns'` anywhere | FIELD_NAMES budget index.ts:38-48 (`'calls'` at 42); zero `'turns'` literals |
| Schema has NO operators (lte/lt/gt) | capSchema index.ts:50-57 — only `{field, maximum, window?, scope?, mode?, message?}` |
| `mode` ignored on model path, honored on tool path | evaluateCap index.ts:723-732 (unconditional throw); enforcePreTool 796 |
| `tokens` = cumulative input+output, not peak | getSnapshotValue 687-696; task_usage schema.ts:142-144 explicit warning |
| Subagent spend: tracked+reported+depth-enforced, NOT budget-enforced | usage-plugin.ts:36/75/126/228-235; budget accumulators keyed per taskId (319-333); policy.ts:66-69 enforces depth only |
| Peak context is nearly free | post:model_response carries normalized inputTokens; usage-plugin computes peakContextTokens (143,172-181) |
| Context-window registry exists (internal) | engine context-window.ts:31-60 (`CONTEXT_WINDOWS`, `contextWindowFor`, 128K fallback); divergent second source: ModelStore.contextWindow (agent-core-provider/model-store.ts:12) |
| Error signal exists at the right seam | post:tool_call carries isError (orchestrator.ts:764-772); message.ts:20 |

## 5. Open design points (resolve before/at dispatch)

1. **Windowed cumulative field name** post-`tokens`-removal: re-express
   `maxTokensPer24h` as windowed `inputTokens`, or introduce a `tokensVolume`
   cumulative field? (Owner: windowed caps valued; architect originally dropped —
   overruled. Prefer minimal: windowed `inputTokens` + `outputTokens` already cover
   volume; `maxTokensPer24h` flat alias re-maps to windowed `inputTokens`.)
2. **`context` at session/agent/global = MAX(peak_context_tokens)** — accepted by
   owner (ruling 4 context); confirm at dispatch.
3. **errors caps configured-only** (recommended — no silent behavior change to
   existing configs) vs auto-applied defaults. Owner leaned warning-by-default
   posture; recommended: configured-only with the 5/3 defaults carried in the global
   config file (ruling 6).
4. **Divergent context-window sources** (engine prefix table vs
   `ModelStore.contextWindow`) — consolidate later, out of this wave.
5. **`budget:block` payload parity** with `budget:warning` — confirm whether the
   orchestrator needs to *act* on the event (e.g. host-facing) or whether the
   existing `ToolError('BUDGET_EXCEEDED')` conversion is the action and the event is
   pure notification. (Owner: block "should probably hook into that event".)
   **RESOLVED at Packet A dispatch (2026-08-11):** the event is the notification
   layer only; the orchestrator's existing `IEnforcementError` →
   `ToolError('BUDGET_EXCEEDED')` conversion (orchestrator.ts:318-319) is the action;
   hosts hook the event via `HookEventMap`. Verified the orchestrator already
   performs the conversion and was untouched by Packet A.

## 6. Deferred future feature — recursion / subagent budget rollup

Verified current state: subagent spawn threads `rootTaskId` +
`recursionDepth = callerContext.recursionDepth + 1` (task.ts:79-100); usage-plugin
persists rootTaskId (schema.ts:138, index 185) and the usage report aggregates
subtrees by rootTaskId (tools/usage.ts:100-105,224); depth is ENFORCED by the policy
engine (`MAX_DEPTH_EXCEEDED`, policy.ts:66-69) — but **budget accumulators never
aggregate child spend into parent caps**. Future shape: budget `scope: 'root'`
aggregating `task_usage` by `root_task_id` (index exists). Owner: future feature,
correctly spec'd — not this wave.

## 7. Research — external cap vocabulary & user perception (2026-08-11)

Full findings are in `docs/ideas/run-control-cap-research.md` (companion doc,
written because memory/backlog stores were down). Highlights:
- **Industry vocabulary:** turns/iterations/steps (OpenAI `max_turns`=10, LangGraph
  `recursion_limit`=25, CrewAI `max_iter`=20-25, Vercel `maxSteps`, OpenCode
  `steps`); cost USD (Claude Code `--max-budget-usd` counts subagent spend, Copilot
  AI-credit session limits 2026-07-01); time (CrewAI `max_execution_time` — unit
  confusion bug CrewAI#732); error caps (CrewAI `max_retry_limit` default 2,
  production failure budgets 5-10, n8n 5-in-10-min).
- **No major framework ships a configurable task-level error budget or a
  no-progress/repeated-action guard** — differentiated territory.
- **User complaints:** token-volume caps decoupled from spend (HN 48297491,
  tokenfence.dev); "context limit fills up faster" backend-shift perception (HN
  47096937); runaway spend incidents ($6K/$1.8K overnight, devtoolpicks/MSN);
  unit/name confusion (CrewAI#732); 80%-alerts-too-late for autonomous agents
  (medium.com teja.kusireddy23).
- **Thresholds worth copying:** turns 10-25; per-tool retries 3; task failure
  budget 5/10; wall-clock 10 min; error retry 2; 5 failures/10min; budget alert 80%.

## 8. Outstanding items from prior dispatch (persisted — backlog graph down)

1. **BUG-AGENTMCP-009 (OPEN, HIGH)** — the 500K cumulative token cap kills
   cache-warm runs at trivial cost. Packet B fixes the semantics; the repo config
   `tokens: 500000` (project-scope `.adhd/agent-mcp/config.json`) must be migrated.
2. **Model-path `mode` ignored** (no BL id — backlog down) — Packet A.
3. **6 DEBT follow-up items fixed in code, still OPEN in graph** (graph write path
   down): SYMLINK-TEST-TEETH, TEST-ENV-LEAK, MIGRATION-PINNED-MARKER,
   INSTALL-HOST-DEFAULT, HITL-TEST-CLEANUP, CHANGELOG-ID-COLLISION. Re-verify and
   transition RESOLVED once the store is repaired.
4. **P1 budget fix unpublished on npm** — `@adhd/agent-plugin-budget@0.1.0` (npm) is
   the pre-cache-weighting build; release must bump+ship plugin + agent-mcp together.
5. **Backlog graph write path down** (sox-graph-store FK mismatch after turso
   migration 70faf42e) — blocks all filing; needs store repair.
6. **Memory server down** (stale WAL sidecar, BL-373) — needs manual sidecar move.
   NOTE 2026-08-11 16:30: recovery deferred — another agent is actively performing
   forensic analysis of the sidecar (`/var/folders/.../opencode/forensic-wal`); do
   not move the sidecar while that investigation is in flight.
7. **TS6305 in fresh worktrees: `tsc -p tsconfig.json --noEmit` typecheck targets
   fail on 7 projects** — agent-engine-orchestrator, agent-core-provider,
   agent-core-policy, agent-engine-compiler, agent-store-runtime, agent-store-prompts,
   agent-store-tools. Root cause: their root tsconfigs mix `include` with
   `references` to composite projects whose `dist/packages/<proj>/` outputs are
   never produced by the vite builds, so a fresh worktree fails TS6305 (main
   checkout masks it with stale artifacts). Found 2026-08-11 while adding Packet A
   typecheck targets. Backlog-worthy (BL-248-adjacent); file when the graph store
   is repaired. Packet A used the `tsconfig.lib.json` pattern instead
   (dispatch-cli/backlog/apigen-base-types cluster) — clean in fresh worktrees.
8. **Tool-path `budget:block` event asymmetry (F1) — FIXED in Packet A review
   fold-in (commit `1d3b5bd1`):** tool-path block branch now emits `budget:block`
   before the throw, symmetric with the model path (owner ruling 7).
9. **Tool-scoped `context` caps are silently inert** (Packet B review finding,
   low): `enforcePreTool` filters out `context`, `enforcePreModel` can't see tool
   overrides, yet capSchema permits the placement — a silent no-op. Decision:
   capSchema REJECTS `context` in tool scope (schema error, not warning); folded
   into Packet C dispatch (same file/test).
10. **Release-ordering hazard (H1, Packet B review, HIGH):** published
    `@adhd/agent-base-types@2.2.0` lacks `contextWindowFor`; the plugin's new
    module-level import makes base-types a hard publish prerequisite. Release
    wave must publish base-types FIRST + raise plugin peerDependency floor.

## 9. Dispatch plan (when approved)

Strictly serial A → B → C in ONE worktree (all three edit
`agent-plugin-budget/src/index.ts` + `budget-plugin.test.ts`); commit each packet
separately by pathspec; review gate before merge (read-only review agent, no cf/rf);
post-merge full gate `npx nx run-many -t build,lint,test --projects=agent-plugin-
budget,agent-mcp,agent-engine-orchestrator,agent-base-types`; then release wave
(bump + publish plugin and agent-mcp together). Worktrees under `.worktrees/`.

**Status: Packet A DONE** (worktree `.worktrees/run-control-v2`, commits `8876fa00`
+ `1d3b5bd1`, merge `fa2b3152` on main). **Packet B DONE** (commit `ccaa661c`,
merge `da3373d2` on main). Packet C next in the same worktree (re-point branch to
main), then the release wave.

**Release wave (amended for H1):** publish order is REQUIRED, not optional —
1. `agent-base-types` (contains the new `model-context.ts` export; the plugin's
   module-level import fails against the published 2.2.0 without it)
2. `agent-plugin-budget` (bump version; RAISE the `@adhd/agent-base-types`
   peerDependency floor to the new base-types version)
3. `agent-mcp` (bump + ship together)
Verify with a clean-room install + `npx @adhd/agent-mcp` + budget accounting
exercised through the published artifacts before calling the release done.
