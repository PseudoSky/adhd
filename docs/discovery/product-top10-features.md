# Product: top 10 highest-ROI new features (dispatch-1014)

Source set: 90 open `kind=feature` items read via `adhd-backlog query` (read-only), plus `docs/ideas/`, `docs/product/`, `CHANGELOG.md`. Bugs and debt excluded. ROI = consumer value x leverage across existing packages / effort. External market research: not needed (every pick is an internal capability gap with in-repo evidence); `researcher` was not dispatched.

## Ranked list

### 1. uid 40aaffce - Task-event read surface for agent-mcp (full MODEL_REQUEST / TOOL_RESULT, CONTEXT_COMPACTED)
- ROI: every experiment, debug session and dispatcher audit currently needs raw SQLite or API logs; one read tool unblocks all of them. Small code surface, huge leverage.
- Evidence: not shipped. `entrypoint/agent-mcp/src/server.ts:528-539,787-798` expose only `task_list`, `task_cancel`, `task_resume`; `task_events` mentioned only in a usage note (server.ts:384). `CONTEXT_COMPACTED` absent from `packages/agent/agent-base-types/src/domain.ts` (rg, no hit). Item body cites orchestrator.ts:1224-1232, 1423-1439 (500-char truncation).
- ACs: AC1 a new `task_events` MCP tool returns all events for a finished task by id, paginated. AC2 TOOL_RESULT events store the model-visible text and its hash (not a 500-char slice). AC3 MODEL_REQUEST records system prompt hash and advertised tool names. AC4 `CONTEXT_COMPACTED` is a member of the TaskEventType union and the zod enum. AC5 an e2e test drives the tool through the built server over stdio and reads back events of a real task (mock provider only).
- Write scope: `entrypoint/agent-mcp/src/server.ts`, `packages/agent/agent-base-types/src/domain.ts`, `packages/agent/agent-engine-orchestrator/src/validation/task.ts`, orchestrator event emit sites, `entrypoint/agent-mcp/src/__tests__/`.
- Size: M. DoR: **ready**.

### 2. uid 287c301e - Scheduled / on-open embedding backfill (heal) for the backlog store
- ROI: dedupe and search quality degrade silently; item measured 15% of live issues unvectorized and growing, and the only repair is a dev-only script. Fixes the tool every agent files through.
- Evidence: item body (2026-09-23 measurement; re-measure before work); no scheduler in backlog src per the item; spec exists at `entrypoint/backlog/report/embed-durability-fix-spec.md`; dev CLI `tools/etl/embed-backfill-cli.ts`.
- ACs: AC1 a mounted verb (or on-open sweep) backfills missing vectors, bounded by a batch limit and resumable. AC2 `embedding-status` reports missing count 0 after a run on a seeded store with N missing. AC3 a new write embeds without manual action (missing count does not grow). AC4 each backfill run is audited (count, duration). AC5 real-store integration test, reopen proves persistence.
- Write scope: `entrypoint/backlog/src/**`, `entrypoint/backlog/skill/REFERENCE.md`, `tools/etl/embed-backfill-cli.ts` (promote or delete).
- Size: M. DoR: **ready** (spec file present).

### 3. uid 40fde12c - Provider failure handling epic (PF-1..PF-11: classify, retry/failover, trip store, propagation up dispatch chain)
- ROI: billing/429/overload failures today are string-matched and kill whole dispatch chains; this is the reliability backbone for all unattended runs.
- Evidence: PF-1 partly shipped: `packages/agent/agent-core-provider/src/failure/{classify,rules,heuristics,retry-after,cooldown}.ts`, `packages/agent/agent-base-types/src/provider-failure.ts`. PF-2..PF-11 open (uids 8efb36fa, 3d887244, cfdbbbea, c3962ff6, 1cf076e1, dd192a30, de14eb06, 69698447, 4e220a1f, 52d4dedc); each carries write scope and negative-control ACs (PF-1 body).
- ACs (next slice, PF-2 + PF-3 + PF-4): AC1 adapters return raw error for single-shot calls. AC2 trip store persists provider trips across restart (reopen test). AC3 attempt engine retries per class and fails over to the next `models[]` entry; a billing class never retries. AC4 each PF's own ACs and negative controls hold.
- Write scope: `packages/agent/agent-core-provider/src/**`, `packages/agent/agent-engine-orchestrator/src/**`, `packages/agent/agent-base-types/src/**`.
- Size: L (slice M). DoR: **ready** (per-PF specs exist; dependency order PF-1 -> PF-2/3 -> PF-4).

### 4. uid 376fe07f - Numbered offset/limit file read for all providers (`agent-core-native-read`)
- ROI: a correctness bug (model answered line 6 for line 7) affecting every provider using `fs__read_text_file`; ~68 LOC prototype already evaluated.
- Evidence: item body; ADR-0008 Amendment A1 permits the build (`docs/decisions/0008-agent-mcp-native-tooling.md`); `packages/agent/agent-core-native-tooling/src/lib/catalog.ts` has no read server. Not shipped (no `agent-core-native-read` anywhere in repo).
- ACs: AC1 read tool returns 6-wide right-aligned 1-based numbers, tab, text, honoring offset/limit. AC2 catalog mounts it and denies `read_text_file`/`read_file` so exactly one read tool is advertised. AC3 claudecli bridge deny path proven by test. AC4 an e2e run reads a fixture and the recorded result is numbered.
- Write scope: new `packages/agent/agent-core-native-read/**`, `packages/agent/agent-core-native-tooling/src/lib/catalog.ts`.
- Size: S-M. DoR: **needs-human-approval** (new package; CLAUDE.md forbids creating one without recorded approval). Otherwise ready.

