# Orchestration Ledger — agent-registry-schema (+ plan-set close-out)

Orchestrator: `workflow:plan-orchestrator` (execute, resume). `$SKILL` = installed cache
`~/.claude/plugins/cache/sox-subagents/workflow/0.8.22/skills/plan-state-machine/scripts`.
Worktree `/Users/nix/dev/node/adhd-agent-registry`, branch `agent-registry-execution`.

## Dispatch rows

| ts | slug | wave | executor | tier | tokens(in/out) | guard-exit | retries | outcome | notes |
|---|---|---|---|---|---|---|---|---|---|
| 2026-06-23 (resume) | (interfaces recovery, 4 plans) | — | orchestrator (mechanical) | n/a | n/a (no LLM) | gap-check 0 | 0 | advance | copied conforming api-designer interfaces.json from main worktree → branch for tool-registry/provider/policy/mcp-refactor; all pass Check 12 with 0 warnings; committed 43a7541 |
| 2026-06-23 (resume) | (spec recovery) | — | orchestrator (mechanical) | n/a | n/a (no LLM) | n/a | 0 | advance | docs/plan/agent-registry/ source spec was untracked+uncommitted on main; recovered → branch, committed 5b049e8 (protects from concurrent apigen session) |
| 2026-06-23 (resume) | interfaces repair (schema/compiler/migration) | — | api-designer | sonnet | 0/73390 (out; in not reported) tool_uses=41 | gap-check 0 (×3, independently re-verified) | 0 | advance | re-authored 3 Decision-5 contracts into conforming flat format; provenance docs→vendored-source citing shipped code; corrected stale orig signatures (openRegistryDb/findByContentHash never existed; ComposedPrompt.id is number); committed 470e835. agentId aa6486426d5345329. Token in not reported → output-only proxy. |
| 2026-06-23 (resume) | (schema completion re-verify) | — | orchestrator (guards) | n/a | n/a | audit 31/31 exit 0; build exit 0; test 62/62 exit 0 | 0 | advance | re-ran final-phase audit + nx build + nx test agent-registry state-side to settle "did prior plan finish" — all green NOW on branch |
| 2026-06-23 (resume) | (DoD confirm) | — | orchestrator | n/a | n/a | n/a | 0 | done | human (pseudosky) confirmed dod.1-5 verbatim; state-transition --confirm-dod stamped (confirmed_at 2026-06-23T20:45:51), verified state-side; auto-committed |

> Schema plan's 10 build/audit dispatches were driven in the prior session before this
> ledger file existed; their per-state record lives in `state.json.transition_log`
> (refs + notes) and `events.ndjson`. Token figures there fell back to
> `transcript_byte_proxy` — executors did not report MCP usage (structural, RESUME §gotchas).

## Findings

### F1 — interfaces.json recovery is a PLAN-CONTENT DEFECT, not a file-copy (corrects RESUME open-item 1)
- **Symptom:** `gap-check docs/plan/agent-registry-schema` → 5 hard FAILs (Check 12):
  `$note` slug fails `^[a-z0-9-]+$`; `provides` missing required `interface/shape/provenance/confidence`.
- **Root cause (PROVEN):** canonical `interfaces.json` is a FLAT map `slug → {interface, shape,
  provenance, confidence, source}` (Check 12 source lines 992–1054; cross-checked against the
  conforming `apigen-client-generation/interfaces.json`). Main's api-designer files conform for
  all 7 plans. The Decision-5 head/version **refactor agent** (not the original api-designer)
  rewrote the branch schema file into a non-conforming nested `$note`/`provides`/`tables` shape.
- **Classification (PROVEN, not migration):** all 6 siblings are `schema_version: 2`,
  `authored_with: 0.8.22` = the installed skill. Current schema + red gate ⇒ **quality defect →
  planner/api-designer repair**, NOT `migrate-plan.js`.
- **Authoring-tier signal (unverified):** original interfaces authored by api-designer (sonnet);
  the malformed shape was introduced by the separate refactor agent, so a sonnet api-designer
  repair (≥ authoring tier) is appropriate — the original reasoning was sound, only the refactor
  agent's re-expression was off-format.
