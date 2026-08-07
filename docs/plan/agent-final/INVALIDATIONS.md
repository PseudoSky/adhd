# INVALIDATIONS — claims disproven against source

**Purpose:** every claim in the agent+dispatch corpus (SYNTHESIS, the architecture doc,
BACKLOG entries, superseded plans) that has been **checked against code and found stale or
false**, with the disproof pinned to file:line. Check here before acting on any corpus
claim — this session alone burned three dispatch cycles on claims this log would have caught.

**Rule:** an entry needs (1) the stale claim + where it's asserted, (2) the disproof with
file:line, (3) verified-by: `direct` (this session read the source) or `subagent` (cited
agent report, spot-checked). Append-only; never delete — strike through and date if an
entry is itself later invalidated.

---

## I-1 · "Agent deletion orphans sessions forever" (BUG-ORCH-012) — FIXED since migration 0009; docs never updated

- **Asserted in:** `SYNTHESIS.md` §1.2 ("Agent deletion orphans sessions forever"); `docs/architecture/agent-dispatch-systems.md:171-178` (§3 gap #1, "Real bug, independently corroborated"); repo `BACKLOG.md` BUG-ORCH-012.
- **Disproof (direct):** `entrypoint/agent-mcp/drizzle/0009_restore_sessions_agent_fk.sql` rebuilds `sessions` **with** `FOREIGN KEY (agent_name) REFERENCES agents(name) ... ON DELETE cascade`, and its header comment names BUG-ORCH-012 as the reason. It is live: `entrypoint/agent-mcp/drizzle/meta/_journal.json` entry `idx=9, tag=0009_restore_sessions_agent_fk`.
- **⚠️ The root cause is NOT fixed — a regression is armed.** `packages/agent/agent-store-runtime/src/db/schema.ts:14-15` still declares `agentName: text("agent_name").notNull()` with **no `.references()`** (its sibling `messages.sessionId` at `:32-36` shows the correct pattern). The DB has the FK; the drizzle schema doesn't declare it. 0009's own header explains the mechanism: drizzle-kit can't see the cross-package relationship — so the next `drizzle-kit generate` diff can silently emit a migration that drops the FK **again**, exactly as 0007 did. The owner-decided fix (2026-07-16): fold `agents` + `AgentStore` into `agent-store-runtime` so the FK is declarable in-file.

## I-2 · "Dispatch's spine — builds green, 30 tests pass" — the optimizer's 30 tests have never run

- **Asserted in:** `docs/architecture/agent-dispatch-systems.md:268` (§4 "What is REAL today").
- **Disproof (direct):** `packages/dispatch/dispatch-core-optimizer/project.json` declares **no `test` target** (targets: `build`, `nx-release-publish`). Its specs exist and are substantial — `src/lib/optimize.spec.ts` (280 lines, 12 cases), `src/lib/snapshot.spec.ts` (361 lines, 18 cases) — and cannot be run via any nx target. The "30 tests pass" figure is `dispatch-cli`'s suite, not the optimizer's.

## I-3 · "The plugin seam — proven live by budget" — budget's 35 test cases have never run

- **Asserted in:** `docs/architecture/agent-dispatch-systems.md:267`.
- **Disproof (direct):** `packages/agent/agent-plugin-budget/project.json` has no `test` target; `src/__tests__/budget-plugin.test.ts` (1404 lines, 35 cases) is unreachable by `nx test`. Same for `agent-plugin-sanitize` (10 cases). The seam may work; this sentence is not evidence.

## I-4 · "`nx run-many -t test` verified green" for projects with no test target — nx reports SUCCESS for targets that don't exist

- **Asserted in:** repo `BACKLOG.md:23` (BUG-DISPATCH-PUBLISH-001 closure: "Verified green ... all tasks passed" naming `dispatch-core-optimizer` and `dispatch-base-types`).
- **Disproof (direct, reproducible):** `npx nx run-many -t test -p dispatch-core-optimizer,agent-plugin-budget` → `Successfully ran target test for 2 projects`, `EXIT=0` — neither project has the target (run 2026-07-16). Any historical "run-many -t test green" that named these projects is partly vacuous.

## I-5 · "sox-hybrid-search / -analysis / -graph-store are 404 — publish them or implement fusion locally" — they exist, complete, with full APIs; only unpublished

- **Asserted in:** `SYNTHESIS.md` §1.4 and §3 Q4.
- **Disproof (subagent recon of `/Users/nix/dev/ai/sox-ecosystem` @ `797981f`, spot-checked):** `libs/data/graph/graph-store` (`@adhd/sox-graph-store@0.2.0`) and `libs/data/search/hybrid-search` (`@adhd/sox-hybrid-search@0.1.0`) build and test green (105/105, 74/74 pre-fix; 113/113, 82/82 after 2026-07-16 fixes). "404" conflated *unpublished* with *nonexistent*. Also: `sox-analysis` is deliberately **not consumed** by the authoring design (`superseded/agent-mcp-authoring/contexts/_shared.md:57-67`) — its 404 was never a blocker.

## I-6 · "BL-295 = make `kind` an extensible constructor-allowlist" — sox's own plan says Option A (`'generic'` + sub-kind in meta)

- **Asserted in:** `superseded/agent-mcp-authoring/decisions.md:296-304` (relayed into two dispatch briefs this session — both had to be corrected mid-flight).
- **Disproof (direct):** `sox-ecosystem/BACKLOG.md` BL-295 (read at lines 5563-5652, 2026-07-16): "Recommendation: **Option A** first (smallest safe step) ... write nodes with `kind:'generic'` plus their own domain-specific data carried in the existing free-form meta/fields columns." The shipped CHECK already contains `'generic'`. *(2026-07-16, later: sox-fixer commit `0ce39c7` subsequently built an opt-in `kinds` allowlist — see I-13 for the pending owner call.)*

## I-7 · "BL-303: prune the unused drizzle-orm dep" — inverted; drizzle was ADOPTED, pruning would break the package

- **Asserted in:** `superseded/agent-mcp-authoring/decisions.md:296-304`.
- **Disproof (subagent ×2, independently):** sox commit `9c63d40 feat(graph-store): port to Drizzle migration management (ADR-0008)`; live imports at `libs/data/graph/graph-store/src/index.ts:5-6`, `migrate(...)` executed in `applySchema()` (`:711`).

## I-8 · "BL-293: createGraphBackend throws `no such table: node`" — landed 2026-07-11, same day it was filed

- **Asserted in:** `superseded/agent-mcp-authoring/decisions.md:296-304`; still labelled "Open (HIGH)" in sox `BACKLOG.md` until 2026-07-16.
- **Disproof (subagent ×2 + live run through built dist):** sox commit `7edfd93`; constructor auto-applies schema (`src/index.ts:686-697` at current HEAD).

## I-9 · "BL-302: `_schema_version` stub means no schema change can ever reach an existing store" — superseded by the Drizzle port

- **Asserted in:** sox `BACKLOG.md` BL-302 ("Open (HIGH)").
- **Disproof (subagent, current source):** the stub is gone from `src/index.ts` (zero matches); real versioned migrations run via `__drizzle_migrations` + `drizzle/migrations/0000_sad_onslaught.sql`. Resolved by a different mechanism than BL-302 proposed.

## I-10 · AMA-D6-FLIP — six artifacts still describe the *rejected* Option-B retrieval design

- **Asserted (stale Option-B prose) in:** `superseded/agent-mcp-authoring/contexts/discovery-tools.md:85-93` (says verbatim "Do NOT wire SqliteSearchBackend / Option A rejected"); `contexts/_shared.md:49-50`; `README.md:131-138` (dod.2); `scripts/criteria.json`; `scripts/audit_authoring.py`; `human-blockers.json`.
- **Authoritative:** `decisions.md` §D6 `⟲ FLIP (2026-07-11, owner directive)` — Option A. Any artifact derived from the six above without cross-checking the FLIP block inherits a dead design. Tracked in that plan's own `BACKLOG.md:297-310`.

## I-11 · Every path in the agent-registry demo and in dispatch-orchestrator doc comments citing `packages/ai/*` — that tree does not exist

- **Asserted in:** `superseded/agent-registry/DEMO.md:51` (boundary check), `:173-186` (env block), `:352-355` (step 12); `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts:168, :222, :301-304` (doc comments).
- **Disproof (direct + AGENTS.md):** `packages/ai/` is one of the seven deleted directories (AGENTS.md §1, BUG-WORKSPACE-GEN-001). Real paths: `packages/agent/*`, `entrypoint/agent-mcp/`. The registry demo's *fixture design* remains excellent; its every path is stale.

## I-12 · "12 plans complete" — at least one certified state is disproven by code; none has a `guard_pass`

- **Asserted in:** superseded plans' `state.json` files (`complete` with 3–48 `guard_bypass_suspected`, 0 `guard_pass` — `SYNTHESIS.md` §3 Q5).
- **Disproof (direct, one exemplar):** `agent-mcp-refactor`'s `agent-store-retire` is `complete`, yet `entrypoint/agent-mcp/src/store/agent-store.ts:20-152` is a full source-of-truth CRUD store — the state's own objective, unexecuted (`agent-final/README.md:14-16`). Corollary: **no superseded plan's DoD may be cited as evidence without re-verification.**

## I-13 · Two sections of the architecture doc answer "where does AgentStore live?" differently

- **Asserted in:** `docs/architecture/agent-dispatch-systems.md:176-178` (§3 gap #1: "move `agents` + `AgentStore` into `agent-store-runtime`") **vs** `:241-248` (§3 TARGET STATE diagram: `store-registry ✅ NEW`).
- **Resolution (owner, 2026-07-16):** **fold into `agent-store-runtime`.** The FK resolves in-file; the target diagram's `store-registry` box is dead. *(Related pending call: sox-fixer's `0ce39c7` opt-in `kinds` mechanism vs BL-295's Option A — owner decision requested 2026-07-16.)*

## I-14 · "dispatch-base-types orphan deletion is already tracked under docs/plan/dispatch-completion" — that plan is quarantined

- **Asserted in:** repo `BACKLOG.md:25`.
- **Disproof (direct):** `docs/plan/dispatch-completion/` no longer exists; commit `7bfbac35` moved it to `docs/plan/agent-final/superseded/dispatch-completion/`, whose README forbids resuming anything in it. The deferral dangles. (Same class: audit any BACKLOG deferral pointing into `docs/plan/{agent-*,dispatch-*}`.)

## I-15 · sox `BACKLOG.md` "Open" labels for BL-293/295/303 — stale against sox's own code

- **Asserted in:** `sox-ecosystem/BACKLOG.md:5502, :5563, :5653` (as of `797981f`).
- **Disproof:** I-6/I-7/I-8 above. **Resolved 2026-07-16** — sox-fixer moved the four entries to sox's `CHANGELOG.md` per that repo's convention (commits `0ce39c7`, `65dad22`, `220cb1f`).

---

*Opened 2026-07-16 during the agent-final goals/demos consolidation. Sources: direct reads
this session + three cited subagent reports (authoring/RAG brief; dispatch/agent inventory;
sox-ecosystem publish recon), each spot-checked before entry.*
