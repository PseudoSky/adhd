# SPEC-SET — the small set of fixes between now and the target end state

**Status:** TARGET plan. Changes no behavior and no code. Not an ADR; derives from `backlog-interface-target.md` (target ADR-0007, PROPOSED) and `tmp/backlog-consolidation/reconciliation-plan.md`.
**Source of truth:** the 49 reconciled clusters in `tmp/backlog-consolidation/clusters/reconciled.json`; cluster→card-uid map in `tmp/backlog-consolidation/clusters/cluster-card-map.json`.
**Machine mapping:** `docs/plan/backlog-consolidation/spec-set-mapping.json`.

**Mapping sum (one line):** 49 clusters → **10 specs** (47 clusters absorbed) **+ 2 deferred** (`adr-0005-policy`, `project-config-surface`); 47 + 2 = 49. Of the 27 unclustered survivors, 26 attach to a spec by home cluster and 1 (`eec45b05`) is deferred.

**Reading the fields.** Each spec carries: id + imperative title; root problem (P-1..P-8, plan §9.1); the cluster keys/uids it absorbs; its design-corpus anchor (C1–C10 / FOUNDATION `69632883`); concrete write-scope; 2–6 binary observable acceptance criteria; dependencies / gating order; classification (additive-safe-now vs breaking); executor class. `REM:` marks a cluster that is *remodeled-by* a design item and therefore **deferred-until** that anchor lands — it is budgeted inside its owning spec but must not be implemented ahead of the gate (`reconciliation-plan.md` §8).

**Ordering principle.** Foundational-safe-now first (S01, S07, S08, S09, S10 have no target-ADR gate). Everything the target ADR would remodel is marked `dependent/deferred-until-<gating uid>` and is never a standalone implementation. Gate chain the plan fixed: FOUNDATION `69632883` → target ADR (Bucket E, `backlog-interface-target.md`) → C1/C8/C9/C3/C10/C2.

**Spec index (10).**

| id | title | problem | anchor | clusters | class | executor |
|----|-------|---------|--------|----------|-------|----------|
| S01 | Freeze & extend the node/edge vocabulary (FOUNDATION) | P-3 | FOUNDATION 69632883 | 1 | additive-safe-now | backend |
| S02 | Establish canonical identity, merge/redirect & duplicate linking | P-1 | C1 73d0b9c6 + C9 cf97c613 | 5 | **breaking** | backend |
| S03 | Make reads complete and honest | P-2 | C2 ac911229 + C7 395cfcad | 2 | additive (wide `related` = breaking) | typescript |
| S04 | Anchored attestation & work-product citizenship | P-3 | C3 38631ad4 + C10 b009396b | 3 | additive-safe-now | backend |
| S05 | Obligations, derived verdict & the closure gate | P-3 | C4 1c53784d + C5 b076742d + C6 291263ea | 5 | **breaking** (gate) | backend + qa |
| S06 | Closed, readable vocabulary & configuration surface | P-4 | C8 4a12472e | 4 | additive (close/vocab = breaking) | doc-steward + backend |
| S07 | Make writes atomic & durable | P-5 | C5 write path | 6 | additive-safe-now | backend |
| S08 | Guarantee shipped artifacts match source | P-6 | — (foundational) | 9 | additive-safe-now | devops + typescript |
| S09 | Give runtime services a durable lifecycle & truthful telemetry | P-7 | — (foundational) | 4 | additive-safe-now | backend |
| S10 | Make process & tooling self-enforcing | P-8 | — (foundational) | 8 | additive-safe-now | devops + doc-steward |

---

## Spec S01 — Freeze and extend the node/edge vocabulary (FOUNDATION)

