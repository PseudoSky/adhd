# Packets — backlog surface / registry / registry-data (architect 3)

**Deliverable:** packet set #3. **Author:** architect, 2026-09-22.
**Target branch:** `feat/backlog-hard-replacement` (PR #9), checked out at `.worktrees/backlog-v2`.
**Source specs (both written in the main repo; move onto this branch before dispatch):**
- `entrypoint/backlog/report/registry-surface-redesign.md` — Option A registry verbs (`registry-get`/`-list`/`-upsert`/`-delete` + `lookup`); 8 owner questions. Cited below as **SPEC-REG** §n.
- `entrypoint/backlog/report/citation-component-linking.md` — the `implicates` edge + resolver; 7 owner questions + 2 hard prerequisites. Cited below as **SPEC-LINK** §n.
- `entrypoint/backlog/report/deferral-cleanup-plan.md` — batch/sequence context (L0–L7); cited as **PLAN** §n.

**Domain ownership.** This set owns **surface / registry / registry-data semantics**. Deploy/build
mechanics (frozen-build re-cutover, machine relocation, publish, CI wiring) are owned by the
live/deploy architect; this set contains **no deploy step**. The corpus-hygiene items
`9200ed9e`/`4a3caa9e` are owned here (data semantics) even though the deploy architect may also
list them.

**Constraints every packet inherits (do not restate per-packet):**

1. **ADR-0013 — feature switches are typed config with an explicit default, never env vars.** No
   packet may add a `*_ENABLED` toggle. The governing catalog
   (`/Users/nix/dev/ai/sox-ecosystem/docs/decisions/`, 0001–0020) is **not present in this
   checkout**; the constraints are taken from the two specs' explicit ADR statements: ADR-0010
   (open edge typing — a new rel is a table row, permissive policy), ADR-0012 (parallel-process
   enabled; every write is one `BEGIN IMMEDIATE` tx with bounded retry), ADR-0013 (above),
   ADR-0014 (report-first retention — never auto-delete sidecars/snapshots), ADR-0017 (a
   present-but-empty scope selects **nothing**).
2. **AGENTS.md §7 — live testing.** Every behavioural test runs **by default, unflagged**; drive
   real components; assertions must FAIL if the defect is reintroduced (**each packet names its
   negative control**); key on exit codes, never stdout; deterministic (no sleep); clean up
   `tmp/`. A paid/external service is the *only* valid env gate, and it must be documented in
   README + AGENTS.md + the test header.
3. **Commit hygiene:** the dispatcher commits with `--no-verify`. The packet's Tests are therefore
   **the only gate** — never rely on a pre-commit hook to catch a regression.
4. **Never `--skip-nx-cache`.** Rebuild by changing an input; `npx nx reset` clears deliberately.
5. **The registry is a resolution index.** `registry-get`/`lookup` resolving by name in **one
   call** is the §3a non-negotiable (SPEC-REG §3.5); every surface packet must preserve it.
6. **Never hand-edit `BACKLOG.md`** (a dead artifact on this branch). Transition items via the
   `adhd-backlog` CLI / `mcp__backlog__*`.

**Verification baseline.** `npx nx run backlog:test` (its `test` target `dependsOn: ["build"]`, so
the `api.d.ts` the surface extracts is rebuilt) + `npx nx lint backlog`. Wire tests spawn the real
built bin via `src/test/helpers/spawn-backlog-bin.ts` and key on the child's exit code.

---

## Item status snapshot (queried 2026-09-22 against the live graph, 1748 live items)

| Item | Kind | Status | Packet |
|---|---|---|---|
| `8d5bff19` repo-string fork (CRITICAL) | BUG | **OPEN** | RSD-11 |
| `f429e81f` 26 orphan project identities | bug | **OPEN** | RSD-13 |
| `1d57b8cb` no delete verb for project/component | bug | **OPEN** | RSD-1 |
| `4a19c33e` no hard-delete verb for items | FEAT | **OPEN** | RSD-17 |
| `7a42f8d6` soft-delete, no restore/undelete | DEBT | **OPEN** | RSD-16 |
| `826208d3` auditTrail unreachable for soft-deleted | BUG | **OPEN** | RSD-16 |
| `e7595669` probing CLI writes production | BUG | **SUPERSEDED** | RSD-18 (locate live successor) |
| `4ded6e35` reporter as first-class field | TASK | **OPEN** | RSD-19 |
| `b84169cc` author+reporter as nodes/edges | FEAT | **OPEN** | RSD-19 |
| `56036274` near-dup counter | FEAT | **OPEN** | RSD-20 |
| `6a422302` hierarchical grouping + rollup | FEAT | **OPEN** | RSD-21 |
| `21f08536` backup/snapshot | FEAT | **OPEN** | RSD-24 |
| `6866cba0` plugin system | FEAT | **OPEN** | RSD-23 |
| `8bfa09b4` clustering group-bys | FEAT | **OPEN** | RSD-22 |
| `9200ed9e` status/kind case-splits | bug | **OPEN** | RSD-14 |
| `4a3caa9e` CLI invalid JSON on control chars | bug | **OPEN** | RSD-15 |
| `15432109` hard-delete should be default | BUG | **DUPLICATE** | disposition (folds into RSD-16/17) |
| `642efedb` composite cross-repo graph | FEAT | **SUPERSEDED** | disposition |
| `7a538259` backlog doctor | FEAT | **SUPERSEDED** | disposition |
| `328c600a` update partial-apply | BUG | **SUPERSEDED** | disposition |
| `68f80443` closed-key gate | DEBT | **SUPERSEDED** | disposition |
| `902160e7` MCP return values | DEBT | **SUPERSEDED** | disposition |
| `c2bec25` product brief | — | **NOT FOUND** | disposition |
| 38/40 path-less projects | — | prerequisite | RSD-12 |

No item carries a `plan` (`part_of` edge). `c2bec25` is 7 hex chars and resolves to nothing live
(nor by raw byte scan) — it is not addressable; do not dispatch against it.

---

## Packet index

| Packet | Group | One-line goal | Items | Gate |
|---|---|---|---|---|
| RSD-1 | Registry | Delete verb for project/component/location, refuse-if-referenced | 1d57b8cb | **Q3,Q4** |
| RSD-2 | Registry | Registry input/result types; `get`/`query` become pure issue verbs | SPEC-REG | **Q1** |
| RSD-3 | Registry | Mount `registry-get/-list/-upsert/-delete`; retract registry overloads | SPEC-REG | **Q1,Q2,Q5,Q6,Q7** |
| RSD-4 | Registry | Surface test pins + import-site fanout | SPEC-REG | **Q1** |
| RSD-5 | Linking | Declare the `implicates` edge-kind row | SPEC-LINK | **Q6** |
| RSD-6 | Linking | Linker core: pure prefix matcher + idempotent tx recompute | SPEC-LINK | **Q2,Q3** |
| RSD-7 | Linking | Link on create/transition in the same tx | SPEC-LINK | none |
| RSD-8 | Linking | Query surface: `implicates` filters + overlap axis + card field | SPEC-LINK | **Q1** |
| RSD-9 | Linking | Deterministic backfill tool (path-less projects block) | SPEC-LINK | **Q5** |
| RSD-10 | Linking | Registry delete guard + path-change recompute | SPEC-LINK §7 | **Q4** |
| RSD-11 | Data | Repo-identity fork: canonical slug + alias + reconciliation | 8d5bff19 | **OWNER** |
| RSD-12 | Data | Project identity dedupe + path backfill (unblocks RSD-9) | path-less | **OWNER** |
| RSD-13 | Data | Orphan project-identity component cleanup | f429e81f | **OWNER** |
| RSD-14 | Data | Status/kind case normalization + case-insensitive filters | 9200ed9e | **OWNER** |
| RSD-15 | Data | CLI envelope strict-JSON under control characters | 4a3caa9e | none |
| RSD-16 | Surface | `restore`/undelete + auditTrail reachable for soft-deleted | 7a42f8d6, 826208d3 | **OWNER** |
| RSD-17 | Surface | Hard-delete primitive (admin, gated) | 4a19c33e | **OWNER** |
| RSD-18 | Surface | Gate production writes; first-class scratch path | e7595669 | **OWNER** |
| RSD-19 | Data | Reporter/author first-class provenance | 4ded6e35, b84169cc | **OWNER** |
| RSD-20 | Data | Near-dup counter ticked + surfaced in ranking | 56036274 | none |
| RSD-21 | Data | Hierarchical rollup + evidence-gated terminal transition | 6a422302 | **OWNER** |
| RSD-22 | Data | Clustering group-by query engine | 8bfa09b4 | none |
| RSD-23 | Surface | Backlog plugin system (lifecycle hooks + enrichment) | 6866cba0 | **OWNER** |
| RSD-24 | Data | Backup/snapshot for live stores | 21f08536 | **OWNER** |
| RSD-25 | Docs | Skill + docs for both specs (owns CHANGELOG) | SPEC-REG/LINK | **Q1** |
| RSD-26 | Surface | Retire the `APIGEN_IR_CACHE_ENABLED` env toggle (ADR-0013) | SPEC-REG Q8 | **OWNER** |

**Group key:** Registry = SPEC-REG verb surface · Linking = SPEC-LINK semantics ·
Data = registry-data/identity/provenance · Surface = item-lifecycle & surface safety · Docs.

---

## File-ownership & sequencing (avoid concurrent edits)

| File | Packets | Sequence |
|---|---|---|
| `src/write/catalog.ts` | RSD-1, RSD-5, RSD-10 | RSD-5 → RSD-1 → RSD-10 |
| `src/query/types.ts` | RSD-2, RSD-8, RSD-14 | RSD-2 → RSD-8 → RSD-14 |
| `src/query/query.ts` | RSD-8, RSD-14, RSD-22 | RSD-8 → RSD-14 → RSD-22 |
| `src/api.ts`, `src/server.ts`, `src/index.ts`, `src/cli.ts` | RSD-3, RSD-16, RSD-17, RSD-26 | RSD-3 first |
| `src/write/create-issue.ts`, `transition.ts` | RSD-7 | after RSD-6 |
| `src/write/link-citations.ts` (new) | RSD-6 | — |
| `skill/SKILL.md`, `CHANGELOG.md`, docs | RSD-25 | after RSD-3 + RSD-7 |

`RSD-2` and `RSD-6` are independent and can run in parallel; `RSD-3` gates `RSD-4`/`RSD-25`;
`RSD-6` gates `RSD-7`/`RSD-8`/`RSD-9`/`RSD-10`.

---

## PACKET RSD-1: Registry delete verb — project / component / location
- Goal: a caller can delete a registry project or component (not just a location), with safe
  refuse-if-referenced semantics and `(root)` protection, so `deploy-verify-*` scratch projects
  become removable.
- Scope: `src/write/catalog.ts` — replace the location-only `rmLocation` with
  `deleteRegistryNode(handle, IRegistryDeleteInput)`; new `src/write/registry-delete.spec.ts`.
  Non-goals: **no cascade** (`cascade?: boolean` is a later slice, SPEC-REG §3.4); no hard delete
  (RSD-17); no mounted-verb change (RSD-3 wires the verb).
- Inputs: `1d57b8cb`; SPEC-REG §3.4, §4, §5.2. `rmLocation` today at `catalog.ts:1192-1251`;
  `has_location` is the only rel touching a location (`catalog.ts:1180-1184`).
- Acceptance/DoD: deleting a root-only project succeeds and a subsequent `registry-get` returns
  `not_found`; reopen the store and assert the node is **still** invalidated (durability, not
  timing). Deleting a component with a live `owns_component` or `has_location` edge →
  `precondition_failed` whose message names the blocker ("N live issues, M live locations") **and
  the component is still live** (assert both). Deleting a project with any live non-`(root)`
  component or any live issue → `precondition_failed`. Deleting a `(root)` component →
  `precondition_failed`. **Negative control:** remove the reference guard → the "component with a
  live issue" test goes RED.
- Tests: `npx nx run backlog:test` — new `src/write/registry-delete.spec.ts` against a real store
  (`src/test/helpers/tmp-store.ts`); reopen-store durability assertion. Plus the wire round-trip
  in RSD-4.
- Dependencies: none. If RSD-6/RSD-10 land first, the guard must also count live `implicates`
  edges (RSD-10 owns that edit).
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: the `(root)` invariant is load-bearing for project resolution — verify against
  `upsertProject`'s minting path (`catalog.ts:655-707`). The 26 orphan projects (RSD-13) may hold
  edges that block deletion; RSD-13 sequences after this.
- Decision gates: **SPEC-REG Q3** (refuse-if-referenced vs `cascade:true` now) — recommend
  **refuse-if-referenced**; **SPEC-REG Q4** (`(root)` never deletable) — recommend **yes, never**.

## PACKET RSD-2: Registry input/result types; `get`/`query` collapse
- Goal: the registry's seven input/result types exist and `get`/`query` are typed as pure issue
  verbs, so no caller can address the registry through them.
- Scope: `src/query/types.ts` only. Non-goals: no runtime logic; no `api.ts` change (RSD-3).
- Inputs: SPEC-REG §3.1–3.4, §4. Add `IRegistryGetInput`, `IRegistryListInput`,
  `IRegistryListResult`, `IRegistryUpsertInput`, `IRegistryUpsertOutcome`, `IRegistryDeleteInput`,
  `IRegistryDeleteOutcome`. Remove `IIssueGetRegistryInput` (`types.ts:451-455`); collapse
  `IIssueGetInput` to the uid card (`:469`); drop `'projects'|'components'|'locations'` from
  `IIssueView` (`:254-264`) and the three members from `IIssueQueryResult` (`:378-380`).
- Acceptance/DoD: `npx nx build backlog` type-checks with the registry overloads gone; a
  compile-time probe (a `@ts-expect-error` on `{registry:'project'}` passed to `IIssueGetInput`)
  is present. `IProjectDetail`/`IComponentDetail`/`ILocationDetail`/`ILookupResult` unchanged.
  **Negative control:** re-add `'projects'` to `IIssueView` → the `@ts-expect-error` goes unused
  and `nx build` fails.
- Tests: `npx nx build backlog` (types are the artifact); `src/api.surface.spec.ts` (RSD-4).
- Dependencies: none. Gates RSD-8 (also edits `query/types.ts`).
- Size/tier: **S** · executor hint: typescript
- Risks/unknowns: apigen union-extraction sensitivity — the literal `kind` discriminator is the
  mitigation (`types.ts:483-497`, `BUG-APIGEN-CORE-CLIENT-BARE-NAME-COLLISION-001`). If union
  extraction misbehaves, that is the trigger for **Option B** (RSD-3 gate).
- Decision gates: **SPEC-REG Q1** (Option A vs B) — recommend **A**. This gate blocks the packet:
  Option B changes every type here.

## PACKET RSD-3: Mount the registry verb family; retract the registry overloads
- Goal: `registry-get`, `registry-list`, `registry-upsert`, `registry-delete` are the one
  discovery namespace; `get`/`query` answer issues only; the surface stays at 14 verbs.
- Scope: `src/api.ts` (4 new exports; remove the `get` registry branch `:396-414` and the
  `upsert*`/`rmLocation` exports `:536-570`), `src/server.ts` (`BACKLOG_VERBS` `:193-208`),
  `src/index.ts` (`:24-39`), `src/cli.ts` (delete the `query --help` registry note `:808-818`;
  optional `registry-list --help` note). Non-goals: no test-pin edits (RSD-4); no skill/docs
  (RSD-25).
- Inputs: SPEC-REG §3, §4, §5.1. Delegates to the unchanged `getRegistryDetail`
  (`query/views/registry.ts:162-349`) and `listProjects`/`listComponents`/`listLocations`
  (`:88-148`), and dispatches `registry-upsert` on `input.kind` to the unchanged
  `upsertProjectOp`/`upsertComponentOp`/`upsertLocationOp` (`catalog.ts:696,875,1045`).
  `registry-delete` calls RSD-1's `deleteRegistryNode`.
- Acceptance/DoD: `BACKLOG_VERBS` is exactly the 14 new names; the count stays 14
  (`server.verbs.spec.ts:411` `toBe(14)` unchanged); MCP tools are `backlog_registry_get|_list|_
  upsert|_delete`; `registry-get`/`lookup` resolve **by name in one call** (the §3a
  non-negotiable). **Negative control:** re-mount `upsert-project` → the surface pin goes RED.
- Tests: `npx nx run backlog:test` — `src/api.surface.spec.ts:46-81` (EXPECTED → new 14),
  `src/server.verbs.spec.ts:400-412`, `src/server.mcp.spec.ts:84`,
  `src/server.published-layout.spec.ts:100-101`. Real-binary consumer proof: `registry-get`/
  `lookup` by name against the built `dist/index.js`, keyed on exit code.
- Dependencies: RSD-1 (delete target), RSD-2 (types). Gates RSD-4, RSD-25.
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: `registry-upsert`'s `kind`-discriminated unions are the apigen extraction risk
  (mitigated by the literal discriminator). Direct importers break in the same commit (RSD-4).
- Decision gates: **Q1** (A vs B) · **Q2** (one generic `registry-upsert` vs three typed
  upserts) — recommend **one generic** (14 verbs) · **Q5** (replace `get --registry`/`query
  --view` outright) — recommend **replace** · **Q6** (`lookup` stays top-level) — recommend
  **stays** · **Q7** (hard cut at cutover vs a one-release alias) — recommend **hard cut**, per
  SPEC-v2 §7's no-shim posture.

## PACKET RSD-4: Surface pins + import-site fanout
- Goal: every spec and seed-site that names a registry verb is updated so the suite is green
  against the new surface.
- Scope: `src/api.surface.spec.ts`, `src/server.verbs.spec.ts`, `src/cli-envelope.spec.ts`
  (`:32-34` comment, `:105` seed), `src/search-shortcut-wire.spec.ts:100-125`,
  `src/server.published-layout.spec.ts:100-101`, `src/server.mcp.spec.ts:84`; import sites
  `src/api.semantic-laziness.spec.ts:71-73,196…`, `src/api.semantic-production-seam.spec.ts:77,141…`,
  `src/store/embed-drain-real-model.spec.ts:38`, `src/write/bootstrap.spec.ts:44`. Non-goals: no
  production code change.
- Inputs: SPEC-REG §5.1, §5.2.
- Acceptance/DoD: `npx nx run backlog:test` green with the new 14-verb surface; every seed uses
  `registryUpsert(ctx,{kind:'project',…})` **or** imports `upsertProject` directly from
  `./write/catalog.js` (prefer the direct write-layer import for write-layer tests).
  **Negative control:** revert one seed to `upsert-project` → its spec goes RED.
- Tests: the listed specs, plus `npx nx run backlog:test` full.
- Dependencies: RSD-3.
- Size/tier: **M** · executor hint: test
- Risks/unknowns: mechanical but wide; use `rg` for every `upsert-project`/`rm-location`/
  `--registry`/`view.*projects` occurrence in `src/**/*.spec.ts` before declaring done.
- Decision gates: **Q1** (A vs B) — recommend **A**.

## PACKET RSD-5: Declare the `implicates` edge-kind row
- Goal: the graph accepts an issue→component `implicates` relation, so derived citation links can
  be written without a schema/policy change.
- Scope: `src/write/catalog.ts` `EDGE_KIND_TABLE` (`:311-409`) — add
  `{ rel:'implicates', sourceKind:'issue', targetKind:'component', multiplicity:'n:m' }`.
  Non-goals: `OPEN_TYPE_POLICY` is unchanged (permissive, ADR-0010); no join table.
- Inputs: SPEC-LINK §3.1, §10. `resolveEdgeKindTx` self-heals the row from the table
  (`catalog.ts:452-509`); `writeEdgeTx` already accepts `metadata` (`tx.ts:506-528`).
- Acceptance/DoD: writing an `implicates` edge succeeds without any policy edit; the `edge_kind`
  row is self-healed. **Negative control:** remove the table row → the write of `implicates`
  fails (`unknown rel`) → RED.
- Tests: `npx nx run backlog:test` — extend `src/write/catalog.spec.ts` (or
  `catalog-verbs.spec.ts`) with a self-heal assertion.
- Dependencies: none. Gates RSD-6.
- Size/tier: **S** · executor hint: backend
- Risks/unknowns: shared-store CHECK constraints are closed strings upstream (per `b84169cc`'s
  BL-313 note) — but `resolveEdgeKindTx`'s self-heal is the sanctioned path; do **not** mint a
  rel by an upstream CHECK migration.
- Decision gates: **SPEC-LINK Q6** (direction issue→component vs component→issue) — recommend
  **issue→component** (travels with the issue through body-change supersede).

## PACKET RSD-6: Linker core — pure prefix matcher + idempotent tx recompute
- Goal: a citation's file path deterministically resolves to its owning component(s), and an
  issue's derived `implicates` edges are recomputed idempotently.
- Scope: new `src/write/link-citations.ts` exporting `resolveCitationTargets(canonicalPath, index)`
  (pure) and `recomputeIssueLinksTx(tx, handle, params)` (tx-scoped, delete-then-recompute). New
  `src/write/link-citations.spec.ts`. Non-goals: no hooks (RSD-7), no backfill (RSD-9), no query
  surface (RSD-8).
- Inputs: SPEC-LINK §2 (canonicalization, prefix index, longest-prefix, ambiguity/unresolved
  table), §3.3 (recompute), §10. Prefix index built once per tx from live components/locations/
  projects with `meta.path`.
- Acceptance/DoD: **segment-boundary guard** — prefix `packages/foo` does **not** match
  `packages/foobar/x.ts`; longest prefix wins (a `path` location beats its component); insertion
  order is irrelevant (order-independence pin); `..` normalizes lexically without FS access;
  equal-longest → `ambiguous`, **no** edge; outside every root → `unresolved`, **no** edge, and
  the write still succeeds; recompute twice → identical live edge set. The recompute invalidates
  only edges whose `meta.provenance === 'derived'`. **Negative controls:** drop the `/` guard →
  the boundary test RED; make recompute ignore `provenance` → the "manual `asserted` edge
  survives" test RED.
- Tests: `npx nx run backlog:test` — new `src/write/link-citations.spec.ts` (real store, fixture
  registry). No I/O in the pure function (assert by construction/absence of fs imports).
- Dependencies: RSD-5. Gates RSD-7/8/9/10.
- Size/tier: **L** · executor hint: backend
- Risks/unknowns: auto-upsert's manifest walk (SPEC-LINK §2.4) reads the filesystem and MUST run
  pre-transaction (mirrors `create-issue.ts:932-936`); if that ordering is violated, that is a
  spike. `meta.provenance` is the clobber guard — pin it.
- Decision gates: **SPEC-LINK Q2** (bounded discovery under a registered project root only) —
  recommend **bounded**; **Q3** (a human `upsert-component` on the same `(project,name)` merges
  and clears `metadata.discovered`) — recommend **yes**.

## PACKET RSD-7: Link on create / transition (same transaction)
- Goal: filing or transitioning an issue links its citations to components atomically — no
  post-commit window.
- Scope: `src/write/create-issue.ts` (after citation nodes land, `:928-966`),
  `src/write/transition.ts` (`:520-540`). Non-goals: no registry-change trigger (RSD-10); `move`
  does **not** recompute.
- Inputs: SPEC-LINK §3.4, §6.
- Acceptance/DoD: an issue with three citations across two projects yields three live `implicates`
  edges each carrying the right `via`/`prefix`, all in the same `immediate` tx; unresolved
  citations are non-fatal and the outcome carries `data.linkage = {linked, unresolved:[{file,
  reason}], ambiguous:[{file, candidates}]}`; a body-change supersede carries the edges onto the
  successor with `meta` intact (residual sweep, `update.ts:536-637`). **Negative control:** remove
  the hook call → the cross-project edge test RED.
- Tests: `npx nx run backlog:test` — extend `create-issue.spec.ts` + `transition.spec.ts`; add a
  carry-forward assertion for the new rel (pin `update.ts`'s residual-sweep coverage).
- Dependencies: RSD-6.
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: FS detection must stay pre-transaction; the outcome shape is additive (do not
  change the existing success arm's shape).
- Decision gates: none (SPEC-LINK is explicit).

## PACKET RSD-8: Query surface — `implicates` filters, overlap axis, card field
- Goal: "all open issues touching component X" and "issues spanning projects Y and Z" are one-call
  queries over derived links, without redefining the home-placement filter.
- Scope: `src/query/types.ts` (add `implicatesComponent?`, `implicatesProject?`,
  `implicatesProjects?` to `IIssueFilter`; add `'implicates'` to `IOverlapAxis` and
  `IIssuePseudoField`; add the `implicates?` array to `IIssueCard`), `src/query/query.ts`
  (`queryOverlap` `implicates` branch `:904-968`; filter intersection via
  `resolveEdgeScopedCandidates`), `src/query/resolve.ts`, `src/query/card.ts`. Non-goals: **the
  four existing overlap axes are unchanged**; `filter.component` still means home placement.
- Inputs: SPEC-LINK §5, §10. Direction is read from the `edge_kind` row (`resolve.ts:286-329`),
  so the new rel queries correctly automatically.
- Acceptance/DoD: `filter.implicatesComponent:'X'` + `status:'open'` returns exactly the issues
  with a **derived** edge to X (not those merely placed on X); `implicatesProjects:['Y','Z']` is
  **all-of**; **ADR-0017** — `implicatesProjects: []` returns zero, never the whole store;
  `view:'overlap', overlapAxis:'implicates'` groups a multi-component issue into every group while
  the four existing axes' outputs are byte-identical (regression pin). **Negative control:** make
  `implicatesComponent` fall back to placement → the "not merely placed" assertion RED.
- Tests: `npx nx run backlog:test` — real-store query specs; extend the overlap spec with a
  regression pin on the four existing axes. Consumer proof: real built CLI — create a cross-project
  citation, then `query --input '{"filter":{"implicatesComponent":"…"}}'`, key on exit code.
- Dependencies: RSD-6 (edges must exist), RSD-2 (shares `query/types.ts` — sequence after).
- Size/tier: **L** · executor hint: backend
- Risks/unknowns: candidate-set intersection for `implicatesProjects` is the all-of subtlety;
  pin it with a disjoint-project negative.
- Decision gates: **SPEC-LINK Q1** (add `implicatesComponent` vs extend `filter.component`) —
  recommend **add**.

## PACKET RSD-9: Link backfill tool
- Goal: existing citations get derived links deterministically, and a path-less project with
  citations **blocks** the run rather than silently producing zero links.
- Scope: new `entrypoint/backlog/tools/recompute-links.ts` + an nx target in `project.json`.
  Non-goals: **not a mounted verb** (the surface stays 14; ETL/`tools/` is the house pattern).
- Inputs: SPEC-LINK §4. ~1,700 items (PLAN read 1701); prefix index built once and reused.
- Acceptance/DoD: run twice on a fixture store → byte-identical edge set; iterate live issues
  ordered by `rowid`, one tx per bounded batch; output `{issues, edgesWritten, edgesInvalidated,
  unresolved:[…], ambiguous:[…], pathlessProjects:[…]}`; exit **non-zero** if any project that
  owns citations is path-less. **Negative control:** revert the path-less check → the blocking
  test RED.
- Tests: `npx nx run backlog:test` — new `src/write/link-backfill.spec.ts` (real fixture store,
  run the tool twice, assert byte-identical). Exit-code keyed.
- Dependencies: RSD-6; **RSD-12 is a hard prerequisite** (path-less projects make the backfill a
  no-op); RSD-11 (repo fork) is the other hard prerequisite.
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: the backfill bakes in whatever project identity exists at run time — running it
  before RSD-11/RSD-12 fragments every derived link. **Do not dispatch before both land.**
- Decision gates: **SPEC-LINK Q5** (path-less project fails the backfill vs warns) — recommend
  **fail**.

## PACKET RSD-10: Registry-delete `implicates` guard + path-change recompute
- Goal: deleting a component cannot strand derived edges, and moving a component's path
  recomputes the affected issues' links.
- Scope: `src/write/catalog.ts` (RSD-1's guard adds live `implicates` to its blocker count; the
  `registry-upsert` path write schedules a targeted recompute). Non-goals: no new verb.
- Inputs: SPEC-LINK §7(b),(c), §3.5.
- Acceptance/DoD: deleting a component with live derived `implicates` edges → `precondition_failed`
  naming them; a component `path` upsert recomputes every distinct owning issue whose citations
  fall under the old or new prefix (assert the moved-package case). **Negative control:** drop the
  `implicates` count from the guard → the "component with derived links" delete succeeds → RED.
- Tests: `npx nx run backlog:test` — extend `registry-delete.spec.ts` and the RSD-6 spec.
- Dependencies: RSD-1, RSD-6.
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: the path-change query must match citations under **both** old and new prefixes,
  or a moved package silently strands edges — the trigger designs commonly forget.
- Decision gates: **SPEC-LINK Q4** (refuse vs cascade-invalidate on `implicates`) — recommend
  **refuse** (consistent with RSD-1's safe default).

## PACKET RSD-11: Repo-identity fork — canonical slug + alias + reconciliation
- Goal: one logical repo is one repo identity, so a repo-scoped query or dedupe scan sees the
  whole corpus instead of a silent half.
- Scope: the repo-string resolution/write path (repo is resolved at create from session context —
  locate the resolver in `src/`; `env.ts` documents the environment cascade), a canonical-slug +
  alias mapping, and a one-off reconciliation tool (report-first). Non-goals: **not** the
  repo→first-class-node promotion (that is `FEAT-BACKLOG-011` ask #3, a separate slice); no
  humanId collision auto-merge.
- Inputs: `8d5bff19` (CRITICAL). Measured current split: **sox-ecosystem 733 vs
  PseudoSky/sox-ecosystem 0; claude-tools 55 vs QuSecure/claude-tools 17; dot 1 vs id8/dot 2**;
  the item body's original `adhd 52 / PseudoSky/adhd 348`. Both fixes the item names: (a) data
  reconciliation, (b) schema normalization to stop recurrence.
- Acceptance/DoD: after reconciliation, `stats.byRepo` reports **one** entry per logical repo; a
  dedupe scan with a repo filter sees the whole corpus; writing both `adhd` and `PseudoSky/adhd`
  lands the same canonical value. The reconciliation tool detects humanId collisions across the
  merged sets **before** moving anything and escalates them (never silently merges). **Negative
  control:** revert write-time normalization → a fresh fork reappears and the byRepo test RED.
- Tests: `npx nx run backlog:test` — a normalization unit test (both spellings → one canonical
  value) + a reconciliation test on a fixture store with a collision, asserting escalation, not
  merge. Exit-code keyed.
- Dependencies: none. Gates RSD-9 (hard prerequisite).
- Size/tier: **L** · executor hint: backend
- Risks/unknowns: **destructive data write** — report-first per ADR-0014 and owner-gated;
  humanId collisions are a real hazard (`BUG-BACKLOG-HUMANID-COLLISION`). The alias table's
  source of truth (git remotes) must be captured before any move.
- Decision gates: **OWNER** — schema shape: normalize-on-write + alias table **now** (recommend,
  bounded, no store migration) vs repo→node promotion (defer to `FEAT-BACKLOG-011`); and approval
  for the destructive reconciliation.

## PACKET RSD-12: Project identity dedupe + path backfill
- Goal: every project that owns citations has `meta.path`, and duplicate project identities
  collapse to one row — the precondition that makes linking resolvable at all.
- Scope: a report-first `tools/` reconciliation + the path-setting path (direct write-layer
  `upsertProject`, or `registry-upsert {kind:'project', path}`). Non-goals: no citation linking
  (RSD-9 consumes this).
- Inputs: SPEC-LINK §4.1; PLAN:56 records **38/40 projects are path-less**; `8d5bff19`'s duplicate
  identities (`sox-ecosystem` vs `PseudoSky/sox-ecosystem`, etc.); `projectHasKnownPath`
  (`catalog.ts:603-628`) already reads `project.metadata.path`.
- Acceptance/DoD: a report enumerates every project that owns citations but has no path; after
  backfill, that set is empty; RSD-9's blocking condition fires while any remain. Duplicate
  identities each collapse to one row (shared with RSD-11). **Negative control:** leave one
  citation-owning project path-less → RSD-9 exits non-zero → RED.
- Tests: `npx nx run backlog:test` — a fixture-store test asserting the path-less report and that
  `projectHasKnownPath` flips after the backfill.
- Dependencies: RSD-11 (shared identity reconciliation). Gates RSD-9 (hard prerequisite).
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: the **path source** is an owner input — where do 38 project roots come from?
  Derive from the workspace index / git remote where possible; escalate unresolvable ones rather
  than guessing. A wrong path is worse than a missing one (it mislinks).
- Decision gates: **OWNER** — confirm the path-derivation source and approve the reconciliation
  (report-first, ADR-0014).

## PACKET RSD-13: Orphan project-identity component cleanup
- Goal: no live component references a project UID absent from `view:projects`.
- Scope: a report-first cleanup using RSD-1's component delete; enumerate via `registry-list`.
  Non-goals: no hard delete; no item changes.
- Inputs: `f429e81f` — 26 project UIDs referenced by components are absent from `view:projects`
  (soft-invalidated test-project nodes); their `(root)` components are still live, and one carries
  a live non-root component `packages/domain/my-package` (`a3e60ff7`, 0 items).
- Acceptance/DoD: after cleanup, a scan reports **0** components referencing an absent project
  UID; the report names each component and its project before deleting. **Negative control:** a
  component whose project **is** live must not be touched (assert it survives).
- Tests: `npx nx run backlog:test` — a fixture-store test with one orphan and one live-parent
  component; assert exactly the orphan is invalidated.
- Dependencies: RSD-1 (component delete), RSD-3 (enumerate). 
- Size/tier: **S** · executor hint: backend
- Risks/unknowns: **destructive** — report-first, owner-gated; some orphans may hold live edges
  (RSD-1 refuses, which is correct — escalate those).
- Decision gates: **OWNER** — approve the destructive cleanup (report-first, ADR-0014).

## PACKET RSD-14: Status/kind case normalization + case-insensitive filters
- Goal: a filter on `status`/`kind` matches the whole corpus regardless of the casing a writer
  generation used.
- Scope: write-path canonicalization for status/kind + a one-off normalization pass + filter
  semantics in `src/query/query.ts` (and `query/views/stats.ts`). Non-goals: no status-semantics
  change.
- Inputs: `9200ed9e` — the store holds `OPEN` 139 vs `open` 49, and `BUG`/`bug`, `DEBT`/`debt`,
  `FEAT`/`feature`; filters are case-sensitive. (`resolve.ts:398` already lowercases for
  distance — evidence the codebase treats these as case-insensitive in places.)
- Acceptance/DoD: after normalization the store holds one casing; `kind:'bug'` and `kind:'BUG'`
  return identical sets; a `status` filter matches the whole corpus. **Negative control:**
  reintroduce a mixed-case row → the filter-parity test RED.
- Tests: `npx nx run backlog:test` — a fixture store with both casings; assert set equality
  across casings and one canonical casing after the pass.
- Dependencies: none. Coordinates with RSD-2/RSD-8 (shares `query/types.ts`) and RSD-8 (shares
  `query/query.ts`) — sequence after RSD-8.
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: `6a422302`'s evidence shows four items shipped `RESOLVED` while still broken and
  ~125 closed items never audited — a casing rewrite must not change **meaning**, only spelling.
  Pin the count of open/closed before and after.
- Decision gates: **OWNER** — normalize the data, make filters case-insensitive, or both?
  Recommend **both** (canonicalize on write + case-insensitive read as defense).

## PACKET RSD-15: CLI envelope strict-JSON under control characters
- Goal: every CLI envelope parses under a strict JSON consumer (`jq`, an MCP client) even when a
  body contains a raw control character.
- Scope: the CLI envelope serialization path (locate by reproduction — likely a non-`JSON.stringify`
  output branch in `src/cli.ts` or the CLI-output plugin). Non-goals: no body-content rewriting.
- Inputs: `4a3caa9e` — ~15% of sox-ecosystem component responses were unparseable by `jq`; the
  envelope "does not escape raw control characters". Note `JSON.stringify` **does** escape control
  chars, so the fault is in a path that does not use it (or emits a lone surrogate) — **reproduce
  first**.
- Acceptance/DoD: write an item whose body contains a raw control char (`\u0000`/`\u001b`); the
  CLI's stdout parses under `jq` and round-trips the body. **Negative control:** revert the fix →
  `jq` exits non-zero on the same body → RED.
- Tests: `npx nx run backlog:test` — a wire test spawning the real built bin, piping stdout to a
  strict parser (key on exit code); the raw capture from the item's scan dir is a fixture seed.
- Dependencies: none.
- Size/tier: **S/M** · executor hint: debug
- Risks/unknowns: **spike first** — if reproduction shows the fault is in a shared apigen
  serializer (not backlog-local), the fix moves to `packages/apigen/apigen-plugin-cli-output` and
  the packet must be re-scoped/escalated. Do not assert a mechanism without reproducing it.
- Decision gates: none.

## PACKET RSD-16: `restore`/undelete + auditTrail for soft-deleted items
- Goal: a soft-delete is reversible in-place, and an item's audit trail stays reachable after
  deletion.
- Scope: a write-layer restore (mirror `write/delete.ts` in reverse: `t_invalid = NULL`, strip
  `invalidatedReason`/`invalidatedAt` from `meta`, one `immediate` tx, audit `action:'restored'`);
  an entry point for it; `auditTrail` lookup tolerant of an invalidated node
  (`store/query.ts:362-364` `findItemNode` throws today). Non-goals: no hard delete (RSD-17).
- Inputs: `7a42f8d6` (recovery required a raw `UPDATE … SET t_invalid = NULL` against the live
  store); `826208d3` (audit events persist in `BACKLOG_AUDIT_EVENT_TAG` nodes, but `auditTrail`
  resolves the live node first and throws; `markdown.ts:306` documents the unreachable
  capability). `15432109` is the DUPLICATE arguing hard-delete-default — folded here + RSD-17.
- Acceptance/DoD: delete then restore → the item is live again, `meta` no longer carries the
  invalidation keys, audit records `action:'restored'`; `auditTrail` on a soft-deleted item
  returns its deletion event (query events by repo+humanId via the event nodes, not via
  `findItemNode`). **Negative control:** revert the restore → the delete→restore round-trip RED;
  revert the auditTrail tolerance → the soft-deleted auditTrail test RED.
- Tests: `npx nx run backlog:test` — real-store `delete.spec.ts` extension + a command-level
  auditTrail test (soft-delete, then assert the trail still returns).
- Dependencies: none. **Conflicts with RSD-3 on `src/api.ts`/`server.ts`** if `restore` is mounted
  as a verb — see the gate.
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: mounting `restore` as a 15th verb breaks SPEC-REG's 14-verb pin and its tests.
  Resolve with RSD-3's surface decision before dispatch.
- Decision gates: **OWNER** — `restore` as a **first-class verb** (surface becomes 15) or an
  **admin action** (surface stays 14)? Recommend **admin action `restore`** to preserve the pin,
  unless the owner deliberately accepts 15.

## PACKET RSD-17: Hard-delete primitive (gated admin action)
- Goal: an agent can permanently remove its own mis-filed/duplicate item, gated so it can never
  erase something others built on.
- Scope: a new write-layer `hardDeleteItemNode` (row DELETE of the node + edges + citations);
  exposed as an **admin action** `hard_delete` (dry-run by default; `confirm:true` + `by` +
  non-empty `reason` to write; refuse when a live item still has an inbound edge, surfaced in the
  dry-run). Non-goals: **not** flipping the default delete to hard (that is `15432109`, contingent
  on this + auto-prune).
- Inputs: `4a19c33e` (verified: no hard-delete primitive at any layer; `admin.prune` only
  soft-invalidates; `renameHumanIdNode` exists but is unwired — expose rename separately if the
  owner wants it). `15432109` (DUPLICATE) states the dependency explicitly.
- Acceptance/DoD: `hard_delete` on a referenced item → refused with the blocker named, item still
  resolvable; on an already-soft-deleted item (or one created in a short recent window with zero
  citations/relations/claims from others) → the row is gone (reopen the store; not resolvable even
  with `includeDeleted`); `computeNextHumanId` may re-mint. **Negative control:** revert the
  inbound-edge refusal → the referenced-item test RED.
- Tests: `npx nx run backlog:test` — real-store test with reopen-durability; a dry-run test
  asserting no row change.
- Dependencies: RSD-16 (restore is the non-destructive companion).
- Size/tier: **L** · executor hint: backend
- Risks/unknowns: id re-minting guards (`computeNextHumanId`); shared-store CHECK constraints
  (per `b84169cc`'s BL-313 note) — do not migrate the shared store. **Destructive** → owner-gated.
- Decision gates: **OWNER** — hard-delete as an **explicit admin primitive only** (recommend) vs
  `15432109`'s hard-delete-by-default; the item's own condition is that the default flips only
  once restore **and** automatic pruning exist.

## PACKET RSD-18: Gate production writes; first-class scratch path
- Goal: an agent probing the CLI cannot silently pollute the production store, and the correct
  throwaway path is documented.
- Scope: the repo-slug resolution gate (refuse a write whose repo does not resolve to a real git
  remote unless an explicit opt-in flag is passed — turning the incidental `repoWarning` into a
  gate); a documented `--sandbox`/scratch recipe in `skill/SKILL.md`; ensure soft-deleted probe
  rows are removable (prune target). Non-goals: the contamination **cleanup** itself (destructive
  — live/deploy architect's lane).
- Inputs: `e7595669` (**SUPERSEDED** — locate the live successor before dispatch; the related
  `53eb67a7` "active production contamination" is IN_PROGRESS). Three pollution incidents in one
  session; `env.ts` documents `production` as the default namespace and `sandbox` as the
  throwaway-by-construction namespace.
- Acceptance/DoD: a write to an unresolvable repo without the opt-in flag is refused; the scratch
  recipe appears in the skill; soft-deleted probe rows are removable. **Negative control:** revert
  the gate → the unresolvable-repo write succeeds → RED.
- Tests: `npx nx run backlog:test` — a wire test spawning the real bin with a bogus repo slug,
  asserting a non-zero exit and **no** new row in a sandbox store.
- Dependencies: none. **Note the worktree AGENTS.md** documents the bin rename `backlog` →
  `adhd-backlog`; the skill/CLI help must use the new name.
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: the gate could break legitimate new-repo filing — hence the explicit opt-in
  (a **typed config / CLI flag**, never an env toggle, per ADR-0013). Confirm the live successor
  uid; `e7595669` is not dispatchable as-is.
- Decision gates: **OWNER** — gate new-repo writes (with an explicit opt-in) vs scratch-mode only?
  Recommend **gate + document scratch**.

## PACKET RSD-19: Reporter / author as first-class provenance
- Goal: every item records who wanted it and who wrote it up, queryable and aggregate-by-reporter
  across the repo fork.
- Scope: the item write path + query filter (`filter.reportedBy`/`filter.authoredBy`); model as
  **`kind:'entity'` nodes + a distinguishing tag + the existing `ASSIGNED_TO` rel** (the
  `structure.ts:177,199` precedent for plans/assignees). Non-goals: **do not mint a new edge rel**
  (closed upstream CHECK constraints; BL-313 data-loss incident; BL-295 reverted attempt) — if a
  new rel seems unavoidable, **stop and escalate**.
- Inputs: `4ded6e35` (reporter auto-derived from session/transport context, with an explicit `by`
  still accepted for CLI callers); `b84169cc` (`author` and `reporter` are **separate** and
  **both required**; aggregate by reporter; the human-requested distinction).
- Acceptance/DoD: through the real surface, create an item without `author`/`reporter` → rejected;
  create with both → one query returns every item for that reporter **including across the
  adhd/PseudoSky/adhd fork** (depends on RSD-11). **Negative control:** relax the requirement →
  the rejection test RED. A type-only assertion is not acceptable.
- Tests: `npx nx run backlog:test` — real-store MCP/CLI test; the cross-fork aggregate test.
- Dependencies: RSD-11 (the cross-fork acceptance criterion).
- Size/tier: **L** · executor hint: backend
- Risks/unknowns: making both required is a breaking change for ~239 existing open items — the
  backfill decision matters (a fabricated author is worse than an absent one).
- Decision gates: **OWNER** — required-for-all vs new-writes-only; backfill sentinel
  (`legacy-import`) vs infer-from-earliest-audit-`by`; recommend **both required on new writes**,
  backfill `legacy-import` sentinel (never fabricate).

## PACKET RSD-20: Near-duplicate counter
- Goal: an item that keeps being re-filed rises in ranking, so demand signal accumulates on the
  item instead of vanishing.
- Scope: `createItem`'s dedupe scan (`crud.ts` `dedupeScan` — locate in the v2 write path) ticks
  `metadata.dupeHits` on the matched existing item when the filer proceeds; surface it in ranking.
  Non-goals: no semantic matching yet (FTS first; upgrade later per `RAG-SPEC.md`).
- Inputs: `56036274` (operator-requested). Constraints: counter lives on the existing item's
  metadata (no caller break); idempotent under the CAS claim protocol; must not fire when
  `dedupeScan` opt-outs suppress the candidate path.
- Acceptance/DoD: create A; attempt near-dup B → B is flagged **and** A's counter increments by
  exactly 1; a second identical attempt does not double-count; a ranking/spotlight query surfaces A
  above an equivalent non-duplicated item. **Negative control:** remove the increment → the
  counter test RED.
- Tests: `npx nx run backlog:test` — real-store test incl. a concurrent-increment (CAS) case using
  a latch, not sleep.
- Dependencies: none.
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: CAS lost-update on concurrent `createItem` — prove with a deterministic
  latch/barrier.
- Decision gates: none (the item specifies acceptance).

## PACKET RSD-21: Hierarchical grouping — two-axis rollup + evidence-gated transitions
- Goal: a parent item reports its children's rollup on read, and terminal transitions are gated by
  evidence — so consumers stop rebuilding a planning layer in markdown.
- Scope: read-time rollup on the parent card (`{childrenTotal, childrenClosed, childrenOpen,
  selfVerified}`); a per-repo opt-in evidence gate on terminal transitions (typed error, status
  unchanged on re-read); file-overlap pairing. **Decomposes into three independently dispatchable
  stages** (rollup / evidence gate / overlap) — split at dispatch.
- Inputs: `6a422302` (acceptance criteria Stages 1–3 + migration, verbatim in the item body);
  `sox-ecosystem`'s `PLAN.md`/`plan-status.mjs` as the parity oracle (85 packets; migration must
  match item-by-item with a named diff on mismatch). Related open: `c6d35272` (citation gate for
  out-of-repo evidence).
- Acceptance/DoD (Stage 1): parent with 3 children, close 2 → `childrenClosed: 2`,
  `childrenOpen: [two ids]`; close the third → `3`, `selfVerified` still `false`; add a citation
  and transition the parent → `selfVerified: true`; closing a child changes the parent's reported
  rollup with **no write to the parent**. (Stage 2): zero-citation terminal transition → typed
  error, status unchanged on re-read; add a citation, retry → succeeds; the gate is per-repo
  opt-in and a repo without it is unaffected. (Stage 3): overlapping `files` → reported as a pair;
  disjoint → not reported; no filesystem access. **Negative control:** remove the read-time
  computation (write the rollup) → the "no write to the parent" assertion RED.
- Tests: `npx nx run backlog:test` — per-stage real-store tests; the 85-packet migration parity
  test against `plan-status.mjs`'s derived status.
- Dependencies: none, but it is a large feature — schedule after the registry/linking core.
- Size/tier: **L** (×3 stages) · executor hint: backend
- Risks/unknowns: the item explicitly **refuses** to absorb a dispatch methodology — hold that
  line. The evidence gate is per-repo typed config (ADR-0013), never an env toggle.
- Decision gates: **OWNER** — is this in the current wave? Recommend **defer to a later wave**
  and split into three packets at dispatch.

## PACKET RSD-22: Clustering group-by query engine
- Goal: dimensional questions ("which packages have the most open bugs?", "which files are cited
  by the most items?") are one query, not an ad-hoc scan.
- Scope: a `query` group-by operation combining filters, group-by dimensions, aggregations, sort,
  and output formats. Non-goals: no new storage.
- Inputs: `8bfa09b4` (filter dimensions, group-by dimensions, aggregations, examples). Depends on
  the structured fields from `FEAT-BACKLOG-004` (decomposed humanId, repo-as-node, citation file
  paths) — `RSD-11` is the repo-identity part of that dependency.
- Acceptance/DoD: each worked example in the item returns the expected shape (`grouped by
  priority`, `grouped by component as count`, etc.); `count-only` and `list-of-ids` output modes
  exist. **Negative control:** a group-by on a dimension with a filter that selects nothing
  returns zero groups, never the whole store (ADR-0017).
- Tests: `npx nx run backlog:test` — real-store query specs mirroring the item's examples.
- Dependencies: RSD-11 (repo as a structured identity).
- Size/tier: **L** · executor hint: backend
- Risks/unknowns: overlaps the `query` surface — coordinate with RSD-8/RSD-14 on `query.ts`.
- Decision gates: none (the item specifies the surface).

## PACKET RSD-23: Backlog plugin system
- Goal: lifecycle events and enrichment hooks are pluggable, so external consumers can react
  without forking the write path.
- Scope: a minimal `Plugin` interface (name, hooks map, init/shutdown) + a `PluginRegistry` the
  write ops call at named points (`onItemCreated`, `onItemTransitioned`, `onItemClaimed/Released`,
  `onItemUpdated`, `onItemResolved`, `onDependencyAdded/Removed`). Plugins are async, non-blocking,
  each in its own try/catch, ordered and configurable per event; config lives in the graph store.
  Reuse the `@adhd/agent-base-types` `HookRegistry`/`PluginFactory` pattern rather than inventing
  one. Non-goals: no external notifications in the first slice.
- Inputs: `6866cba0`; `@adhd/agent-plugin-budget` as the reference implementation.
- Acceptance/DoD: a registered plugin observes each lifecycle event exactly once per write; a
  throwing plugin does not fail or slow the primary write; plugin order is deterministic and
  configurable. **Negative control:** make the registry call a plugin synchronously on the write
  path → the "primary write latency unaffected" assertion RED.
- Tests: `npx nx run backlog:test` — real-store write with a probe plugin asserting the event
  sequence; a throwing-plugin isolation test.
- Dependencies: none.
- Size/tier: **L** · executor hint: backend
- Risks/unknowns: "non-blocking" must be proven, not asserted (a bounded-latch test, no sleep).
  Plugin config in the graph store must respect ADR-0012 concurrent writes.
- Decision gates: **OWNER** — is a plugin system wanted now (the item itself says MEDIUM; the
  flat model is functional)? Recommend **defer** until an external consumer exists.

## PACKET RSD-24: Backup / snapshot for live stores
- Goal: the shared, live-mutated backlog store has a point-in-time snapshot and a restore path, so
  a bad repair or migration has a cheap rollback.
- Scope: periodic SQLite-level snapshot (`VACUUM INTO` or a WAL-consistent file copy), a retention
  policy (report-first per ADR-0014 — never auto-delete), a `snapshotBeforeRepair()` helper, and a
  restore procedure/subcommand. Non-goals: deploy scheduling (live/deploy architect's lane).
- Inputs: `21f08536` (motivated by `BUG-BACKLOG-HUMANID-COLLISION` and a destructive repair script
  run against the live store). Must be compatible with WAL + `busy_timeout` (`DESIGN.md` §3) and
  the CAS claim protocol (`DESIGN.md` §4). Store location varies by env scope
  (`@adhd/environment`); a snapshot that covers only one scope misses the shared-store risk.
- Acceptance/DoD: snapshot a live store under a concurrent writer (bounded latch), restore it, and
  read back a known row; retention never deletes without a report. **Negative control:** take the
  snapshot without a WAL-consistent read → the concurrent-writer test RED (torn read).
- Tests: `npx nx run backlog:test` — real-store snapshot/restore with a concurrent writer; assert
  the restored file opens and resolves.
- Dependencies: none.
- Size/tier: **M** · executor hint: backend
- Risks/unknowns: restore under concurrent writers may need an advisory lock / brief offline
  window — **that design is a spike**. Snapshots belong under `tmp/` or a gitignored backup root,
  never tracked.
- Decision gates: **OWNER** — is snapshotting in this wave, and does it generalize beyond the
  backlog store (registry DBs, memory DB)? Recommend a backlog-local snapshot first.

## PACKET RSD-25: Skill + docs for both specs (owns CHANGELOG)
- Goal: the shipped skill, spec docs, and changelog describe the new surface and semantics, in
  lockstep with the binary.
- Scope: `skill/SKILL.md` (§1 command table, §1 `--help` excerpt, §2 MCP tool names, §4 registry
  section, §5 batch note, plus the "Citations drive linking" subsection and the amended "No other
  component is ever auto-created"); `SPEC-v2.md` §3a/§4c/§6.3/§6.7/AC-21; `README.md:51-59`;
  `DESIGN.md:92-99,287-288`; `DATA_MODEL.md` §3/§5 (the `implicates` row + provenance);
  `CHANGELOG.md`. **This packet owns `CHANGELOG.md`** — no other packet edits it.
- Inputs: SPEC-REG §5.3/§5.4; SPEC-LINK §8. Redeploy is part of the change: rebuild →
  `adhd-backlog install-skill --host all --scope user` (and `--scope project` where pinned), or
  the binary/skill divergence the owner already sees recurs.
- Acceptance/DoD: the installed skill documents exactly the 14 shipped verbs; every verb it names
  resolves; `DATA_MODEL.md` carries the `implicates` row; CHANGELOG has one entry per surface
  change. **Negative control:** an `rg` audit finds no `upsert-project`/`rm-location`/`upsert-
  component` in the shipped skill or README.
- Tests: `src/install-skill-usage.spec.ts`, `src/install.spec.ts`, `src/install.published-layout.
  spec.ts`; the `rg` audit above (exit-code keyed where a script is used).
- Dependencies: RSD-3, RSD-7.
- Size/tier: **M** · executor hint: refactor
- Risks/unknowns: the skill is versioned in lockstep with the built `dist/` (`install-skill.ts:101-
  106,242-248`) — a stale skill is a shipped defect. Note the bin rename `backlog` → `adhd-backlog`
  (worktree AGENTS.md).
- Decision gates: **Q1** (A vs B) — recommend **A**.

## PACKET RSD-26: Retire the `APIGEN_IR_CACHE_ENABLED` env toggle
- Goal: the one remaining env-var feature switch in the surface is replaced by typed config, so the
  surface complies with ADR-0013.
- Scope: `src/server.ts:541-543` — replace the `APIGEN_IR_CACHE_ENABLED` kill-switch with a typed
  config field (explicit default, no env gate). Non-goals: no behavior change beyond the switch's
  retirement.
- Inputs: SPEC-REG §6 Q8 (flagged as a pre-existing deviation, out of the redesign's scope but to
  be filed and fixed separately). ADR-0013.
- Acceptance/DoD: no `*_ENABLED` env read remains in `server.ts`; the IR cache's on/off is a typed
  config value with an explicit default; an `rg` for `APIGEN_IR_CACHE_ENABLED` returns nothing.
  **Negative control:** reintroduce the env read → the `rg` audit RED.
- Tests: `npx nx run backlog:test` — an env/config spec asserting the typed field controls the
  cache and no env var does.
- Dependencies: none.
- Size/tier: **S** · executor hint: typescript
- Risks/unknowns: the env var may be used by external tooling/tests — check `rg
  APIGEN_IR_CACHE_ENABLED` across the repo before removing (the cache file itself has a separate
  `APIGEN_IR_CACHE_FILE` escape hatch used by tests, which is a path config, not a feature toggle
  — legitimate).
- Decision gates: **OWNER** — confirm this is tracked/fixed now (SPEC-REG Q8) — recommend **yes**.

---

## Dispositions (not dispatchable packets)

These items are closed/duplicated/unaddressable in the live graph. **Transition them via
`adhd-backlog`, never by editing `BACKLOG.md`.** Each needs a verified live successor before any
close.

| Item | Status | Disposition |
|---|---|---|
| `15432109` | DUPLICATE | Folds into RSD-16 (restore) + RSD-17 (hard delete). Its stated condition — flip to hard-delete-default only once restore **and** auto-prune exist — is exactly the RSD-16/17 ordering. Cross-link, do not implement separately. |
| `642efedb` composite cross-repo graph | SUPERSEDED | Superseded by the composite-store work (`FEAT-SOX-002`); this item is the backlog-side consumer. Confirm the live successor and close with a cross-link; no backlog-side packet. |
| `7a538259` backlog doctor | SUPERSEDED | Superseded; the integrity checks may now live in a successor. Confirm the successor before closing. If the successor is open, re-file as a packet then. |
| `328c600a` update partial-apply | SUPERSEDED | The **defect is real** (a `precondition_failed` still commits the `addNote`). Locate the live successor; if the successor does not already fix atomicity, file a packet: validate the terminal-transition precondition **before** committing any field. Related open: `fce03d93`. |
| `68f80443` closed-key gate | SUPERSEDED | Defense-in-depth gap (no live CLI-observable accept-and-ignore). Confirm the successor; if open, a small packet adding `assertKnownCreateKeys`/`assertKnownRelateKeys`/admin top-level check mirrors `assertKnownUpdateKeys`. |
| `902160e7` MCP return values | SUPERSEDED | `link_related` returning `null` for success and failure alike. Confirm the successor; if open, a small packet returning `{ok:true}`/the edge. |
| `e7595669` probing writes production | SUPERSEDED | Its fix is RSD-18. Locate the live successor; if RSD-18's gate is the successor's ask, cross-link and implement via RSD-18. |
| `c2bec25` product brief | NOT FOUND | 7 hex chars; no live uid, no raw-store match. Not addressable. Ask the requester for the full uid or a title; do not dispatch. |

---

## Cross-architect seams

- **Live/deploy architect** owns: the frozen-build re-cutover, machine relocation, sox publishes,
  CI wiring (PLAN L0/L1/L2/L5), and the destructive contamination **cleanup** (`53eb67a7`,
  `e9a094be`). This set owns the surface semantics around it (RSD-18's **gate**, not the cleanup).
- **`registry-surface-redesign` seam (SPEC-REG §7 / SPEC-LINK §7):** RSD-3 owns the verb shapes;
  RSD-6 owns the semantics. They touch at RSD-10 (the delete guard must count `implicates`).
- **14-verb pin tension:** RSD-16 (`restore`) and RSD-17 (`hard_delete`) must NOT silently grow
  the mounted surface past 14. Resolve via admin actions (recommended) or an explicit owner
  acceptance of 15 verbs — before RSD-3 freezes `BACKLOG_VERBS`.
- **`query/types.ts` contention:** RSD-2, RSD-8, RSD-14 all edit it. Sequence RSD-2 → RSD-8 →
  RSD-14, or serialize on that file.

## Decision gates summary (owner input required before dispatch)

| Gate | Packets | Question | Recommendation |
|---|---|---|---|
| SPEC-REG Q1 | RSD-2/3/4/25 | Option A (kind-discriminated, 14 verbs) vs B (per-kind typed, ~18) | **A** |
| SPEC-REG Q2 | RSD-3 | One generic `registry-upsert` vs three typed upserts | **one generic** |
| SPEC-REG Q3 | RSD-1 | Refuse-if-referenced vs `cascade:true` now | **refuse** |
| SPEC-REG Q4 | RSD-1 | `(root)` never deletable | **yes** |
| SPEC-REG Q5 | RSD-3 | Replace `get --registry`/`query --view` outright | **replace** |
| SPEC-REG Q6 | RSD-3 | `lookup` stays a top-level verb | **stays** |
| SPEC-REG Q7 | RSD-3 | Hard cut vs a one-release alias | **hard cut** |
| SPEC-REG Q8 | RSD-26 | Retire `APIGEN_IR_CACHE_ENABLED` now | **yes** |
| SPEC-LINK Q1 | RSD-8 | Add `implicatesComponent` vs extend `filter.component` | **add** |
| SPEC-LINK Q2 | RSD-6 | Bounded auto-discovery (registered root only) | **bounded** |
| SPEC-LINK Q3 | RSD-6 | Human upsert merges + clears `metadata.discovered` | **yes** |
| SPEC-LINK Q4 | RSD-10 | Refuse vs cascade-invalidate `implicates` on delete | **refuse** |
| SPEC-LINK Q5 | RSD-9 | Path-less project fails vs warns | **fail** |
| SPEC-LINK Q6 | RSD-5 | `implicates` direction issue→component | **issue→component** |
| SPEC-LINK Q7 | — | Manual-assert verb | **out of scope** (field defined, verb not built) |
| OWNER ×11 | RSD-11/12/13/14/16/17/18/19/21/23/24 | Schema shapes, destructive approvals, wave inclusion | see each packet |

**Hard prerequisites for the linking backfill (RSD-9): RSD-11 and RSD-12 must land first** — the
repo fork must collapse and path-less projects must get paths, or the backfill fragments every
derived link / resolves nothing.

*No code was written or modified by this pass. The `.worktrees/backlog-v2` tree was read-only
throughout. All item statuses were read from the live graph on 2026-09-22; the two source specs
live in the main repo and must be moved onto this branch before dispatch.*
