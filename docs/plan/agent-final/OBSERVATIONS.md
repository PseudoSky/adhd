# OBSERVATIONS — agent-final running log

**Purpose:** every claim in this corpus that has been checked against reality gets a row
here — verified, invalidated, or superseded — with direct file:line references, so no
session ever re-derives these from scratch again.

**Rule:** these are OBSERVATIONS, not conclusions. Nothing here means "ok, let's plan."
The plan is authored only when the owner says the vision is locked.

**Provenance codes:** `[direct]` = read/executed in the main session. `[recon]` /
`[fixer]` / `[harvest]` / `[inventory]` / `[authoring-brief]` = reported by a dispatched
subagent on the date shown; independently cited but not re-read by the main session unless
also marked `[direct]`.

Append-only. Newest additions at the bottom of each section. Started 2026-07-16.

---

## 1 · Invalidated claims in agent-final's own documents

### OBS-1 — BUG-ORCH-012 is STALE: the sessions FK was already restored by migration 0009 `[direct]`
- **Stale claim:** `SYNTHESIS.md:52-55` — "Migration `0007` dropped the cascade… **Agent deletion orphans sessions forever.**" Repeated at `docs/architecture/agent-dispatch-systems.md:171-178` (§3 gap #1, "Real bug, independently corroborated").
- **Observed:** `entrypoint/agent-mcp/drizzle/0009_restore_sessions_agent_fk.sql` rebuilds `sessions` with `FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE cascade`, and its header cites BUG-ORCH-012 by name. It is entry `idx=9` in `entrypoint/agent-mcp/drizzle/meta/_journal.json` — it runs.
- **The live residue (real, unfixed):** `packages/agent/agent-store-runtime/src/db/schema.ts:14-15` still declares `agentName: text("agent_name").notNull()` with **no `.references()`**, while sibling `messages.sessionId` has one (`schema.ts:32-36`). The DB has the FK; the drizzle schema doesn't declare it. 0009's own header explains the mechanism: the two tables live in different packages, so drizzle-kit cannot see the relationship — meaning **the next `drizzle-kit generate` can regenerate the drop** exactly as 0007 did. The bug is not "orphans forever"; it is "hand-patched in SQL, structurally re-droppable."
- **Bearing on the fold decision (OBS-20):** folding `agents` into `agent-store-runtime` removes the cross-package invisibility that produced both 0007 and the schema/DB drift.

### OBS-2 — architecture doc §4 "What is REAL (do not rebuild)" contains two unproven claims `[direct]`
- **Stale claim 1:** `docs/architecture/agent-dispatch-systems.md:268` — "Dispatch's snapshot/optimize/serialize/CLI spine — builds green, **30 tests pass**."
- **Observed:** `packages/dispatch/dispatch-core-optimizer/project.json` declares **no `test` target**; its `src/lib/optimize.spec.ts` (280 lines, 12 cases) and `src/lib/snapshot.spec.ts` (361 lines, 18 cases) have **never run** via nx. The "30 tests" that pass are `dispatch-cli`'s.
- **Stale claim 2:** `agent-dispatch-systems.md:267` — "The plugin seam (`loader.ts:260-281`) — **proven live by budget**."
- **Observed:** `packages/agent/agent-plugin-budget/project.json` has no `test` target; `src/__tests__/budget-plugin.test.ts` (1404 lines, 35 cases) never runs. Same for `agent-plugin-sanitize` (10 cases). The seam may work; this sentence is not evidence.
- **Mechanism proven `[direct]`:** `npx nx run-many -t test -p dispatch-core-optimizer,agent-plugin-budget` → "Successfully ran target test for 2 projects", **EXIT=0** — nx reports success for a target that does not exist. 75 total test cases are invisible-green. Filed as BUG-NXTEST-001 (BACKLOG.md, commit `c250c97c`) before the no-backlog directive.

### OBS-3 — SYNTHESIS §2's AMA-D6-FLIP row under-reads the state: the decision is MADE, only propagation is open `[authoring-brief 2026-07-16]`
- **Stale framing:** `SYNTHESIS.md:133` — "Self-contradicted… Tracked OPEN as `AMA-D6-FLIP`" reads as an undecided A-vs-B question.
- **Observed:** `superseded/agent-mcp-authoring/decisions.md` §D6 carries a `⟲ FLIP (2026-07-11, owner directive)` block — **Option B → Option A is decided** ("We should not be designing around things"). What remains open is propagation: six artifacts still describe dead Option B, most dangerously `contexts/discovery-tools.md:85-93`, which says verbatim "Do NOT wire SqliteSearchBackend / Option A rejected." Also stale-B: `contexts/_shared.md:49-50`, `README.md:131-138` (dod.2), `scripts/criteria.json`, `scripts/audit_authoring.py`, `human-blockers.json`. Ledger: `superseded/agent-mcp-authoring/BACKLOG.md:297-310`.
- **Hazard:** anyone building from `discovery-tools.md`'s prose implements the rejected design.

### OBS-4 — SYNTHESIS §1.4's sox-availability snapshot is stale in both directions `[recon 2026-07-16] [fixer 2026-07-16]`
- **Stale claim:** `SYNTHESIS.md:81-84` — "`sox-hybrid-search`, `sox-analysis`, `sox-graph-store` are 404" (still true on npm as of 2026-07-16) framed alongside four enabling blockers implied open.
- **Observed in sox-ecosystem (cross-repo, `/Users/nix/dev/ai/sox-ecosystem`):**
  - BL-293 (schema auto-apply) — **landed** before this session: constructor calls `applySchema()` unconditionally (`libs/data/graph/graph-store/src/index.ts:686-697` post-session numbering; commit `7edfd93`).
  - BL-303 (prune unused drizzle-orm) — **premise inverted**: drizzle was *adopted* (ADR-0008, commit `9c63d40`) and is live (`index.ts:5-6`, migrate call at `:711`). "Prune it" would have broken the package.
  - BL-302 (no real migration runner) — **resolved as a side effect**: the `_schema_version`/`targetVersion=1` stub is gone, replaced by drizzle's `__drizzle_migrations` tracking + `drizzle/migrations/0000_sad_onslaught.sql`.
  - BL-295 (kind escape hatch) — partially landed pre-session: CHECK gained `'generic'` (`kind IN ('episode','entity','claim','community','session','generic')`). `'component'` still rejected as a literal kind.
  - BL-294 (degrade signal) — was genuinely open; **fixed this session** by sox-fixer (commit `65dad22`), see OBS-17.
  - sox `BACKLOG.md` labels BL-293/295/303 "Open" (`BACKLOG.md:5502,5563,5653`) — **the labels are stale relative to the code**; sox-fixer's first pass moved resolved entries to CHANGELOG per that repo's convention.
- **Meta-observation:** adhd-side documents describing sox's design were wrong on 3 of 4 blockers. Cross-repo plan claims decay in hours. Never relay them into an implementation brief unverified (this session did, and had to issue a mid-flight correction).

### OBS-5 — "the RAG is 100% unbuilt" is CONFIRMED, and now also OUT OF SCOPE for adhd `[inventory 2026-07-16] [direct: owner directive]`
- **Verified:** zero embedding/vector/cosine/FTS5/sqlite-vec code in `packages/agent`, `packages/dispatch`, `entrypoint/*`; zero `@adhd/sox-*` references in any package.json or import. Only incidental string hits (a "injection vectors" prompt template at `packages/agent/agent-store-prompts/src/seed/components.ts:297`; milestone-name fixtures).
- **Owner directive (2026-07-16, verbatim scope):** adhd implements **no** features belonging to "rag", "enrichment", "graph", "embedding", "vector" — those are improvements to sox-ecosystem packages. adhd consumes.
- **Consequence for the superseded design:** `agent-mcp-authoring`'s planned adhd-side modules `agent-store-prompts/src/enrich/{cosine,summarize,embedding,usecase-anchors,enrich-component}.ts` (per `contexts/enrichment-pipeline.md:67-127`, `contexts/embedding-substrate.md:67-127`) are **workarounds by definition** and must not be built in adhd. The registry's own entities (components/versions/compositions/use-cases) remain adhd's.

## 2 · Invalidated claims in the superseded corpus (spot-checked, not exhaustive)

### OBS-6 — `agent-registry/DEMO.md` is path-stale end to end `[direct]`
- Written against `packages/ai/agent-mcp` (`superseded/agent-registry/DEMO.md:51,352` boundary checks; `:185` deep-import path) and worktree `/Users/nix/dev/node/adhd-agent-registry` (`:170`) — neither exists. Its fixture *design* (§2: conditioned/unpinned/shared components engineered to force every differential path; §8 fired-with-consequence matrix) remains the best acceptance discipline in the corpus. Harvest the method, not the paths.

### OBS-7 — stale `packages/ai/*` doc-comments inside shipped dispatch code `[inventory 2026-07-16]`
- `packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts:168,222,301-304` cite `packages/ai/agent-mcp/...`; real path is `entrypoint/agent-mcp/`. Cosmetic, same family as BUG-WORKSPACE-GEN-001.

### OBS-8 — `dispatch-base-types` is dead generator scaffold `[inventory 2026-07-16] [direct: test-target scan]`
- `packages/dispatch/dispatch-base-types/src/lib/dispatch-dispatch-base-types.ts:1-3` is untouched boilerplate (`export function dispatchDispatchBaseTypes(): string`). Zero consumers. Its deletion was deferred to `docs/plan/dispatch-completion` (`BACKLOG.md:25`) — which is now quarantined under `superseded/`, stranding the deferral (filed as CHORE-REPO-003).

### OBS-9 — the two-CLI-router hazard in dispatch-cli `[inventory 2026-07-16]`
- `entrypoint/dispatch-cli` has two routers over one `src/api.ts` contract: the apigen-generated CLI (5 of 7 commands crash on a documented apigen-core `$ref` bug, `src/api.ts:134-148`) and the hand-written shipped `bin/cli.ts` (all 7 work: validate/snapshot/optimize/eligible/status/run/calibrate, `bin/cli.ts:60-143`). Any demo alias silently exercises only the working one.

### OBS-10 — `agents` table: two stores confirmed, host-side surface small `[direct]`
- `entrypoint/agent-mcp/src/db/schema.ts:3-9`: `agents` keyed by `name`, 5 columns. Business rules in `entrypoint/agent-mcp/src/store/agent-store.ts` — `AGENT_ALREADY_EXISTS` (:42-43), `AGENT_NOT_FOUND` (:71), `AGENT_HAS_ACTIVE_SESSIONS` (:131-132).
- `packages/agent/agent-engine-orchestrator/src/tools/agent-crud.ts:9-15`: `AgentStore` **interface only** (create/read/update/delete/list) — the impl lives in the host, exactly as `agent-dispatch-systems.md:83-85` says (that claim verified TRUE).
- `agent-mcp` owns the drizzle migrations for both its own and store-runtime's tables (`entrypoint/agent-mcp/drizzle/0000-0009`; `packages/agent/agent-store-runtime` has **no** drizzle dir).

### OBS-11 — dead duplicate `composed_prompts` confirmed `[direct]`
- `packages/agent/agent-store-runtime/src/db/schema.ts:99-115` defines `composed_prompts` (no `registry_` prefix) shadowing the live `registry_composed_prompts` in store-prompts. Corroborates `agent-dispatch-systems.md:180-182` (§3 gap #2).

### OBS-12 — 15-tool MCP surface + in-process delegation subset both verified `[inventory 2026-07-16]`
- `entrypoint/agent-mcp/src/server.ts:445-538` advertises 15 tools; switch at `:540-704` routes every one to an `@adhd/agent-engine-orchestrator` export (thin-router claim TRUE). The 11-tool in-process delegation subset **already exists** (`server.ts:295-443`, `inProcessDescriptors`/`inProcessHandler`) — so the authoring plan's "delegation-surface separation" invariant is an assertion over an existing seam, not a build.

## 3 · Cross-repo lineage observations (sox-ecosystem)

### OBS-13 — `adhd-build` (sox) is the ancestor of `dispatch-*`; owner confirms harvest-and-consolidate `[harvest 2026-07-16] [direct: owner]`
- `sox-ecosystem/docs/plan/adhd-build/`: GOAL (10 problems, non-LLM dispatcher, dag.json single source of truth, guards as verification — `GOAL.md:7-16,32-36`), DEMO in literal terminal-transcript idiom (`Setup / The Run / What Proves It's Done`, 5 scriptable closing claims — `DEMO.md:158-165`), dag at `schema_version:4`, 13 milestones, 2/15 ops complete.
- Lineage: `dispatch-optimizer` (sox) explicitly continues it (`dispatch-optimizer/README.md:87-89,126` runs against adhd-build's dag). Milestone shape survived nearly field-for-field into `dispatch-base-spec` `MilestoneDag` (`types.ts:499-511`); top-level `DagJson` grew `optimization`/`providers`/`effort_max_tokens` (`types.ts:567-586`); `DispatchUnit` grew 7→24 fields (`types.ts:626-651`).
- **Shipped:** dispatcher core, guard exec, resumability, per-milestone model/effort, agent routing, cost optimizer, guard-failure replan injection (`orchestrator.ts:713-718` — more automated than the ancestor demo's halt-and-wait).
- **Shipped nowhere:** goal→questions→milestones generation, scaffolding, interactive Q&A shell (zero clack/inquirer/readline in `packages/dispatch` + `entrypoint/dispatch-cli`), playbooks/amend (zero "playbook" hits). Authoring landed in sox's `workflow:plan-builder` instead. Honest three-way split: **authoring (sox) / optimizing (adhd) / executing (adhd)**.
- Also: `mcp_servers: null` on every DispatchUnit flagged as highest-priority blocker in `dispatch-optimizer/README.md:130-135` (BL-105) — inherited gap, still open.

### OBS-14 — `retrieval-infrastructure/SPEC.md` (sox) is authoritative for retrieval; it is ADDITIVE, not a rug-pull `[direct]`
- 638 lines, Q&A-iterated 2026-06-29. D3 (`SPEC.md:574`): "`VectorBackend` IS the adapter" — LanceDB sits beside `SqliteVectorBackend`, same interface; cross-encoder reranker has a `'skip'` mode; parent-context expansion is opt-in with defaults unchanged. Nothing in it invalidates consuming today's published shapes.
- Owner ruling (2026-07-16): this implementation direction is authoritative; adhd plans that designed around sox gaps were the error.
- One design flaw observed while demo-drafting (reported, not filed): D9's `threshold-gated` rerank mode gates on fusion *confidence*, but the lexical-overlap trap ("revoke user access" vs "grant user access") is precisely a confident-and-wrong case — the gate skips the query it exists for. Owner of that spec should decide before `threshold-gated` ships.

### OBS-15 — sox publish state `[recon 2026-07-16]`
- Published: `sox-embedding-provider@0.1.0`, `sox-vector-store@0.1.0`, `sox-ingest@0.1.0`, `sox-memory-core@0.2.1` (local repo at 0.3.0, unshipped bump). 404: `sox-graph-store`, `sox-hybrid-search`, `sox-analysis` (analysis is deliberately unconsumed by the authoring design — 404-and-unneeded).
- `graph-store` is the **only** unpublished node in `hybrid-search`'s transitive `@adhd` tree (`libs/data/search/hybrid-search/package.json:26-30`, all `workspace:*`).
- Release path: Changesets (`.changeset/` had zero pending changesets), `PUBLISHING.md` owner-gated, `pnpm run release:prepared`; owner has cleared OTP as a blocker (2026-07-16).

### OBS-16 — sox-fixer landed BL-294 and found it was WORSE than filed: a cross-namespace leak `[fixer 2026-07-16, commit 65dad22]`
- The vector (kNN) channel applied **no filter at all** regardless of `query.filters` — only the FTS5 channel filtered. Proven by negative control: two nodes, identical vectors, different namespaces; a `namespace:'tenant-b'`-scoped query returned tenant-a's node on unfixed code. Fixed by resolving `NodeFilter` via `graph.queryNodes()` and constraining `knn()` to the matched id set (empty match ⇒ skip knn, since `{ids:[]}` means "no filter" to the backend). Degrade signal `degraded?: { unsupportedFilters }` added unconditionally. Also fixed: `project_path`/`agent_id` filters were silently dead for **both** channels via `buildFilterClause()`'s unapplied `extraClauses`. 82/82 green; 12/12 red on pre-fix source.

### OBS-17 — sox-fixer session outcome + the one unresolved conflict `[fixer 2026-07-16]`
- 3 commits on sox `main` (`0ce39c7`, `65dad22`, `220cb1f`), +575/−145, graph-store 113/113, hybrid-search 82/82, lint/build/test exit 0, `npm pack --dry-run` clean (14 + 15 files, no test leakage), `check-publishable` OK. No publish, no version bump, no push.
- **CONFLICT AWAITING OWNER CALL:** `0ce39c7` implements `createGraphBackend(db, { kinds: ['component'] })` — an opt-in constructor allowlist that rebuilds the CHECK in place (default DDL untouched). This was built to the *original* (adhd-derived) brief before the mid-flight correction relaying sox BL-295's own Option-A recommendation (`'generic'` + sub-kind in meta, no CHECK change) arrived. Options on the table: **(a)** revert to strict Option A; **(b)** keep the opt-in mechanism as a superset. Fixer is holding. Note sox BL-295's own title says "extensible/generic escape hatch" and recommends A *first* with C as fast-follow — (b) is not obviously against its spirit, but the explicit relayed instruction said do-not-extend-the-CHECK. **Not decided. Owner call.**
- Also flagged by fixer: `graph-store`'s own `CLAUDE.md` still calls `src/index.ts` "a compileable skeleton… do not add implementation code" while it is a full implementation with 100+ tests — stale doc, unowned.

## 4 · Owner directives recorded this session (2026-07-16) — directives, not plans

### OBS-18 — scope directives `[direct: owner messages]`
1. **Working repo is adhd.** Track the half-built migrations/projects here; do not lose them.
2. **No rag/enrichment/graph/embedding/vector features in adhd** — those are sox package improvements. adhd consumes.
3. **Goal right now: create and confirm the goals and demos in agent-final.** Final vision locked before planning, to end the redundant re-derivation loop.
4. **Ask before assuming.**
5. **sox publishes via its own Changesets flow; OTP not a blocker.**
6. **sox's plans/backlog are authoritative for sox design** — adhd plan docs guessing at sox internals are not evidence (proven right: 3 of 4 blocker premises were wrong, OBS-4).
7. **`adhd-build` became `dispatch-*`** — harvest and consolidate its GOAL/DEMO when building the agent-final set; don't invent parallel framing.
8. **Fix things, don't build debt** — stop filing BACKLOG entries; fix directly. (Two entries — BUG-NXTEST-001, CHORE-REPO-003 — were committed at `c250c97c` before this directive landed.)

### OBS-19 — demo-idiom synthesis agreed in-session (not yet ratified as a plan)
- Skeleton: sox transcript style (`Setup / The Run / What Proves It's Done`, literal diffable strings) + `⟦U#⟧` unresolved-interface ledger (from `dispatch-completion/demo/`) + engineered-fixture / fired-with-consequence / negative-control discipline (from `agent-registry/DEMO.md` §0-§2, §8).
- Known tension to surface at authoring time: `adhd-build/GOAL.md:35` mandates dag.json as the **single** source of truth (no separate state file); the `plan-state-machine` skill uses `dag.json` + `state.json`. Shipped `dispatch-*` honors the ancestor (single file + inline `dispatch_log`). Unresolved which convention agent-final's own plans use.

### OBS-20 — settled architecture decision `[direct: owner AskUserQuestion answer]`
- **`agents` + `AgentStore` fold into `agent-store-runtime`.** Not a new `agent-store-registry` package. Rationale: FK resolves in-file, killing the cross-package drizzle-kit blindness that caused 0007's silent FK drop and the current schema/DB drift (OBS-1). This resolves the architecture doc's self-contradiction (§3 gap #1 "fold into store-runtime" at `agent-dispatch-systems.md:176-178` vs §3 TARGET STATE "store-registry ✅ NEW" at `:242-247`) in favor of §3 gap #1. SYNTHESIS §3 Q1/Q2 are thereby answered.
- Decomposition of agent-final into plans: **deliberately not chosen yet** ("Lets make 1 right now then come back") — owner picked no decomposition option.

### OBS-21 — owner rulings, second batch `[direct: owner message, 2026-07-16]`
1. **`agent-core-policy`'s original intent (SYNTHESIS Q3 answered):** "apply restrictions to the agent — how it can use tools, what files it can access, how it can access them." Owner assessment: "**it may be irrelevant at this point.**" Consequence: no enforcement demo is owed; policy work stays on hold; the package's disposition (retire vs keep as descriptive metadata) is an open item but **not a blocker** for anything in agent-final. The architecture doc's TARGET STATE "✅ ENFORCED" ambition (`agent-dispatch-systems.md:246-247`) is thereby unratified — do not build toward it without a new ruling.
2. **Decomposition (O-2 answered): ONE plan.** agent-final is a single plan. The per-subsystem GOAL+DEMO pairs are its internal milestone gates, not sibling plans. `store-move/` becomes the first milestone's goal/demo, not "plan 1 of N."
3. **Dispatch demo (O-3 answered): retained.** "I want that demo, i have not confirmed that they are invalid." `superseded/dispatch-completion/demo/DEMO.md` (+ `UNRESOLVED.md`, 15 ⟦U#⟧) is the dispatch milestone's demo. **Precision note:** the mechanically-proven facts in OBS-2 (missing test targets, nx silent-success) invalidate claims in `agent-dispatch-systems.md:267-268` and `BACKLOG.md:23` — they were never claims *about demo beats*, whose grounded steps were live-captured 2026-07-15. The owner has not ratified any invalidation as applying to the demo itself; none was asserted.
4. **sox BL-295: "A or B but I want at least how sox defined it and that item to be popped from the backlog."** Either shape acceptable; sox's Option-A contract (all 4 acceptance criteria) must exist and be proven regardless; BL-295 moves BACKLOG→CHANGELOG in the closing commit. Relayed to sox-fixer 2026-07-16 (supersedes the earlier strict-(a) instruction, which the fixer may have been mid-executing — least-churn from current state applies). This resolves open-items rows 4 and 12 below (row 12 via ruling 1).

### OBS-22 — sox publish COMPLETE; scope was wider than planned; owner accepted `[direct, 2026-07-16]`
- `pnpm run release:prepared` (run from the main adhd session with standing owner approval) published **10 packages**, registry-verified via `npm view`: the two targets **`sox-graph-store@0.3.0`** (BL-295 Option-A shape) and **`sox-hybrid-search@0.2.0`** (degrade signal + cross-namespace leak fix), plus `sox-analysis@0.1.0`, `sox-memory-core@0.3.0`, `sox-cli@1.2.0`, `sox-extension-memory-server@1.3.0`, `sox-task-queue@0.1.0`, `sox-blob-store@0.1.0`, `sox-claim-verification@0.1.0`, `sox-source-provider@0.1.0`.
- **Race + over-breadth, disclosed and accepted:** `changeset publish` sweeps every workspace package whose local version differs from npm — sox-fixer flagged mid-flight that this would ship memory-core's pre-existing, unaudited 0.2.1→0.3.0 delta and stopped to ask; the main-session publish had already run. Owner ruling: **"Its fine"** (2026-07-16). Closed.
- Residue handled: `registry/index.json` regenerated + committed with the PUBLISHING.md fix (sox `15b0ff1`); git tags created by changesets; **`PUBLISHING.md`'s documented `changeset publish --dry-run` gate DOES NOT EXIST** in @changesets/cli@2.31.0 (fixer finding) — doc fixed to a real drift-audit command in the same commit.
- Demo impact: `demo/UNRESOLVED.md` **U3's publish precondition is now landed** (`npm view @adhd/sox-graph-store version` exits 0); the remaining half of U3 (agent-store-prompts consuming them) is build work.
- sox-fixer final state: commits `1446028`→`a8715dc`→`8d0ab06`→`cfa5ca6`→`e428d92`→`8bcb2cb` on sox main; BL-295 popped from BACKLOG (in `220cb1f`); fixer session ended at its usage limit — remaining items absorbed here.

### OBS-23 — owner directive: multi-provider configuration + portability `[direct: owner message, 2026-07-16]`
- Verbatim intent: "the provider package to support configuring multiple providers, we should compare to opencode & openrouter so that agents can be portable across providers and sessions themselves could swap providers/model/etc."
- Grounding already on record: provider is represented **three ways with no mapping** (SYNTHESIS §1.5 — dispatch's snake_case `ProviderConfig`, agent-mcp's camelCase `providerConfigSchema`, `agent-core-provider`'s DB registry); `ModelTier`(`Haiku|Sonnet|Opus`) has zero mapping to `provider_models.pricingTier`; `agent-core-provider` is seeded but has **zero runtime consumers** (`agent-dispatch-systems.md:113` — resolution is hardcoded env vars + a switch on 3 literal types).
- Memory recall: no prior research on provider portability → one scoped research dispatch launched (opencode + OpenRouter reference designs vs adhd ground truth; findings/options separated). GOAL.md + demo gain a provider act **after** the brief lands and the owner confirms the design decisions — not before.

### OBS-24 — provider portability: research findings + the four owner rulings `[research subagent 2026-07-16, spot-grounded] [direct: owner AskUserQuestion, 2026-07-17]`
**Findings (grounded, file:line):**
1. **The gap is wiring, not schema.** `agent-core-provider`'s tables already separate provider identity × canonical model × platform binding × tool-format (`src/db/schema.ts:15-100`) — structurally equivalent to OpenRouter slug resolution / opencode model inheritance. But: the live chat path is a `switch` over 3 literals (`agent-engine-orchestrator/src/providers/factory.ts:8-26`); `provider_tool_formats` ships **zero seed rows** (`seed/index.ts:1-32` seeds only providers→models→bindings); `emitTool()` is built+tested+**unwired** (`runtime/emit-tools.ts:11-14`: "wiring into the live provider is agent-mcp-refactor's job (plan 6)" — never happened; `providers/anthropic.ts:115,250` still calls local `toAnthropicTools()`).
2. **Agents are welded**: `agentDefinitionSchema.provider` is *required* (`validation/agent.ts:106-120`) — an agent cannot exist without exactly one provider.
3. **Sessions/tasks have no provider/model columns** (`agent-store-runtime/src/db/schema.ts:12-69`); `taskUsageTable.providerType/model` (`:139-140`) is a post-hoc ledger, not a selector. No storage seam for a swap exists.
4. **`deepseek` is dead config**: `PROVIDER_DEFAULTS` includes it (`entrypoint/agent-mcp/src/config.ts:70-86`) but `GetProviderConfigOpts.provider` (`:10`) and the Zod union accept only `openai|anthropic|claudecli` — unreachable through the typed API.
5. One registry consumer IS live: `agent-engine-compiler/src/resolve/model.ts:44-79` uses `ModelStore` for prompt-frontmatter model lines — but nothing in the LLM-call path consults the registry.
6. Reference designs: opencode = `provider/model` slugs, agent `model` is an *optional override* with inheritance (agent→global; subagent→invoker), Vercel AI-SDK normalization, models.dev capability registry, mid-session `/models` reselection with **undocumented** carryover. OpenRouter = ordered `models[]` fallback (last-error-wins), `provider{order,sort,allow_fallbacks,…}` preferences, `:nitro`/`:floor` slug variants, normalized `finish_reason` + tool-schema transforms.
**Rulings (owner, 2026-07-17) — now GOAL.md D-G:**
- Canonical: **"we can merge all of the registries"** — ONE provider registry; the three representations retired, not mapped.
- Binding: inheritance chain — agent optional hint → session (new columns, swap = row update) → task override; `task ?? session ?? agent ?? global`.
- Swap: **soft** — same session, history re-rendered through the tool-format layer (the built-unwired machinery finally load-bearing); negative control = normalization stubbed → hard fail.
- Routing: **ordered `models[]` fallback only** this pass.
**Artifacts updated:** GOAL.md (D-G + end-state #8), demo/DEMO.md **Act 6** (3 beats: un-welded agent + merged registry · BLUEHERON soft-swap · revoked-key failover), REQ-016..019, CAP-013..015, ⟦U7⟧–⟦U9⟧ ledgered. Validator re-run: PASS, 9 stubs, 34 ids.

### OBS-25 — owner directive: dispatcher demo items covered first-class `[direct: owner message, 2026-07-17]`
- "All dispatcher demo items should be covered as well" — the nested dispatch-completion demo must not sit behind a single gate checkbox. Implemented: DEMO.md §7.2b imports its complete traceability set as 29 `DSP-*` rows (15 REQs preserving its numbering gaps, 14 CAPs), each mapped to its nested beats and exercised via spine beat 5.3; its 15 unresolved-work items indexed in the spine's UNRESOLVED.md scope section (glyph-free, so the two ledgers' stub ids can't collide). A provider-ruling interaction note marks where D-G's merged registry re-grounds the nested demo's provider-shaped beats (behaviors binding, shapes follow D-G — folded into ⟦U7⟧). Validator: PASS, 35 ids.

### OBS-26 — Q&A round 1 rulings + BUG-NXTEST-001 closed at true scale `[direct: owner AskUserQuestion + fixes, 2026-07-17]`
**Rulings:** U6 in-process seam **in scope** for agent-final (Act 5 stands) · authoring verbs **kept** (`component_define`/`agent_define`/`component_search`/`agent_compile`) · 75 unrun tests **fix now** · climax **not confirmed as asked** — owner critique: *"I dont like how your demo doesnt use the actual mcp/clis."*
**Demo rewritten onto the real surface:** the `call-tool.mjs` shim is gone; the runner is a real MCP host session (`.mcp.json` → built dist, `/mcp` reload), every agent action a literal `mcp__agent-mcp__<tool> {json}` invocation, dispatch via the real CLI. The critique exposed a genuine semantics bug the shim was hiding: plugin/provider env (`ADHD_AGENT_PLUGINS`, secrets, `AGENT_MCP_LIVE`) is **server-process** configuration — the affected beats now say "restart the server with this env," which is how it actually works. Validator: PASS, 9 stubs, 35 ids, 0 warnings.
**BUG-NXTEST-001 closed (commit `6b0fc2a2`) — true scale was 15 projects, not 4:** the closing gate (`scripts/check-test-wiring.mjs`, negative-controlled, `npm run check:test-wiring`) found 11 more spec-carrying target-less projects. All 15 wired; **~500 cases executed for the first time, 15/15 green, real exit 0**. Two genuine failures surfaced and fixed: `workspace-base-tools` `vi.spyOn` on a non-configurable `node:fs` namespace export (Node 24), `use-debounce` missing `act()` wraps. En-route: `node_modules` repaired (`estree-walker` missing; `npm install --legacy-peer-deps` because `package.json` pins `nx@18.3.4` while declaring `@nxlv/python@^22.2.1` — pre-existing ERESOLVE inconsistency, still open); owner-approved deletion of 330 stray compiled artifacts in `packages/agent/*/src/` + gitignore guard (root cause = agent tsconfig template defect, tracked); storybook package eslint now ignores its own `node_modules` cache. Residue (open, honest): the newly-green suites have no red→green history (teeth unproven); hooks had 1 non-reproducible crash-after-green (3/3 green rerun) + 11 env-conditional skips; vitest `cache.dir` deprecation repo-wide; the nx18/nxlv22 manifest conflict.

### OBS-27 — owner verdict: the demo missed the corpus's intent; AGENT_MCP_TOOL_INTERFACE.md read in full `[direct, 2026-07-17]`
**Owner ruling on the climax/demo:** missed the mark — "all centered around agent authoring in basically the exact demo that already works." Named misses: the dispatch CLI experience · graph components · **intelligent task-based agent SP compilation** · the whole premise of dispatcher user interactions · the agent client as a generic package · how the graph+RAG system is actually valuable · the absorbed intents of ALL superseded plans ("this plan is what is superseding them by absorbing all of their intent"). Consequence: demo rebuild against a full-loop climax (plan → packed waves → per-task-compiled SPs → guards → telemetry → mid-plan fleet edit → terminal); intent-mining of all 21 plans dispatched (2 miners in flight); the rebuilt demo carries a per-plan intent-absorption matrix — every superseded intent gets a beat or an explicit "not absorbed" row.
**Read direct (563/563 lines): `superseded/agent-registry/AGENT_MCP_TOOL_INTERFACE.md`.** Load-bearing facts my demo contradicted:
1. Task-context compilation enters at **session start**: `agent({name, platform?, context?})` → `resolveComposedPrompt`, `context_hash = SHA256(platform + componentVersions + context)` (§1 :53-74, §3 :317-327). The prompt is computed per invocation, never stored.
2. **Small-model preservation is a designed value** (§3): hot-path required-arg budget counted 7→5; author-then-run in 3-5 calls (:241-244); pre-authored steady state = 2 tools (:305-313); `guide` as progressive disclosure (§2 :204-217).
3. **An operator CLI lane is designed** (§6 :465-473): `agent-registry compile` (.md emit), component browsing, `tool_grant`/`model_bind`/`policy_attach` — deliberately CLI-only, never MCP.
4. Compat semantics: `COMPILE_MISSING_COMPONENTS` surfaces at session start, not create (§4 :352-356); `systemPrompt` is a **permanent** compat shim, no sunset (§7 :535-536).
5. Doc ends with **4 unratified decision forks** (A: granularity, B: agent-tool params, C: existingComponentSlug, D: semver) — "Decisions Requested," never answered (:540-563).
**NEW FORK (unowned): the two superseded authoring designs contradict.** This doc (§6): ONE composite `component_define {agentName, component, position, existingComponentSlug}` = define-and-attach; component browsing/search **CLI-only, never MCP** (:428-444, :465-473). `agent-mcp-authoring` (later): content-only `component_define`, separate `agent_define`, and an 11-tool MCP **discovery lane headlined by `component_search`**. Both are "the spec." The rebuilt demo must carry an explicit reconciliation ruling — flagged for the owner with the intent matrix.

## 5 · Open items ledger (things observed and still unowned)

| # | Item | Where observed |
|---|---|---|
| 1 | `sessions.agentName` lacks `.references()` in the drizzle schema while the DB has the FK — regeneration will re-drop it | OBS-1 |
| 2 | 75 unrun test cases across 3 projects; nx silent-success mechanism | OBS-2 |
| 3 | AMA-D6-FLIP propagation across 6 superseded artifacts (matters only if any is harvested) | OBS-3 |
| 4 | sox BL-295 (a)/(b) revert-or-keep decision — fixer holding | OBS-17 |
| 5 | sox publish of graph-store + hybrid-search — code ready, changesets unauthored | OBS-15/17 |
| 6 | `threshold-gated` rerank gates away its own use case (sox SPEC D9) | OBS-14 |
| 7 | Dead duplicate `composed_prompts` table in store-runtime | OBS-11 |
| 8 | Stale `packages/ai/*` doc-comments in `agent-runner.ts` | OBS-7 |
| 9 | `dispatch-base-types` dead scaffold; deferral stranded in quarantined plan | OBS-8 |
| 10 | BL-105 `mcp_servers:null` on DispatchUnit (inherited from adhd-build lineage) | OBS-13 |
| 11 | BL-300/301 (sox): node/edge schema duplicated graph-store↔memory-core and already drifted (HIGH, sox-side) | OBS-4 §context |
| 12 | `agent-core-policy` purpose / enforcement question — SYNTHESIS Q3, still on hold, no decision requested yet | SYNTHESIS.md:159-163 |
| 13 | DATA_MODEL Domain 4 (Workflow Structures) has no plan; RUNTIME_GAPS Gap 1 unassigned | SYNTHESIS.md:140-144 |
| 14 | Two ~500-line tool-interface specs unread; requirement coverage unverified | SYNTHESIS.md:144-146 |
| 15 | 12 superseded plans claim `complete` with 0 `guard_pass` — no DoD trustworthy without re-verification | SYNTHESIS.md:166-167 |
| 16 | untracked compiled `.js`/`.d.ts`/`.map` under `packages/agent/*/src/` (not authored by this session; needs a human call) | git status, session start |
| 17 | graph-store `CLAUDE.md` "skeleton" line stale vs full implementation (sox-side, unowned) | OBS-17 |
