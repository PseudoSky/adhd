# sox vs adhd — Feature Comparison v2 (2026-08-12)

**Scope.** This document compares the **sox CLI ticket state-management system** (`/Users/nix/dev/ai/claude-agents/tools/cli`, sox state machine, event log, supervisor, worker orchestration) against the **adhd** stack's three feature-bearing groups: the **backlog CLI** (`/Users/nix/dev/node/adhd/entrypoint/backlog`), the **agent-mcp tooling** (`/Users/nix/dev/node/adhd/packages/agent` + `entrypoint/agent-mcp`), and the **dispatcher orchestration** (`/Users/nix/dev/node/adhd/packages/dispatch`). The **sox-ecosystem storage substrate** (turso/sox graph store, bi-temporal memory) was cataloged on a standalone track and is noted as background only — it is not a comparison column here, because the adhd backlog's storage substrate is a different engine and comparing substrates would conflate "the tool's own capability" with "the infrastructure it sits on."

**Method.** All evidence is evidence-cataloged in graph memory, produced by two-sided exploratory verification, plus a system-lens pass (v2) surfacing enforcement-vs-recorded, authority, inertness, emergent behavior, and integration properties. The pipeline ran entirely in graph memory and never re-derived from code after Wave 1: (1) per-group capability catalogs (47 episodes), (2) capability manifests (11), (3) anchor equivalence maps (4), (4) a unified feature catalog F1..F40 split into 4 parts plus adhd-only (A1..A16) and absence registers, (5) reconciliation pass D (which demoted over-merged rows and added missed mappings — 17 correction episodes), (6) two-sided exploratory verification (adhd-side + sox-side, 5 reports + 6 correction episodes), (7) a **system-lens pass v2** (12 episodes from 5 analysts, topic `sox-vs-adhd-system`) producing enforcement-vs-recorded, authority, inertness, emergent-behavior, and integration findings, and (8) a **strict consolidation v2** re-deriving the catalog into **F1..F41 + S1..S15** (splitting F16→F41; every v2 finding homed exactly once, either as a feature Implications bullet or an S-row). Every claim below traces to file:line citations carried inside those episodes; negative evidence is recorded as `rg <pattern> <path> = 0 hits` or a CLI-surface check. No code or docs were re-explored during synthesis of this document.

**Memory source index.** All source episodes are recallable from `~/.memory/memory.db` (topics `sox-vs-adhd-features`, `sox-vs-adhd-manifest`, `sox-vs-adhd-equivalence`, `sox-vs-adhd-catalog`, `sox-vs-adhd-reconciliation`, `sox-vs-adhd-verification`, `sox-vs-adhd-system`, `sox-vs-adhd-catalog-v2`). UIDs are listed in the Evidence & Method Appendix (section 4).

---

## 1. Feature Comparison Table

Legend: **✓** = fully supported · **◐** = partial (difference note in section 2) · **✗** = not supported.
**adhd (superset)** = ✓ if at least one of backlog/agent/dispatch is ✓, ◐ if the best adhd cell is ◐, ✗ if all three are ✗. A row flagged **GAP** is a superset gap: the feature exists on sox but is missing (or only convention-level) on the entire adhd side.

| Feature | sox | backlog | agent | dispatch | adhd (superset) |
|---|---|---|---|---|---|
| **A — State & lifecycle** | | | | | |
| F1 Formal work-item state machine & transition legality | ✓ | ◐ | ◐ | ◐ | ◐ |
| F2 Multi-agent claim lease with identity CAS | ✓ | ◐ | ◐ | ◐ | ◐ |
| F3 Priority model & durable assignment | ✓ | ◐ | ◐ | ◐ | ◐ |
| F4 Dependency blocking, readiness & cascade | ✓ | ◐ | ◐ | ✓ | ✓ |
| F5 Work-item authoring, context, plans & spec mutation | ✓ | ◐ | ✗ | ◐ | ◐ |
| F6 Structural lifecycle ops (supersede / split / merge / relate / plan / assign) | ◐ | ✓ | ✗ | ✗ | ✓ |
| **B — Trust & recovery** | | | | | |
| F7 Append-only event/audit log | ✓ | ◐ | ✗ | ◐ | ◐ |
| F8 Audit querying & reconstruction from logs | ✓ | ◐ | ✗ | ◐ | ◐ |
| F9 Tombstone / quarantine / archival retirement | ✓ | ◐ | ✗ | ✗ | ◐ |
| F10 Heartbeat / liveness & stale-claim detection | ✓ | ◐ | ✗ | ✗ | ◐ |
| F11 Concurrency control & atomic writes | ✓ | ◐ | ✗ | ✗ | ◐ |
| F12 Collision-safe ID minting | ✓ | ◐ | ✗ | ✗ | ◐ |
| F13 Git worktree isolation (runtime enforcement) | ✓ | ✗ | ✗ | ◐ | ◐ **GAP** |
| F14 Install-level snapshots & restore (verified) | ✓ | ✗ | ✗ | ✗ | ✗ **GAP** |
| **C — Operational machinery** | | | | | |
| F15 Layout / migration machinery (phased, dry-run, authority shift) | ✓ | ◐ | ✗ | ✗ | ◐ |
| F16 Admin / operator mutations | ✓ | ◐ | ✗ | ✗ | ◐ |
| F17 Review gates, evidence gates & handoff pipeline | ✓ | ◐ | ✗ | ◐ | ◐ |
| **D — Interface & surface** | | | | | |
| F18 One op surface over multiple transports (CLI + MCP) | ✓ | ◐ | ◐ | ◐ | ◐ |
| F19 Uniform error / exit-code contract | ✓ | ✓ | ✗ | ◐ | ✓ |
| F20 MCP wire boundary & tool-surface naming | ◐ | ◐ | ◐ | ✓ | ✓ |
| F21 Versioned agent definition lifecycle (CRUD + version) | ✗ | ✗ | ✓ | ◐ | ✓ |
| F22 Provider config schema & credential guards | ✗ | ✗ | ✓ | ◐ | ✓ |
| **E — Execution & orchestration** | | | | | |
| F23 Orchestration cycle with per-unit persistence | ✗ | ◐ | ◐ | ✓ | ✓ |
| F24 State-derived eligibility, resumption & re-derivation | ◐ | ✓ | ✗ | ✓ | ✓ |
| F25 Terminal conditions & safety caps | ◐ | ◐ | ◐ | ✓ | ✓ |
| F26 Bounded polling of async tasks | ✗ | ✗ | ◐ | ✓ | ✓ |
| F27 Execution-mode discriminant | ◐ | ✗ | ◐ | ✓ | ✓ |
| F28 Context-window-aware packing & compaction | ✗ | ✗ | ◐ | ✓ | ✓ |
| F29 Prompt / context compilation & briefing | ◐ | ✗ | ◐ | ✓ | ✓ |
| F30 Tier routing, calibration & baselines | ✗ | ✗ | ◐ | ✓ | ✓ |
| F31 Per-call token telemetry & cost accounting | ✗ | ✗ | ◐ | ✓ | ✓ |
| F32 Guard-execution verification (not model trust) | ◐ | ◐ | ✗ | ✓ | ✓ |
| F33 Correction injection on guard failure | ◐ | ✗ | ✗ | ✓ | ✓ |
| F34 Per-item error control in multi-item loops | ✗ | ◐ | ✗ | ✓ | ✓ |
| F35 Cooperative task cancellation | ✗ | ✗ | ✓ | ◐ | ✓ |
| F36 Safe-by-default execution boundary (dry-run) | ◐ | ◐ | ✗ | ✓ | ✓ |
| F37 State-derived status output | ◐ | ◐ | ✗ | ✓ | ✓ |
| F38 Ephemeral session-less task firing | ✗ | ✗ | ◐ | ✓ | ✓ |
| F39 Backend-agnostic runner seam | ✗ | ✗ | ◐ | ✓ | ✓ |
| F40 Milestone snapshot derived read-model | ◐ | ◐ | ✗ | ✓ | ✓ |
| F41 Injectable enrichment / plugin seams | ◐ | ✗ | ◐ | ◐ | ◐ |

**Footnote — F16→F41 split (v2):** F41 *Injectable enrichment / plugin seams* is **new in v2**, split out of F16 *Admin / operator mutations*. dispatch-C38 (IOrchestratorIoPlugin / IOrchestratorGitnexusPlugin injectable seams) was promoted out of the admin/operator-mutation row into its own feature (catalog v2 part 2/3, uid `01KZVYK9C0XF4FMW0TQDK1V3Z5`; originating pass-D correction `01KZVR3PAY3CC10J12BMN2N14Z`). Read F16 strictly as admin/operator mutations — it no longer covers plugin seams. F41 is **seam infrastructure only**: the enrichment it fronts is NOT implemented (see its Implications bullets in section 2, and S5).

**Superset summary:** the adhd superset (backlog ∪ agent ∪ dispatch) covers **39 of 41** features. Two **superset gaps** (sox-only): **F13 Git worktree isolation** (dispatch touches it only as a non-enforced consumer convention; runtime enforcement is sox-only) and **F14 Install-level snapshots & restore** (no adhd group has any equivalent). F41 is covered only at seam level (◐ — infrastructure exists, enrichment not implemented).

---

## 2. Enumerated Feature Definitions

**Footnote convention:** every ◐ cell carries its difference note inline in the bullet — there are no numbered footnotes. Each **Implications** bullet preserves a system-lens v2 finding verbatim in substance (enforcement caveat, recorded-only status), with its classification and file:line evidence.

### THEME A — STATE & LIFECYCLE MODEL

### F1 — Formal work-item state machine & transition legality
- **What it supports:** a declarative, enforced transition model for work items — a status vocabulary plus rules about which transitions are legal.
- **sox:** ✓ — sox-C1: frozen data-driven TRANSITIONS table, 9 per-ticket states + EPIC, 22 transition families, `assertTransition`/`requireTransition` guards, `validateStateMachine` reachability + `renderStateMachineMermaid` introspection. `state/state-machine.js:22-48` (TRANSITIONS table), 9 states (READY/CLAIMED/IN_PROGRESS/IN_REVIEW/AWAITING_HANDOFF/BLOCKED/DONE + EPIC).
- **backlog:** ◐ — backlog-C1 is deliberately **not** a strict FSM: 19-status vocabulary in 4 classes with any→any transitions gated by citation (terminal-done/workaround) and trimmed reason (terminal-dismissed).
- **agent:** ◐ — agent-C6: 7-status task model (pending..awaiting_input) with guarded transitions; domain is a conversation task, not a ticket.
- **dispatch:** ◐ — dispatch-C2: plan-execution state machine (24 states/10 phases in state.json) over plan phases, not ticket statuses.
- **adhd superset:** covered.
- **Implications:** **[backlog SL2-08]** BLOCKED is a pure label with zero write-path enforcement — claim/renew/startWork on BLOCKED succeed like OPEN, and blockers() only reflects DEPENDS_ON (a status-BLOCKED item can have empty blockers). Class: EMERGENT+INVARIANT, RECORDED-ONLY. Evidence `01KZVXQBFMB2T7CC1CN0AGQGMZ` (`query.ts:224-231`, `lifecycle.ts:109-116`).
- **Verification:** sox `state/state-machine.js:22-48` (sox-side verification report, PRESENT); `sox-vs-adhd-catalog` part 1 uid `01KZVQP1BKCQ9XN2GBYDW3S79M`; sox-side verification uid `01KZVSQTWZ60CBBBAXPEZSCWCP`.

### F2 — Multi-agent claim lease with identity CAS
- **What it supports:** multi-agent claiming with contention refusal and stale recovery.
- **sox:** ✓ — sox-C2: atomic top-priority pop under sentinel lock, 4-step assignment matching, dep-blocked rejection, stale ready[] pruning, SOX_ONE_SHOT. `state/commands/cmd-claim.js`, `state/queue.js:119` (priority-ordered ready[]), `state/locking.js:39` (proper-lockfile sentinel mutexes).
- **backlog:** ◐ — backlog-C2: per-node identity CAS lease — exact BEGIN IMMEDIATE branch table (claimed/renewed/held/reclaimed-stale/force), 30-min staleness (`DEFAULT_STALE_AFTER_MIN=30`, `claim.ts:28`), identity protocol `agentName:instanceId`, `ClaimContentionError` (`claim.ts:30-38`), proven by a 2-process race test. **Demoted from ✓ to ◐ in pass D (OV-1):** the anchors disagree (sox-anchor=partial, backlog-anchor=STRONG) and the v2 consolidation rule resolves to partial.
- **agent:** ◐ — agent-C4 (stateful session lifecycle) shares only the identity-scoped durable-state-with-guards pattern; domain is a conversation session.
- **dispatch:** ◐ — dispatch-C2: claim+release lease (claimed_by/claimed_at, renewal, stale takeover) but as an authoring-time mechanism over plan states.
- **adhd superset:** covered — lease mechanics differ per group.
- **Implications:** **[backlog SL2-01]** renewClaimNode has NO same-claimant verification — any caller's `by` overwrites claimedBy; a fresh claim held by A is silently seized by B (claim-steal bypass of the whole CAS table; releaseClaim/claimItemNode DO verify). Class: FAILURE-MODE+INVARIANT-VIOLATION. Evidence `01KZVXP3TEMDYN4XA5E3ZAJRVH` (`claim.ts:88-97`).
  **[backlog SL2-06]** startWork is TWO transactions — claim commits, then transition; transition failure leaves claimed-but-not-IN_PROGRESS dirty state. Class: FAILURE-MODE. Evidence `01KZVXP3TEMDYN4XA5E3ZAJRVH` (`lifecycle.ts:109-116`).
- **Verification:** backlog PRESENT `claim.ts:48-85` (adhd-side verification part 2 uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); pass-D correction OV-1 uid `01KZVR3W9G8EF11DJMS2JNFSMF`; catalog part 1 uid `01KZVQP1BKCQ9XN2GBYDW3S79M`.

### F3 — Priority model & durable assignment
- **What it supports:** priority ordering and durable (non-claim) assignment of work.
- **sox:** ✓ — sox-C2: P0..P5 tiers, priority-ordered ready[] insertion (FIFO within tier), claim-time assignment matching (exact workerId, stable SOX_AGENT_NAME, group lead, leaderless), plus `assign` mutation (sox-C13).
- **backlog:** ◐ — backlog-C7: CRITICAL|HIGH|MEDIUM|LOW mapped deterministically to graph importance (10/8/5/2/1), `setPriority` writes metadata+importance atomically, `spotlight()` prioritized view, durable assignee entity distinct from the ephemeral claimant. **Demoted from ✓ to ◐ (OV-2):** sox-anchor classified the pair partial (priority tiers + assignment matching vs graph-importance mapping).
- **agent:** ◐ — agent-C2 model-tier routing (Haiku/Sonnet/Opus): a different axis (provider capability, not work priority).
- **dispatch:** ◐ — dispatch-C16 effort-tier routing (low..max): same different-axis caveat as agent.
- **adhd superset:** covered.
- **Implications:** **[backlog SL2-02]** assignee recorded-but-not-consumed by ANY enforcement path (no claim matching, no WIP gate, no startWork gate, no readyItems partition). Class: RECORDED-NOT-CONSUMED. Evidence `01KZVXP3TEMDYN4XA5E3ZAJRVH` (`structure.ts:244-255`).
  **[backlog SL2-04]** setPriority dual-writes `metadata.priority` + graph importance in TWO separate transactions — non-atomic; crash leaves divergence with no reconciliation. Class: FAILURE-MODE. Evidence `01KZVXP3TEMDYN4XA5E3ZAJRVH` (`structure.ts:200-207`).
  **[backlog SL2-05]** importance column write-only from backlog's own perspective — spotlight sorts by PRIORITY_RANK, not importance; divergence undetectable in-package. Class: INERT-FIELD. Evidence `01KZVXP3TEMDYN4XA5E3ZAJRVH`.