### 5. uid 04472d3c - Auto component discovery and many-to-many issue-to-component linking from citations
- ROI: makes `overlap`, reservations and blast-radius queries trustworthy without hand-maintained components; foundation for multi-agent collision avoidance.
- Evidence: spec exists `entrypoint/backlog/report/citation-component-linking.md`; partial machinery (overlap view, owns_component edge) per item body; REFERENCE.md section 13 shows reservations shipped but no component auto-linking.
- ACs: AC1 a citation path resolves to project+component by longest registered prefix. AC2 links are recomputed on create/update and idempotent. AC3 `query` returns issues touching component X and issues spanning projects Y+Z. AC4 backfill over existing items reports counts. AC5 real-store integration test.
- Write scope: `entrypoint/backlog/src/**`, backlog store adapter, `entrypoint/backlog/skill/`.
- Size: L. DoR: **ready** (spec present; confirm the spec's repo-string normalization decision first).

### 6. uid 0f9b6132 - `remove-note` verb
- ROI: a dozen unremovable notes already litter third-party items; reached constantly via the safe `duplicateAction: comment`. Tiny effort.
- Evidence: item body lists note ids; `rg remove-note|removeNote entrypoint/backlog` returns nothing (unshipped).
- ACs: AC1 `remove-note` deletes a note by id when caller is its author or on an allowed actor list, recording a reason. AC2 other callers get a typed refusal. AC3 removal appears in auditTrail. AC4 CLI + MCP surface via `--help` listing.
- Write scope: `entrypoint/backlog/src/**`, `entrypoint/backlog/skill/REFERENCE.md`.
- Size: S. DoR: **ready**.

### 7. uid 87799e1d - Persisted store health record
- ROI: one call answers "is this store healthy and when verified"; closes the case where a store missing 34% of vectors reads healthy.
- Evidence: item body (identity/crash state stored, health only computed or emitted as telemetry).
- ACs: AC1 integrity check and `embedding_health` write verdict, vector coverage, versions, last-verified timestamp. AC2 one read returns the latest record plus bounded history. AC3 coverage below threshold yields a non-healthy verdict. AC4 survives reopen.
- Write scope: backlog store layer and `entrypoint/backlog/src/**` (exact store package unnamed in the item).
- Size: M. DoR: **needs-spec** (storage location, history bound and threshold undecided).

### 8. uid cc5a4906 - `git-operator` agent (single git owner)
- ROI: git operations are scattered across dispatcher and executors; the repeated "swept-in files" incidents come from it.
- Evidence: item body; target `docs/contributing/conventions/git-workflow.md` absent per item; source files live outside the repo (`~/dev/ai/claude-agents/...`).
- ACs: AC1 `docs/contributing/conventions/git-workflow.md` exists and encodes pathspec-commit and worktree rules. AC2 `extensions/agents/git-operator/` renders for each host. AC3 dispatcher merge step references the doc.
- Write scope: `docs/contributing/conventions/git-workflow.md`, `extensions/agents/git-operator/**` (verify this path exists in this repo; it is not a workspace package).
- Size: S-M. DoR: **needs-spec** (extension scaffold location not verified in this repo).

### 9. uid 26280300 - N=100 concurrent memory-server instances
- ROI: concurrent agents are the product's core use; prod instance currently hit by respawn loops when a dev instance runs.
- Evidence: item body (secondhand symptoms; root cause under investigation in 26584e74).
- ACs: AC1 100 mixed instances (same db and distinct dbs) start and all answer `memory_ping`. AC2 prod instance unaffected (no watchdog kill). AC3 no stale sidecar growth.
- Write scope: undetermined until root cause known.
- Size: L. DoR: **needs-research** (root cause 26584e74).

### 10. uid 69a8b83b - Dispatcher run topic anchor and side-ask fast path
- ROI: one trivial side-ask cost ~135k tokens; classification cuts ceremony on every run.
- Evidence: item body, plus companion cf4b08e3.
- ACs: AC1 Step 0 records a one-line main topic. AC2 each ask is classified on-topic or side-ask in one stated line. AC3 side-ask takes one dispatch with no review gate, declared in the report. AC4 an explicit user request for full review is honored.
- Write scope: dispatcher skill/agent files under `~/.config/opencode/` (outside this repo).
- Size: S. DoR: **needs-spec** (write scope outside repo; confirm the owning repo for dispatcher playbooks).

## Considered and excluded (already shipped or out of repo)
- 46cf1086 (CRITICAL reservation enumeration): shipped. `entrypoint/backlog/skill/REFERENCE.md:1409-1418` documents `query view:"reservations"` and `view:"sessions"`. Item is stale; should be resolved with that citation.
- 37f6c511 (OpenRouter daily price pull): shipped. `entrypoint/agent-mcp/src/pricing/pull.ts:27-28`.
- 1f1c8598 (unpriced models must be loud): shipped. `entrypoint/agent-mcp/src/server.ts:247` (`cost_status 'unpriced_model'`, `unpriced_tasks`) and `packages/agent/agent-core-provider/src/pricing/rate-card.ts:224-226`.
- b168fcd5, 6d28ba4a, a672f3ae (query-engine group_by/aggregate): `group_by` is in `packages/data/data-query-engine/src/lib/expressions.ts:285` with specs; the items describe a superseded shape. Needs a gap review before refiling.
- All `agent-dashboard:` features: no dashboard package exists under `entrypoint/` or `packages/` in this repo.
- 5186dbc2 / c8d64420 (session rediscovery): backlog half shipped (REFERENCE.md:1403-1418); remaining work is dispatcher/operator playbook outside this repo.

## Counts
Ready: 5 (#1, #2, #3, #5, #6). Not ready: 5 (needs-human-approval #4, needs-spec #7, #8, #10, needs-research #9).
