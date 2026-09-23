# Registry surface redesign — project / component / location verbs

**Status:** DESIGN SPEC (uncommitted; no code touched). Author: architect, 2026-09-22.
**Target branch:** `.worktrees/backlog-v2` (the replacement branch that ships post-cutover).
**Write location:** written in the **main repo** (`/Users/nix/dev/node/adhd`); the
`.worktrees/backlog-v2` tree is owned by another executor and was read-only for this pass.
Move/commit it onto `backlog-v2` as the owner sees fit (same posture as
`report/deferral-cleanup-plan.md`).
**ADR note:** the `adhd` repo has no `docs/decisions/`; the governing catalog is
`/Users/nix/dev/ai/sox-ecosystem/docs/decisions/` (0001–0018). This design complies with
**ADR-0013 (typed config, never env-var feature switches)** — it introduces **no** env toggle.
(The existing `APIGEN_IR_CACHE_ENABLED` kill-switch in `server.ts:541-543` is a pre-existing
deviation, out of scope here, and is *not* a precedent for this design.)

---

## 0. Method + evidence base

Every claim below is from a file read, not inferred.

| Evidence | Location |
|---|---|
| The 14 mounted verbs, pinned | `.worktrees/backlog-v2/entrypoint/backlog/src/server.ts:187-208` (`BACKLOG_VERBS`) |
| The mounted surface = `api.ts` exports | `src/api.ts:1-48` (file header: "The exported surface of this file IS the mounted surface") |
| Registry CRUD implementations | `src/write/catalog.ts:655-1252` (`IUpsertProjectInput`…`rmLocation`) |
| Registry read surface | `src/query/views/registry.ts:1-498` (`listProjects`/`listComponents`/`listLocations`/`getRegistryDetail`/`lookup`) |
| Registry read types | `src/query/types.ts:383-502` (`IProjectSummary`…`IIssueGetInput`) |
| `get` registry union | `src/api.ts:391-417`; `src/query/types.ts:451-469` |
| `query` registry views | `src/query/types.ts:254-264` (`IIssueView` incl. `projects`/`components`/`locations`) |
| Envelope | `src/envelope.ts:143-172` (`IOutcomeEnvelope`) |
| SPEC-v2 §3a (registry, non-negotiable) | `entrypoint/backlog/SPEC-v2.md:270-329` |
| SPEC-v2 §4 write layer / §4c mode table | `SPEC-v2.md:368-383`, `:497-507` |
| SPEC-v2 §6.1 addressing / §6.3 issue verbs / §6.7 surfaces | `SPEC-v2.md:969-1033`, `:1074-1080`, `:1791-1806` |
| SPEC-v2 §7 "wipe, no coexistence shim" | `SPEC-v2.md:1808-1824` |
| Surface pins (tests) | `src/api.surface.spec.ts:46-81`; `src/server.verbs.spec.ts:400-412`; `src/cli-envelope.spec.ts:32-34,105`; `src/server.published-layout.spec.ts:100-101` |
| Skill source + redeploy | `skill/SKILL.md`; `src/install-skill.ts:101-106,220-291` |
| Docs naming the verbs | `README.md:51-59`; `DESIGN.md:92-99,287-288`; `SPEC-v2.md:324,376-377,1079,2254` |

**Which surface ships.** The deployed binary is v1-shaped (the installed skill documents
`humanId`/`family`/`migration-status`, which the deployed build answers with *Unknown command*).
The replacement branch's surface is the 14-verb apigen mount. **This design targets the
`backlog-v2` branch** — the surface that ships once the cutover lands. The current
binary/skill mismatch is exactly what the cutover reconciles; this redesign must therefore be
part of the cutover payload, not a follow-up (see §5.4).

---

## 1. Diagnosis — precisely how the registry verbs deviate

The item verbs (`get`, `query`, `create`, `update`, `transition`, `claim`, `relate`, `move`,
`delete`) follow a consistent pattern: **one verb per operation, one `--input` JSON object,
`uid`-addressed, one `{ok,data}|{ok,error}` envelope**. The four registry verbs break that
pattern in five distinct ways.

### D1 — Naming is inconsistent with the item vocabulary

- `rm-location` uses the abbreviation `rm`; the item verb for the same operation is **`delete`**
  (`api.ts:519-585`). Two names for one concept.