- **Verification:** pass-D correction OV-2 uid `01KZVR3XDE4DJPQAEDP2YRY9BC`; catalog part 1 uid `01KZVQP1BKCQ9XN2GBYDW3S79M`.

### F4 — Dependency blocking, readiness & cascade
- **What it supports:** dependency-gated scheduling of work — "what can run next".
- **sox:** ✓ — sox-C4: `blocked_by` at create, `cmdBlock` with state_before, reactive `cascadeBlock`/`cascadeUnblock` with state restoration, event-log-authoritative conservative resolution, fail-closed.
- **backlog:** ◐ — backlog-C5: DEPENDS_ON edge, `blockers()`/`readyItems()` derived at query time, dependencyGraph, Kahn topoOrder with real-cycle extraction (cycles allowed at write, detected at query). **Demoted from ✓ to ◐ (OV-3):** sox-anchor classified sox-C4→backlog-C5 partial (reactive cascade + state restoration vs query-time derivation). NAM-2 homing: backlog-C5 + dispatch-C10 ALSO home in F24 — F4 carries dependency/blocking mechanics, F24 the state-derived eligibility theme; both kept, documented.
- **agent:** ◐ — agent-C8: `depends_on` + `on_upstream_failure` fail|skip (skip feeds upstream results into downstream inputs — no analog anywhere else), `validateNoCycle` rejects cycles. `dag-engine.ts:48-79,81-125`.
- **dispatch:** ✓ — dispatch-C10: eligibility strictly from state (`allDepsComplete && noDepFailed`, pending surfaced iff deps complete) — STRONG pair with backlog-C5 (both compute "what can run next" purely from persisted state).
- **adhd superset:** covered.
- **Implications:** **[backlog SL2-10]** blockers() silently returns [] on a miss (no throw, no hint) — indistinguishable from "no blockers"; the one read op that breaks the typed-error contract (getItem null, others throw). Class: FAILURE-MODE+INVARIANT. Evidence `01KZVXQBFMB2T7CC1CN0AGQGMZ` (`query.ts:224-231`).
- **Verification:** pass-D correction OV-3 uid `01KZVR3YCF314YZ34DTV4A5512`; NAM-2 uid `01KZVR48C7E3XC8G6GH06QF324` (C5/C10 double-homed split across F4 and F24 documented); adhd-side PRESENT `query.ts:224-273` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F5 — Work-item authoring, context, plans & spec mutation
- **What it supports:** creating work items with rich self-describing content (spec, context, plan, mutation gates).
- **sox:** ✓ — sox-C12: `cmdCreate` with YAML spec validation, `cmdContext` full worker briefing, `cmdSetPlan` authorship-stamped plan, `cmdUpdateSpec` creator-only with gate reset.
- **backlog:** ◐ — backlog-C3 creation path with dedupe scan + atomic insert (partial overlap); backlog-C6 `attachToPlan`: find-or-create plan node + MEMBER_OF edge.
- **agent:** ✗ — no work-item authoring/plan/spec concept (only agent-def CRUD + sessions + tasks). Verified absent: no `cmdCreate`/`attachToPlan` analog (adhd-side verification part 1 uid `01KZVRQVERYRH3ESAXP0E5QTF2`).
- **dispatch:** ◐ — dispatch-C1 (plans authored externally as dag.json by plan-state-machine skill, GATE 2 sign-off); dispatch-C4 Plan registry / plan-index.json (tooling-maintained read-only inventory of plan dirs, plans_root/mutate_set/read_only_set/reservations) — **added in pass D (MISS-1)**; dispatch-C35 self-contained work-order shape (ID/epic/files/acceptance/tier/deps/token budget, convention-only).
- **adhd superset:** covered.
- **Implications:** **[sox SLS-01]** verdict_hint written (`cmd-create.js:147,174`) but never read by any decision point; the documented semantic contract has no enforcement path. Class: RECORDED-ONLY, INERT. Evidence `01KZVX7VK0K94X1FF4HDXS92ES`.
  **[backlog SL2-11]** importFromMarkdown convergent re-import is per-field non-atomic — citation-gated status leg can throw after title/body already persisted, leaving a partially-refreshed item. Class: FAILURE-MODE. Evidence `01KZVXQBFMB2T7CC1CN0AGQGMZ` (`client.ts:322-457`).
- **Verification:** pass-D correction MISS-1 uid `01KZVR3JCP35K3SN4PXK6TTBTQ`; catalog part 1 uid `01KZVQP1BKCQ9XN2GBYDW3S79M`; agent N absent-verified uid `01KZVRQVERYRH3ESAXP0E5QTF2`.

### F6 — Structural lifecycle ops (supersede / split / merge / relate / plan / assign)
- **What it supports:** graph-structural mutation of work-item relationships.
- **sox:** ◐ — partial only: sox-C13 `assign` (durable ASSIGNED_TO-equivalent in-place mutation) and sox-C7 quarantine tombstone (recoverable isolation — same bi-temporal retire-with-tombstone family). No sox supersede/split/merge/link/attach graph ops.
- **backlog:** ✓ — backlog-C6 is the full implementation: `linkRelated` (RELATES_TO), `supersedeItem` (new humanId first, SUPERSEDES edge, bi-temporal invalidation, never hard-delete), `splitItem` (PART_OF children), `mergeItems` (SAME_AS drop→keep + DUPLICATE + auto note), `attachToPlan` (MEMBER_OF), `assignItem` (ASSIGNED_TO), `renameHumanIdNode`.
- **agent:** ✗ — verified absent (`rg supersede/splitItem/mergeItems/linkRelated/attachToPlan` over agent+dispatch = 0 hits; "superseded" in dispatch docs is plan-archival naming only).
- **dispatch:** ✗ — same negative evidence as agent.
- **adhd superset:** covered — backlog-distinct mechanics preserved.
- **Implications:** **[backlog SL2-07]** MEMBER_OF/ASSIGNED_TO/SAME_AS/DERIVED_FROM edges WRITTEN but never read by any backlog query — the dependencyGraph surface can never return them; audit read-back bypasses its own edge. Class: INERT-EDGES. Evidence `01KZVXQBFMB2T7CC1CN0AGQGMZ` (`structure.ts:228,251,192`; `audit-log.ts:64`).
- **Verification:** catalog part 1 uid `01KZVQP1BKCQ9XN2GBYDW3S79M`; absent-verified uid `01KZVRQVERYRH3ESAXP0E5QTF2`.

### THEME B — TRUST & RECOVERY

### F7 — Append-only event/audit log
- **What it supports:** persisting every transition/claim as an append-only event separate from the item's own data.
- **sox:** ✓ — sox-C5: authoritative NDJSON event log (event_id/session_id/seq/schema_version/branch/commit), ~30 state + ~40 system events, STRICT-ON-WRITE/TOLERANT-ON-READ with EVENT_ALIASES, state.log/system.log split, never drops on lock exhaustion, authoritative over ticket.json. `audit/event-log.js` (22 hits), `event-types.js:6` (typed vocab).
- **backlog:** ◐ — backlog-C9: each audit event its OWN graph node tagged backlog-audit-event with DERIVED_FROM edge, written post-commit (logging gap can never corrupt real state), explicitly non-authoritative. **Demoted from ✓ to ◐ (OV-4):** sox-anchor classified sox-C5→backlog-C9 partial (authoritative+telemetry+reconstruct vs non-authoritative graph audit nodes).
- **agent:** ✗ — agent has task_events table (usage telemetry, `agent-store-runtime/schema.ts:73-85`) but no authoritative append-only audit log.
- **dispatch:** ◐ — dispatch-C3: `events.ndjson` authoring-scope scaffold_mutation log only (not a runtime lifecycle log).
- **adhd superset:** covered.
- **Implications:** **[sox SLS-05]** EventLog.append retries then RETURNS the event even when never persisted ('event dropped' warn) — silent event loss under lock contention; MISSING_DONE_EVENT + git-merge tiebreak is the compensating self-heal. Class: FAILURE-MODE, AUTHORITATIVE log with DERIVED compensation. Evidence `01KZVX7XYZ1AWMW35TVCY9SWFT` (`event-log.js:262-291`, `queue.js:95-202`).
  **[backlog SL2-14]** audit-event uniqueness marker uses a RANDOM string — content-hash dedup collapse prevention is probabilistic (vs a deterministic repo::humanId marker). Class: FAILURE-MODE. Evidence `01KZVXQBFMB2T7CC1CN0AGQGMZ` (`audit-log.ts:56`).
- **Verification:** pass-D correction OV-4 uid `01KZVR40RVB7DRND4WE58M89XA`; sox PRESENT `audit/event-log.js` (uid `01KZVSQTWZ60CBBBAXPEZSCWCP`); backlog PRESENT `store/audit-log.ts` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F8 — Audit querying & reconstruction from logs
- **What it supports:** querying and rebuilding derived state from persisted events.
- **sox:** ✓ — sox-C6: audit filter (ticket/actor/session), reconstruct roles from replay (Layer 1 events + Layer 2 ticket.json), anomaly taxonomy, repairDeadClaims, verifyQueues, reconcileTicketJSON, `--verify` drift exit 0/1, `--dry-run`. `audit/reconstruct.js` (70 hits), CLI `sox audit reconstruct`.
- **backlog:** ◐ — backlog-C9 `auditTrail(id)`: merged view (created + citations + notes + events + supersession chain) — audit-view half only; NO reconstruction (graph is the store, nothing rebuilt).
- **agent:** ✗ — no audit querying/reconstruction (`rg audit` over agent = 0 src hits).
- **dispatch:** ◐ — dispatch-C13: client-side re-derivation of milestone completion from dispatch_log alone ("verification from state, not subagent reports") — narrower scope (completion only, no repair/reconstruct).
- **adhd superset:** covered.
- **Implications:** **[sox SLS-06]** AUTHORITY DISCONNECT — supervisor periodic reconcile reads the RETIRED live.log (frozen at the Phase-3 split) while authoritative events flow to state.log; the self-heal is inert post-split and emitted events are invisible to reconstruct. Class: RECORDED-ONLY (self-heal inert), AUTHORITATIVE (state.log). Evidence `01KZVX7VK0K94X1FF4HDXS92ES` (`sox-reconcile.sh:89,182-199`; `event-log.js:55-98`).
  **[sox SLS-13]** reconstruct anomaly taxonomy produced but never consumed by automation — daemon boot verify reads only exit-code 1 as boolean; the anomaly list is decorative. Class: RECORDED-ONLY. Evidence `01KZVX7VK0K94X1FF4HDXS92ES` (`reconstruct.js:1074-1081`).
  **[sox SLS-12]** authority-derivation lattice: state.log AUTHORITATIVE for ticket state (last-event-wins; ticket.json.state NEVER authority); role.json derived (rebuilt; done[] union-merged; next_id NOT event-derived); ticket.json.state synced (QUARANTINED skipped); assigned_to re-derived; WIP from team.yaml. Class: AUTHORITATIVE vs DERIVED. Evidence `01KZVX7XYZ1AWMW35TVCY9SWFT`.