- **Root problem:** P-3 (the substrate the evidence/obligation system is written against).
- **Absorbs (1):** `graph-store-identity` (`2cd00fd3-07cb-48eb-9532-563148eba0ff`). AMB-2 ("does the FOUNDATION node-kind vocab subsume per-kind node identity?") is answered **yes** by this spec — it *is* the vocabulary decision; owner-confirm at target-ADR review.
- **Design anchor:** FOUNDATION `69632883` (node kinds + internal edges + typed error arms); partial overlap with C8 `4a12472e`.
- **Write-scope:** `entrypoint/backlog/src/store/vocabulary-guard.ts`, `entrypoint/backlog/src/write/tx.ts`, `entrypoint/backlog/src/write/catalog.ts`, `entrypoint/backlog/src/write/errors.ts`, `entrypoint/backlog/src/store/graph-backlog-store.ts`; substrate seam to external `node_modules/@adhd/sox-graph-store` (out-of-repo dependency — file a coordinated upgrade if new kinds must be taught to the substrate).
- **Acceptance criteria (binary):**
  1. Node kinds `attestation` and `obligation` are admitted and readable; the catalog reports 15 kinds (13 → 15).
  2. Internal edges `attests`, `has_obligation`, `satisfies` are writable/traversable and are **absent** from the public `relate` enum — a `relate` with `attests` returns a typed error, not success.
  3. Unknown-kind *mint* behaviour is unchanged (the guard is additive; closing the catalog is S06's breaking decision, not this spec).
  4. `npx nx test @adhd/backlog` and `npx nx run @adhd/backlog:verify-dist-load` exit 0.
- **Dependencies / gating:** none — foundational-safe-now. **Precedes S04 and S05** (they are written against these kinds/edges).
- **Classification:** additive-safe-now (internal vocabulary; permitted under ADR-0006 D6).
- **Executor:** backend.

## Spec S02 — Establish canonical identity, merge/redirect & duplicate linking

- **Root problem:** P-1 (a record has no identity lifecycle; one thing is several rows; ids unresolvable).
- **Absorbs (5):** `backlog-lifecycle-model` (`0b0df8f3-cf19-45e6-a00f-486dc8b74a88`), `backlog-write-integrity` (`65029970-4e7e-4516-9e00-713ae705056b`), `id-resolution` (`3a4a0405-9e18-4ae7-a74a-152ed5a740be`), `registry-integrity` (`39799f8e-dacb-4acb-a7cb-cd98ed32531f`) — all **REM: C1 73d0b9c6**, deferred-until target ADR; `dedupe-similarity` (`6d64f6b3-f950-4396-83e9-83fe28322b30`) — **REM: C9 cf97c613**, deferred-until target ADR.
- **Design anchor:** C1 `73d0b9c6` (canonical node + merge/retire/redirect) + C9 `cf97c613` (cross-project dedupe + reviewed linking) + blocker B3 + adoption `e54bd58b`.
- **Write-scope:** `entrypoint/backlog/src/` uid-resolution path and merge/redirect handling, `entrypoint/backlog/src/cli.ts`, `entrypoint/backlog/src/store/graph-backlog-store.ts`, `entrypoint/backlog/skill/SKILL.md`, `entrypoint/backlog/SPEC.md`, `entrypoint/backlog/DATA_MODEL.md`.
- **Acceptance criteria (binary):**
  1. An ambiguous uid prefix returns the candidate **set** (typed `ambiguous_reference` carrying candidates); no silent first-match.
  2. A merge writes one `Redirect` row and soft-retires the source; the source uid still resolves to the chain head — no hard delete, addressability preserved.
  3. Cross-project dedupe never auto-links: default scope `same-project`; `link-duplicate {sourceUid,targetUid,by,reason}` requires explicit inputs; a `duplicates` read returns candidate clusters with provenance.
  4. Every uid-taking verb resolves through the SUPERSEDES/Redirect chain (resolution invariant holds across the surface).
- **Dependencies / gating:** gate = target ADR (`backlog-interface-target.md`) approval of D3a/D3c. **Breaking** — canonical identity resolution changes behavior across every uid-taking verb: `OWNER SIGN-OFF REQUIRED`, inert until a superseding ADR of ADR-0006 is authored at ship. No code in this spec ships before that.
- **Classification:** **breaking** (sign-off gated).
- **Executor:** backend.

## Spec S03 — Make reads complete and honest

- **Root problem:** P-2 (reads are silently lossy — omit relations, FTS shadow, ignore sort direction, cap windows, no complete-vs-truncated signal).
- **Absorbs (2):** `query-semantics` (`b3e24b62-335b-49a0-a3d9-139eec3f9f8b`), `envelope-routing` (`20b2ce5c-513f-4667-a321-3c1969cc9a69`). Defects folded in: D1 `77310a60` (stale `card.ts:8` comment), D3 `9a95be96` (query ignores `direction:"desc"`; AMB-5 resolved here — the sort bug is read-layer, owned by this spec).
- **Design anchor:** C2 `ac911229` (structural legibility; resolves contradiction #1) + C7 `395cfcad` (honest envelopes + observability).
- **Write-scope:** `entrypoint/backlog/src/` query/order/projection path, `entrypoint/backlog/src/cli.ts`, `entrypoint/backlog/SPEC.md`, `entrypoint/backlog/DATA_MODEL.md`; the `card.ts` stale comment location named by D1.
- **Acceptance criteria (binary):**
  1. Every view returns completeness meta (`total`/`returned`/`limit`/`offset?`/`truncated?`/`has_more`); a truncated result is always distinguishable from a complete one regardless of client-side array length.
  2. A `direction:"desc"` order request returns descending order (D3 `9a95be96` fixed); derived reads carry `score_kind` (`rrf|bm25|cosine|rank`).
  3. `view:"order"` scopes to every member kind the filter selects (not just `issue`) and includes outbound `blocks` + a dependent count; a second `part_of` returns a typed error naming the existing parent.
  4. The C1-contradiction is closed one way in the target ADR: either `related` returns every live relation (wide variant) and the stale comment is deleted, **or** the enumerated three are declared authoritative and the stale comment is deleted. Either way the two sources no longer disagree.
- **Dependencies / gating:** gate = target ADR D4e decision. Narrow variant needs no sign-off; **wide `related` is behavior-visible → `OWNER SIGN-OFF REQUIRED`**.
- **Classification:** additive (narrow variant); breaking if the wide variant is chosen.
- **Executor:** typescript.

## Spec S04 — Anchored attestation & work-product citizenship

- **Root problem:** P-3 (evidence is proxy-shaped; citations green while broken).
- **Absorbs (3):** `citation-integrity` (`8392a07c-ca69-4b2f-b71d-6009c4867211`) — **REM: C3 38631ad4**, deferred-until target ADR; `spec-design-corpus` (`c88a73b2-e4c2-4414-9cbf-16f3dc74d457`) — **REM: C10 b009396b**; `evidence-integrity` (`65788fd8-de26-4886-bc86-e13af546b089`). Blockers resolved: B1 `34b69c69` (spec-revision read path), B2 (citation-by-path enumeration).
- **Design anchor:** C3 `38631ad4` + C10 `b009396b`; B1/B2 target resolutions in the target ADR.
- **Write-scope:** `entrypoint/backlog/src/` `attest`/anchor + revision/pointer path, `SPEC` node-kind handling, citation projection; `entrypoint/backlog/SPEC.md`, `entrypoint/backlog/DATA_MODEL.md`, `entrypoint/backlog/skill/SKILL.md`.
- **Acceptance criteria (binary):**
  1. `attest {subject:{id,revision},claim:{kind,body},anchor:{locator,digest},by}` records an anchored attestation; re-checking an anchor whose locator changed yields state `stale` (never a silent `verified`). States are `unverified|verified|stale|unknown` (`refuted` excluded).
  2. A `SPEC` item is a queryable store citizen, `part_of` a work item; its export reads back with `revision` + anchor digest and reports `verified|drifted|gone`.
  3. B1 closed: a `get` optional input field (or additive `spec-get`) returns the revision fragment, not just the pointer.
  4. B2 closed: a `query` filter/projection (e.g. `byCitationPath`) returns which items cite a given path.
- **Dependencies / gating:** **depends on S01** (attestation kind + `attests` edge). Gate = target ADR. Additive.
- **Classification:** additive-safe-now *once S01 lands*.
- **Executor:** backend (+ doc-steward for SPEC/DATA_MODEL wording).

## Spec S05 — Obligations, derived verdict & the closure gate

- **Root problem:** P-3 (closure has no verified-evidence gate; "checks that cannot fail" — gates/demos/tests green while broken). One-problem-many-symptoms: clusters 18/23/25/47/48 + edbb640b/fa0c8cc6/dc40a5dc.
- **Absorbs (5):** `demo-acceptance-integrity` (`ddceb069-65b7-4a56-b870-332bb7297ef7`), `gate-integrity` (`8b579d52-e72b-496f-85e2-950a8a8d5049`), `test-assertion-integrity` (`55ba4178-e198-4d13-9a3e-47a1f25443ae`), `test-harness` (`af7c138f-5409-4acc-9f98-ecb4d54cb70b`), `ci-chronic-red` (`8c0c314e-4a2d-4c3c-a5cb-c0ca3bbf9a1c`).
- **Design anchor:** C4 `1c53784d` (obligation core) + C5 `b076742d` (closure gate) + C6 `291263ea` (derived verdict).
- **Write-scope:** `entrypoint/backlog/src/` `obligate`/`transition`/`claim` path + `Verdict`/`Condition` read types; `.github/workflows/ci.yml`, `.github/workflows/pull-request.yml`; `tools/nx-plugins/test/`; demo-acceptance harness.
- **Acceptance criteria (binary):**
  1. `obligate {uid,applies_to,requirement,on_fail:block|warn,override?,by}` with the closed predicate core (`evidence{kind,min?}`, `blockers_terminal()`, `relation{type,direction}`, `all_of`, `any_of`, `not`); an item with no obligation is unaffected.
  2. A terminal transition with an unsatisfied `block` obligation is refused with typed `{code, required_kind}`; a commit ref alone does **not** satisfy `published-artifact`.
  3. `claim` fails loudly on a `block`-severity condition; `Verdict`/`Condition` are derived on read, never stored.
  4. Every CI/test/demo gate has a negative control that turns red when the guarded defect is reintroduced (proven by a deliberately-broken variant going red, then reverted).
- **Dependencies / gating:** **depends on S01 + S04** (obligations consume verified evidence). Gate = target ADR. **Breaking** — the closure gate + `claim` precondition change existing-verb success semantics: `OWNER SIGN-OFF REQUIRED`, inert until a superseding ADR of ADR-0006.
- **Classification:** **breaking** (sign-off gated).
- **Executor:** backend + qa (devops for CI wiring).

## Spec S06 — Closed, readable vocabulary & configuration surface

- **Root problem:** P-4 (vocabulary unstructured/undocumented; unknown kinds mint silently; hand-copied prose drifts; catalog not machine-readable).
- **Absorbs (4):** `catalog-minting` (`4d603d05-0ec3-4041-b3a8-5c31c3c74532`), `docs-spec-drift` (`7586d46c-0d63-4c0a-bb52-bb4af46dbcea`), `planning-extensibility` (`af3eb285-0c40-446c-aefc-ee2f9ec78531`) — all **REM: C8 4a12472e**, deferred-until target ADR; `config-environment` (`37c0430c-8fc3-40d0-a447-d64b3536816f`).
- **Design anchor:** C8 `4a12472e` (closed primitives, readable catalogs, self-describing surface); B2's C8 half.
- **Write-scope:** `entrypoint/backlog/src/write/catalog.ts`, `entrypoint/backlog/src/store/vocabulary-guard.ts`, `entrypoint/backlog/skill/SKILL.md`, `entrypoint/backlog/SPEC.md`, `packages/environment/*`, `.adhd/workspace.json`, `docs/decisions/0006-backlog-public-interface-freeze.md` (defect D2 `73d3b97d`).
- **Acceptance criteria (binary):**
  1. `get {registry:"kind"}` (or a `kind` view) returns every catalog term with identity/type/scope/lifecycle/replacement pointer; the verb surface is machine-readable — "no advertised verb is absent" is checkable.
  2. Every doc that hand-copies the verb/enum surface is regenerated from the catalog; a drift check fails on divergence (cluster 20).
  3. Vocabulary cleanup either done or explicitly deferred with sign-off: `kind:EPIC` retired, `bug`/`BUG` reconciled, `undefined`/`MEDIUM` removed.
  4. Defect D2 `73d3b97d` repaired: ADR-0006 records `ambiguous_reference` among the ten codes and no longer invents an `update` status (non-decision correction, doc-steward).
- **Dependencies / gating:** gate = target ADR. Additive (registry reads, drift checks); **breaking sub-items** — closing the kind catalog and the vocabulary migration — need `OWNER SIGN-OFF REQUIRED` and are inert until a superseding ADR.
- **Classification:** additive for the registry/self-describing surface; breaking for the close + vocab migration (gated).
- **Executor:** doc-steward + backend.

## Spec S07 — Make writes atomic and durable

- **Root problem:** P-5 (writes are not as atomic/durable as documented — claim+lease, concurrent MCP writes, supersede, lock/WAL/sidecar/backup split/leak/false-success).
- **Absorbs (6):** `concurrency-atomicity` (`4679369b-f7cc-4375-8d2a-e814a620df7e`), `fts-rebuild-migration` (`faab1209-39a9-4333-9dd6-d66b53d955be`), `graph-store-soundness` (`0fd6728c-55ea-41a4-8338-8bbd70accd7b`), `memory-write-race` (`b2afcfa2-b123-41f8-bc8f-fea9cba1d606`), `store-integrity` (`5848752b-2fc8-4dd1-bc76-0ae2160f0af3`), `store-lock-lifecycle` (`453fdd4f-44ae-45ec-b4c4-baf443ef06dd`).
- **Design anchor:** C5 write path (derived); governed by sox **ADR-0012** (parallel-process invariant — multiple processes may hold concurrent write connections).
- **Write-scope:** `entrypoint/backlog/src/write/claim.ts`, `entrypoint/backlog/src/write/claim-lease.ts`, `entrypoint/backlog/src/write/tx.ts`, `entrypoint/backlog/src/store/graph-backlog-store.ts`; FTS rebuild/migration under `entrypoint/backlog/`; external `@adhd/sox-graph-store` / `@adhd/sox-store-adapter` seam (out-of-repo dependency).
- **Acceptance criteria (binary):**
  1. Two concurrent processes racing to claim one node yield **exactly one** claim; a distinct caller gets typed `E_CLAIM_HELD`; same-caller re-claim is idempotent — proven with latches/barriers, never wall-clock.
  2. An interrupted write leaves no split WAL/sidecar; reopening the store shows the pre-write state (durability proven by reopen, not by a success envelope).
  3. FTS rebuild is idempotent and migration-safe; a shadow/missing row is detected rather than silently serving stale matches.
  4. A failed write reports failure — no false-success envelope (negative control).
- **Dependencies / gating:** independent — foundational-safe-now. Must uphold sox ADR-0012; correct any stale single-writer claim touched.
- **Classification:** additive-safe-now.
- **Executor:** backend.

## Spec S08 — Guarantee shipped artifacts match source

- **Root problem:** P-6 (shipped artifacts diverge from source; install/build/release/publish report success delivering stale or broken output; toolchain drift).
- **Absorbs (9):** `artifact-dist-integrity` (`420a7051-9eaf-4597-b9ea-ca1a499dedc0`), `install-engine` (`5fd61857-cb70-4a23-ab77-064db5c3fa79`), `ir-cache-freshness` (`f8b6ffc2-13c5-48f5-a68a-93449b679483`), `nx-config` (`b83f167d-3a8f-4274-8826-99f8d0aa476f`), `pnpm-toolchain` (`5f3d80dd-e0c3-441c-9462-59f247e81cb5`), `release-publish-drift` (`df9de4da-6c6b-4e32-af4f-ef2b24a8d378`), `apigen-contract` (`1854a9f6-0bb4-4165-9678-c78d518c0fe3`), `apigen-runmode-strictness` (`2c7179a0-8728-4df4-b6fa-d0de983cd866`), `apigen-tracing` (`5cd7502b-95b2-4bdd-a0bb-ffbda10173e2`).
- **Design anchor:** none in the design corpus — foundational P-6 work. The apigen trio is the generated-contract instance of the same "artifact ≠ source" defect and shares the ship gate.
- **Write-scope:** `tools/nx-plugins/build/executors/publish/release-publish.mjs`, `tools/nx-plugins/build/executors/publish/release-commit.mjs`, `tools/nx-plugins/build/lib/release-manifest.js`, `tools/nx-plugins/build/lib/release-reset.js`, `tools/nx-plugins/verify-dist-load/`; `nx.json`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`; `packages/apigen/*` (contract/runmode/tracing plugins), `entrypoint/apigen-cli/`.
- **Acceptance criteria (binary):**
  1. A publish with a stale/mismatched `dist/` fails the release-manifest backstop — it cannot report success while shipping a stale artifact.
  2. `verify-dist-load` runs by default (unflagged) and loads the real built entry; an apigen generated contract that diverges from its source types fails the build.
  3. pnpm/nx toolchain versions are pinned; a mismatch fails rather than silently re-resolving.
  4. apigen runmode strictness: an unsupported runmode errors; tracing emits a trace for every invoked operation.
- **Dependencies / gating:** independent — foundational-safe-now.
- **Classification:** additive-safe-now.
- **Executor:** devops + typescript.

## Spec S09 — Give runtime services a durable lifecycle and truthful telemetry

- **Root problem:** P-7 (embedding/RAG has no durable lifecycle; telemetry is false; no persisted health record).
- **Absorbs (4):** `embedding-lifecycle` (`e6e5da46-5c3d-40c1-a2da-607014eec969`), `memory-core-recall` (`709cc0ad-9ea9-4212-8a1d-445c996ecf85`), `metrics-telemetry` (`e8626233-dd4a-4eaa-aaba-91f6f26f4436`), `service-lifecycle` (`cbbf1786-d6e5-418a-952f-c99f81e39fbc`).
- **Design anchor:** none in the design corpus — foundational P-7 work.
- **Write-scope:** the external `@adhd/sox-extension-memory-server` bundle seam (surveyed under `docs/environment/adoption-survey/sox-ecosystem/`); in-repo consumers `entrypoint/agent-mcp/`, `packages/agent/*`; metrics/telemetry emission paths.
- **Acceptance criteria (binary):**
  1. Embedding/RAG has a durable lifecycle: a persisted health record survives process restart; a failed embed is recorded and retried, never silently dropped.
  2. Recall over the same store returns the same result after reopen (persistence proven by reopen, not by cache).
  3. Telemetry never reports success for a failed operation (false-metric negative control goes red).
  4. Service start/stop is idempotent and leaves no orphaned process or socket.
- **Dependencies / gating:** independent — foundational-safe-now. Carries an out-of-repo substrate dependency (memory server lives in the soxe bundle).
- **Classification:** additive-safe-now.
- **Executor:** backend.

## Spec S10 — Make process and tooling self-enforcing

- **Root problem:** P-8 (process/tooling not self-enforcing — dispatch grants, agent specs, worktree provisioning, repo hygiene, CI un-gated).
- **Absorbs (8):** `agent-spec-output-discipline` (`53664070-209f-413a-901e-423c703e79de`), `branch-artifact-parity` (`c4060ba9-f483-475a-a2e2-824fb3f17a12`), `dispatch-tooling` (`7ed25125-177c-4846-97e4-4fae692d27a2`), `process-resource-hygiene` (`d794287f-6dc1-4321-b48a-b9588eff3a52`), `repo-hygiene` (`e92e2b92-db4c-40bb-a846-479dbb2a2c92`), `worktree-tooling` (`7b7d5e38-b93f-42fe-9fa7-e6d9497ea57a`), `agent-dashboard` (`5743ca57-e250-40f9-a62f-c31657fc94eb`), `dead-code` (`13af6d56-43f7-4072-ae5e-615de4b33fe4`).
- **Design anchor:** none in the design corpus — foundational P-8 work.
- **Write-scope:** `packages/dispatch/*`, `entrypoint/dispatch-cli/`, `packages/agent/*`, `entrypoint/agent-mcp/`, `.github/workflows/*`, `tools/nx-plugins/` (lint/deps/secret-scan guards), repo-hygiene scripts, git worktree tooling under `.worktrees/`.
- **Acceptance criteria (binary):**
  1. Dispatch grants are declared — no empty/omitted `tools` or `model`; a violation fails loudly.
  2. Agent-spec output discipline: a spec missing a required section fails validation.
  3. Worktrees are provisioned under `.worktrees/` with an installed `node_modules` before dependency-checks; a missing install is detected (never silently strips used deps).
  4. Repo hygiene: a `git status --porcelain` clean-or-accounted gate; no tracked `dist/`/`tmp/` artifacts; dead code detected by lint.
- **Dependencies / gating:** independent — foundational-safe-now.
- **Classification:** additive-safe-now.
- **Executor:** devops + doc-steward.

---

## Deferred (2 clusters)

| cluster | uid | reason (one line) |
|---|---|---|
| `adr-0005-policy` | `9b99df00-01ce-4fa1-aa35-47c8b2722c37` | AMB-1 — whether the `IProjectPolicy` knob is obsolete vs C4's no-config-engine + adoption `e54bd58b` joined-project needs one architect decision before it can be scoped. |
| `project-config-surface` | `6ab30778-5d26-49bd-b8f2-85652263996f` | AMB-3 — whether C4's closed-predicate / no-config-engine obsoletes project-scoped config; decide before owning it. |

## Ambiguities absorbed (owner-confirm at target-ADR review)

- **AMB-2** (`graph-store-identity` → S01): this spec *is* the node-kind vocabulary decision; per-kind node identity is subsumed.
- **AMB-4** (`query-semantics` → S03): C7's completeness contract + C2's order view directly cover read-layer limit/score semantics.
- **AMB-5** (defect `9a95be96` `direction:"desc"` → S03): read-layer bug, owned by the read spec, not orthogonal.

## Unclustered survivors (27)

26 attach by home cluster; 1 deferred. Full per-uid list is in `spec-set-mapping.json` (`unclustered`). Attach counts: S03:1 (`983f5971`, gated with `query-semantics`), S04:2 (`2cf61846`,`4a979cef`), S05:3 (`3bd99d24`,`f613472b`,`fa0c8cc6`), S06:4 (`4f0882e3`,`c8b8fb10`,`cc4698c4`,`f78b8692`; `cc4698c4` gated with `catalog-minting`), S07:2 (`8c261906`,`d1ebe470`), S08:1 (`255394d0`), S09:4 (`29ae3faa`,`91f57dc3`,`e29cd816`,`edbb640b`), S10:9 (`025d3239`,`2979eb6a`,`4a41a335`,`51a725c4`,`57c370ce`,`8db42169`,`c3532742`,`dc40a5dc`,`dc92006f`). **Deferred (1):** `eec45b05` — unclustered `decision` item (`HIGH`), no home cluster; resolve at target-ADR review.

## What this document is not

Not an ADR, not a schedule, changes no behavior or code. It is the target the gated implementation program builds toward. Every breaking spec is inert until the owner signs off and a superseding ADR of `adhd ADR-0006` is authored at ship time.