- `upsert-project` / `upsert-component` / `upsert-location` fuse create + update behind a verb
  the item surface does not have at all. (This fusion is *justified* — see D2 — but the naming
  is still a second, unexplained verb vocabulary.)

### D2 — Addressing is inconsistent (and the one deliberate deviation is undocumented at the verb level)

- Every item verb that addresses an entity takes **`uid`** (`SPEC-v2.md:971-977`).
- The registry **writes** take a **business key**: `upsertProject` by `name`,
  `upsertComponent` by `(project, name)`, `upsertLocation` by `(component, locType, value)`
  (`catalog.ts:655-664,838-847,994-1013`).
- The registry **delete** takes **`uid`** (`rmLocation`, `catalog.ts:1154-1160`).
- `move` is a **third addressing shape** for the same registry relation: it takes an issue
  `uid` plus `toProject`/`toComponent` business refs (`write/move.ts:75-98`).

The business-key write addressing is **not a defect** — SPEC-v2 §3a designed it as the
resolution primitive ("resolved in ONE call", `SPEC-v2.md:328-329`) and the ETL depends on its
idempotency (`SPEC-v2.md:368-377`). But it is **undocumented as a deliberate deviation**, so it
reads as an accident next to the uid-addressed item verbs. The design keeps it and states why.

### D3 — CRUD is asymmetric: there is no delete for project or component

| Kind | Create/Update | Read | Delete |
|---|---|---|---|
| project | `upsert-project` | `get --registry project` / `query --view projects` | **MISSING** |
| component | `upsert-component` | `get --registry component` / `query --view components` | **MISSING** |
| location | `upsert-location` | `get --registry location` / `query --view locations` / `lookup` | `rm-location` |