- **Remediation order:**
  1. ✅ 4 untouched plans (tool-registry, provider, policy, mcp-refactor) — mechanical recover
     from main → branch; gap-check green; committed 43a7541. **DONE.**
  2. ⏳ 3 touched plans (schema, compiler, migration) — dispatch **api-designer** to take main's
     conforming file as base and fold the Decision-5 head/version contract (source of truth:
     `decisions.md` Decision 5 + branch's nested blob as raw material) into the conforming flat
     entry's `shape`. Verify each with gap-check Check 12 before resume. **GATED on caller go.**

### F3 — original api-designer contracts had signatures that never shipped (caught by grounding repair against real code)
- The Decision-5 repair grounded each contract against the shipped `packages/ai/agent-registry/src` code and found the *original* contracts asserted exports that do not exist: `openRegistryDb` (barrel actually exports `sqlite`/`db`), `ComponentStore.findByContentHash` (no such method), and typed `ComposedPrompt.id` as `string` when it ships `number` (integer autoincrement). All corrected; provenance upgraded to `vendored-source`/`verified`.
- **Lesson:** an interface contract authored at `provenance: docs` before code exists is a guess; once code ships, re-grounding it to `vendored-source` is mandatory or downstream plans consume phantom signatures. (Generalizes RESUME's interface-contract concern.)

### F4 — reflections (RESUME open-item 3) BLOCKED on MCP tool surface, not server liveness
- `memory_ping` returns `{ok:true}` (server live), but `memory_write` and `memory_recall` are **"No such tool available"** in this agent's tool surface — only `memory_ping` is exposed. The reflection skill forbids any file/markdown/json fallback ("no file fallback by design"), so the 11 nodes were NOT written.
- The 11 reflections are fully authored + schema-mapped (agent_id=plan-orchestrator; subjects: self→plan-orchestrator ×4 [#1 commit-before-dispatch, #2 per-dispatch token budget, #5 steer-live-agents/SendMessage, #6 teammate reuse+GC of >40 idle agents]; delegation→workflow-planner ×3 [#3 haiku phase reviews, #7 schedule interface contracts + link multiplan deps — directly caused this run's F1 blocker, #10 stale docs/plan paths]; skill→plan-state-machine ×4 [#4 executor footgun channel triaged mid-dispatch, #8 worktrees-on-by-default, #9 multiplan build sequencing, #11 minimal-plan <30k-token variant, DERIVED_FROM #9]). Raw source: `REFLECTION.md`.
- **Confirmed runtime-level (not a frozen-surface fluke):** after the user's `/mcp` "Reconnected to memory-server", a FRESHLY-spawned scribe still found NO `memory-server`/`memory_*` tools — its registry exposed `mcp__plugin_sox-tools_sox__*` + `mcp__agent-mcp__*` (the wrong store) but memory-server was absent. The interactive reconnect did not propagate to the agent execution surface. `mcp__memory-server__memory_ping` worked at THIS session's spawn but not after.
- **Recovery (needs the human's interactive session, where memory-server is reachable):** run `/sox-tools:reflection` pointed at this `REFLECTION.md`, OR execute the 11 `memory_write` payloads (fully specified in the scribe work-order this run + structured here). Attribute `agent_id: plan-orchestrator`; then `memory_link N11 DERIVED_FROM N10` (minimal-plan ← multiplan-sequencing). Likely root cause to check: the `memory-server` MCP isn't registered for the headless/subagent runtime (only for the interactive client).

### F2 — audit-phase membership (seed criteria mis-filed into --phase schema)
- Fixed in schema (commit 0d92141, recategorized to final phase). The 6 siblings were checked by
  planner-add-review-gates; **re-verify at each sibling's execute preflight** (RESUME item 4).

## Human-gated items
- **DoD-confirm (dod.1–5):** ✅ DONE — human confirmed clauses verbatim; `--confirm-dod` stamped
  2026-06-23T20:45:51, verified state-side, auto-committed.
- **Merge `agent-registry-execution` → `main`:** ⏳ HELD — human decision; concurrent apigen session
  is live on main (tsconfig.base.json collision expected). Recommend after the foundation plans land.
- **Reflections (11) → memory:** ⛔ BLOCKED on MCP write-tool surface (F4) — needs reconnect.

## Resume / next actions (for the caller)
1. Reflections: reconnect memory-server write tools → `/sox-tools:reflection` → write the 11 (F4).
2. Execute next foundation plan `agent-tool-registry` (0/8) in this worktree — interfaces now
   recovered/green; re-verify F2 audit-phase membership at its preflight. (Awaiting caller go.)
3. Merge branch → main once foundations are complete.