- **Verification:** catalog part 1 uid `01KZVQP1BKCQ9XN2GBYDW3S79M`; sox PRESENT `audit/reconstruct.js` (uid `01KZVSQTWZ60CBBBAXPEZSCWCP`); agent N absent-verified (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### F9 — Tombstone / quarantine / archival retirement
- **What it supports:** retiring items without destroying history.
- **sox:** ✓ — sox-C7: quarantine tombstone to `.cto/quarantine.json` with full ticket_snapshot, RECOVERABLE (restore from snapshot, re-insert into ready[]), refuses without snapshot. `state/commands/quarantine.js` (47 hits).
- **backlog:** ◐ — backlog-C11 archiveResolved stamps terminal items with `metadata.archivedAt` (bi-temporal, never deletes) + CHANGELOG.md composition; backlog-C15 soft delete via t_invalid bi-temporal invalidation, tombstoned ids read absent — permanent with NO recovery path.
- **agent:** ✗ — no tombstone/quarantine/archive (`rg tombstone/quarantine` over agent = 0 code hits).
- **dispatch:** ✗ — same absence; "quarantined the dispatch plans" in base-spec tests is prose only.
- **adhd superset:** covered — but the mechanisms diverge: sox recoverable isolation + snapshot restore vs backlog permanent archival/invalidation; sox-C2 done[] pruning is queue GC, explicitly not archival.
- **Verification:** sox PRESENT `state/commands/quarantine.js` (uid `01KZVSQTWZ60CBBBAXPEZSCWCP`); backlog PRESENT `lifecycle.ts:149-161` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); absent-verified agent+dispatch (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### F10 — Heartbeat / liveness & stale-claim detection
- **What it supports:** dead-worker detection.
- **sox:** ✓ — sox-C8: implicit `touchLastSeen` on every `sox state` invocation, per-agent heartbeat files mirrored to stable SOX_AGENT_NAME, TTL 300s preferring last_seen over mtime, scalar heartbeats for daemon/watch, supervisor death detection feeding repairDeadClaims. `heartbeat.js:12` (HEARTBEAT_TTL_S=300), `:64-84`, `state/commands/query.js:26`.
- **backlog:** ◐ — backlog-C2: staleness via claim age (`staleAfterMin=30`, staleClaims, reclaim-stale) — same purpose, different mechanism (explicit heartbeat TTL vs claim-age computation).
- **agent:** ✗ — no heartbeat/liveness (`rg heartbeat/staleClaim` over agent = 0 src hits).
- **dispatch:** ✗ — same absence.
- **adhd superset:** covered.
- **Implications:** **[sox SLS-02]** `sox state heartbeat` stamps role/actor/last_tick that no code reads; isHeartbeatAlive reads only last_seen; the archived worker-template last_tick contract is obsolete. Class: RECORDED-ONLY, INERT. Evidence `01KZVX7VK0K94X1FF4HDXS92ES` (`query.js:27-35`, `heartbeat.js:72-88`).
  **[sox SLS-03]** LIVENESS-AUTHORITY DIVERGENCE — the runtime supervisor releases dead claims keyed on PROCESS DEATH (kill(0) probe), NOT heartbeat staleness; a hung-but-alive worker retains claims; heartbeat-based repairDeadClaims runs only at boot/config-change. Class: AUTHORITATIVE (PID-probe at runtime; heartbeat only in reconstruct). Evidence `01KZVX7XYZ1AWMW35TVCY9SWFT` (`daemon.js:378-415`).
  **[backlog SL2-15]** no in-code scheduler/reaper — all time-based semantics (stale claims, archival, migration phase) are pull-model, requiring explicit caller invocation. Class: RUNTIME-SEMANTICS. Evidence `01KZVXQBFMB2T7CC1CN0AGQGMZ`.
- **Verification:** sox PRESENT `heartbeat.js:12,64-84` (uid `01KZVSQTWZ60CBBBAXPEZSCWCP`); absent-verified agent+dispatch (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### F11 — Concurrency control & atomic writes
- **What it supports:** many agents writing one shared store without corruption.
- **sox:** ✓ — sox-C9: proper-lockfile sentinel mutexes (30s stale timeout, 10 retries 50–200ms exponential backoff + jitter, exit 3 on exhaustion), 4 lock flavors (backlog/counter/single-role/multi-role, AB/BA deadlock avoidance), tmp+rename atomic writes. `state/locking.js:39`.
- **backlog:** ◐ — backlog-C15: BEGIN IMMEDIATE on every metadata mutation inside bounded jittered-exponential-backoff retry (busy_timeout default 5000), single shared graph, turso substrate; backlog-C2 claim CAS is the same atomic-RMW-under-lock pattern. **Demoted from ✓ to ◐ (OV-5):** this is the strongest case — BOTH anchors classify the pair partial (sentinel-file locks + atomic rename vs BEGIN IMMEDIATE + backoff); the catalog row had contradicted both anchors.
- **agent:** ✗ — agent store is single-process better-sqlite3 WAL (`db/client.ts` pragma WAL), no multi-writer contention contract.
- **dispatch:** ✗ — **N for the locking half with a documented atomic-write nuance (verify-corr-F11):** `@adhd/dispatch-serializer-json` DOES ship tmp+rename atomic writes (`atomicWrite()`, `dispatch-serializer-json/src/index.ts:34-46`) — the exact sub-mechanism sox-C9 uses — but has ZERO locking/contention control (no sentinel mutex, no BEGIN IMMEDIATE, no busy_timeout, no backoff/retry; `rg lock|backoff|busy_timeout|BEGIN IMMEDIATE` over dispatch = 0 concurrency-control hits).
- **adhd superset:** covered.
- **Implications:** **[sox SLS-04]** CONTRACT VIOLATION — supervisor dead-worker reclamation writes role.json via tmp+rename WITHOUT the sentinel locks STATE-CONTRACTS/sox-C9 mandate for ALL queue mutations; last-writer-wins race under concurrent claim/finish. Class: FAILURE-MODE/INVARIANT-BREAK, RECORDED-ONLY (contract not consumed by this path). Evidence `01KZVX7XYZ1AWMW35TVCY9SWFT` (`lifecycle.js:55-115,107-109`).
  **[backlog SL2-13]** repo identity dual-stored (namespace column + metadata.repo) with fallback — a divergence seam only migrateRepo repairs; namespace is the filter key, metadata.repo the render key. Class: AUTHORITY+INVARIANT. Evidence `01KZVXQBFMB2T7CC1CN0AGQGMZ` (`mapping.ts:183`).
- **Verification:** pass-D correction OV-5 uid `01KZVR41E28ZCMFT1Z7ACV4PMY`; verification correction verify-corr-F11 uid `01KZVRQ3XBV2BBAN793M68C3BV`; backlog PRESENT `claim.ts:48-85` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F12 — Collision-safe ID minting
- **What it supports:** atomic, collision-safe work-item ID allocation.
- **sox:** ✓ — sox-C10: global counter (STORY-0001) under withCounterLock + per-role prefixed IDs (ENGI-0001) via role.json.next_id; collision advance when `.cto/work/<id>/` exists; resyncRoleNextId; corruption aborts exit 3 (never auto-reset); strict `^[A-Z]+-[0-9]+$` at every command entry.
- **backlog:** ◐ — backlog-C3: HumanId allocation (family-NNN max+1 zero-padded) + insert in ONE retried BEGIN IMMEDIATE transaction closing the concurrent max+1 TOCTOU. **Partial pair (corrected in pass D, MAT-1):** the atomic max+1 TOCTOU closure is the shared core; but backlog additionally dedupes CONTENT before ID allocation while sox guards ID-counter collisions — different layers/mechanisms. The v2 catalog restates the correction: the pre-reconciliation text 'STRONG pair (sox map)' is WRONG; per both anchors sox-C10↔backlog-C3 is PARTIAL.
- **agent:** ✗ — agent uses uuidv4 (`utils/ids.ts generateId`), no counter-based human IDs.
- **dispatch:** ✗ — randomUUID for log ids, no `^[A-Z]+-\d+$` minting.
- **adhd superset:** covered.
- **Verification:** pass-D correction MAT-1 uid `01KZVR3QV90SPXAVTPF845JZ7S`; catalog part 1 uid `01KZVQP1BKCQ9XN2GBYDW3S79M`; backlog PRESENT `crud.ts:2-3` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F13 — Git worktree isolation (runtime enforcement)
- **What it supports:** enforcing per-ticket workspace isolation in git.
- **sox:** ✓ — sox-C11: `cmdStart` creates worktree at `.worktrees/<id>` on branch `ticket/<id>` (3-attempt branch strategy, idempotent across respawns), `assertWorktreeIsolation` enforced by `cmdFinish` and `cmdGate`, teardown on DONE, WORKTREE_SKIP opt-out. `state/worktree.js:1-42`, `cmd-finish.js:5,79,258`, branch `ticket/<id>` (`:50`).
- **backlog:** ✗ — `rg worktree` over backlog = 0 hits.
- **agent:** ✗ — same absence.
- **dispatch:** ◐ — dispatch-C36: worktree isolation under `.worktrees/` + explicit-path staging appear only as consumer CONVENTIONS in the dispatch plan (never `git add -A`); dispatch-ABSENT-12 excludes git from the dispatch shell path entirely.
- **adhd superset:** ◐ — **SUPERSET GAP.** The only adhd touch is a non-enforced convention; runtime isolation enforcement is sox-only.
- **Verification:** sox PRESENT `state/worktree.js:1-42`, `cmd-finish.js:5,79,258` (uid `01KZVSQTWZ60CBBBAXPEZSCWCP`); catalog part 1 uid `01KZVQP1BKCQ9XN2GBYDW3S79M`; dispatch-ABSENT-12 confirmed (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### F14 — Install-level snapshots & restore (verified)
- **What it supports:** verified tar.gz snapshots of the whole install with create/restore/list/prune/verify.
- **sox:** ✓ — sox-C14: create tars then STRUCTURAL validation by extract+check (CONVENTIONS.md/context.md/epics/work/backlogs/live.log); restore preserves current broken state to `failed-<ts>.tar.gz` for forensics, wipes, extracts, re-validates, preserves applied.log; prune retention (<7d all, 5 most recent, failed-* forever); HALTED + escalation file on restore failure (exit 2); four hard guarantees. `sox-snapshot.sh:13-41` (create/restore/list/prune/verify subcommands), tar.gz at `.cto/snapshots/:118`, restore preserves broken state (`:21,52`), HALTED + escalation (`:27,47`).
- **backlog:** ✗ — no install-level snapshots (`rg snapshot/tar.gz/prune/restore` over adhd = 0 install-scope hits).
- **agent:** ✗ — same absence.
- **dispatch:** ✗ — same absence.
- **adhd superset:** ✗ — **SUPERSET GAP.** No adhd group has any equivalent.
- **Implications:** **[SYS-ASYM-4]** the adhd recovery counterpart is VACUUM INTO DB copies (single DB file) vs sox whole-`.cto` file snapshots — different blast radius and granularity. Class: MACHINE-ENFORCED comparison. Evidence `01KZVXB548D4TRMTCS2P4C8ZHA`.
- **Verification:** sox PRESENT `sox-snapshot.sh:13-41,118,21,52,27,47` (uid `01KZVSQTWZ60CBBBAXPEZSCWCP`); absent-verified backlog+agent+dispatch (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### THEME C — OPERATIONAL MACHINERY

### F15 — Layout / migration machinery (phased, dry-run, authority shift)
- **What it supports:** phased, idempotent migration of legacy data with an authority shift and dry-run.
- **sox:** ✓ — sox-C15: migrate subcommands (routing-config/tickets/queues/all/status), legacy→new state mapping (CLAIMED→READY, COMPLETED→AWAITING_HANDOFF, REJECTED→DONE), schema-version migration per-step snapshot→verify→dry-run→apply→validate→rollback, HALTED exit 2.
- **backlog:** ◐ — backlog-C12: MigrationPhase not-started..phase-5..complete, toolIsAuthoritative from phase-3+, setMigrationPhase (admin-only) writes through to global config.yaml, per-phase DoD semantics; backlog-C10 partially overlaps via legacy status normalization (IN-PROGRESS→IN_PROGRESS, CLOSED→RESOLVED). **Demoted from ✓ to ◐ (OV-6):** sox-anchor classified the pair partial (per-step snapshot/verify/rollback + exit-code discipline vs global phase flag + config write).
- **agent:** ✗ — feature concept absent (only DB schema migrations via drizzle migrate-runner, not data-layout migration).
- **dispatch:** ✗ — **N for the feature concept with a documented schema-version nuance (verify-corr-F15):** `@adhd/dispatch-base-spec/src/lib/migrate.ts` ships a minimal dag.json schema-version migration (MIGRATIONS[2→3, 3→4], `:1-60`) — dag-document schema versioning, NOT the F15 concept (legacy work-item data migration with authority shift).
- **adhd superset:** covered.
- **Implications:** **[backlog SL2-03]** migration phase (toolIsAuthoritative) REPORTED but never ENFORCED — no write path consults it; the ADHD_BACKLOG_MIGRATION_PHASE env can lie about authority without a durable write. Class: RECORDED-NOT-CONSUMED + AUTHORITY. Evidence `01KZVXP3TEMDYN4XA5E3ZAJRVH` (`client.ts:507-516`).
- **Verification:** pass-D correction OV-6 uid `01KZVR421RNJ3ERQBX95F628SK`; verification correction verify-corr-F15 uid `01KZVRQ43W49D6QDW1N7DH1NX7`; backlog PRESENT `client.ts:507-515` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F16 — Admin / operator mutations
- **What it supports:** operator-only escape-hatch and administrative mutations.
- **sox:** ✓ — sox-C13: admin-close (force-closes AWAITING_HANDOFF, requires `--commit --why --force`, dry-run), emit (named SCREAMING_SNAKE event without queue mutation), assign (`--ticket --to` across roles under per-role locks), resubmit (creator-only), append-output (worker-attributed, stdin capped 10MB), release-dead-worker, epic-rollup, workflow commands, swarm-cost hooks (read-cap/grep-cap/budget-gate PreToolUse).
- **backlog:** ◐ — partial: setMigrationPhase (backlog-C12) is the admin-only global-config mutation; assignItem (backlog-C6) is durable ASSIGNED_TO.
- **agent:** ✗ — no admin-close/emit/assign/resubmit analogs (`rg gate/approve` over agent = 0 src hits).
- **dispatch:** ✗ — **no admin/operator mutation row (v2):** the dispatch plugin seams that previously appeared here (dispatch-C38, added in pass D as MISS-3) were **SPLIT OUT to F41 in v2** — read this row strictly; the accepted-but-unread gitnexus seam caveat now lives under F41.
- **adhd superset:** covered — same admin-only-operator-mutation family; different specific ops.
- **Verification:** catalog part 1 uid `01KZVQP1BKCQ9XN2GBYDW3S79M`; pass-D correction MISS-3 uid `01KZVR3PAY3CC10J12BMN2N14Z` (origin of the split — now homed under F41).

### F17 — Review gates, evidence gates & handoff pipeline
- **What it supports:** independent verification before a work item is accepted.
- **sox:** ✓ — sox-C3: routing-rules.yaml flag lifecycle (pending→active→approved), `cmdGate` approved/changes_requested (clears review queues, routes rework, rework_count), `cmdFinish` handoff Path A/B, single-implementer invariant, cycle detection — implemented transitions in the state machine. `state/routing.js` + `routing-graph.js` (70 hits), `cmd-gate.js:354,369,373` (rework_count increments).
- **backlog:** ◐ — citation-gated terminal transitions (backlog-C1) + enforced structured citations (backlog-C4) = evidence-before-closure inside the metadata transaction.
- **agent:** ✗ — no review gates (`rg gate/approve` over agent = 0 src hits).
- **dispatch:** ◐ — dispatch-C36: review gate (7 axes, findings loop to SAME order, escalation) — same review-gate/handoff concept but plan discipline (convention), not code-enforced.
- **adhd superset:** covered.
- **Verification:** sox PRESENT `cmd-gate.js:354,369,373`, routing gates (uid `01KZVSQTWZ60CBBBAXPEZSCWCP`); absent-verified agent (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### THEME D — INTERFACE & SURFACE

### F18 — One op surface over multiple transports (CLI + MCP)
- **What it supports:** one operation surface exposed over CLI and MCP.
- **sox:** ✓ — sox-C16: `sox state` 25-subcommand router + MCP adapters (`tools/mcp-server/adapters/state.js` mirroring touchLastSeen + sox_usage/heartbeat/claim/context/start/finish/block/list/gate/append_output/create/reopen/unblock), CTO_DIR+WORKER_ID env contract.
- **backlog:** ◐ — backlog-C14: client.ts 38 async ops over HTTP + MCP stdio + CLI, lazy store open, install-skill/install, serve (SIGTERM/SIGINT → AbortController). **Demoted from ✓ to ◐ (OV-7):** sox-anchor classified the pair partial (25-subcommand router + heartbeat + env contract vs 38 ops + HTTP + lazy store).
- **agent:** ◐ — agent-C16: 16-tool MCP surface (agent_* + session_* + task_* + usage_query + guide), tools-only, stdio/http transports.
- **dispatch:** ◐ — dispatch-C26: 7-command npx-invocable CLI (validate/snapshot/optimize/eligible/status/run/calibrate); apigen-generated CLI broken (transitive zod $ref bug — canonical path is hand-written Commander bin).
- **adhd superset:** covered — same concept, different op sets and scopes.
- **Verification:** pass-D correction OV-7 uid `01KZVR42MHX2MV5N7HMDWXQMG9`; catalog part 2 uid `01KZVQPY2THYXXFHNJ187G1ZFA`.

### F19 — Uniform error / exit-code contract
- **What it supports:** predictable, scriptable failure signaling.
- **sox:** ✓ — sox-C16: canonical exit codes 0 OK / 1 generic / 2 usage / 3 env / 5 boot-failed, errors to stderr.
- **backlog:** ✓ — backlog-C14: exit 4 not_found / 2 invalid_argument / 0 no-args-help with JSON error on LAST stderr line.
- **agent:** ✗ — agent is a server (stdio/http), tools-only, no canonical exit-code contract (index.ts uses `process.exit(1)` only for fatal boot).
- **dispatch:** ◐ — dispatch-C29: consistent missing-dag-file guard (DEBT-025) throwing `dag file not found: <path>` across 5/7 commands — a specific guard, not a full exit-code taxonomy.
- **adhd superset:** covered.
- **Verification:** catalog part 2 uid `01KZVQPY2THYXXFHNJ187G1ZFA`; agent N absent-verified (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### F20 — MCP wire boundary & tool-surface naming
- **What it supports:** exposing/consuming operations over the MCP wire.
- **sox:** ◐ — sox-C16 MCP adapter surface mirroring touchLastSeen + sox_* tools.
- **backlog:** ◐ — backlog-C14 MCP server with `backlog_<snake_case>` tool names.
- **agent:** ◐ — agent-C16 is the MCP SERVER (16 tools, stdio/http, sse falls back to stdio). **Demoted from ✓ to ◐ (OV-8):** agent-anchor classifies agent-C16 as interface-level partial (tools-only with agent_* naming, no resources/prompts).
- **dispatch:** ✓ — dispatch-C30: AgentMcpRunner is a stdio JSON-RPC MCP CLIENT with locally-mirrored wire types (deliberate no-TS-dep isolation) — the consumer of agent-mcp's server. STRONG from the consumer direction (dispatch-anchor direction-specific claim, preserved in v2).
- **adhd superset:** covered.
- **Implications:** **[SYS-INERT-5]** agent-mcp SSE transport accepted in config but falls back to stdio with a warning — the declared transport is inert. Class: INERT. Evidence `01KZVXA9BS6ZN2BYT3XCC3A8B8` (`server.ts:820-836`).
- **Verification:** pass-D correction OV-8 uid `01KZVR43AJ2KEZHW2XB6VMCE6A`; adhd-side PRESENT D8 `agent-runner.ts:333-457` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F21 — Versioned agent definition lifecycle (CRUD + version)
- **What it supports:** a named, versioned agent-definition store.
- **sox:** ✗ — absent: `rg AGENT_ALREADY_EXISTS|agent_create|agent_update|versioned agent` over tools/cli = 0 hits; only read-only registry lookups (marketplace.js `list()/search()/resolveAgent()/fetchAgent()`, `sox list|search|fetch`); sox-protocol's single hit is a StateStore usage ledger, not a definition store.
- **backlog:** ✗ — no agent-definition lifecycle among client.ts 38 ops.
- **agent:** ✓ — agent-C1: full CRUD over SQLite rows (name PK, version int, data JSON), create stamps version:1 / AGENT_ALREADY_EXISTS, update patch-merges + bumps version+1, delete guarded by active sessions unless force, sessions snapshot the definition at creation. `agent-store.ts` (version:1 create, version+1 update, delete-guard).
- **dispatch:** ◐ — dispatch-C31: ensureAgent = idempotent agent_read by name → on AGENT_NOT_FOUND agent_create with version:1 — a 1:1 consumption of agent-C1's read/create semantics.
- **adhd superset:** covered — adhd-side feature (no sox counterpart).
- **Implications:** **[agent R9]** agent.description validated but never read by the agent-mcp runtime — only the optional registry compiler consumes it. Class: DECORATIVE. Evidence `01KZVXVRPK1YK94EWSBQD8DEXA`.
- **Verification:** sox absent-verified `rg` (uid `01KZVSQ271D83NWDK3HFT7QMZE`); agent PRESENT `agent-store.ts`, dispatch PRESENT `agent-runner.ts:378-398` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F22 — Provider config schema & credential guards
- **What it supports:** validated multi-provider configuration before any paid boundary.
- **sox:** ✗ — absent: `rg VALID_PROVIDERS|ProviderType|retryConfig|claudecli|ADHD_AGENT_` over tools/cli = 0 hits; run.js `provider` hits are only `delete spawnEnv.ANTHROPIC_API_KEY` for OAuth.
- **backlog:** ✗ — no provider config among client.ts 38 ops.
- **agent:** ✓ — agent-C2 zod discriminated union anthropic|openai|claudecli with per-provider options (retryConfig/baseURL/claudePath), credentials as env-var NAME pointers; agent-C3 env-var name guard (rejects non-ADHD_AGENT_-prefixed env names at create/update). `validation/agent.ts isEnvNameAllowed`, `index.ts:188-215` startup verify.
- **dispatch:** ◐ — dispatch-C16 model/effort tier routing; dispatch-C18 assertModelTier + VALID_PROVIDERS guard + toAgentMcpProviderConfig wire translation.
- **adhd superset:** covered — adhd-side feature.
- **Implications:** **[agent R8]** toolAdvertisement IGNORED for the claudecli provider — forced to 'full' regardless of the per-agent setting. Class: CONFIG-ACCEPTED-BUT-UNENFORCED. Evidence `01KZVXVRPK1YK94EWSBQD8DEXA` (`orchestrator.ts:171-174`).
- **Verification:** sox absent-verified `rg` (uid `01KZVSQ271D83NWDK3HFT7QMZE`); agent PRESENT `validation/agent.ts`, `index.ts:188-215` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### THEME E — EXECUTION & ORCHESTRATION (dispatch/agent-side)

### F23 — Orchestration cycle with per-unit persistence
- **What it supports:** a scheduling loop that executes multiple units with per-item outcomes.
- **sox:** ✗ — **core absent, confirmed with a near-miss (verify-corr-f23):** sox has partial-adjacent orchestration loops under different names — `supervisor/daemon.js:156-282` "tick" (one poll cycle: heartbeat check, respawn, pressure, metrics; iterates worker roster at `:240`, persists supervisor.state.json via persistState at `:190,:230`, POLL_INTERVAL_MS 30s at `:56`, nextTick loop at `:610`) and `tools/cli/program.js:97-159` "meta-loop" (janitor Duty 10, an LLM loop over the `.cto` ticket store with per-ticket durable state via ticket.json). What is genuinely absent: the DAG/milestone unit domain (`rg milestone|dag.json|dispatch_log|topoSort` over tools/cli = 0 real hits), dispatch_log entry-per-unit, ensureAgent/fire/poll/queryTurns, and continueOnError.
- **backlog:** ◐ — backlog-C13 generic N-way batch over any mounted op (parallel/serial/chained modes, onItemError continue/abort, per-index results) — multi-item execution loop with per-item outcomes, generic op fan-out vs DAG-driven. NAM-1: backlog-C13 is triple-homed (F23 loop-context partial, F34 error-control, A6 generic-batch register) — all three roles retained in v2.
- **agent:** ◐ — agent-C6 task execution dual-mode (session/ephemeral) — complementary single-task execution.
- **dispatch:** ✓ — dispatch-C5: load dag.json → snapshot → optimize → SEQUENTIAL for-each unit: ensureAgent/fire/poll/queryTurns → milestone guards → append ONE dispatch_log entry → persist after EVERY unit (crash mid-cycle never loses completed work); catch records failed entry + persists before continueOnError check. `orchestrator.ts:1261-1270`.
- **adhd superset:** covered — adhd-side feature.
- **Implications:** **[dispatch SL2-13]** DispatchUnit immutable at runtime — ~8 of ~24 fields inert by construction; lifecycle fields never written; the serialized status is always 'pending'. Class: RUNTIME-SEMANTICS. Evidence `01KZVX9FAETA2H5AMHETP4SANW` (`orchestrator.ts:906-1016`).
  **[dispatch SL2-09]** the multi-cycle orchestrate() loop is UNWIRED — zero production callers; CLI run executes exactly ONE cycle; unattended-to-terminal requires an external supervisor (see S3). Class: EMERGENT + UNWIRED-SEAM. Evidence `01KZVX9FAETA2H5AMHETP4SANW` (`core.ts:231-251`).
- **Verification:** verification correction verify-corr-f23 uid `01KZVSP4YBT11DD4W1P1935FBJ`; sox absent-verified `rg` (uid `01KZVSQ271D83NWDK3HFT7QMZE`); dispatch PRESENT `orchestrator.ts` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F24 — State-derived eligibility, resumption & re-derivation
- **What it supports:** truth comes from persisted state, never from executor prose.
- **sox:** ◐ — sox-C6 reconstruct derives queues from event log + `--verify` drift detection — same state-truth-telling, different mechanism.
- **backlog:** ✓ — backlog-C5 graph-node derivation: `blockers()`/`readyItems()` computed from DEPENDS_ON at query time.
- **agent:** ✗ — no eligibility/resumption read-model (dag-engine dispatchReady is task-DAG dispatch, not work-item eligibility).
- **dispatch:** ✓ — dispatch-C6 free state-derived resumption (reload + re-snapshot + pending-filter, zero re-dispatch — proven by resume test); dispatch-C10 eligibility strictly from state (D-07: pending===null && allDepsComplete && noDepFailed) — STRONG vs backlog-C5; dispatch-C13 client-side re-derivation of completion from dispatch_log alone. NAM-2 homing: F24 carries the state-derived resumption/re-derivation theme (dispatch-C6, dispatch-C13, sox-C6, backlog-C5); F4 carries dependency/blocking mechanics.
- **adhd superset:** covered.
- **Implications:** **[dispatch SL2-08]** authority chain = exactly ONE durable artifact (dag.json with dispatch_log embedded); DagSnapshot is pure re-derivation every cycle, nothing persisted; O(dag) per read. Class: AUTHORITY/DERIVATION. Evidence `01KZVX9FAETA2H5AMHETP4SANW` (`types.ts:587`, `snapshot.ts:991`).
- **Verification:** NAM-2 uid `01KZVR48C7E3XC8G6GH06QF324` (documents the C5/C10 double-homing split between F4 and F24); adhd-side PRESENT D1 `optimize.ts` D-07, `snapshot.ts:296-330` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F25 — Terminal conditions & safety caps
- **What it supports:** defining when execution stops, with a hard safety cap.
- **sox:** ◐ — sox-C1 `isTerminal` state check.
- **backlog:** ◐ — backlog-C1 terminal status classes (terminal-done/workaround/dismissed).
- **agent:** ◐ — agent-C6 task statuses completed/failed/cancelled.
- **dispatch:** ✓ — dispatch-C7: terminal when units.length===0 ('all-complete'|'no-eligible-work') + DEFAULT_MAX_CYCLES=500 hard cap (exists precisely because guard-failing corrections keep re-injecting pending work) — unique safety mechanism.
- **adhd superset:** covered.
- **Implications:** **[dispatch SL2-09]** the maxCycles cap is UNREACHABLE in shipped wiring — it lives only in the unwired orchestrate() loop; an external loop re-invoking run against a guard-failing plan has NO backstop. Class: UNWIRED-SEAM. Evidence `01KZVX9FAETA2H5AMHETP4SANW` (`orchestrator.ts:298,1356-1375`).
- **Verification:** catalog part 2 uid `01KZVQPY2THYXXFHNJ187G1ZFA`.

### F26 — Bounded polling of async tasks
- **What it supports:** waiting for an async task with a timeout, never infinitely.
- **sox:** ✗ — absent: `rg pollUntilTerminal|POLL_TERMINAL_STATUSES|timeoutMs` over tools/cli = 0; "polling" hits are filesystem watchers (chokidar), TUI render interval, heartbeat poll loop — dead-worker detection (F10), NOT bounded task-status polling.
- **backlog:** ✗ — no polling.
- **agent:** ◐ — agent-C6/agent-C7 provide the pollable surface (status model + background tasks + task status query).
- **dispatch:** ✓ — dispatch-C8: pollUntilTerminal polls runner.poll(taskId) until terminal status or timeoutMs (default 10 min at 2s interval); POLL_TERMINAL_STATUSES = completed/failed/cancelled/awaiting_input; TimedOut → opResultStatus 'failed'. `orchestrator.ts:744-762`.
- **adhd superset:** covered — adhd-side feature.
- **Implications:** **[dispatch SL2-12]** poll timeout / awaiting_input leaves a BILLED task ORPHANED and stalls the plan PERMANENTLY — guards skipped, no correction injected, cancel() never invoked on timeout; the milestone derives 'failed' and is never re-packed; dependents block via noDepFailed. Class: FAILURE-MODE + INVARIANT-CONSEQUENCE. Evidence `01KZVX9FAETA2H5AMHETP4SANW` (`orchestrator.ts:947-965`, `agent-runner.ts:423-425`).
  **[agent F3]** on server restart 'running' tasks are never re-enqueued nor marked failed (only 'pending' re-enqueued) — zombies; 'awaiting_input' rows lose the in-memory resolver → guaranteed TASK_NOT_RESUMABLE. Class: FAILURE-MODE. Evidence `01KZVXWTK15FRMJWR4PYFYVT42` (`index.ts:362-377`).
- **Verification:** sox absent-verified `rg` (uid `01KZVSQ271D83NWDK3HFT7QMZE`); dispatch PRESENT D5 `orchestrator.ts:744-762` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F27 — Execution-mode discriminant
- **What it supports:** per-unit decision of HOW to execute.
- **sox:** ◐ — sox-C3 routing flags decide delegation vs self-handling (weak, different axis).
- **backlog:** ✗ — none.
- **agent:** ◐ — agent-C6 session-scoped vs ephemeral dual-mode.
- **dispatch:** ✓ — dispatch-C9: `unit.execution_mode === 'model-dispatch'` | tool-call-only (in-process ops) | guard-only (skip agent entirely).
- **adhd superset:** covered.
- **Verification:** catalog part 2 uid `01KZVQPY2THYXXFHNJ187G1ZFA`.

### F28 — Context-window-aware packing & compaction
- **What it supports:** managing model context-window limits.
- **sox:** ✗ — absent: `rg windowMessages|estimateTokens|next-fit|context.?window|packing` over tools/cli = 0 hits; `sox context` is the worker-briefing read (F29 partial), not packing/compaction.
- **backlog:** ✗ — none.
- **agent:** ◐ — agent-C5: context windowing/compaction — `estimateTokens` + `windowMessages` (keep system + trailing recent, collapse middle once) with cache-prefix preservation. `session-store.ts`. (agent-C5 is also registered as A11, adhd-only.)
- **dispatch:** ✓ — dispatch-C14: greedy wave packing — partition by family:model, sort ki_estimate ascending, next-fit into effective context window W, hard-reject over-W batches; never packs completed milestones.
- **adhd superset:** covered — adhd-side feature.
- **Implications:** **[dispatch SL2-03]** sentinel_fanout HALF-WIRED — sentinel_role always null, the enabled gate is dead; computeBEff applies multipliers UNCONDITIONALLY (default 0.215x) even when enabled:false. Class: INERT/RESERVED. Evidence `01KZVX8J7ZGTR8H4J75TAME0AW` (`optimize.ts:402-403,473`; `snapshot.ts:601-626`).
  **[dispatch SL2-04]** fits_context_window DECORATIVE — computed + validated but read at ZERO decision points; invariant true on every emitted unit (over-W dropped pre-flag). Class: INERT/DECORATIVE. Evidence `01KZVX8J7ZGTR8H4J75TAME0AW` (`optimize.ts:437-438,472`).
  **[dispatch SL2-06]** b_override / context_window_override carried-but-unconsumed — validated, persisted, re-derived, never influence an estimate or pack decision. Class: INERT/RESERVED-CONFIG. Evidence `01KZVX8J7ZGTR8H4J75TAME0AW` (`snapshot.ts:981-982`).
  **[agent R6]** store-runtime estimateTokens/windowMessages are DEAD DUPLICATES — the engine uses a different implementation; consumed by no runtime code. Class: INERT-DUPLICATE. Evidence `01KZVXVRPK1YK94EWSBQD8DEXA` (`session-store.ts:215-253`).
- **Verification:** sox absent-verified `rg` + surface check (uid `01KZVSQ271D83NWDK3HFT7QMZE`); agent PRESENT A3 `session-store.ts` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F29 — Prompt / context compilation & briefing
- **What it supports:** assembling the worker briefing / task body.
- **sox:** ◐ — sox-C12 `cmdContext`: full worker briefing JSON (spec/context/plan/routing_flags/reopen findings/output counts/branch/worktree/commit).
- **backlog:** ✗ — none.
- **agent:** ◐ — agent-C4 composed systemPrompt via PromptResolver, snapshot bound to agent-version; agent-C6 task prompt.
- **dispatch:** ✓ — dispatch-C15: compilePrompt builds per-fire task body from milestone ops (type_spec field→type inlining), stable milestone-independent systemPrompt (DISPATCH_AGENT_SYSTEM_PREAMBLE), context_files unioned + sized for token estimation.
- **adhd superset:** covered.
- **Implications:** **[agent R2]** experiment_assignments table COMPLETELY INERT — created by migration, never read/written by any store. Class: INERT/RESERVED. Evidence `01KZVXVRPK1YK94EWSBQD8DEXA` (`drizzle/0006_composed_prompts_cache.sql:15-22`).
  **[agent R3]** the OPERATIONAL composed_prompts table is dead — the ACTIVE cache lives in the registry DB (registry_composed_prompts); the operational copy has zero consumers. Class: INERT/RESERVED. Evidence `01KZVXVRPK1YK94EWSBQD8DEXA`.
  **[agent R4]** sessions.composed_prompt_id WRITE-ONLY — set at session create, never read back by any path. Class: RECORDED-ONLY. Evidence `01KZVXVRPK1YK94EWSBQD8DEXA` (`session-store.ts:46`).
- **Verification:** catalog part 3 uid `01KZVQQPVMBD53DPR87CPA72HX`.

### F30 — Tier routing, calibration & baselines
- **What it supports:** routing to model tiers with measured per-tier baselines.
- **sox:** ✗ — **core absent, with a near-miss (verify-corr-f30):** sox has a heuristic model-tier CLASSIFIER (no routing, no calibration, no baselines) — `catalog/shared.js:484-522` auto-detects haiku/sonnet/opus from tool-set/name/description heuristics; `supervisor/agent-resolver.js:80` returns a model string. `rg calibrat|effort_max_tokens|model.?tier|baseline` over tools/cli = 0 hits; no calibration store, no measured baselines.
- **backlog:** ✗ — none.
- **agent:** ◐ — agent-C2 per-agent provider config; agent-C11 rate-card usage baselines (reactive accumulation).
- **dispatch:** ✓ — dispatch-C16 resolveUnitProviderAndTokens (provider from dag.providers + max_tokens from dag.effort_max_tokens); dispatch-C17 calibration store — cold-start B per tier (Haiku 8000 / Sonnet 15000 / Opus 27000), calibrate fires a real null-task and merges measured tokens into `~/.adhd/dispatch-calibration.json`. `core.ts` calibrateCore, `core.ts:274` DEFAULT_CALIBRATION_PATH, `orchestrator.ts:707-714`.
- **adhd superset:** covered — adhd-side feature.
- **Implications:** **[dispatch SL2-01]** calibration WRITE-ONLY in the shipped CLI — calibrate persists `~/.adhd/dispatch-calibration.json` but no command reads it; runCycleCore deps omit calibration, so B never affects packing/estimates. Class: RECORDED-BUT-NOT-CONSUMED. Evidence `01KZVX8J7ZGTR8H4J75TAME0AW` (`core.ts:243-249,346-372,274`).
  **[dispatch SL2-02]** resolved_max_tokens computed but never transmitted/enforced — fire() sends only {agent_name, prompt}; effort-tier token caps NEVER reach agent-mcp. Class: RECORDED-BUT-NOT-CONSUMED. Evidence `01KZVX8J7ZGTR8H4J75TAME0AW` (`orchestrator.ts:707-714`, `agent-runner.ts:400-411`).
- **Verification:** verification correction verify-corr-f30 uid `01KZVSPPA1NS5YM5Y0FX08RME7`; dispatch PRESENT D9 `core.ts:274`, `orchestrator.ts:707-714` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F31 — Per-call token telemetry & cost accounting
- **What it supports:** recording real per-model-call tokens and rolling them up.
- **sox:** ✗ — **core absent, with a near-miss (verify-corr-f31):** sox ships `tools/cli/token-audit.js:1-60` — a deterministic token-cost rollup over live.log (aggregates by role/event/actor, `missing_tokens_pct`, CLI `sox token-audit --since/--json/--out`) using `details.approx_tokens` tagging (`:14-17`) — NOT real per-call telemetry. `rg usage_query|tokens_actual|estCostUsd|peakContextTokens|task_usage|grain` over tools/cli = 0 hits; the MCP sox_usage tool is help-text listing only (`state.js:527-541`).
- **backlog:** ✗ — none.
- **agent:** ◐ — agent-C11 per-turn capture + per-task rollup + rate-card estCostUsd, peakContextTokens, cache/reasoning tokens; agent-C12 usage_query grain:'turn' (one row per real MODEL_RESPONSE task_event). **Demoted from ✓ to ◐ (OV-9):** agent-anchor classifies agent-C11/C12 as partial owner-of-capture; dispatch is the wire consumer.
- **dispatch:** ✓ — dispatch-C19 per-task token telemetry in dispatch_log[].turns[] (queryTurns/reconcileTurns capture REAL rows via agent-mcp usage_query); dispatch-C20 tokens_actual closed loop at milestone level feeding optimizer gates — STRONG cross-group pair (the strongest in the catalog), direction-specific (dispatch-anchor consumer side, preserved in v2).
- **adhd superset:** covered — adhd-side feature.
- **Implications:** **[agent R1]** task_usage.maxTokens WRITE-ONLY — no query grain/group_by/summary exposes it. Class: RECORDED-ONLY. Evidence `01KZVXVRPK1YK94EWSBQD8DEXA` (`usage-plugin.ts:41,80-83,137`).
  **[agent R7]** UsageClient has zero production consumers — orphaned export, test-only. Class: INERT-EXPORT. Evidence `01KZVXVRPK1YK94EWSBQD8DEXA` (`usage-client.ts:24`).
  **[agent AU1]** task completion truth SPLIT — non-orchestrator terminal paths (DagEngine fail, task_cancel, ephemeral-fail, not-resumable) never set task_usage.isComplete → excluded from usage_query default; group_by and grain disagree. Class: AUTHORITY-DIVERGENCE. Evidence `01KZVXWTK15FRMJWR4PYFYVT42` (`dag-engine.ts:121-123`, `task-store.ts:208-221`).
  **[agent AU2]** session grain is_complete requires ALL constituent rows isComplete=1 — one hook-less cancel marks the whole session incomplete forever. Class: DERIVATION. Evidence `01KZVXWTK15FRMJWR4PYFYVT42` (`usage.ts:387-483`).
  **[agent AU3]** skip-input DAG merges upstream results into inputs JSON, not usage rows — subtree cost attribution undercounts. Class: DERIVATION. Evidence `01KZVXWTK15FRMJWR4PYFYVT42` (`dag-engine.ts:129-141`).
  **[SYS-SHARED-4]** usage_query grain:'turn' is the real base-unit accounting edge but a hand-mirrored row contract — zero shared schema across the wire. Class: ACTIVE-INTEGRATION. Evidence `01KZVX9NA2PRG5AC1HSJV67E7X` (`agent-runner.ts:115-120`).
- **Verification:** pass-D correction OV-9 uid `01KZVR44DSW8BYCYSNF9W4XY7Z`; verification correction verify-corr-f31 uid `01KZVSPFAZPXB8R0YR4S2XD69Q`; agent PRESENT `tools/usage.ts`, dispatch PRESENT `agent-runner.ts:427-444` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F32 — Guard-execution verification (not model trust)
- **What it supports:** completion granted only by an independent mechanism, never the executor's word.
- **sox:** ◐ — sox-C3 gate-approve review gates (declarative review-flag approval).
- **backlog:** ◐ — backlog-C1 terminal transitions require citation (evidence-before-terminal).
- **agent:** ✗ — no guard-exec verification (`rg gate/approve` over agent = 0 src hits).
- **dispatch:** ✓ — dispatch-C11 milestone completion ONLY from guard_result 'pass' appended to dispatch_log; dispatch-C21 guard execution via deps.guardExec (node:child_process exec, exit 0 → pass, 8KB capped output, 5-min timeout); dispatch-C37 Plan-state-machine audit gates (each plan phase ends in an audit state running deterministic env-pinned commands; `audit_dispatch-completion.py` gates on exit code, never stdout scraping) — **added in pass D (MISS-2)**.
- **adhd superset:** covered.
- **Verification:** pass-D correction MISS-2 uid `01KZVR3NVR7J4YE874GXR8W4WS`; dispatch PRESENT D2 `orchestrator.ts` guardExec (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F33 — Correction injection on guard failure
- **What it supports:** injecting rework when verification fails.
- **sox:** ◐ — sox-C3 `cmdGate` changes_requested: clears reviewer pending_review, resets flags to pending, routes rework to target role, increments rework_count — role-queue rework routing with rework_count.
- **backlog:** ✗ — none.
- **agent:** ✗ — none.
- **dispatch:** ✓ — dispatch-C23 injectCorrectionMilestone clones the failed milestone (same phase/deps/agent/model/effort/guard), injects one generative doc-shaped fix op ('fix milestone X so its guard passes', guard output inlined truncated 1500 chars), names `<slug>-correction-<N>`, triggered_by set. DISCLOSED GAP: generic best-effort re-fire, NOT causally-aware replan (dispatch-ABSENT-16). `orchestrator.ts:803-863`.
- **adhd superset:** covered.
- **Implications:** **[dispatch SL2-10]** auto-correction COMPOUNDS cost — the correction clones the SAME guard; an unsatisfiable guard → correction-N+1 each a fresh paid dispatch; downstream stays blocked forever; no cap backstop. Class: EMERGENT-BEHAVIOR. Evidence `01KZVX9FAETA2H5AMHETP4SANW` (`orchestrator.ts:803-863`).
- **Verification:** dispatch PRESENT D3 `orchestrator.ts:803-863` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); dispatch-ABSENT-16 confirmed (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### F34 — Per-item error control in multi-item loops
- **What it supports:** multi-item execution where one failure doesn't kill the batch.
- **sox:** ✗ — absent: `rg continueOnError|onItemError|allSettled` over tools/cli = 0 hits.
- **backlog:** ◐ — backlog-C13 onItemError 'continue' (allSettled semantics) | 'abort' (stop fan-out on first rejection); per-index {status fulfilled|rejected, value|reason}, never whole-batch abort. **Demoted from ✓ to ◐ (OV-11):** the backlog-anchor only ever classified backlog-C13→dispatch-C14 as PARTIAL and never confirmed STRONG against dispatch-C24; only the dispatch-anchor asserts C24↔C13 STRONG — the v2 consolidation rule preserves the partial.
- **agent:** ✗ — no multi-item loop with per-item error control.
- **dispatch:** ✓ — dispatch-C24: continueOnError (default true) — per-unit error records a FULL failed dispatch_log entry + persists NOW (before the continueOnError check, so the forensic trace survives even when about to rethrow); false propagates immediately. `orchestrator.ts:1338`.
- **adhd superset:** covered — adhd-side feature.
- **Verification:** pass-D correction OV-11 uid `01KZVR4762WXDM21WK5P72PAC4`; dispatch PRESENT D4 `orchestrator.ts:1338` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F35 — Cooperative task cancellation
- **What it supports:** cancelling a running task cooperatively.
- **sox:** ✗ — absent: `rg task_cancel|TASK_NOT_CANCELLABLE|AbortController|cancell` over tools/cli = 0 hits.
- **backlog:** ✗ — none.
- **agent:** ✓ — agent-C9: task_cancel accepts only pending|running|awaiting_input (else TASK_NOT_CANCELLABLE), TaskStore.cancel aborts registered AbortController (cooperative — orchestrator checks signal.aborted between phases), persists cancelled + cancelled_at. `task.ts:463-483`.
- **dispatch:** ◐ — dispatch-C25 IDispatchAgentRunner.cancel → agent task_cancel exists as a seam — 1:1 wire counterpart but the seam is dormant (never auto-invoked; `.cancel` only in agent-runner.ts:423 interface impl, no orchestrator caller — cross-ref F26 SL2-12: cancel() is never invoked on poll timeout either).
- **adhd superset:** covered — adhd-side feature.
- **Verification:** agent PRESENT A7 `task.ts:463-483` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); F35 backlog N + dispatch seam dormant confirmed (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### F36 — Safe-by-default execution boundary (dry-run)
- **What it supports:** defaulting to no-side-effect execution at the dangerous boundary.
- **sox:** ◐ — `--dry-run` on audit reconstruct (sox-C6), snapshot/migrate dry-run (sox-C14/C15) — per-command, guards state mutations.
- **backlog:** ◐ — importFromMarkdown dryRun zero-writes (backlog-C10), migrateRepo dryRun-first (backlog-C15).
- **agent:** ✗ — no dry-run boundary.
- **dispatch:** ✓ — dispatch-C27: run's dryRun defaults TRUE (MockAgentRunner — no network, deterministic), dryRun:false wires the paid boundary (npx @adhd/agent-mcp); DISPATCH_E2E_LIVE=1 env gate for one real billed dispatch. dispatch-C37 audit gates (added via MISS-2) also carry the F36/sox-C6/sox-C14 affinity. `api.ts` run dryRun=true DEFAULT.
- **adhd superset:** covered — difference: dispatch dryRun defaults TRUE and gates the PAID agent boundary; sox/backlog dry-runs are per-command and guard state mutations.
- **Verification:** pass-D correction MISS-2 uid `01KZVR3NVR7J4YE874GXR8W4WS`; dispatch PRESENT D6 `api.ts` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F37 — State-derived status output
- **What it supports:** reporting status derived from state, never executor prose.
- **sox:** ◐ — sox-C6 audit/reconstruct renders BEFORE→AFTER transitions from the event log.
- **backlog:** ◐ — backlog-C8 graph-derived query/stats surface (byStatus/byKind/byFamily/byPriority/byRepo).
- **agent:** ✗ — no state-derived status output.
- **dispatch:** ✓ — dispatch-C28: status command reports per-milestone {status (snapshot-derived single source of truth), loggedOperationIds (from dispatch_log), tokensEstimated, tokensActual} — read-only, no live streaming. `core.ts:184-203` statusCore.
- **adhd superset:** covered.
- **Verification:** dispatch PRESENT D7 `core.ts:184-203` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); agent N absent-verified (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### F38 — Ephemeral session-less task firing
- **What it supports:** firing a cold, context-free task with no conversation continuity.
- **sox:** ✗ — absent: `rg isEphemeral|runEphemeralTask|noopSessionStore|fire\(` over tools/cli = 0 hits; SOX_SESSION_ID is event-log session attribution, not LLM task sessions.
- **backlog:** ✗ — none.
- **agent:** ◐ — agent-C6 agent_name mode / runEphemeralTask (isEphemeral:true, noopSessionStore, no session_id passed). **Demoted from ✓ to ◐ (OV-10):** agent-anchor classifies agent-C6 as partial (agent owns the authoritative 7-status model; dispatch is the cold ephemeral consumer).
- **dispatch:** ✓ — dispatch-C32: fire() {agent_name, prompt} → task_id — exactly agent-mcp's ephemeral task mode; poll() reads the result tool; AgentMcpToolError carries parsed error codes. dispatch-ABSENT-4 (no session continuity) is the mirror of agent-C4 — agent HAS sessions, dispatch deliberately fires session-less.
- **adhd superset:** covered — adhd-side feature.
- **Implications:** **[agent R5]** ephemeral agent_name mode VALIDATES depends_on/on_upstream_failure/stream but SILENTLY IGNORES all three — success with no DAG forming. Class: VALIDATED-BUT-UNENFORCED. Evidence `01KZVXVRPK1YK94EWSBQD8DEXA` (`task.ts:70-90`).
  **[agent RT2]** ephemeral tasks PERSIST to DB (tasks + task_usage + task_events) despite the 'nothing is written' doc — only messages/sessions skipped. Class: RUNTIME-SEMANTICS, contradicts documented invariant. Evidence `01KZVXWTK15FRMJWR4PYFYVT42` (`task.ts:83-90`).
  **[SYS-GAP-2]** dispatch treats awaiting_input as terminal-failure; task_resume is exposed by agent-mcp but dispatch NEVER calls it (the runner has no resume method). Class: CONVENTION-GLUE. Evidence `01KZVXA9BS6ZN2BYT3XCC3A8B8` (`orchestrator.ts:720-731`).
- **Verification:** pass-D correction OV-10 uid `01KZVR46K7QAZSSVT75CARK03A`; dispatch PRESENT `agent-runner.ts:400-411` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F39 — Backend-agnostic runner seam
- **What it supports:** abstracting the execution backend behind one seam.
- **sox:** ✗ — absent: `rg IDispatchAgentRunner|MockAgentRunner|StdioClientTransport|AgentMcpRunner` over tools/cli = 0 hits; 'runner' hits are stdio spawn configs, workflow events, plan flags — no execution-backend abstraction seam.
- **backlog:** ✗ — none.
- **agent:** ◐ — agent-C13 self-referential in-process agent-mcp client + McpClientRegistry (InProcessMcpClient vs stdio client) — provider-side transport selection.
- **dispatch:** ✓ — dispatch-C33 IDispatchAgentRunner seam — agent-mcp is the only shipped implementation; MockAgentRunner (deterministic test double) implements the same seam; StdioClientTransport with memoized connect — consumer-side test/production swap.
- **adhd superset:** covered — adhd-side feature.
- **Implications:** **[SYS-FAIL-4]** MCP transport failure has NO recovery — AgentMcpRunner memoizes the client once and never reconnects; a dead stdio subprocess poisons the whole cycle. Class: ACTIVE-INTEGRATION failure mode. Evidence `01KZVXB548D4TRMTCS2P4C8ZHA` (`agent-runner.ts:342-353`).
- **Verification:** sox absent-verified `rg` (uid `01KZVSQDTD5FGS1W5MTQXC7R3F`); agent PRESENT A10 `clients/in-process.ts`, `clients/registry.ts:28-59` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).

### F40 — Milestone snapshot derived read-model
- **What it supports:** a per-unit derived read-model of progress.
- **sox:** ◐ — sox-C2/sox-C6 derived role queues from the event log.
- **backlog:** ◐ — backlog-C8 rich filter/query surface over live nodes.
- **agent:** ✗ — no milestone snapshot read-model.
- **dispatch:** ✓ — dispatch-C12: MilestoneSnapshot carries derived wave (topoSortMilestones), status, started_at, guard_result/output/completed_at, artifacts (write-class op.file + move to_file), si_bytes, ki_estimate, tokens_estimated, tokens_actual (completed dispatches only). NOTE (dispatch-ABSENT-17): OperationSnapshot blast_radius/conflict/tokens_actual/attempt_count are explicit TODO stubs (0/empty) — flagged, not claimed. `snapshot.ts:465-480,577-588`.
- **adhd superset:** covered.
- **Implications:** **[dispatch SL2-07]** derived snapshot views computed-and-validated but read by NO decision logic — pairwise_overlap (O(n^2) per snapshot), open_questions (TODO-null/always-false), cross_plan_deps, assumed_baseline, executor_* are pure decoration. Class: DERIVED-VIEW-WITH-NO-CONSUMER. Evidence `01KZVX8J7ZGTR8H4J75TAME0AW` (`snapshot.ts:642-688,956-964,998-1010,1025-1049`).
- **Verification:** dispatch PRESENT `snapshot.ts:296-330,465-480,577-588` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); dispatch-ABSENT-17 confirmed (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

### F41 — Injectable enrichment / plugin seams [NEW — SPLIT from F16]
- **What it supports:** seams for injecting optional enrichment into the orchestration path (plugin infrastructure, not implemented enrichment).
- **sox:** ◐ — sox-C13: swarm-cost PreToolUse hooks (read-cap/grep-cap/budget-gate) as the closest pluggable-injection analog.
- **backlog:** ✗ — no plugin seam.
- **agent:** ◐ — agent-C15: external-loadable budget plugin seam (`agent-plugin-budget`, 12 cap types / 4 scopes).
- **dispatch:** ◐ — dispatch-C38: IOrchestratorIoPlugin (fileSizes/readFiles optional, graceful si_bytes degradation) + IOrchestratorGitnexusPlugin ACCEPTED-BUT-UNREAD (blast_radius/conflict TODO stubs). **CRITICAL:** this is seam infrastructure only — do NOT read as implemented enrichment.
- **adhd superset:** ◐ — covered only at seam level; enrichment NOT implemented anywhere.
- **Implications:** **[dispatch SL2-05]** readFiles is a ZERO-call-site seam and the IO plugin is never CLI-wired — the CLI never passes plugins, so si_bytes=0 and tokens_estimated = bEff+kiSum in production. Class: RECORDED-BUT-NOT-CONSUMED + INERT-SEAM. Evidence `01KZVX8J7ZGTR8H4J75TAME0AW` (`orchestrator.ts:1238`, `core.ts:243-249,77-82`).
  **[SYS-INERT-3]** gitnexus plugin seam accepted-but-never-read — placeholder type + passthrough, zero consumers; blast-radius integration is convention-glue. Class: INERT. Evidence `01KZVXA9BS6ZN2BYT3XCC3A8B8` (`orchestrator.ts:139-148`).
  **[SYS-INERT-4]** plugins.io optional enrichment degrades silently when absent — the production path runs without file-size enrichment. Class: INERT. Evidence `01KZVXA9BS6ZN2BYT3XCC3A8B8` (`core.ts:77-82`).
- **Verification:** pass-D correction MISS-3 uid `01KZVR3PAY3CC10J12BMN2N14Z` (dispatch-C38 split source); catalog v2 part 2/3 uid `01KZVYK9C0XF4FMW0TQDK1V3Z5`; dispatch-ABSENT-17 confirmed (uid `01KZVRQVERYRH3ESAXP0E5QTF2`).

---

### Adhd-only features (no sox counterpart) — register A1..A16

Register rows from catalog part 4 (uid `01KZVQRAT28J7BBNH7X24HRYFE`), preserved and corrected by v2. Each is a real capability documented in the manifests, with no sox equivalent; system-lens v2 implications are appended where the v2 catalog attaches them.

- **A1 — Markdown interop (import/render/export)** — backlog-C10, backlog only. Faithful legacy BACKLOG.md parser port (HEADER_RE, classifyStatus prose sniffing, detectStatus/detectPriority), legacy status normalization, idempotent AND convergent re-import, importedFrom ownership gating, dryRun zero writes, renderToMarkdown blocks, buildChangelogSection. sox migrates legacy `.cto` layout, not markdown backlog files. [v2 implication: SL2-11 intra-item non-atomic re-import — see F5.] Evidence: `markdown.ts` HEADER_RE/classifyStatus/renderItemsToMarkdown/buildChangelogSection (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); sox absence `rg BACKLOG.md|importFromMarkdown|renderToMarkdown` = 0 (uid `01KZVSQDTD5FGS1W5MTQXC7R3F`).
- **A2 — Archive-resolved sweep** — backlog-C11, backlog only. archiveResolved stamps every terminal non-excluded item with `metadata.archivedAt` (bi-temporal, never deletes); CLI composes CHANGELOG.md-formatted markdown. sox-C2 done[] pruning is queue GC, sox-C7 quarantine is corruption isolation — neither is archival. Evidence: `lifecycle.ts:149-161`; sox ARCHIVED_EVENTS (`audit/event-types.js:101`) are retired event-type names, not archiving (uid `01KZVSQDTD5FGS1W5MTQXC7R3F`).
- **A3 — Structured citations & notes, enforced** — backlog-C4, backlog only (dispatch-C36 partial convention). Citation type `{file, lines?, context?}` with presence-only acceptance NOT accepted as evidence; terminal-done/workaround require ≥1 citation ELSE `CitationRequiredError` thrown INSIDE the metadata transaction; appendNote; inline + accumulated citations merged. First-class evidence data type with transactional gates. Evidence: `lifecycle.ts` CitationRequiredError/assertValidCitation (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); sox `state/queue.js:169-192` git-evidence reconciliation is reconstruct-time heuristic, not a transition-time citation gate (uid `01KZVSQDTD5FGS1W5MTQXC7R3F`).
- **A4 — Rich filter/query surface** — backlog-C8, backlog only (sox-C16 partial: basic show/list only). Full filter vocabulary (repo/projectPath/status open|closed/exact/kind/family/priority/plan/assignee/claimedBy/tags AND/grep-FTS/importedFrom/rootLevel/excludeArchived/limit/offset) + stats byStatus/byKind/byFamily/byPriority/byRepo + typed errors (AmbiguousHumanIdError, BacklogItemNotFoundError with 'did you mean repo X?'). Evidence: `query.ts` listItems/stats/spotlight (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); sox `state/commands/query.js:117` allowlist only --status/--assigned-to/--role/--json (uid `01KZVSQDTD5FGS1W5MTQXC7R3F`).
- **A5 — Content-level dedupe-before-filing** — backlog-C3, backlog only (sox-C10 partial: ID-collision avoidance only). Dedupe scan BEFORE ID allocation: FTS over title+body (sanitized) + title-token overlap gate + exact symbol/path/errorText metadata match; non-empty candidates → {created:false, duplicateCandidates}, writes NOTHING; force bypasses soft scan but never the idOverride hard-collision check. **[v2 implication: SL2-12]** cross-repo dedupe asymmetry — the scan is repo-namespace-scoped; same content under two repo spellings is never deduped while the read-side hint is cross-repo. Class: EMERGENT. Evidence `01KZVXQBFMB2T7CC1CN0AGQGMZ` (`crud.ts:148-151`). Evidence: `crud.ts:2-3` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`); sox no duplicateCandidates/FTS title dedupe at creation — hits are queue/catalog/reconstruct dedupe (uid `01KZVSQDTD5FGS1W5MTQXC7R3F`).
- **A6 — Generic N-way batch action semantics** — backlog-C13, backlog + dispatch-C14 partial (prompt-assembly only). Generic batch over any mounted op on all three transports: {operation, items[], concurrency?, mode parallel|serial|chained, onItemError continue|abort, itemTimeoutMs?}; per-index results, never whole-batch abort; batch namespace dynamically reserved. Triple-homed with F23/F34 (see NAM-1, uid `01KZVR47SFVV0RP43R9GXNYX0R`). Evidence: `apigen-plugin-batch/plugin.ts:58-60,163-165,234-235` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`).
- **A7 — Confined in-process tool-call execution** — dispatch-C22, dispatch only. Tool-call ops execute IN-PROCESS confined to toolsRoot (dag.set-field rejecting __proto__/constructor/prototype, dag.clear-pending, dag.add-milestone referential-integrity-checked, dag.append-dispatch-log, fs.move/fs.delete/fs.scaffold); path escaping root → failed outcome, never executed; fixed whitelist, no arbitrary shell. No sox/backlog/agent counterpart.
- **A8 — Consumer-side orchestration convention (backlog↔dispatch)** — dispatch-C34, dispatch/backlog process convention. 45 work orders / 7 epics / 6 waves with tier routing, mandatory review gate, verify-from-state gates, findings-loop — a documented process convention, not dispatch code. No code-level counterpart in sox/agent.
- **A9 — Dependency isolation (no agent-family deps)** — dispatch-C39, dispatch architectural invariant. packages/dispatch depends on NOTHING in the agent family; crosses agent-mcp only over the MCP wire. A constraint, not a capability. Contrast: agent-C13 self-referential in-process client is the OPPOSITE pattern.
- **A10 — Env-var name guard for provider credentials** — agent-C3, agent only. Rejects non-ADHD_AGENT_-prefixed env names at create/update; allowlist extensible; startup verify warn-only. sox absence: `rg ADHD_AGENT_` = 0 (uid `01KZVSQDTD5FGS1W5MTQXC7R3F`).
- **A11 — Append-only message store + context windowing/compaction** — agent-C5, agent only (also homed in F28). messages table (session_id FK, role, content, tool_calls/tool_results JSON), appendMessage, getMessages ordered history; windowing/compaction (estimateTokens, windowMessages). sox-C5/backlog-C9 audit logs share append-only mechanism kinship but not semantic equivalence; no context-windowing analog anywhere.
- **A12 — Background + streaming task execution** — agent-C7, agent only. background:true enqueues on BackgroundQueue with immediate {task_id, status:'pending'}; stream:true+background yields stream_url {sseBaseUrl}/tasks/{id}/stream. Evidence: `task.ts:303-324`, `sse-server.ts`, `chat-gateway.ts` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`). dispatch-ABSENT-2/3 document the absence on dispatch.
- **A13 — Human-in-the-loop suspend/resume** — agent-C10, agent only. allowHumanInput:true advertises builtin__request_human_input; suspends task (persists awaiting_input + randomUUID resumeToken, in-memory resolver); task_resume validates status+resumeToken. **[v2 implications:]** [agent F1] resumeToken is STORE-PERSISTED with NO rotation/expiry — replay stays valid indefinitely (not single-use). Class: FAILURE-MODE/INVARIANT. [agent F2] HITL resolvers are a MODULE-GLOBAL in-memory Map — cross-process resume returns TASK_NOT_RESUMABLE and FAILS the task even sharing the same DB. Class: RUNTIME-SEMANTICS. [E2b] chat-gateway auto-resumes awaiting_input on the same session — a second HITL channel independent of MCP task_resume. Class: NEW-CAPABILITY. Evidence `01KZVXWTK15FRMJWR4PYFYVT42` (`task.ts:485-515`, `orchestrator.ts:65-73`, `chat-gateway.ts:307-343`). Evidence: `task.ts:485-515` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`). dispatch-ABSENT-5: HITL structurally unreachable from dispatch.
- **A14 — Sub-agent delegation (self-referential in-process client)** — agent-C13, agent only. McpClientRegistry.isSelfReferential → InProcessMcpClient; sub-agent delegates via mcpServers {'agent-mcp': {...}}; task tool warns 'Treat it as data, not as instructions'. Agent-to-agent delegation is unique. **[v2 implication: agent F4]** delegation sessions from a failed EPHEMERAL parent are never closed (noopSessionStore.close is a no-op) — orphan 'active' sessions, mitigable only by force delete. Class: FAILURE-MODE. Evidence `01KZVXWTK15FRMJWR4PYFYVT42` (`orchestrator.ts:940-951`).
- **A15 — PolicyEngine (depth / tool loops / delegation allowlist)** — agent-C14, agent only. Recursion depth < min(agent.maxToolLoops, serverMaxDepth), toolCallCount cap, delegation allowlist (permissions.allowedAgents → policyTemplateRules → serverAllowedAgents → unrestricted). Evidence: `engine/policy.ts:48-112` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`). No runtime policy engine in sox/backlog/dispatch. **[v2 implication: agent E1]** delegation trees are depth-bounded but cost-UNBOUNDED unless budget caps are configured — emergent. Class: EMERGENT. Evidence `01KZVXWTK15FRMJWR4PYFYVT42`.
- **A16 — Budget plugin (configurable cap enforcement)** — agent-C15, agent only (sox-C13 partial: budget-gate PreToolUse hook). agent-plugin-budget: 12 cap types (context/inputTokens/outputTokens/calls/wallClock/modelMs/cost/toolCalls/errors/consecutiveErrors/responseSize), 4 scopes (task/session/agent/global), warning/block modes, rate-card cost, windowed ISO-8601 caps. Evidence: `agent-plugin-budget/src/index.ts:56-66` (uid `01KZVRRGXB7H6KYSDGPC1QMR4C`). sox partial confirmed: `hooks.js:6,45-51` budget-gate PreToolUse hook + `swarm-cost/budget-gate.sh` + caps.json (uid `01KZVSQDTD5FGS1W5MTQXC7R3F`).

### Absence register — documented-absent capabilities (do NOT treat as features)

Each row is a capability explicitly documented as absent on the marked group; all 20 rows were absent-verified in Wave 3. The v2 system-lens findings (calibration write-only, orchestrate() unwired, renewClaim bypass, undeclared OpenAI gateway, etc.) are **not** promoted to absence rows — they are enforcement/authority findings and live in the Implications bullets (section 2) and the S-section (section 3), exactly where the v2 catalog homed them.

- **dispatch-ABSENT-1** — `@adhd/dispatch-tools` authoring MCP package does NOT exist (packages/dispatch has exactly 6 dirs; `orchestrator.ts:409-419` says "That package does not exist"; capability gap C7 has no provider).
- **dispatch-ABSENT-2** — In-cycle parallel dispatch ABSENT (background:true is inert metadata; orchestration loop is sequential, `orchestrator.ts:1261`).
- **dispatch-ABSENT-3** — Live status/progress streaming ABSENT (status is batch/state-derived only; zero SSE/stream in dispatch).
- **dispatch-ABSENT-4** — Session continuity across milestones ABSENT (cold session-less tasks; fire() sends only {agent_name, prompt}, no session_id, `agent-runner.ts:400-411`).
- **dispatch-ABSENT-5** — HITL reachability from dispatch ABSENT (orchestrator treats awaiting_input as terminal-but-unresolved, `orchestrator.ts:720-731`; no task_resume wiring).
- **dispatch-ABSENT-6** — Deferred packages (serializer-sqlite, plugin-io, plugin-gitnexus, tools-mcp) NEVER RAN; only the 6-package spine exists (0 references in pnpm-workspace.yaml + package.jsons).
- **dispatch-ABSENT-7** — optimizer-algorithms 4-algorithm cascade HELD, data-gated (≥3 real cycles showing >15% shortfall; else recorded HELD; `optimize.ts:20-22`; only greedy next-fit shipped).
- **dispatch-ABSENT-8** — C7/C8/C9/C13 capability providers ABSENT (no provider map/registry for these slots).
- **dispatch-ABSENT-9** — Prompt caching (cache_control) ABSENT (zero hits over dispatch).
- **dispatch-ABSENT-10** — Default-on budget/sanitize plugins ABSENT (opt-in only; dispatch has no plugin loading, only optional io/gitnexus seams, `orchestrator.ts:133-148`).
- **dispatch-ABSENT-11** — agent-store-tools executor ABSENT (15 registry rows decorative, `seed/tools.ts:18`; zero executor hits; store is lookup-only).
- **dispatch-ABSENT-12** — Git operations in the shell path ABSENT (tool-call whitelist is exactly dag ops + fs.move/delete/scaffold, `orchestrator.ts:490-577`; git excluded).
- **dispatch-ABSENT-13** — Clean-room external-consumer e2e gate in CI ABSENT (no dispatch e2e job in ci.yml/pull-request.yml).
- **dispatch-ABSENT-14** — In-orchestrator escalation ABSENT (escalation is consumer convention only; `rg escalat/halt` over dispatch = 0).
- **dispatch-ABSENT-15** — Usable apigen-generated CLI ABSENT/broken (transitive zod $ref bug; `api.ts:134-148`; hand-written Commander CLI canonical).
- **dispatch-ABSENT-16** — Causally-aware replan on guard failure ABSENT (corrections are generic re-fires, never rewire other milestones' depends_on, `orchestrator.ts:784-794`).
- **dispatch-ABSENT-17** — OperationSnapshot blast_radius/conflict/tokens_actual/attempt_count enrichment ABSENT (explicit TODO stubs, `snapshot.ts:465-480,577-588`; IOrchestratorGitnexusPlugin accepted-but-unread).
- **dispatch-ABSENT-18** — dispatch-base-types as a usable package ABSENT (orphan placeholder stub returning its own name; planned delete).
- **agent-A1** — Rich AgentPolicy (per-agent maxDepth/maxChildren/maxTokensPerTask/maxCostUsdPerTask, tool/filesystem/network/env allowlists, permission inheritance) — documented in architecture-and-security.md but NOT shipped; shipped enforcement is the narrower PolicyEngine (agent-C14) + budget plugin (agent-C15). Absent-verified: `rg maxChildren|maxTokensPerTask|maxCostUsdPerTask` = 0.
- **agent-A2** — policyTemplateRules ('rate'/'permission' template-scoped policy) — exists in PolicyConfig type but NOT configurable per agent at runtime (`index.ts:237-241` wires only server-level maxDepth/maxToolLoops/allowedAgents; PolicyConfig.policyTemplateRules never populated). **Verified with a nuance (verify-corr-A2):** a separate per-agent policy store (`@adhd/agent-core-policy`, `agent-policy-store.ts:152-357`) IS real shipped code, but is wired only through the compiler as compiled-prompt constraint text (`agent-engine-compiler/src/resolve/policy.ts`) — never into runtime PolicyEngine enforcement, so agent-A2 stands.

---

## 3. System-Level Findings & Fit

This section is the headline addition of v2. It is sourced from the 12 system-lens v2 episodes (topic `sox-vs-adhd-system`, tags contain v2) and consolidated in catalog v2 part 3/3 (uid `01KZVYNA42M85PJCE9FZBS1SZW`). **These are findings ABOUT the systems — every one carries its enforcement caveat; none is asserted as a shipped capability.** Every v2 finding appears exactly once: either as a feature Implications bullet in section 2 or as an S-row here. Classification dimensions: **ENFORCED | RECORDED-ONLY** (write-path teeth vs recorded-only), **AUTHORITATIVE | DERIVED** (source of truth), **ACTIVE | INERT** (consumed by runtime vs dead), and **ACTIVE-INTEGRATION | CONVENTION-GLUE** (code-wired vs process convention).

### S1 — Single-writer vs multi-writer vs no-lock concurrency asymmetry
- **Classification:** MACHINE-ENFORCED architecture asymmetry.
- **Description:** sox serializes via proper-lockfile sentinel files (30s stale, exit 3) + a single supervisor daemon; backlog uses DB transactions with busy-retry (BEGIN IMMEDIATE CAS, 30-min lease, explicit renew); dispatch writes dag.json via atomic rename with a FIXED temp name and NO lock — concurrent orchestrator cycles clobber each other's `.tmp` and lose dispatch_log entries (last-writer-wins).
- **Subjects:** sox-C9 (sentinel locks), backlog-C15 (BEGIN IMMEDIATE CAS), dispatch dag.json (atomic-rename NO lock).
- **Evidence:** `01KZVXB548D4TRMTCS2P4C8ZHA` (SYS-ASYM-1, SYS-SHARED-3, SYS-FAIL-2).
- **adhd-superset relevance:** dispatch has no mutual-exclusion contract; sox's single-writer guarantee has no adhd equivalent.

### S2 — Truth-authority asymmetry: event-log-authoritative + reconstruct/verify vs graph-as-truth with non-authoritative audit, no replay
- **Classification:** MACHINE-ENFORCED (sox) vs DERIVED / no-replay (adhd).
- **Description:** sox state.log is AUTHORITATIVE; reconstruct rebuilds role queues from it with `--verify` drift exit 0/1 and an anomaly taxonomy; adhd audit events are best-effort post-commit nodes that never gate state and cannot rebuild it. Lattice details (sox SLS-12): next_id and done[] history are NOT event-derived; ticket.json.state is synced but QUARANTINED is skipped.
- **Subjects:** sox-C5/C6, backlog-C9, dispatch-C13.
- **Evidence:** `01KZVXB548D4TRMTCS2P4C8ZHA` (SYS-ASYM-2) + `01KZVX7XYZ1AWMW35TVCY9SWFT` (SLS-12).
- **adhd-superset relevance:** adhd has no replay/reconstruct path.

### S3 — Supervision asymmetry: persistent daemon + heartbeat vs one-shot poll; orchestrate() unwired + maxCycles unreachable
- **Classification:** MACHINE-ENFORCED (sox daemon) / UNWIRED-SEAM (dispatch).
- **Description:** sox runs a persistent supervisor (respawn, crash-state persistence, scalar heartbeats, boot reconstruct); dispatch `run` executes exactly ONE orchestrateCycle per invocation and the multi-cycle orchestrate() generator (with DEFAULT_MAX_CYCLES=500) has ZERO production callers — unattended-to-terminal requires an external supervisor with no cap backstop.
- **Subjects:** sox daemon.js + heartbeat, dispatch-cli run, dispatch-C5/C7.
- **Evidence:** `01KZVXB548D4TRMTCS2P4C8ZHA` (SYS-ASYM-3) + `01KZVX9FAETA2H5AMHETP4SANW` (SL2-09).
- **adhd-superset relevance:** sox's liveness/crash-recovery guarantees have no dispatch counterpart.

### S4 — State-location asymmetry: in-repo human-readable .cto files vs out-of-tree ~/.adhd SQLite
- **Classification:** MACHINE-ENFORCED architecture contrast.
- **Description:** sox state is committed-able, diff-able, PR-able (files-as-UI); adhd state is deliberately out-of-repo, reachable only via CLI/MCP.
- **Subjects:** sox `.cto/`, adhd agents.db / registry.db / dispatch-calibration.json.
- **Evidence:** `01KZVXB548D4TRMTCS2P4C8ZHA` (SYS-ASYM-5).
- **adhd-superset relevance:** opposite auditability/portability contracts. (Recovery-corollary: adhd's VACUUM INTO DB copies are single-file, vs sox whole-.cto snapshots — see F14, SYS-ASYM-4.)

### S5 — Backlog is a data island; the integration loop does not close in code
- **Classification:** INERT / CONVENTION-GLUE.
- **Description:** no code in agent or dispatch reads any backlog field programmatically (assignee/priority/plan/status/readyItems) — zero `@adhd/backlog` imports outside backlog itself; dispatch reads only dag.json. The work-order → dispatch → agent → verify loop closes ONLY at dag.json; the '→ backlog update' leg is 100% convention (human/agent running the backlog CLI by hand). So any cross-subsystem enforcement is a process convention with zero code teeth.
- **Subjects:** entrypoint/backlog, dispatch-cli, agent-mcp.
- **Evidence:** `01KZVXA9BS6ZN2BYT3XCC3A8B8` (SYS-INERT-1, SYS-GAP-1) + `01KZVXQBFMB2T7CC1CN0AGQGMZ` (SL2-09).
- **adhd-superset relevance:** sox's role queues ARE read programmatically by its supervisor; backlog's readyItems are read by no program.

### S6 — Wire-contract version skew dispatch↔agent-mcp (locally-mirrored types; no compile-time contract; no reconnect)
- **Classification:** ACTIVE-INTEGRATION failure mode.
- **Description:** DispatchTaskStatus/DispatchUsageReport/RealUsageTurn are declared LOCALLY by design (no TS dep); a server-side zod status/usage change is invisible to dispatch until JSON.parse fails or an unknown status falls through POLL_TERMINAL_STATUSES → 10-min poll timeout. AgentMcpRunner memoizes the client once and never reconnects — a dead stdio subprocess poisons the whole cycle.
- **Subjects:** dispatch-orchestrator (AgentMcpRunner), agent-mcp.
- **Evidence:** `01KZVX9NA2PRG5AC1HSJV67E7X` (SYS-ACT-1, SYS-SHARED-4) + `01KZVXB548D4TRMTCS2P4C8ZHA` (SYS-FAIL-1, SYS-FAIL-4).
- **adhd-superset relevance:** version-skew is the structural cost of dispatch's wire-only isolation (C39/A9).

### S7 — Shared registry.db config drift across five agent packages
- **Classification:** ACTIVE-INTEGRATION.
- **Description:** five packages share ONE registry.db resolved through a 3-legacy-env-name precedence chain (ADHD_AGENT_REGISTRY_DB_PATH / REGISTRY_DATABASE_PATH / DATABASE_PATH) plus a project/global scope switch — two env-var sets can materialize two different registry DBs. Two scope philosophies coexist: the agent-mcp operational store is scope-FORCED global while the registry family is scope-sensitive (ADHD_ENV_SCOPE=project moves registry.db but not agents.db).
- **Subjects:** agent-core-env, agent-store-prompts/tools/policy/provider, agent-engine-compiler.
- **Evidence:** `01KZVX9NA2PRG5AC1HSJV67E7X` (SYS-SHARED-1, SYS-SHARED-2) + `01KZVXB548D4TRMTCS2P4C8ZHA` (SYS-FAIL-3).
- **adhd-superset relevance:** no sox analog (sox state location is a single `.cto` contract).

### S8 — Backlog is built directly on sox's own published store stack — sox-vs-adhd is NOT fully orthogonal
- **Classification:** ACTIVE-INTEGRATION (cross-stack dependency).
- **Description:** backlog's graph store is created from sox npm packages (createStoreAdapter/createGraphBackend); a sox store release can silently change backlog semantics.
- **Subjects:** entrypoint/backlog, `@adhd/sox-store-adapter`, `@adhd/sox-graph-store`.
- **Evidence:** `01KZVX9NA2PRG5AC1HSJV67E7X` (SYS-ACT-2).
- **adhd-superset relevance:** feature comparison is not clean-room; the shared substrate is a version-drift surface (see Architecture asymmetries below).

### S9 — Dispatch cost-governance is structurally optimistic vs wire reality
- **Classification:** EMERGENT / SYSTEMIC DIVERGENCE.
- **Description:** tokens_estimated uses sentinel multipliers (default 0.215x = assumes 90% read-hits) but dispatch sends NO cache_control anywhere and every task is a fresh cold session-less prompt — zero cross-dispatch cache reuse; combined with si_bytes=0 (IO seam never CLI-wired, F41) and calibration write-only (F30), every CLI-produced tokens_estimated understates real per-dispatch cost, so packing decisions run on systematically low estimates.
- **Subjects:** dispatch-C14/C15/C17/C32, ABSENT-9.
- **Evidence:** `01KZVX9FAETA2H5AMHETP4SANW` (SL2-11) + `01KZVX8J7ZGTR8H4J75TAME0AW` (SL2-01/03/05).
- **adhd-superset relevance:** cost governance is advisory-only; no enforcement exists on any path.

### S10 — sox healer-cadence taxonomy (emergent composition)
- **Classification:** ACTIVE, EMERGENT.
- **Description:** independent healers at different cadences/authorities: boot-time full reconstruct (`--verify` exit1 → `--yes` auto-fix), config-change reconstruct (10s cooldown), periodic frontmatter reconcile, periodic reconcile-assignments, stuck-ticket scan (5min), STEWARD janitor (10min), watchers + log-tail one-shots.
- **Subjects:** sox-C5/C6/C8/C13 (daemon healers).
- **Evidence:** `01KZVX80621XABJPH83R9QEWBY` (SLS-07).
- **adhd-superset relevance:** no adhd subsystem runs a multi-healer self-healing composition.

### S11 — sox stuck-ticket liveness backstop = the missing max-rework-cycles safety cap (NEW capability)
- **Classification:** ENFORCED, ACTIVE, NEW.
- **Description:** detectStuckTickets escalates excessive_rework (SOX_REWORK_LIMIT), stuck_in_review (2h), stuck_blocked (6h) into idempotent STUCK-* markers → janitor reopen/reassign/quarantine/escalate. Code comments name it the 'missing max cycles backstop' that NOTHING compares to a limit. Contrast: dispatch's maxCycles cap is unreachable (S3).
- **Subjects:** sox-C3 (rework_count), sox-C13 (janitor).
- **Evidence:** `01KZVX80621XABJPH83R9QEWBY` (SLS-08).
- **adhd-superset relevance:** this is a NEW sox guarantee with no adhd counterpart (dispatch's correction-loop has no backstop).

### S12 — sox demand-based saturation spawn model
- **Classification:** ACTIVE, RUNTIME-SEMANTICS.
- **Description:** leads single-instance and stay up whenever groupHasWork; workers spawn up to min(countAssignableWork, wipLimit) ONLY with assigned/default-routed work; 'no work → signalAgentDrain + skip' avoids idle cost; heartbeat-adoption path; team.yaml wip_limit becomes a PROCESS-COUNT limit, not a ticket cap.
- **Subjects:** sox-C2/C16 (daemon).
- **Evidence:** `01KZVX80621XABJPH83R9QEWBY` (SLS-09).
- **adhd-superset relevance:** no adhd concurrency model maps WIP to spawn count.

### S13 — sox crash-loop circuit breaker + poison-pill isolation
- **Classification:** ACTIVE, RUNTIME + FAILURE-MODES.
- **Description:** exit=5 BOOT_FAILED disables agent immediately; repeated unclean exits quarantine only if no recent heartbeat; rapid/idle clean exits increment a counter that quarantines at threshold; productive exit resets; drain files exempt intentional shutdowns; CLAIMED resets crash counters (poison-pill isolation); backoff 30/60/120/300s.
- **Subjects:** sox-C8 (heartbeat), spawner.
- **Evidence:** `01KZVX80621XABJPH83R9QEWBY` (SLS-10).
- **adhd-superset relevance:** no adhd process supervision.

### S14 — sox startup crash recovery
- **Classification:** ACTIVE, EMERGENT.
- **Description:** validatePriorSessionPids kills stale claude processes from a prior supervisor run (name-gated, deduped), re-releases their tickets (TICKET_RERELEASED), boot-drift auto-fix before first spawn; PID-reused-by-non-claude left alive with warning.
- **Subjects:** sox-C5/C6/C8 (lifecycle).
- **Evidence:** `01KZVX80621XABJPH83R9QEWBY` (SLS-11).
- **adhd-superset relevance:** no adhd equivalent (backlog startWork can leave dirty claims — see F2 implication).

### S15 — agent-mcp SSE/OpenAI-compat HTTP gateway — undeclared second API surface, unauthenticated
- **Classification:** RUNTIME-SEMANTICS + NEW-CAPABILITY + SECURITY-SURFACE.
- **Description:** `/v1/models` + `/v1/chat/completions` (OpenAI-compat) + `/tasks/:id/stream` are served by default (sse.enabled default true) on every stdio instance with NO auth — any localhost caller can list models / run completions / subscribe to streams; not part of the 16-tool MCP surface. Also enables: HITL-over-HTTP (chat-gateway auto-resumes awaiting_input on the same session — a second HITL channel independent of task_resume) and SSE stream replay-on-subscribe.
- **Subjects:** agent-C7/C10/C16 (sse-server, chat-gateway).
- **Evidence:** `01KZVXWTK15FRMJWR4PYFYVT42` (RT1, E2).
- **adhd-superset relevance:** an undeclared agent-as-model server; the MCP catalog (A12 streaming) understates the actual surface.

### Architecture asymmetries (integration-lens synthesis)

The integration-v2 lens reduced the cross-system gaps to six asymmetries. S1–S4, S6, S8 carry the full evidence; the two cross-cutting ones (CLI-first vs MCP-first; non-orthogonality) are synthesized here:

1. **File-lock single-writer vs DB CAS vs no-lock atomic rename** (S1). sox serializes through sentinel lockfiles + a single daemon; backlog through SQLite BEGIN IMMEDIATE CAS; dispatch through tmp+rename with a fixed temp name and NO lock — the weakest of the three, last-writer-wins under concurrent cycles.
2. **Event-log reconstruct vs graph-as-truth-no-replay** (S2, S8 findings). sox can rebuild derived role queues from state.log with `--verify` drift detection; adhd treats the graph as the store, its audit nodes never gate state and nothing replays.
3. **Daemon + heartbeat vs poll-based** (S3, S10–S14). sox runs a persistent supervisor with heartbeat, boot reconstruct, crash-loop breaker, poison-pill isolation, stuck-ticket backstop and saturation spawn; dispatch is one-shot-poll with an unwired multi-cycle loop and an unreachable maxCycles cap, and backlog has no scheduler/reaper at all (SL2-15).
4. **In-repo .cto file snapshots vs out-of-tree VACUUM DB copies** (S4, F14/SYS-ASYM-4). sox snapshots the whole `.cto` tree (committable, diffable, restorable with forensics); adhd recovery is single-file VACUUM INTO DB copies — different blast radius and granularity.
5. **CLI-first vs MCP-first** (cross-cutting; F18/F20/F23). sox is CLI-first (25-subcommand router) with MCP adapters as a secondary transport; the adhd side is MCP-first — agent IS a 16-tool MCP server, backlog serves MCP/HTTP/CLI over one 38-op client, and dispatch is a thin CLI consuming agent-mcp over the wire. Interface priority is inverted, which is why sox's MCP surface (F20 ◐) is a mirror while agent-mcp's is native.
6. **Non-orthogonality: adhd backlog runs on sox's published store substrate** (S8). backlog's graph store is built from `@adhd/sox-store-adapter` + `@adhd/sox-graph-store` (sox npm packages); a sox store release can silently change backlog semantics, so the comparison is not clean-room and the shared substrate is a version-drift surface.

---

## 4. Evidence & Method Appendix

### Method

The comparison was produced through eight stages, all artifacts persisted to graph memory (`~/.memory/memory.db`) and never re-deriving from code after Wave 1:

1. **Wave 1 — catalogs (47 episodes, topic `sox-vs-adhd-features`):** per-group capability catalogs — sox (16 episodes), backlog (15), dispatch (13), agent (5), plus sox-ecosystem storage substrate (8, standalone track, background only).
2. **Wave 2 — manifests (11 episodes, topic `sox-vs-adhd-manifest`):** per-group consolidated capability manifests (capability ids C1..Cn per group).
3. **Wave 2b — anchor equivalence maps (4 episodes, topic `sox-vs-adhd-equivalence`):** cross-group pair maps (sox/backlog/dispatch/agent anchors) classifying pairs as strong-equivalent or partial, plus auto-chunked content recovered via DERIVED_FROM edges.
4. **Wave 3 — unified catalog (4 parts, topic `sox-vs-adhd-catalog`):** consolidation of manifests + anchor maps into F1..F40 organized thematically (A state & lifecycle, B trust & recovery, C operational machinery, D interface & surface, E execution & orchestration), plus the adhd-only register (A1..A16) and the absence register (dispatch-ABSENT-1..18, agent-A1/A2) in part 4. Merge rule: strong-equivalence pairs merge into ONE feature; partials become ONE feature with per-group difference notes; distinct capabilities stay distinct.
5. **Wave 3b — reconciliation pass D (5 episodes + 17 corrections, topic `sox-vs-adhd-reconciliation`):** final consolidation check — 3 missed equivalences, 11 over-merges, 2 naming, 2 matrix errors, all resolved by correction episodes DERIVED_FROM the affected catalog parts. Root cause of the over-merge cluster: the anchor maps contradicted each other (sox-anchor: 1 strong/14 partial vs backlog-anchor: 6 strong/7 partial) and the catalog had silently picked the strong side.
6. **Wave 3c — two-sided exploratory verification (5 reports + 6 correction episodes, topics `sox-vs-adhd-verification` / `sox-vs-adhd-catalog`):** adhd-side absent-verified 64 rows (20 absence register + 44 feature N-cells) and present-verified 30 positive Y/partial spot-checks (10 backlog + 11 agent + 9 dispatch); sox-side absent-verified every sox=N claim and present-verified the sox Y/◐ controls; 3 nuance discoveries per side, 0 overturned absences, 0 false-positives on claimed-present rows.
7. **Wave 4a — system-lens v2 (12 episodes from 5 analysts, topic `sox-vs-adhd-system`, tags contain v2):** a second, orthogonal pass producing enforcement-vs-recorded, authority, inertness, emergent-behavior, and integration findings (SLS-*, SL2-*, R*, AU*, RT*, F*, E*, SYS-*) over sox, backlog, dispatch, agent, and the cross-system wire.
8. **Wave 4b — strict consolidation v2 (3 episodes, topic `sox-vs-adhd-catalog-v2`):** re-derived the catalog from all prior stages into **F1..F41 + S1..S15** under the rules: split any feature bundling anchor-flagged-distinct capabilities (when in doubt split — hence F16→F41); do NOT merge anything anchors did not classify ≥partial; preserve every pass-D correction; system-lens v2 findings appear ONLY as Implications bullets or in the S-section, never as capability rows. Homing (NAM-1/NAM-2) and the 5 kept cross-group strong-pair merges are documented inside the catalog v2 summary; every v2 finding appears exactly once.

### Evidence index (memory UIDs)

| What | Topic | UIDs |
|---|---|---|
| Catalog index (registry of the 47 Wave-1 episodes) | sox-vs-adhd-features | `01KZVKXZ13AZD2VX6H781J17GC` |
| 47 Wave-1 catalog episodes (sox 16 / backlog 15 / dispatch 13 / agent 5 / sox-ecosystem 8) | sox-vs-adhd-features | sox: `01KZVKSBY95MSKKVAKWQJ77P5S`..`01KZVKSH0YS1C0HANW1NNS6K57` (16, ep01..ep16); backlog: `01KZVKN2V149T9J796PCMRG6M3`.. (15); dispatch: `01KZVKWDPJ7QP6TKYMRJHTKJ9V`..`01KZVKWKZND4AHFJ6ZHC3HYYM5` (13); agent: `01KZVKHJZ80XZB4KE3PN5AP3SM`..`01KZVKHNSW1X2P2VG380MG4Y96` (5); sox-ecosystem: `01KZVKTNSV3BGEBQ3RW6687G3H`..`01KZVKTSQC51A4TQ6PX61FMGPG` (8, background) |
| 11 capability manifests | sox-vs-adhd-manifest | topic-scoped (per-group manifest episodes, tags per group) |
| 4 anchor equivalence maps | sox-vs-adhd-equivalence | topic-scoped (sox/backlog/dispatch/agent anchors + chunks via DERIVED_FROM) |
| Unified catalog v1 — part 1/4 (F1..F13) | sox-vs-adhd-catalog | `01KZVQP1BKCQ9XN2GBYDW3S79M` |
| Unified catalog v1 — part 2/4 (F14..F27) | sox-vs-adhd-catalog | `01KZVQPY2THYXXFHNJ187G1ZFA` |
| Unified catalog v1 — part 3/4 (F28..F40) | sox-vs-adhd-catalog | `01KZVQQPVMBD53DPR87CPA72HX` |
| Unified catalog v1 — part 4/4 (adhd-only A1..A16 + absence register + summary) | sox-vs-adhd-catalog | `01KZVQRAT28J7BBNH7X24HRYFE` |
| 17 pass-D corrections (demote over-merges + add missed mappings) | sox-vs-adhd-catalog | `01KZVR3JCP35K3SN4PXK6TTBTQ` (F5 +C4), `01KZVR3NVR7J4YE874GXR8W4WS` (F32/F36 +C37), `01KZVR3PAY3CC10J12BMN2N14Z` (F16 +C38 → now F41), `01KZVR3QV90SPXAVTPF845JZ7S` (F12), `01KZVR3W9G8EF11DJMS2JNFSMF` (F2), `01KZVR3XDE4DJPQAEDP2YRY9BC` (F3), `01KZVR3YCF314YZ34DTV4A5512` (F4), `01KZVR40RVB7DRND4WE58M89XA` (F7), `01KZVR41E28ZCMFT1Z7ACV4PMY` (F11), `01KZVR421RNJ3ERQBX95F628SK` (F15), `01KZVR42MHX2MV5N7HMDWXQMG9` (F18), `01KZVR43AJ2KEZHW2XB6VMCE6A` (F20), `01KZVR44DSW8BYCYSNF9W4XY7Z` (F31), `01KZVR46K7QAZSSVT75CARK03A` (F38), `01KZVR4762WXDM21WK5P72PAC4` (F34), `01KZVR47SFVV0RP43R9GXNYX0R` (NAM-1), `01KZVR48C7E3XC8G6GH06QF324` (NAM-2) |
| 5 reconciliation episodes (pass D report) | sox-vs-adhd-reconciliation | `01KZVR2DJ60FR2KCY3JGFMYG49` (report), `01KZVR2DW7KW1PP5DQ0GFXX2ES`, `01KZVR2E1TK6QM72A94KX9J02W`, `01KZVR2E8FHCFBH9VD12RXC512`, `01KZVR2ECH4308G4YZ55139PH9` (DERIVED_FROM chunks) |
| 5 verification reports | sox-vs-adhd-verification | adhd-side: `01KZVRQVERYRH3ESAXP0E5QTF2` (part 1/2 absent-verified), `01KZVRRGXB7H6KYSDGPC1QMR4C` (part 2/2 present-verified); sox-side: `01KZVSQ271D83NWDK3HFT7QMZE` (part 1/3 absent-verified), `01KZVSQDTD5FGS1W5MTQXC7R3F` (part 2/3 absent-verified + A-row checks), `01KZVSQTWZ60CBBBAXPEZSCWCP` (part 3/3 present-verified) |
| 6 verification corrections | sox-vs-adhd-catalog | adhd-side: `01KZVRQ3XBV2BBAN793M68C3BV` (F11 atomic-write nuance), `01KZVRQ43W49D6QDW1N7DH1NX7` (F15 schema-migration nuance), `01KZVRQ4B13F6S0C07S0Y731MS` (agent-A2 compiler-policy nuance); sox-side: `01KZVSP4YBT11DD4W1P1935FBJ` (F23 meta-loops near-miss), `01KZVSPFAZPXB8R0YR4S2XD69Q` (F31 token-audit near-miss), `01KZVSPPA1NS5YM5Y0FX08RME7` (F30 heuristic classifier near-miss) |
| 12 system-lens v2 episodes (5 analysts) | sox-vs-adhd-system | sox: `01KZVX7VK0K94X1FF4HDXS92ES` (SLS-01/02/06/13), `01KZVX7XYZ1AWMW35TVCY9SWFT` (SLS-03/04/05/12), `01KZVX80621XABJPH83R9QEWBY` (SLS-07..11); backlog: `01KZVXP3TEMDYN4XA5E3ZAJRVH` (SL2-01..06), `01KZVXQBFMB2T7CC1CN0AGQGMZ` (SL2-07..15); dispatch: `01KZVX8J7ZGTR8H4J75TAME0AW` (SL2-01..07), `01KZVX9FAETA2H5AMHETP4SANW` (SL2-08..13); agent: `01KZVXVRPK1YK94EWSBQD8DEXA` (R1..R9), `01KZVXWTK15FRMJWR4PYFYVT42` (F1..F4, E1, RT1/2, AU1..3); cross-system: `01KZVXB548D4TRMTCS2P4C8ZHA` (SYS-ASYM/FAIL), `01KZVXA9BS6ZN2BYT3XCC3A8B8` (SYS-INERT/GAP), `01KZVX9NA2PRG5AC1HSJV67E7X` (SYS-SHARED/ACT) |
| **Strict-consolidation catalog v2 — part 1/3 (F1..F14)** | sox-vs-adhd-catalog-v2 | `01KZVYHRPDH3S1C3W5XKMXDJ74` |
| **Strict-consolidation catalog v2 — part 2/3 (F15..F41 + registers)** | sox-vs-adhd-catalog-v2 | `01KZVYK9C0XF4FMW0TQDK1V3Z5` |
| **Strict-consolidation catalog v2 — part 3/3 (S1..S15 + summary)** | sox-vs-adhd-catalog-v2 | `01KZVYNA42M85PJCE9FZBS1SZW` |

### Citations convention

- Every feature claim in section 2 and every finding in section 3 carries a **Citations**/**Evidence** bullet with the file:line evidence recorded in the source episodes and the memory UID that carries it.
- **Positive evidence** is a file:line citation from the same src tree the capability lives in (e.g. `claim.ts:48-85`).
- **Negative evidence** is an absence proof: `rg <discriminating-pattern> <path> = 0 hits` (the exact patterns used are quoted in the verification episodes), or a CLI-surface check (`sox state --help` shows no subcommand), or a documented "does not exist"/TODO-stub comment. Zero-absence and negative evidence are always quoted as reported, never invented.
- **Enforcement claims** (an Implications bullet or an S-row asserting that something is or is not enforced) cite the reading code path — the file:line of the decision point that does (or fails to) consume the value, not merely the write site. Recorded-only / inert / write-only classifications always pair with the read-path citation that proves the non-consumption.
- No claim in this document was synthesized from model recall; every verdict traces to one of the UIDs above.