Consequence (the owner's concrete complaint): **`deploy-verify-*` projects are un-removable.**
No verb invalidates a `project` or `component` node. `rmLocation` is the only registry delete,
and it is location-only (`catalog.ts:1192-1251`).

### D4 — Discovery is split across three verbs and two envelope shapes

- List: `query --input '{"view":"projects"|"components"|"locations"}'` — returns the **issue**
  query union `{view:'projects', items}` (`types.ts:378-380`).
- Detail: `get --input '{"registry":"project"|"component"|"location","name":...}'` — a
  **structurally-disjoint union bolted onto the item `get`** (`api.ts:391-417`,
  `types.ts:451-469`).
- Resolve: `lookup --input '{"q":"..."}'` — a third, separate verb (`api.ts:452-457`).

So "where does X live?" is answered by three verbs with two result shapes, and `get` is
dual-purpose (issue-by-uid **or** registry-by-name). The spec itself split these across
`query`/`get` (`SPEC-v2.md:314-322`); the implementation then moved `lookup` to a top-level verb.
That is the "CLI organization is wrong" the owner is pointing at.

### D5 — The registry has no namespace, so it is invisible as a coherent sub-surface

`backlog --help` sorts the registry verbs among the issue verbs with no grouping
(`skill/SKILL.md:47-66`). An agent reading the tool list cannot see "these four verbs are the
registry" — the family has no shared name, no shared input convention, and no shared
discovery entry point.

**What is NOT a deviation (so the redesign does not over-correct):**
- The envelope is already correct — every registry verb runs through the shared
  `envelope()`/`toEnvelope()` helper (`api.ts:370-379,536-570`).
- The business-key upsert is justified (D2).
- `lookup`'s separate existence is justified: it resolves a *value* (tool/path/url) to a
  *chain*, distinct from resolving an *identity* (`SPEC-v2.md:293-305`). It stays.

---

## 2. Target surface — options and trade-offs

### Option A — a named `registry-*` family (4 verbs, `kind`-discriminated) **[RECOMMENDED]**

Replace the four registry verbs with a coherent, symmetric namespace:

| Verb | Replaces | Addressing |
|---|---|---|
| `registry-get` | `get --registry …` | `kind` + `ref` (uid **or** name) |
| `registry-list` | `query --view projects\|components\|locations` | `kind` + `filter` |
| `registry-upsert` | `upsert-project` / `upsert-component` / `upsert-location` | `kind` + business key |
| `registry-delete` | `rm-location` **+ closes the project/component gap** | `uid` |
| `lookup` | unchanged | `q` (value) |

`get` and `query` become **pure issue verbs** (their registry overloads are removed).

- **Pros:** surface stays at **14 verbs** (no growth — 4 registry verbs in, 4 out); one
  discovery namespace; `delete` (not `rm`); uid-addressed delete; closes D1–D5 at once; the
  registry reads as one family in `--help` and in `mcp__backlog__*` (`backlog_registry_*`).
- **Cons:** `registry-upsert`'s input/result become `kind`-discriminated unions, which is more
  apigen-extraction surface (the repo has been burned by union extraction — see
  `types.ts:483-497` `BUG-APIGEN-CORE-CLIENT-BARE-NAME-COLLISION-001`; mitigated by the
  literal-`kind` discriminator, which `pickUnionBranch` now handles, `CHANGELOG.md:36`).
  Adds a `kind` field to every registry call. Touches every direct importer of the registry
  exports (§5.1).

### Option B — keep per-kind typed verbs, fix only naming + symmetry

Keep `upsert-project`/`upsert-component`/`upsert-location` (typed, no unions); rename
`rm-location` → `delete-location`; add `delete-project`/`delete-component`; add
`get-registry`/`list-registry` (or keep `get --registry`/`query --view`).

- **Pros:** no union types; smallest per-verb diff; strongest per-kind schemas in `--help`.
- **Cons:** surface grows to **~18 verbs** (works against SPEC-v2 §6.7's consolidation ethos);
  the family stays loosely named (`upsert-*` + `delete-*` + `get-registry`); the "one discovery
  shape" goal is only half-met.

### Option C — a single `registry` verb with a `view` discriminator

`registry --input '{"view":"projects"|"project"|"lookup"|"upsert"|"delete", …}'`.

- **Pros:** literally one verb; mirrors `query`'s `view` pattern.
- **Cons:** **re-creates the `admin` grab-bag** that SPEC-v2 §6.6 explicitly rejects
  ("that grab-bag shape is precisely what the named, individually-typed verb surface
  replaces", `SPEC-v2.md:1787`). **Rejected.**

### Option D — do nothing but add the two deletes

Rename `rm-location` → `delete-location`, add `delete-project`/`delete-component`. Leave
discovery and addressing as-is.

- **Pros:** minimal, lowest risk.
- **Cons:** leaves D4 (split discovery) and D5 (no namespace) unaddressed — i.e. it does not
  answer the owner's actual complaint. Acceptable only as an emergency stopgap.

### Recommendation

**Option A.** It is the only option that closes all five deviations *without growing the
surface* and *without* re-creating the rejected grab-bag. It keeps the §3a non-negotiable
(`registry-get`/`lookup` resolve by name in one call) and it keeps the justified business-key
upsert (documented as deliberate). If union extraction proves problematic in practice, **Option
B is the fallback**, and it should be chosen deliberately rather than drifted into.

---

## 3. Recommended surface — exact signatures

Mounted surface after Option A (14 verbs, `server.ts` `BACKLOG_VERBS` order):

```
get, query, lookup, create, update, transition, claim, relate, move, delete,
registry-get, registry-list, registry-upsert, registry-delete
```

MCP tools: `backlog_registry_get`, `backlog_registry_list`, `backlog_registry_upsert`,
`backlog_registry_delete` (plus the unchanged issue tools).
CLI: `adhd-backlog backlog registry-get --input '<IRegistryGetInput json>'` etc.

### 3.1 `registry-get`

```ts
// query/types.ts (new)
export interface IRegistryGetInput {
  kind: 'project' | 'component' | 'location';
  /** uid OR name (§6.1 shape-disambiguation). A location has no independent name — pass its uid. */
  ref: string;
  /** Scopes a bare component NAME (component names are unique only within a project). */
  project?: string;
}
export type IRegistryGetResult = IProjectDetail | IComponentDetail | ILocationDetail;
```

```ts
// api.ts
export async function registryGet(
  ctx: BacklogCtx,
  input: IRegistryGetInput
): Promise<IOutcomeEnvelope<IRegistryGetResult>>;
```

Delegates to the existing `getRegistryDetail(graph, …)` (`query/views/registry.ts:162-349`) —
no logic change; the three `registry` overloads are already disjoint.

### 3.2 `registry-list`

```ts
export interface IRegistryListInput {
  kind: 'project' | 'component' | 'location';
  filter?: IRegistryQueryFilter; // { project?, component? }
}
export type IRegistryListResult =
  | { kind: 'project'; items: IProjectSummary[] }
  | { kind: 'component'; items: IComponentSummary[] }
  | { kind: 'location'; items: ILocationSummary[] };
```

```ts
export async function registryList(
  ctx: BacklogCtx,
  input: IRegistryListInput
): Promise<IOutcomeEnvelope<IRegistryListResult>>;
```

Delegates to `listProjects`/`listComponents`/`listLocations` (`registry.ts:88-148`). The result
is `kind`-discriminated (literal), so apigen's union encoder is safe.

### 3.3 `registry-upsert`

```ts
export type IRegistryUpsertInput =
  | { kind: 'project'; name: string; path?: string; repoUrl?: string;
      monorepo?: boolean; description?: string; by: string }
  | { kind: 'component'; project: string; name: string;
      path?: string; description?: string; by: string }
  | { kind: 'location'; component: string; project?: string;
      locType: ILocationType; value: string; by: string };

export type IRegistryUpsertOutcome =
  | { kind: 'project'; uid: string; created: boolean; project: IProjectSummary }
  | { kind: 'component'; uid: string; created: boolean; component: IComponentSummary }
  | { kind: 'location'; uid: string; created: boolean; location: ILocationSummary };
```

```ts
export async function registryUpsert(
  ctx: BacklogCtx,
  input: IRegistryUpsertInput
): Promise<IOutcomeEnvelope<IRegistryUpsertOutcome>>;
```

Dispatches on `input.kind` to the **existing, unchanged** `upsertProjectOp` /
`upsertComponentOp` / `upsertLocationOp` (`catalog.ts:696,875,1045`). Create-or-update by
business key is retained deliberately (§1 D2). `by` required on all three; blank/role-literal
`by` rejects before any write (unchanged).

### 3.4 `registry-delete` (the gap-closer)

```ts
export interface IRegistryDeleteInput {
  uid: string;
  by: string;
  reason?: string;
}
export interface IRegistryDeleteOutcome {
  uid: string;
  kind: 'project' | 'component' | 'location';
  invalidated: true;
}
```

```ts
export async function registryDelete(
  ctx: BacklogCtx,
  input: IRegistryDeleteInput
): Promise<IOutcomeEnvelope<IRegistryDeleteOutcome>>;
```

Backed by a new `write/catalog.ts` function (replacing the location-only `rmLocation`,
`catalog.ts:1192-1251`). One `immediate` transaction, hand-composed, soft-invalidate
(bi-temporal — never a hard delete), mirroring `delete.ts`'s shape.

**Per-kind semantics (refuse-if-referenced; the safe default):**

- **`location`** — invalidate the location node + its owning `has_location` edge. No issue
  references a location directly (`has_location` is the only rel touching a location,
  `catalog.ts:1180-1184`). *This is today's `rmLocation`, unchanged.*
- **`component`** — refuse with `precondition_failed` if the component has any **live
  `owns_component` edge** (issues) or any **live `has_location` edge** (locations). The message
  names the blockers ("N live issues, M live locations"). A project's reserved **`(root)`
  component is never deletable** (`precondition_failed`). On success: invalidate the component
  + its `owns_project` edge; audit `'deleted'`.
- **`project`** — refuse with `precondition_failed` if the project has any **live component
  other than its `(root)`**, or any **live issue** under any of its components. On success:
  invalidate the `(root)` component + its `owns_project` edge, then the project; audit
  `'deleted'`. This is what makes the `deploy-verify-*` scratch projects (root-only, no issues)
  removable.

No env toggle, no hidden `force` (ADR-0013). A future cascade (reparent issues to `(root)`,
invalidate locations) is a **literal `cascade?: boolean` argument** — the same posture as
`claim`'s `force` (`SPEC-v2.md:1057`) — explicitly *out of scope* for this slice (§6, Q3).

### 3.5 `lookup` — unchanged

`lookup(ctx, { q: string })` (`api.ts:452-457`) stays exactly as-is. It is the §3a
one-call value→chain resolver and the non-negotiable the redesign must preserve.

### 3.6 `get` / `query` — become pure issue verbs

- `get`: remove the `'registry' in input` branch (`api.ts:396-414`). `IIssueGetInput` collapses
  to `IIssueGetByUidInput` (`types.ts:199-202,451-469`). **BEFORE:** union of uid-card and
  registry-detail. **AFTER:** uid-card only.
- `query`: remove `projects`/`components`/`locations` from `IIssueView` (`types.ts:254-264`)
  and the three branches from `IIssueQueryResult` (`types.ts:378-380`). **BEFORE:** 10 views.
  **AFTER:** 7 issue views. `cli.ts`'s `query --help` registry note (`cli.ts:808-818`) is
  deleted and re-homed as a `registry-list --help` note.

---

## 4. Interface changes (BEFORE / AFTER)

### `src/api.ts`

```ts
// BEFORE (14 exports)
get, query, lookup, create, update, transition, claim, relate, move,
upsertProject, upsertComponent, upsertLocation, rmLocation, delete

// AFTER (14 exports)
get, query, lookup, create, update, transition, claim, relate, move, delete,
registryGet, registryList, registryUpsert, registryDelete
```

`get`'s registry branch removed (`api.ts:396-414`); `upsert*`/`rmLocation` exports removed
(`api.ts:536-570`). `remove`-as-`delete` alias (`api.ts:585`) unchanged.

### `src/write/catalog.ts`

```ts
// BEFORE
export async function rmLocation(handle, input: IRmLocationInput): Promise<IRmLocationOutcome>

// AFTER
export async function deleteRegistryNode(
  handle: IWriteStoreHandle,
  input: IRegistryDeleteInput
): Promise<IRegistryDeleteOutcome>
```

`upsertProject` / `upsertComponent` / `upsertLocation` **unchanged** (dispatch targets).
`IRmLocationInput`/`IRmLocationOutcome` → replaced by `IRegistryDeleteInput`/`IRegistryDeleteOutcome`.

### `src/server.ts`

`BACKLOG_VERBS` (`server.ts:193-208`) updated to the 14-verb AFTER list. Count stays 14, so
`server.verbs.spec.ts:411`'s `toBe(14)` is unchanged; the live-derived comparison
(`:400-410`) adapts automatically.

### `src/index.ts`

Re-export list (`index.ts:24-39`) updated to the new export names.

### `src/query/types.ts`

- Add `IRegistryGetInput`, `IRegistryListInput`, `IRegistryListResult`,
  `IRegistryUpsertInput`, `IRegistryUpsertOutcome`, `IRegistryDeleteInput`,
  `IRegistryDeleteOutcome`.
- Remove `IIssueGetRegistryInput` (`types.ts:451-455`) and simplify `IIssueGetInput`
  (`types.ts:469`) / `IIssueGetResult` (`types.ts:498-502`).
- Remove `'projects'|'components'|'locations'` from `IIssueView` (`types.ts:254-264`) and the
  three members from `IIssueQueryResult` (`types.ts:378-380`).
- `IProjectDetail`/`IComponentDetail`/`ILocationDetail`/`ILookupResult` unchanged.

---

## 5. Migration

### 5.1 Code — files and blast radius

| File | Change |
|---|---|
| `src/write/catalog.ts` | `rmLocation` → `deleteRegistryNode` (+ project/component guards); upserts unchanged |
| `src/api.ts` | remove 4 exports + `get` registry branch; add 4 `registry*` exports |
| `src/server.ts` | `BACKLOG_VERBS` list |
| `src/index.ts` | re-export list |
| `src/query/types.ts` | add 7 registry types; simplify `get`/`query` types |
| `src/query/views/registry.ts` | no logic change (new api.ts wrappers call it) |
| `src/cli.ts` | delete `query` registry note (`:808-818`); optional `registry-list --help` note |

**Direct importers that break (must be updated in the same commit):**
`src/index.ts:34-37`; `src/api.semantic-laziness.spec.ts:71-73,196…`;
`src/api.semantic-production-seam.spec.ts:77,141…`;
`src/store/embed-drain-real-model.spec.ts:38`;
`src/write/bootstrap.spec.ts:44`.
These seed a project via `upsertProject`; each becomes `registryUpsert(ctx, {kind:'project',…})`
**or** imports `upsertProject` directly from `./write/catalog.js` (the write-layer function is
unchanged). Prefer the direct write-layer import for tests that are testing the write layer,
not the mount.

**CLI-spawn specs that pin the verb list (must be updated):**
`src/api.surface.spec.ts:46-81` (`EXPECTED` → new 14); `src/server.verbs.spec.ts:400-412`
(live-derived — adapts, but the `toBe(14)` guard stays correct); `src/cli-envelope.spec.ts:32-34`
(comment) and `:105` (seed `upsert-project` → `registry-upsert`);
`src/search-shortcut-wire.spec.ts:100-125` (seed calls);
`src/server.published-layout.spec.ts:100-101` (comment/verb list);
`src/server.mcp.spec.ts:84` (tool list).

### 5.2 Tests — with teeth

- **New `src/write/registry-delete.spec.ts`** (unit, real store):
  - deleting a root-only project succeeds and a subsequent `registry-get` returns `not_found`;
    reopen the store and assert the node is still invalidated (durability, not timing).
  - deleting a component with a live issue → `precondition_failed`, message names the blocker,
    **and the component is still live** (assert both).
  - deleting a `(root)` component → `precondition_failed`.
  - **Negative control:** remove the reference guard → the "component with a live issue"
    test goes RED. (AGENTS.md §7 rule 2.)
- **New `src/api.surface.spec.ts` cases** for the 4 `registry*` names (extend `EXPECTED`).
- **New wire test** (`src/registry-wire.spec.ts`, spawns the real built bin): `registry-list`
  → `registry-get` → `registry-upsert` → `registry-delete` round-trip over the real CLI, keyed
  on exit codes; assert `registry-delete` on a referenced component exits non-zero with
  `precondition_failed`.
- **Real-binary consumer proof** (AGENTS.md §7): `registry-get`/`lookup` resolve by name in one
  call — the §3a non-negotiable — asserted against the built `dist/index.js`, not a mock.

### 5.3 Skill (`entrypoint/backlog/skill/SKILL.md`) + redeploy

Rewrite:
- §1 command table (`SKILL.md:24-40`) → the 14 new verbs.
- §1 `--help` excerpt (`:47-66`) → the new live shape (it is an example, not a pin).
- §2 MCP tool names (`:162-170`) → `backlog_registry_*`.
- §4 registry section (`:332-399`) → `registry-upsert` / `registry-get` / `registry-list` /
  `registry-delete` / `lookup`, with worked examples.
- §5 batch note (`:425-427`) → "the 14 verbs above".

**Redeploy is part of the change, not optional.** `install-skill` copies the *packaged*
`skill/SKILL.md` from the built `dist/` (`install-skill.ts:101-106,242-248`), so the skill is
versioned in lockstep with the binary. Sequence: rebuild → `adhd-backlog install-skill --host all
--scope user` (and `--scope project` where a repo pins it). **The installed skill must be
redeployed in the same cutover as the binary**, or the binary/skill divergence the owner is
already seeing recurs.

### 5.4 Docs

| Doc | Change |
|---|---|
| `SPEC-v2.md:314-326` (§3a "Surface — the verbs, one convention") | replace the verb list with `registry-get`/`registry-list`/`registry-upsert`/`registry-delete`; keep the non-negotiable sentence |
| `SPEC-v2.md:1078-1080` (§6.3) | update the parenthetical registry-verb list |
| `SPEC-v2.md:497-507` (§4c mode table) | rename `rmLocation` → `registry-delete`; note the project/component delete is the same `immediate` mode |
| `SPEC-v2.md:2254` (AC-21) | restate for `registry-delete` (all three kinds) |
| `SPEC-v2.md:1791-1806` (§6.7) | update the mounted verb list |
| `README.md:51-59` | update the verb table + the "four `upsert*`/`rmLocation` verbs" sentence |
| `DESIGN.md:92-99` (mint table), `:287-288` | `rmLocation` → `registry-delete`; note the delete guard |
| `CHANGELOG.md` | new entry (this is a surface change) |

### 5.5 Landing relative to the v1/v2 cutover

Land on `backlog-v2` **before** the re-cutover (`report/deferral-cleanup-plan.md` §7, L0-step-2).
Rationale: the deployed binary is v1-shaped while the installed skill documents v2 vocabulary —
the cutover is the reconciliation point. This redesign must be **in the cutover payload** so the
shipped binary, the shipped skill, and the docs agree from the first post-cutover process.
Per SPEC-v2 §7 (`:1822-1824`) there is **no coexistence shim and no legacy-id fallback** — the
old `upsert-*`/`rm-location` names stop resolving by design. If the owner wants a one-release
grace, that is a decision (§6, Q7), not a default.

---

## 6. Open questions for the owner

1. **Option A vs B** — accept the `kind`-discriminated union inputs/results (A, surface stays
   14) or keep per-kind typed verbs and grow the surface to ~18 (B)? Recommendation: **A**.
2. **`registry-upsert` generic vs three typed upserts** — if A is chosen, is one
   `registry-upsert {kind}` acceptable, or keep `upsert-project`/`upsert-component`/
   `upsert-location` as-is and genericize only get/list/delete? (The latter is a hybrid: 16 verbs.)
3. **Delete semantics** — is **refuse-if-referenced** the right default for project/component,
   or is a `cascade: true` literal needed in the first slice to reparent issues to `(root)`?
   Recommendation: refuse-if-referenced now; cascade as a separate slice.
4. **`registry-delete` on `(root)`** — confirm `(root)` is never deletable (a project delete
   cascades it). Any case where a caller wants to drop `(root)` alone?
5. **Discovery** — should `registry-get`/`registry-list` replace `get --registry` /
   `query --view` outright (recommended, "one discovery shape"), or is documenting the existing
   split as "one convention" enough?
6. **`lookup` placement** — keep it a top-level verb (recommended; it is the §3a one-call
   resolver) or fold it into the `registry-*` family as `registry-resolve`?
7. **Compatibility** — hard cut at cutover (SPEC-v2 §7's stated posture) or a deprecation alias
   for `upsert-project`/`rm-location` for one release? Recommendation: hard cut (no shim).
8. **Pre-existing env toggle** — `APIGEN_IR_CACHE_ENABLED` (`server.ts:541-543`) is an env-var
   feature switch that ADR-0013 forbids. Out of scope for this redesign, but it should be filed
   and fixed separately — confirm the owner wants it tracked.

---

## 7. Independent segments (for the executor)

| # | Segment | Files | Depends on | Read tok | Out tok |
|---|---|---|---|---|---|
| 1 | Registry delete core | `write/catalog.ts` | — | ~250 | ~450 |
| 2 | Registry types | `query/types.ts` | — | ~200 | ~300 |
| 3 | api.ts surface swap | `api.ts` | 1,2 | ~250 | ~350 |
| 4 | Pins + barrel | `server.ts`, `index.ts`, `cli.ts` | 3 | ~120 | ~120 |
| 5 | Spec pins | `api.surface.spec.ts`, `server.verbs.spec.ts`, `cli-envelope.spec.ts`, `search-shortcut-wire.spec.ts`, `server.published-layout.spec.ts`, `server.mcp.spec.ts` | 3 | ~300 | ~300 |
| 6 | Import-site fixes | `api.semantic-laziness.spec.ts`, `api.semantic-production-seam.spec.ts`, `store/embed-drain-real-model.spec.ts`, `write/bootstrap.spec.ts` | 3 | ~150 | ~150 |
| 7 | New delete tests (teeth) | `write/registry-delete.spec.ts`, `registry-wire.spec.ts` | 1 | ~100 | ~400 |
| 8 | Skill rewrite | `skill/SKILL.md` | 3 | ~200 | ~500 |
| 9 | Docs | `SPEC-v2.md`, `README.md`, `DESIGN.md`, `CHANGELOG.md` | 3 | ~300 | ~400 |

Segments 1 and 2 are independent and can run in parallel; 3 gates the rest.
Verify with `npx nx run backlog:test` (the `test` target `dependsOn: ["build"]`, so the built
`api.d.ts` this surface extracts is rebuilt) + `npx nx lint backlog`.

*No code was written or modified by this pass. The `.worktrees/backlog-v2` tree was read-only
throughout. All line references are to the `backlog-v2` worktree unless a path names the main
repo's `SPEC-v2.md`.*
