# Backlog v2 Application Layer — Specification (FEAT-017)

Status: PROPOSED v2 — revised after blind architect review + backlog-feature
audit. All library primitive names below were re-verified against the published
npm packages.

## 0. Context & non-negotiable principles

**This is a FULL HARD REPLACEMENT, not a side-by-side rollout.** The entire v1
application layer is WIPED and the v2 layer is architected fresh against the sox
library tier — there is no coexistence, no dual-write bridge, no gradual
deprecation window. The old store DATA is preserved by the one-time ETL (§8); the
old CODE is deleted. This means: the library dep bump lands WITH the fresh v2
build (§10) — there is no "must not break v1" constraint, because v1 is going
away.

Library versions (verified on npm): `@adhd/sox-graph-store@0.9.1` (the 0.9.1
patch surfaces `NodeRecord.uid` + `getNodeByUid` — the stable-identity correction,
§1), `@adhd/sox-store-adapter@0.8.0`, `@adhd/sox-vector-store@0.6.0`,
`@adhd/sox-hybrid-search@0.4.2`, `@adhd/sox-semantic@0.1.2`,
`@adhd/sox-memory-core@0.9.2`.

**Anti-antipatterns to NOT recreate:**

1. **No humanId / composite identity.** Identity is the DB-generated `uid`
   (UUID) exposed to consumers; `rowid` is internal. No allocator, no
   dedupe-scan, no `idOverride`, no `importedFrom`, no repo-string identity.
   **BUG-039 (cross-process write loss) is HYPOTHESIZED to disappear with
   DB-generated ids** — §10.4 keeps the write-safety proof as the gate that
   CONFIRMS it, not as a foregone conclusion.
2. **No kind-derived-from-prefix.** `kind` is a catalog-backed reference.
3. **No closed `CHECK` on `kind`/`rel`.** Open schema + injected `TypePolicy`.
   (Note: the store's `source` column still carries its own `CHECK`; this rule
   is specifically about the kind/rel vocabulary, which is open.)
4. **No dual-stored repo.** `project` is one canonical row; membership is the
   `owns_project` edge.
5. **No legacy type debt** — real columns/edges only; no `namespace`+metadata
   dual-write, no `repoWarning`, no migration-phase state machine.

## 1. Identity, dedup, & uniqueness

- **Identity = `uid` (UUID), now a first-class library surface.** `graph-store`
  ≥0.9.1 exposes `NodeRecord.uid` and `GraphBackend.getNodeByUid(uid)`, so the
  app layer keys the *consumer-facing* identity on the stable, exportable UUID
  and resolves an external `uid` → node with one call. `rowid` (`NodeRecord.id`)
  remains the *internal* edge identity (`writeEdge`/`getEdges` are
  `src`/`dst` rowids) — it is per-store and is NOT stable across the ETL or a
  rebuild, so it must never escape as an external reference.
- **Content is NEVER identity.** The library's global content-hash dedup
  (`skipDedupe` default `false`) is a content-idempotency convenience, not
  identity. **Every live write-layer entity write passes `skipDedupe: true`:**
  `createIssue`, and `supersede`-backed body edits — so two identical-body
  issues are two rows (two `uid`s), never one collapsed row. The ETL already
  passes it (§8); the live path must too. (This was the blind review's blocker.)
- **Uniqueness = a hand-composed find-then-create inside the write layer's own
  `immediate` transaction (§4c) + `NodeUniquenessPolicy` (edge-scoped) — never
  the library's `findOrCreateNode()`, which is two separate, non-transactional
  autocommit statements (a SELECT, then on a miss a bare `writeNode` call) with
  no transaction wrapping either. §4c proves this against the library source,
  and the primitive's own doc comment says so explicitly: under multi-writer
  the caller must wrap check+INSERT in one transaction itself.**
  - flat catalogs (`status`/`priority`/`kind`/`agent`/`edge_kind`) and `project`
    (name unique) → the write layer runs its own `tx.executeGet` SELECT by
    `(kind, name)` against the SAME `immediate`-mode transaction handle the
    verb already opened, and only on a miss issues the INSERT against that
    same `tx` (§4c) — never a call to `findOrCreateNode()` itself.
  - `component` within a project: **the parent project `uid` is carried in
    `meta.metadata.projectUid`**; the injected `NodeUniquenessPolicy.check` reads
    it (resolve parent via `getNodeByUid` on the tx handle), then checks
    `owns_project` edges for an existing same-name component under that project.
    This is implementable because the parent is threaded into `meta` — the check
    runs BEFORE the component's own INSERT, against *other* components, not itself.
- The policy is tx-threaded, and therefore genuinely atomic with the check,
  ONLY because it runs inside the write layer's own `immediate` transaction
  (§4c) — `writeNode` called standalone runs against the bare adapter (no
  transaction at all), so the atomicity is a property of the write layer's own
  composition, never of `writeNode` or `NodeUniquenessPolicy` in isolation.

## 2. Catalogs (first-class data) + project policy

| catalog | kind | uniqueness | extra (metadata) |
|---|---|---|---|
| node kind | `kind` | name | `description` |
| edge kind | `edge_kind` | name | `source_kind`, `target_kind`, `multiplicity` |
| status | `status` | name | `terminal` |
| priority | `priority` | name | `rank` |
| agent | `agent` | name | — |

`status.terminal` drives closedness. Per-project policy is DATA (rows), the home
of the old hardcoded terminal/citation/reason knobs:

```
project_policy (project → policy): transition_requires_note (default true),
  transition_requires_sha (true), citation_required (false),
  citation_requires_sha (true)
project_status  (project → allowed status set)
project_kind    (project → allowed kind set)
project_field_requirement (project → required field)
```

- **Edge-kind schema enforcement is a WRITE-LAYER responsibility, not
  `validateEdge`.** `TypePolicy.validateEdge(srcKind, rel, dstKind)` is a PURE
  three-string predicate (no I/O — FEAT-013). The write layer resolves the
  `edge_kind` catalog row by `rel` name, checks `source_kind`/`target_kind`
  match the resolved endpoints and that `multiplicity` isn't exceeded, THEN
  calls `writeEdge` (whose injected `validateEdge` does the pure vocabulary
  check). Multiplicity/cardinality is therefore enforced by the app layer that
  can read the catalog — never smuggled into the pure seam.

## 3. Entities & edges (graph nodes; event model is graph-native)

**Nodes** (`writeNode`, `kind` + `name` + `metadata`):

- `project` — one canonical row; `name` (slug) unique. Carries the **navigation
  spine**: `meta.path` (absolute local root, e.g. `/Users/nix/dev/node/adhd`),
  `meta.repoUrl` (canonical git remote, e.g. `git@github.com:PseudoSky/adhd.git`),
  `meta.monorepo` (bool hint), optional `meta.description`. A worktree directory
  under the project resolves to the SAME project row — never a phantom row.
- `component` — `name` unique within project; `meta.metadata.projectUid`. The
  logical sub-unit (package/module/service/directory) with optional
  `meta.path` (repo-relative) + `meta.description`.
- `location` — a concrete reference that **resolves** to a component/project:
  `meta.locType` ∈ `path` | `url` | `tool` + `meta.value` (the reference string).
  `path` = filesystem path (absolute or repo-relative); `url` = full URL;
  `tool` = MCP tool / CLI command / symbol name. Unique per
  `(component, locType, value)` via the uniqueness policy.
- `issue` — `title` (name), `body` (content); `kind`/`status`/`priority` as
  catalog refs (resolved via the write layer's hand-composed find-then-create,
  §4c — never `findOrCreateNode()` itself); `closed_at` (realized as
  `meta.metadata.closedAt`, never a relational column — §6.3.4) stamped by the
  terminal transition.
- **Event/evidence nodes — graph-native re-interpretation of DATA_MODEL_v2's
  relational "tables"** (the graph store has no arbitrary tables; a "first-class
  row" is a node). This is a deliberate, stated divergence:
  - `note` — `{ author, text, at }` (metadata).
  - `citation` — `{ target, target_type, sha, line, at }`; content-addressed.
  - `transition` — `{ from_status, to_status, agent, note, sha, at }`.
  - `audit` — `{ actor, action, target_uid, from, to, note, sha, at }`.

**Edges** (typed rels, each name unique with ONE `(source_kind → target_kind)` —
no polymorphic `owns`):

```
owns_project   project   → component   (1:n)
owns_component component → issue       (1:n)
has_kind       issue     → kind        (n:1)
has_status     issue     → status      (n:1)
has_priority   issue     → priority    (n:1)
authored_by    issue     → agent       (n:1)   (notes/transitions/audits carry
                                                their agent in node metadata)
has_note       issue     → note        (1:n)
has_citation   issue     → citation    (1:n)
has_transition issue     → transition  (1:n)
audits         *         → audit       (1:n)   (subject-of-audit link)
depends_on     component → component   (n:m)
has_location   component → location    (1:n)
relates_to     issue     → issue       (n:m)
supersedes     issue     → issue       (1:n)   (issue relation, lowercase)
blocks         issue     → issue       (n:m)   (inverse = blocked_by, derived)
duplicate_of   issue     → issue       (1:n)
part_of        issue     → issue       (1:n)   (hierarchical items, FEAT-005)
```

Note: the library's `supersede()` primitive (CONTENT mutation) writes a
hardcoded `SUPERSEDES` (uppercase) rel — that is the content-versioning
mechanism, distinct from the catalog's `supersedes` (lowercase) issue
relation. The injected `TypePolicy` must accept both.

Bi-temporal: `invalidate` = soft-delete; `invalidateEdge` = typed relation
drop. `supersede` is the ONLY content-mutation path — `touch` cannot change
`content` (compile-time pinned). In-place restore (un-invalidate) is not yet a
library primitive → tracked as a library ticket, never app-layer raw SQL.

## 3a. Registry & resolution (the agent navigation index)

`project` / `component` / `location` are not just write-layer resolution targets —
they are a first-class, queryable **registry** that answers "where does this live?"
without an agent touching the filesystem or a search index. This is the agent's
**go-to before searching** — it must be faster and clearer than `rg`/`gx` for
"which project/component owns this tool/file/url?"

**Node payloads (the navigation spine):**

- `project` = `{ name, path, repoUrl, monorepo?, description? }` — `path` is the
  absolute local root, `repoUrl` the canonical git remote. A worktree dir under
  the project resolves to the SAME project.
- `component` = `{ name, projectUid, path?, description? }` — the sub-unit
  (package/module/service/dir); `path` is repo-relative.
- `location` = `{ locType: path|url|tool, value, componentUid }` — the concrete
  reference. `path` (fs path), `url` (full URL), `tool` (MCP tool / CLI command /
  symbol). Unique per (component, locType, value).

**Edges:** `owns_project` (project→component), `has_location`
(component→location). A location belongs to exactly one component; a component to
exactly one project — the chain `location → component → project` is unambiguous.

**Resolution (`lookup`):** `lookup(q)` normalizes `q` into one `locType` and walks
the chain:

1. **Classify:** `tool` if `q` matches a known MCP/CLI/symbol name (no `/`, no
   scheme); `url` if `q` parses as a URL; else `path` (normalize to absolute via
   the project `path` when repo-relative).
2. **Match** a `location` node by `(locType, normalized value)` — exact first,
   then suffix/prefix fallback for repo-relative paths (`extensions/.../index.ts`
   matches the `location` whose value is that suffix of an absolute path).
3. **Walk** `has_location` → component → `owns_project` → project.
4. **Return** `{ project: {uid,name,path,repoUrl}, component: {uid,name,path?},
   location: {uid,locType,value} }` — plus a `hint` when only a project-level (or
   only a path-prefix) match exists. Never a silent null.

Example: an agent sees `memory_ping` fail in the adhd repo → `lookup("memory_ping")`
resolves to `project: sox-ecosystem` (`/Users/nix/dev/ai/sox-ecosystem`),
`component: memory-server`
(`extensions/bundles/sox-memory-bundle/members/memory-server`), `location: tool
memory_ping` — so the agent knows exactly where to fix it AND exactly which
project to log the bug against, in one call, with no search.

**Surface (the verbs, one convention):**

- `query --input '{"view":"projects"}'` / `"components"` / `"locations"` — list
  registry nodes (`filter` narrows: `filter.project`, `filter.component`).
- `query --input '{"view":"lookup","lookup":"<tool|file|url>"}'` — resolve.
- `get --input '{"registry":"project","name":"adhd"}'` — expanded detail:
  - project → `{ name, path, repoUrl, components:[{name,path}], locations:[{locType,value}] }`
  - component → `{ name, path, project:{name,path,repoUrl}, locations[] }`
  - location → `{ locType, value, component:{name,path}, project:{name,path,repoUrl} }`
- CRUD via the write layer (§4): `upsertProject` / `upsertComponent` /
  `upsertLocation` / `rmLocation` — mounted as registry create/update entries
  (project upsert by `name`, component upsert by `(project,name)`, location upsert
  by `(component, locType, value)`), never a hand-rolled scan.

**Non-negotiable:** the registry is data, seeded from real repos, and resolvable in
ONE call. If an agent has to search, the registry has failed its purpose.

## 4. Write layer (`v2-write.ts`)

Every write is one `store.adapter.transaction(fn, {mode:'immediate'})` (§4c)
over `writeNode` + `writeEdge`(s) + audit; never `GraphBackend.transaction(fn)`
(the graph-store's own composition method always runs at the adapter's
default `deferred` mode and cannot request `immediate` — §4c), and never the
raw adapter directly. **All entity writes pass `skipDedupe: true`.**

- `createIssue(title, body, { project, component, kind, status, priority })`:
  resolve catalogs via the write layer's hand-composed find-then-create (§4c);
  write the issue + `owns_component` +
  `has_kind`/`has_status`/`has_priority`/`authored_by` edges + a `created`
  audit row — atomically.
- `updateIssue(uid, patch)`:
  - **body change → `supersede`** (new node + `SUPERSEDES` edge) — the only
    content path; **title/metadata → `touch`**. Never `touch` a body.
  - status change → `transition` (§4a).
- `moveIssue(uid, toComponent)` (FEAT-008): `invalidateEdge(old
  owns_component)` + `writeEdge(new owns_component)` + audit, atomically.
- `relate(uid, targetUid, rel, action)` (BUG-025/BUG-044): returns a real
  outcome (`noop` vs `changed`); single-valued rels (`supersedes`,
  `duplicate_of`) reject a second target.
- `transition(uid, toStatus, { agent, note })`: writes a `transition` node +
  `has_transition` edge + stamps `closed_at` when terminal.
- **Registry CRUD** (§3a): `upsertProject({ name, path, repoUrl, monorepo?,
  description? })` (create-or-update by `name`), `upsertComponent({ project, name,
  path? })` (upsert by `(project, name)`), `upsertLocation({ component, locType,
  value })` (upsert by `(component, locType, value)`), `rmLocation(uid)`
  (invalidate). Each is ONE `store.adapter.transaction(fn, {mode:'immediate'})`
  (§4c) over `writeNode` + `owns_project`/
  `has_location` edges + audit. No `humanId`, no repo-string, no second
  `dimensionGraph` store.

### 4a. Automatic audit logging

No bare mutation. Every state change writes an `audit` node
(`actor`/`action`/`target_uid`/`from`/`to`/`note`/`sha`/`at`) linked by an
`audits` edge, emitted by a single `writeAudit` helper at the end of each write
transaction — automatic, cannot be forgotten. `sha` = `sha256` over the
canonical serialization (content-addressing, DATA_MODEL_v2 §0.4/§4/§6).

- **Transitions** keep the hard invariant: `agent` + `note` + `sha` REQUIRED,
  validated on the write path (no bare transition).
- **Embeddings are audited by the WRITE LAYER**, not the observer: the
  `createEmbeddingObserver` (FEAT-021) has no graph-write handle, so the write
  layer records the `embedding_upserted`/`embedding_deleted` audit row after the
  observer fires (it owns the actor context the observer lacks).

### 4b. On-write embeddings (FEAT-021)

`createEmbeddingObserver(semanticBackend)` registered at open: embed-on-write,
delete-on-invalidate; degrades to a log. Batch is backfill-only
(`reembed`/`deleteMany`).

### 4c. Concurrency semantics & error taxonomy

**Ground truth:** this store is parallel-process by mandate. `@adhd/sox-store-adapter`'s
concurrency contract (`concurrency-mode.ts`) resolves exactly one mode per backend —
Turso (the default backend) mandates `multiprocess-wal` with **no opt-out**
(`resolveConcurrencyMode`/`VALID_CONCURRENCY_MODES`, `concurrency-mode.ts:54-65`); the
better-sqlite3 fallback mandates `single-writer` (one synchronous in-process
connection — `concurrency-mode.ts:50-57`). Under `multiprocess-wal`, **multiple
processes hold concurrent write connections to the one store file; writers are
serialized, not concurrent** — `multiprocess_wal` extends single-writer WAL across
process boundaries via a `.tshm` coordinator holding a single-writer slot, absorbed by
the adapter's always-on busy timeout and bounded retry (ADR-0012 §1). This is
**explicitly not MVCC**: `BEGIN CONCURRENT` exists as a capability but no production
caller requests it, and it **throws on the SqliteAdapter** (store-adapter
`README.md:102`) — disqualifying it as a mode this spec can rely on, since the spec
must hold on both backends. Ordering across processes is **not FIFO**: two racing
writers may commit in either order (ADR-0012 §1). Nothing below may be read as
single-writer/single-process — that invariant is superseded (ADR-0012, superseding
ADR-0007; ADR-0015's opt-out was never accepted).

#### Transaction mode per write class

Every v2-write.ts verb opens **exactly one** transaction via
`store.adapter.transaction(fn, { mode: 'immediate' })` — the `StoreAdapter` the
backlog store exposes as `.adapter` (`graph-backlog-store.ts:27`, used directly by the
existing harness at `concurrency-scale.spec.ts:233`), **not**
`GraphBackend.transaction(fn)`. The graph-store's own composition method
(`transaction<T>(fn): Promise<T>`, `index.ts:747`, implemented as a bare
`return this.adapter.transaction(fn)` at `index.ts:2057-2059`) accepts no `opts` and
therefore always runs at the adapter's default `'deferred'` mode — it cannot request
`immediate`. v2-write.ts must go one layer down to get mode control.

`immediate` (`BEGIN IMMEDIATE`, RESERVED lock **at BEGIN**) is the one mode this spec
uses, on every verb, for one reason: every v2 write is a **check-then-act** operation
— resolve-or-create a catalog/registry row by business key, read current state to
decide a transition/move/relate outcome, or verify an issue isn't already superseded
— and `deferred` mode's snapshot is fixed at the transaction's first statement, so a
second writer's own check can run against a stale snapshot while a first writer's
commit is in flight, racing past the very check the write layer depends on.
`immediate` closes that window structurally: the RESERVED lock is acquired before any
statement in the callback runs, so

- the loser **blocks** until the winner commits, then its own read (the
  find-by-business-key, the current-status check, the not-already-superseded check)
  executes against the **winner's already-committed state** — it takes the "found
  existing" / "already transitioned" branch, never a duplicate INSERT; or
- the loser's `BEGIN IMMEDIATE` itself **fails busy** — nothing in the callback ran at
  all, so retrying the whole closure is trivially safe (§ Retry semantics below).

Either way there is no lock-free TOCTOU window between check and write. This is the
store-adapter's own documented purpose for the mode — "the compare-and-swap
primitive" (`README.md:111`) — and it is the ✓ row shared by **both** adapters
(`README.md:97-102`), unlike `concurrent`. `multiprocess-wal` is what makes the
"blocks until the winner commits" half true across process boundaries, not just
threads (ADR-0012 §1); `single-writer` mode gives the same serialization for free,
in-process, via the FIFO write queue (ADR-0007's original mechanism, still correct
for that adapter — ADR-0012 §1 note two).

| Write-layer verb (§4) | Mode | Why |
|---|---|---|
| `createIssue` | `immediate` | resolves `kind`/`status`/`priority` (and `project`/`component` if not already `uid`-resolved) by business key before the issue INSERT — a check-then-act composite |
| `updateIssue` (body → supersede path) | `immediate` | must CAS the "not already superseded" check against the write (see below) — the library's own `supersede()` does not |
| `updateIssue` (title/metadata → touch path) | `immediate` | `touch`'s own pre-check (`index.ts:1964-1968`, "not found or invalidated") is a check-then-act read outside any transaction when called standalone; composing it inside the write layer's own `immediate` transaction closes the same window |
| `moveIssue` | `immediate` | must find the specific live `owns_component` edge before invalidating it and writing the replacement — a specific-edge check-then-act |
| `relate` | `immediate` | single-valued rels (`supersedes`, `duplicate_of`) must read "does a target already exist" before deciding `noop` vs `changed` vs reject |
| `transition` | `immediate` | reads current status to validate the `from_status`/terminal transition and decide `closed_at` stamping |
| `claim` | `immediate` | CAS-merges the `claimedBy`/`claimedAt` pair against a fresh read of the same uid, taken on the transaction handle — a specific-node check-then-act, identical shape to `transition`'s current-state read |
| `upsertProject` / `upsertComponent` / `upsertLocation` | `immediate` | create-or-update by business key — the exact `findOrCreateNode` shape, composed by hand (below) |
| `rmLocation` | `immediate` | invalidate-by-uid after confirming the row is live, for uniformity with every other verb above (one mode, one decision, never re-litigated per verb) |

#### `findOrCreateNode` is not race-free — the write layer does not call it

`findOrCreateNode` (`index.ts:1907-1917`) runs
`this.adapter.executeGet(...)` (a SELECT against the base adapter) and then, only if
nothing was found, `this.writeNode(...)` — **two separate autocommit statements, no
transaction at all.** Its own doc comment says so explicitly: *"under multi-writer the
caller must wrap check+INSERT in one transaction or add a DDL backstop"*
(`index.ts:1896-1902`). The DDL-backstop half of that offer does not currently exist
to take: the unique `(kind, name)` index was reverted (FEAT-023, "too broad per
BUG-042"), and edge-scoped uniqueness (component-in-project) is, in the same comment's
words, "inexpressible as a column index" — which is exactly why `NodeUniquenessPolicy`
exists as an injected check instead of a constraint (`index.ts:1899-1901`).

The write layer takes the other half of the library's own offer, literally: it
never calls `GraphBackend.findOrCreateNode()` for a live entity write (§1). Every
business-key resolution (catalog lookup in `createIssue`; the upsert-by-key in the
three registry verbs) is composed by hand inside the verb's own `immediate`
transaction — a `tx.executeGet` SELECT by `(kind, name)` [or `(component, locType,
value)` for `upsertLocation`, `(project, name)` for `upsertComponent`], and only on a
miss, an INSERT against the same `tx` handle, mirroring `writeNodeInTx`'s INSERT shape
(`index.ts:1869-1883`) with `skipDedupe: true`. The same reasoning governs
`NodeUniquenessPolicy` (§1): it is tx-threaded, and therefore genuinely atomic with
the check, only when `writeNode` is *composed* inside a transaction the app already
owns. Called standalone, `writeNode` always passes `this.adapter` (`index.ts:1825`),
i.e. runs inside nothing — the policy is atomic with the check only because the
write layer's own `immediate` transaction is what the hand-composed INSERT above
runs inside.

#### `updateIssue`'s body path: `supersede` needs a CAS the library doesn't give it

`GraphBackend.supersede(oldId, ...)` (`index.ts:1919-1936`) reads the target's
`t_invalid` **before** opening its transaction (`index.ts:1920-1927`, a plain
`this.adapter.executeGet`), then, inside a `deferred`-mode transaction it opens itself
(no mode option — `index.ts:1928`), runs `UPDATE node SET is_superseded = 1 WHERE
rowid = ?` with **no `AND is_superseded = 0` guard** (`index.ts:1930`). Two concurrent
`updateIssue(uid, {body})` calls on the SAME issue can both pass the pre-check before
either commits, and the UPDATE has nothing to reject the second one on — the result is
two superseding nodes and two `SUPERSEDES` edges, silently, with no thrown error at
all. This is a real defect in the composed path, not a theoretical one, and it means
`updateIssue`'s body-change path **must not call `supersede()` as a black box.**

The write layer instead performs the equivalent sequence itself, inside its own
`immediate` transaction, with the guard `supersede()` is missing:

```ts
await store.adapter.transaction(async (tx) => {
  const changed = await tx.executeRun(
    'UPDATE node SET is_superseded = 1 WHERE rowid = ? AND is_superseded = 0',
    [oldRowid],
  );
  if (changed.rowsAffected !== 1) {
    throw new ETerminalConflict('E_CONSTRAINT', 'issue already superseded');
  }
  const newRowid = /* INSERT the new content node, skipDedupe: true, same tx */;
  /* writeEdge(newRowid, oldRowid, 'SUPERSEDES', ..., same tx) */
  /* writeAudit(..., same tx) */
}, { mode: 'immediate' });
```

The `AND is_superseded = 0` clause turns the race into a single-row conditional
UPDATE: exactly one of two concurrent callers gets `rowsAffected === 1`; the loser
gets `0` and is told, terminally, that its target changed under it — never a silent
double-supersede.

#### Error taxonomy

`@adhd/sox-store-adapter` owns driver-shaped **detection** — message-marker
predicates that recognize a specific driver's error shape regardless of which backend
is live: `isBusyError`, `isConcurrentConflict`, `isUniqueConstraintError`,
`isForeignKeyError`, `isDatabaseError` (`README.md:143,158-164`; ADR-0012 §3 records
why these are keyed on driver-specific signals — SQLite's `err.code`, Turso's message
text, since Turso's `err.code` carries no discriminating information). v2-write.ts
composes these into one stable shape every verb returns on failure — never a raw
driver exception, never a bare string:

```ts
interface WriteError {
  code: 'E_CONTENTION' | 'E_CONSTRAINT' | 'E_VALIDATION' | 'E_IO';
  retryable: boolean;
  retry_after_ms?: number;
  message: string;
  cause: unknown; // the original driver-native error — never swallowed
}
```

| Class | `code` | Detected via | `retryable` |
|---|---|---|---|
| Lock/commit contention | `E_CONTENTION` | `isBusyError` / `isConcurrentConflict` | `true` |
| Uniqueness/FK violation | `E_CONSTRAINT` | `isUniqueConstraintError` / `isForeignKeyError` (includes the hand-composed CAS conflict above) | `false` |
| App-level validation | `E_VALIDATION` | thrown before any driver call — missing `agent`/`note`/`sha` on a transition, a `kind`/`rel` outside the injected `TypePolicy`, a multiplicity violation (§2) | `false` |
| Unclassified driver/connection failure | `E_IO` | `isDatabaseError` catch-all | `true` |

A caller distinguishes RETRYABLE from TERMINAL from the **returned value alone** —
the `retryable` boolean field, never a message-text match, never a `code` allow-list
guess. This is the same discipline ADR-0012 §4 states for its own envelope
("`retryable: true` remains present in the final envelope even on exhaustion"), and
the reason `code` is a closed union rather than a passthrough of the driver's own
error name: a consumer written against `WriteError` never needs to know Turso emits
`GenericFailure` for everything (ADR-0012 §3) or that SQLite emits `SQLITE_BUSY` — the
detection layer already normalized that away.

**Two failure-signaling shapes, reconciled into one contract.** `WriteError` above
is `store.adapter.transaction(fn, {mode:'immediate'})`'s own INTERNAL envelope for a
driver-level failure — the shape a v2-write.ts verb's own catch block pattern-matches
on, never the shape a caller of `v2-write.ts` or any transport (CLI/MCP/HTTP) ever
receives directly. Every §6.3 verb catches it at its own transaction call site and
does exactly one of two things: retries per the bound below (`E_CONTENTION`/`E_IO`,
`retryable:true`), or — on final exhaustion, or immediately for the CAS-detected
`E_CONSTRAINT` case above — re-throws a NEW, transport-facing, named class carrying
the envelope's fields forward: `WriteContentionError(retryAfterMs, cause)` (an
exhausted `E_CONTENTION`), `WriteIOError(cause)` (an exhausted `E_IO`), and
`StaleSupersedeError(uid)` (the one deliberate `E_CONSTRAINT` this spec's own
supersede CAS raises, above). Every §6.3 verb's Errors list that can reach a
driver-level failure names these alongside its own validation errors. Those existing
named validation classes (`IssueNotFoundError`, `InvalidArgumentError`,
`CatalogNotFoundError`, `ClaimHeldError`, `SingleValuedRelationConflictError`,
`NoteRequiredError`, `CitationRequiredError`, …) ARE this same union's
`E_VALIDATION`-class members — thrown before any driver call ever runs, never
composed from a caught `WriteError` — so end to end a consumer of the write layer
sees exactly ONE failure-signaling contract: a thrown, named, typed error class,
always. The `WriteError` envelope is real, and it is what decides retry-vs-rethrow
inside the write layer, but it is never itself the value a caller receives.

#### Retry semantics

**Bound:** 3 total attempts (1 initial + 2 retries), linear backoff seeded from
`retry_after_ms` — 250ms, then 500ms. These are not new numbers: they reuse
ADR-0012 §4's own bound, adopted for consistency with the retry loop already
operating one layer down inside the adapter (`TursoAdapterImpl._runTransaction`'s
own `maxRetries: 3`, per ADR-0012 §4) rather than inventing a second, differently-tuned
schedule at the write layer. Only `E_CONTENTION` and `E_IO` are retried; `E_CONSTRAINT`
and `E_VALIDATION` are surfaced on the first attempt — retrying a terminal failure
cannot change its outcome and would only mask the real conflict from the caller.

**Why retrying the whole closure is safe despite `skipDedupe: true` (§1) removing
content-hash dedup as an accidental idempotency guard** — split by entity class:

- **Keyless content nodes** (`issue`, `note`, `citation`, `transition`, `audit`): these
  have no business key, so a naive retry that re-runs an already-committed INSERT
  would produce a second, distinct row with no dedupe safety net to collapse it back
  — exactly the risk `skipDedupe: true` opens up. The guard here is transactional,
  not a check: a retryable failure is only ever raised as a **thrown** error out of
  `adapter.transaction(fn, opts)`, and the adapter's transaction contract is
  rollback-before-rethrow (ADR-0012 §4, citing `turso-adapter.ts`'s
  `_runTransaction`) — so by the time the write layer sees a retryable error, nothing
  from that attempt is durably committed. Retrying the closure from scratch cannot
  therefore produce two committed rows for the same logical write; it can only ever
  produce the one row the eventually-successful attempt writes.
- **Business-keyed nodes** (catalogs; `project`/`component`/`location`): these get a
  second, independent guard on top of the first — the hand-composed find-then-create
  (above) runs its find **inside the same retried `immediate` transaction**, so even
  in the limiting case where an earlier attempt's write somehow did land (a scenario
  the rollback contract above already rules out, kept here as defense-in-depth), the
  retry's own SELECT sees that row and takes the "found existing" branch rather than
  re-inserting. This is the exact hand-composed find-then-create +
  `NodeUniquenessPolicy` guard §1 describes — the write layer's own composition,
  never the library's `findOrCreateNode()` primitive itself.
- **The `supersede` CAS** (previous section) is retry-safe by the same
  single-row-conditional-UPDATE logic: a retried attempt's `UPDATE ... AND
  is_superseded = 0` either affects the one row still eligible (if the prior attempt
  rolled back) or affects zero rows and surfaces `E_CONSTRAINT` (if the prior attempt
  somehow committed) — never a second supersede of the same target.

An exhausted retry (3 attempts, still `E_CONTENTION`/`E_IO`) is surfaced to the
caller as a `WriteError` with `retryable: true` still set — the caller, not the write
layer, owns any retry beyond the bound (ADR-0012 §4). Silent loss — an exhausted
retry disappearing with nothing reaching the caller — is explicitly the failure mode
this contract exists to prevent.

#### §4a audit-write atomicity

§4a requires an `audit` node + `audits` edge for every state change, "emitted by a
single `writeAudit` helper at the end of each write transaction." Under concurrent
writers that requirement is not stylistic — it is the difference between a durable
correctness guarantee and a race. This repo has already produced the failure mode a
non-atomic audit write causes: the concurrency-scale harness's own postmortem
(`concurrency-scale.spec.ts:303-325`) traces an intermittent failure to exactly this
shape — a `logClaimEvent`/`writeAuditEvent` call running **after** the subject write
had already committed, with neither busy-retry nor containment of its own, so the
audit write's failure surfaced as an unhandled error minutes after the state change it
was recording had already taken effect (`BUG-BACKLOG-AUDIT-WRITE-FAILS-COMMITTED-CLAIM-001`,
named at that same location).

The v2 requirement, stated precisely: `writeAudit`'s INSERT (and its `audits` edge)
executes against the **same `tx` handle**, inside the **same `immediate` transaction**,
as the subject write it records — never a separate call, never after the subject
transaction has committed, never with its own independent retry loop. A subject write
whose audit insert fails must roll back the subject write too (the single transaction
already guarantees this — there is no separate step to get wrong once the audit
INSERT lives inside the same `fn`). This closes off the exact race the postmortem
found: an audit write can no longer fail *after* its subject has already durably
committed, because there is no "after" — they commit or roll back together, as one
statement sequence inside one `BEGIN IMMEDIATE`.

## 5. Query layer (`v2-query.ts`)

Primitives: `queryNodes`, `countNodes`, `countBy`, `getNodesByIds`, `getEdges`
(edge-metadata), keyset `after`, `getSubgraph`/`getNeighbors`, `validAt`.

- Issues by project/component/kind/status/priority via filters + `has_*`/`owns_*`
  traversal.
- **`countBy` supports `'kind' | 'namespace' | 'agentId'` only.** Status/priority
  counts are EDGE-SCOPED (the library deliberately excludes them from `countBy`):
  count `has_status`/`has_priority` edges per catalog node (a single grouped
  edge query), never `countBy('status')`.
- **Stats are status-aware (BUG-023):** the priority matrix counts non-terminal
  (open) items by default; closed items only under an explicit terminal filter.
- Keyset pagination for stable listing; `validAt` for cumulative-open curves.
- **Hierarchical rollup (FEAT-005):** `part_of` + derived two-axis rollup.
- **Registry views (§3a):** `view: projects|components|locations` (list), and
  `view: lookup` with the `lookup` key (resolve tool/file/url →
  project/component/location) — the agent navigation index, not an item list.

### 5a. Semantic search (FEAT-022)

`view:similar`/`relevance`/`_score` route through
`StoreSearchBackend.searchRanked(query, limit)` with
`signals:[{text},{vec}]` + `rescore:[{kind:'temporal',decay}]`.
`semanticSearchNodes` DELEGATES to text+vec fusion (FEAT-022 §3 — no longer
vector-only); the embedding-only path is `searchRanked({vec, signals:[{vec}]})`.
A title/body text match surfaces even when its vector is not nearest.

## 6. Consumers

This section specifies the v2 **issue** verb surface (CLI/MCP/HTTP), at the same
implementable depth as §3a's registry surface. It replaces v1's 38
`ops-v1.ts` exports and the current six-verb consolidation
(`IBacklogGetInput`/`IBacklogQueryInput`/`IBacklogCreateInput`/
`IBacklogUpdateInput`/`IBacklogRelateInput`/`IBacklogAdminInput`, model.ts) —
both are wiped in full by §7. Every v1/current-surface parameter is accounted
for in §6.2's table: kept as-is, folded into a new shape with a stated
mapping, or deliberately dropped with a stated reason. Nothing vanishes
silently.

### 6.1 Addressing: identity, project scoping, and lookup

- **Identity is `uid`.** There is no `humanId`, no `(repo, humanId)`
  composite key, and no per-repo numbering. Every issue verb below that
  addresses one issue takes `uid: string` — a value obtained from a prior
  `query`/`create`/`relate` response, never typed by hand. `getNodeByUid`
  (`@adhd/sox-graph-store@0.9.1`, verified: `dist/index.d.ts:285`) is the one
  resolution primitive; a `uid` with no matching live node throws
  `IssueNotFoundError(uid)`.
- **`repo` is replaced by `project`.** Every v1 verb required `repo: string`
  because `humanId` was only unique within a repo; `uid` is globally unique,
  so no verb *requires* a scoping key any more. `project` survives as an
  optional **filter/creation** input, not an addressing key: `create` takes
  `project` to place the new issue under `owns_component`'s chain (§3, §4),
  and `query`'s `filter.project` narrows a listing. Every place that accepts
  an entity reference to a catalog/registry node (`project`, `component`,
  `kind`, `status`, `priority`, `agent`) accepts **either**:
  - the entity's `uid` (exact, always valid if it exists), **or**
  - its catalog `name` (`project`/`component`) — resolved server-side the
    same way §1/§4c's hand-composed find-then-create and §3a's registry
  resolve it.

  Disambiguation is by shape, not a second field: a 36-character
  `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` UUID-formatted string is treated as
  a `uid`; anything else is treated as a `name`. On **write** paths
  (`create`), an unresolved catalog `name` for `kind`/`status`/`priority`
  auto-creates the catalog row (§1/§4c — the write layer's hand-composed
  find-then-create); an unresolved
  `project`/`component` **name** on write also auto-vivifies **only** via
  the explicit registry CRUD verbs (§3a `upsertProject`/`upsertComponent`) —
  `createIssue` itself never silently mints a new `project`/`component` row,
  because doing so would let a typo'd project name fork the registry instead
  of erroring. `createIssue({project: "adph", ...})` (typo) throws
  `CatalogNotFoundError('project', 'adph')` naming the mismatch, mirroring
  v1's `repoWarning` intent but as a hard error instead of a soft warning
  (§7 already retires `repoWarning` as a class of silent-drift bug). On
  **read** paths (`query` filters), an unresolved `name` is not an error —
  it resolves to zero matches, same as any other filter that matches
  nothing.
- **How a human or agent gets a `uid` at all — the two-step pattern.**
  §3a's `lookup` is registry-only (project/component/location — "where does
  this live"); it does **not** resolve issues, and conflating the two would
  be wrong: `lookup` answers a structural question with one correct answer
  per input, while resolving "the issue about X" is inherently a *search*
  with zero, one, or many matches. So issue addressing is **discover, then
  act** — the same shape a coding agent already uses for `rg` before `Edit`:
  1. `query({filter:{grep:"..."} , fields:["uid","title"]})` (or
     `filter.semantic`, §5a) returns a small card list, each carrying `uid`.
  2. The caller picks the right card's `uid` and passes it to
     `get`/`update`/`transition`/`claim`/`relate`/`move`/`delete`.

  A verb that needs to seed a traversal from an existing item (v1's
  `blockerImpact`/`view:"order"` `humanId` seed field) takes the SAME
  `uid`-typed field, renamed `anchor` for symmetry with §5a's existing
  `filter.anchor` (semantic item-anchored similarity) — one seed-field name
  for both traversal and similarity, since both mean "start from this item."

### 6.2 The v1 surface, item by item — what dies, what replaces it

Every field below is drawn from the interfaces
`CreateItemInput`/`UpdateItemInput`/`BacklogFilter`/`ClaimOpts`/
`TransitionOpts`/`ArchiveOpts`/`ImportMarkdownInput` (model.ts) and the
consolidated six-verb inputs (`IBacklogCreateInput`/`IBacklogUpdateInput`/
`IBacklogRelateInput`/`IBacklogQueryInput`/`IBacklogAdminInput`, model.ts).

| v1 param (source) | Why it dies | v2 replacement |
|---|---|---|
| `humanId`, `(repo, humanId)` composite | §1 — identity is DB-generated `uid`; no allocator, no per-repo numbering | `uid` everywhere (§6.1) |
| `repo` (every verb) | `humanId` needed repo-scoping to disambiguate; `uid` never does | dropped as an addressing key; survives only as the optional `project` filter/creation field (§6.1) |
| `family` (`CreateItemInput.family`, `BacklogFilter.family`) | was the parsed prefix of `humanId` (`BUG-APIGEN`); no `humanId` to parse | `kind` (catalog ref) is the open-vocabulary classifier now; a project that wants finer-grained families files them as distinct `kind` catalog rows (§2 — extensible by row, no code change) |
| `idOverride` (`CreateItemInput.idOverride`) | existed so import/planner code could force a specific human-readable id; `uid` is always DB-generated, never caller-chosen (§0 anti-antipattern 1) | **no replacement** — there is no override path; every `create` mints a fresh `uid` unconditionally |
| `importedFrom` (`CreateItemInput`/`UpdateItemInput`/`BacklogFilter`) | the markdown-import provenance/ownership field; §7 retires the markdown `import` admin action itself | **no replacement** — provenance is the `audit` node's `actor`/`action`/`sha` (§4a), not a mutable ownership field on the issue |
| `dedupeScan` (`CreateItemInput.dedupeScan`) | v1's opt-in symbol/path/errorText scan input | subsumed into `create`'s always-on duplicate gate (§6.4); `symbol`/`path`/`errorText` become the ranking hints passed as `filter.files`/`filter.grep`-equivalent terms to the same `searchRanked` call §6.4 already makes |
| `force` (`CreateItemInput.force`) | v1's single bypass-dedupe flag | `duplicateAction: 'force'` (§6.4) — same effect, renamed to sit in the same enum as `abort`/`comment` rather than a bare boolean |
| `citations` (`CreateItemInput.citations`) | still a real feature — filing evidence at creation time | kept, unchanged in spirit: `create`'s input carries `citations?: Citation[]`, written as `citation` nodes + `has_citation` edges in the same transaction (§3, §4) |
| `awaitEmbed` (`CreateItemInput`/`UpdateItemInput`) | still real (RAG-SPEC durability for short-lived processes) | kept verbatim on `create`/`update` — §4b's on-write embedding observer is fire-and-forget by default; `awaitEmbed:true` waits for it, same contract |
| `author`/`reporter` (`CreateItemInput`, `BacklogFilter`, `IUpdatePatch`) | v1 tracked two roles (`AUTHORED_BY`/`REPORTED_BY`) | **collapsed to one**: §3 line 136 declares exactly one edge, `authored_by` (issue→agent, n:1) — no `reported_by` edge exists in the v2 edge table. `reporter` dies; `author` survives as the sole accountability edge. (Resolved here because §3 declares the edge but never states this collapse explicitly.) |
| `plan` (`CreateItemInput`, `BacklogFilter`, `IUpdatePatch`, `attachToPlan`/`planRepo`) | v1's plan-slug string + a dedicated `MEMBER_OF`-style edge | folded into the existing `part_of` edge (§3): a plan is itself an `issue` (kind catalog row, e.g. `kind:"plan"` — no new node type, matching the current system's own "the plan parent IS an item" doctrine); attaching an item to a plan is `relate(childUid, planUid, 'part_of', 'add')`. The plan-native resume view (`view:"plan"`'s rollup/ready/blocked/delta/myClaims/asOf aggregate) is **out of scope for this section** — it is a §5 query-layer concern once `part_of` traversal is queryable, not an issue-verb input shape. |
| `assignee` (`CreateItemInput`? no — `IBacklogUpdateInput.assignedTo`, `BacklogFilter.assignee`) | durable ownership, distinct from the ephemeral claim lease — still a real, distinct feature | kept: `issue.meta.metadata.assignee` (plain scalar, no edge — see §6.3 `claim`'s rationale for why this and `claimedBy`/`claimedAt` are metadata, not edges), mutated via `update`'s `assignee` field, filterable via `NodeFilter.metadata.assignee` (`{eq: "..."}`, verified operator: `@adhd/sox-graph-store@0.9.1 dist/index.d.ts:157-170`) |
| `claimedBy`/`claimedAt` (`BacklogItem`, `BacklogFilter`) + `ClaimOpts.staleAfterMin` + `ClaimOpts.force` + `staleClaims`/`ClaimHeldError` | the ephemeral claim-lease system — a real multi-agent coordination feature with **no mention anywhere else in this spec**; §6.3.5 closes that gap | kept in full, redesigned onto the graph model as its own `claim` write-layer verb (§6.3.5) — `claimedBy`/`claimedAt` live in `issue.meta.metadata` (mutated via `touch`, CAS-checked inside the write transaction); `staleAfterMin` moves from a per-call param to **data**: `project_policy.claim_stale_after_min` (default `30`), consistent with DATA_MODEL_v2 §2's "policy about actions is data, not code" pattern already applied to `citation_required`/`transition_requires_note`; per-call `force` (human-confirmed override of a non-stale claim) survives as a literal argument, since that is a caller decision, not project policy |
| `TransitionOpts.reason` (terminal-dismissed-only free text, distinct from `.note`) | v1 split evidence into `note` (always) vs `reason` (terminal-dismissed only), driven by `TERMINAL_DONE`/`TERMINAL_WORKAROUND`/`TERMINAL_DISMISSED` status categories | **collapsed into `note`** — DATA_MODEL_v2 §3's `transition` node has exactly one free-text field, `note`, and §2's `project_policy` has one boolean, `citation_required` (not three status-category-specific rules). The three-way status categorization (`requiresCitation`/`requiresReason`, model.ts:75-81) dies with it; `status.terminal` (a single bool) plus `project_policy.citation_required` (a single bool, project-tunable) is the entire v2 evidence gate. |
| `statusEvidence: {citations?, reason?}` (`IBacklogUpdateInput`, DEBT-010) | bundling fix for the retired top-level `citations`/`reason` fields on the six-verb `update` | superseded by `transition`'s own input shape (§6.3.4), which HAS the `citations`/`note` fields directly — there is no separate generic `update` path into a status change any more (§6.3.3 `update` explicitly rejects `status`), so the DEBT-010 bundling problem (evidence attached to the wrong verb) cannot recur structurally |
| `duplicateAction: 'abort'\|'file'\|'comment'` (`IBacklogCreateInput`) | still a real feature, needs re-grounding now that `skipDedupe:true` is universal (§1) | kept, renamed `'file'` → `'force'` for clarity, redesigned in full in §6.4 |
| `splitFrom`/`children` (`IBacklogCreateInput`, `splitItem`) | "split into N children `part_of` a parent" — still real | kept: `create`'s `children?: ICreateIssueInput[]` field (§6.3.2) creates each child then `relate`s it `part_of` the freshly-created parent, atomically, in the same write transaction |
| `supersedes`/`reason` (`IBacklogCreateInput`, `supersedeItem`) | content-mutation supersession at create time — still real | kept: `create`'s `supersedes?: uid` field (§6.3.2) is sugar for `updateIssue(uid, {body: ...})`'s `supersede` path (§4) run against an EXISTING issue rather than minting via `create` — see §6.3.2 for the exact composition |
| `IBacklogRelateInput.sourceRepo`/`targetRepo`, `addDependency`/`removeDependency`/`linkRelated`'s `targetRepo` | cross-repo disambiguation — needed only because `humanId` was repo-scoped | **no replacement** — `uid` is globally unique across every project in the store, so a `relate` between two issues in different projects needs no repo parameter at all; `relate(sourceUid, targetUid, rel, action)` just works |
| `migrateRepo`'s `fromRepo`/`toRepo`/`planRepo`, `RepoMigrationPlan`/`RepoMigrationResult` | the whole repo-string-collision-repair module | already wiped by §7 ("the repo-migration module... folded into first-class `project`/`component`/`location` nodes") — restated here only for completeness, since nothing this section still owes a mapping for |
| `DEPENDS_ON` item-to-item edge (`addDependency`/`removeDependency`, `blockers`, `readyItems`, `dependencyGraph`, `topoOrder`) | §3's edge table has **no** issue-to-issue `depends_on` — only `depends_on: component → component` | **mapped to `blocks`** (§3: `blocks issue → issue (n:m), inverse = blocked_by, derived`): v1 `addDependency(item, dependsOnItem)` ("item cannot proceed until dependsOnItem resolves") is v2 `relate(dependsOnUid, itemUid, 'blocks', 'add')` — note the argument order flips, because `blocks` reads subject-first ("X blocks Y") while v1's dependency reads object-first ("Y depends_on X"); `blockers`/`readyItems`/`dependencyGraph`/`topoOrder` all become `query` views over `blocks`/`blocked_by` traversal (view names `ready`/`graph`/`order` — unchanged names, new edge under the hood) |
| `mergeItems` (`keepHumanId`, `dropHumanId`, reason) | `SAME_AS`-edge merge — still real | 1:1 mapping onto existing primitives, no new mechanism needed: `relate(dropUid, keepUid, 'duplicate_of', 'add')` then `delete(dropUid, reason)` (§6.3.7's `invalidate`) |
| `overlapBy` (`IBacklogQueryInput.overlapBy`), `humanIds` (`view:"overlap"` input set) | the pairwise-intersection axis selector and its item-set input — still real (§5a.3 in the current surface) | kept as query-layer concerns, **not** an issue-verb input: `overlapBy` renames to `axis` (matching `IOverlapAxis`'s existing vocabulary `file`\|`project`\|`component`\|`author` — `package` renamed `component` for the v2 vocabulary) and `humanIds` renames to `uids: string[]`; both are `query`'s `view:"overlap"` parameters (§5), out of scope for the write-facing verbs this section specifies |
| `ArchiveOpts.exclude`, `archiveResolved`'s `archivedAt` metadata stamp + generated `changelogMarkdown` | the mutating "hide terminal items from the default projection" admin action | **no replacement as a mutation** — `status.terminal` (already stamped by the terminal `transition`, §4a) is itself the exclusion signal; the default `render`/`query` projection already excludes terminal items unless `filter.status` explicitly asks for them (mirroring v1's `excludeArchived` default), so there is nothing left to "archive" separately. A markdown changelog section is produced by rendering `filter.status:['terminal set']` through the same `render` output, never a second code path. |
| `IBacklogAdminInput.action` (`archive`,`export`,`import`,`render`,`merge`,`migration_status`,`set_migration_phase`,`version`,`skill`,`batch`,`doctor`,`prune`,`migrate_model_v2`,`reconcile_repo`,`run_dedup_sweep`,`cluster_into_plans`,`promote_cluster_to_plan`,`embedding_backfill`,`embedding_health`,`list_near_duplicates`) | the entire `admin` verb — one of the six wiped by §7 | disposition per action, §6.6 |
| `IBacklogQueryInput.limit`/`.offset`, `MAX_QUERY_LIMIT` | still real | kept, redesigned onto keyset in §6.5 |
| `IProjection.fields`, `BACKLOG_FIELDS`/`BACKLOG_PSEUDO_FIELDS`, `assertKnownFields` | still real (context-blow defense) | kept, redesigned in §6.5 |

### 6.3 Issue verbs

Nine verbs, one mounted operation each (same one-descriptor→four-transport
projection server.ts already uses, §10): `get`, `query`, `create`, `update`,
`transition`, `claim`, `relate`, `move`, `delete`. (Registry verbs — `lookup`,
`upsertProject`/`upsertComponent`/`upsertLocation`/`rmLocation` — are §3a's,
not restated here.)

Every mutating verb requires `by: string` (the acting agent/human identity,
resolved through the `agent` catalog via the write layer's hand-composed
find-then-create (§4c) — unchanged from
the current surface's §7.5 attribution rule) and writes exactly one `audit`
node (§4a). A missing/blank `by` on a mutating verb throws
`InvalidArgumentError('by', ...)` before any write runs.

#### 6.3.1 `get`

```ts
interface IIssueGetInput {
  uid: string;
  fields?: readonly IIssueField[]; // §6.5; default DEFAULT_CARD_FIELDS + projectPath-equivalent + updatedAt
}
```

Output: `IIssueCard` (§6.5) projected to the requested fields.
Errors: `IssueNotFoundError(uid)` when no live node carries `uid`.

#### 6.3.2 `create`

```ts
interface ICreateIssueInput {
  title: string;
  body: string;
  project: string;   // uid or name — resolved per §6.1; REQUIRED (every issue has a component chain)
  component?: string; // uid or name, scoped within `project`; auto-created via the write layer's hand-composed find-then-create (§4c) ONLY when given as a name that already resolves to an existing component under `project` — an unresolved name here throws CatalogNotFoundError('component', name) rather than silently forking a new component (see §6.1's project-vs-component asymmetry: components are NOT auto-vivified by createIssue, use upsertComponent first)
  kind?: string;      // catalog name or uid; default catalog row "issue" if the project defines no default
  status?: string;    // catalog name or uid; default is the project's configured initial status (project_policy — falls back to a global default "OPEN"-equivalent catalog row)
  priority?: string;  // catalog name or uid; optional
  citations?: Citation[];
  author?: string;    // catalog agent name/uid; defaults to `by`
  assignee?: string;  // plain metadata scalar (§6.2)
  awaitEmbed?: boolean;
  // duplicate-gate controls — §6.4
  duplicateAction?: 'abort' | 'force' | 'comment'; // default 'abort'
  // structural sugar — §6.2
  children?: ICreateIssueInput[]; // each created, then `part_of` the freshly-minted parent, one transaction
  supersedes?: string;            // uid of an existing issue this create supersedes — see composition below
}

interface Citation {
  file: string;
  lines?: string;
  context?: string;
  symbol?: string;
  blastRadius?: CitationBlastRadius; // unchanged from v1 — still real, still best-effort (model.ts:110-120)
}
```

**`supersedes` composition (resolves the create/update overlap):** when
`supersedes` is given, `create` does NOT mint a standalone new issue —
instead it runs §4's `updateIssue(supersedes, {body: input.body})`
(the `supersede`-backed content path) and returns that result mapped onto
`ICreateOutcome`'s shape (`created: true`, `item`: the NEW node the
`supersede` primitive minted, `supersededUid: input.supersedes`). Every
other field on the input (`title`, `project`, `kind`, ...) is applied via a
following `touch`/edge-write against the same new node, atomically, inside
the SAME transaction the `supersede` call opened — this is the one case
where `create`'s input maps onto `updateIssue`'s write path rather than
`createIssue`'s.

Output:

```ts
interface ICreateOutcome {
  created: boolean; // false ⇒ nothing written; see duplicateCandidates/reason
  uid?: string;      // present iff created
  item?: IIssueCard; // present iff created
  duplicateCandidates?: IDuplicateCandidate[]; // present when the gate fired (§6.4) or on comment
  reason?: 'duplicate-suppressed'; // present iff !created — only one suppression class survives (§6.4)
  supersededUid?: string; // present iff input.supersedes was given
  commentedOn?: { uid: string; noteId: string }; // present iff duplicateAction:'comment' fired
}
```

Errors: `CatalogNotFoundError('project'|'component'|'kind'|'status'|'priority', ref)`,
`InvalidArgumentError` (missing `title`/`body`/`project`, or `citations[i].file`
empty), `StaleSupersedeError(uid)` (only when `supersedes` is given — the
body-change CAS (§4c) lost a race to a concurrent edit of the same target;
nothing was written, re-`get` and retry), `WriteContentionError`/`WriteIOError`
(§4c — an exhausted driver-level retry on the underlying `immediate`
transaction). `DuplicateSuppressedError` is NOT thrown — a suppressed create is a
**success response** with `created:false` (mirrors v1's
`CreateItemResult.created:false` contract exactly — a caller must check the
flag, never a try/catch, because "no write happened" is not exceptional).

#### 6.3.3 `update`

```ts
interface IUpdateIssueInput {
  uid: string;
  by: string;
  title?: string;       // → touch (metadata/name only)
  body?: string;         // → supersede (§3: "body change → supersede... never touch a body")
  kind?: string;         // → touch + has_kind edge rewrite (invalidateEdge old, writeEdge new)
  priority?: string;     // → touch + has_priority edge rewrite
  assignee?: string;     // → touch (metadata scalar, §6.2)
  author?: string;       // → touch + authored_by edge rewrite
  awaitEmbed?: boolean;
}
```

`status` is **deliberately absent** — a status change is ALWAYS `transition`
(§6.3.4), never `update`. This is a structural fix of DEBT-010: v1's
`IBacklogUpdateInput` accepted both `status` and `patch.status`, which is
exactly how `statusEvidence` ended up silently dropped when bundled wrong.
Removing the field from `update` entirely — rather than accepting it and
validating placement — makes the mistake a compile-time TypeScript error for
any typed caller, and a `BacklogValidationError` naming `transition` for any
untyped (CLI/HTTP/MCP JSON) caller. Same rule for `assignedTo`/claim fields:
`claim` (§6.3.5) is a separate verb, not an `update` field, for the same
DEBT-010 reason.

Output:

```ts
interface IUpdateOutcome {
  uid: string;
  changed: Array<'title' | 'body' | 'kind' | 'priority' | 'assignee' | 'author'>;
  // empty array = genuine no-op, stated (BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001's fix, carried forward unchanged in spirit)
}
```

Every key present in the input with a defined value MUST appear in
`changed` or the write layer throws before returning (the
`assertNoSilentlyDiscardedPatchKeys` invariant, carried forward verbatim —
it is a general correctness rule, not v1-specific machinery, so it survives
the wipe).

Errors: `IssueNotFoundError`, `CatalogNotFoundError` (per catalog field
above), `StaleSupersedeError(uid)` (body-change path only — the supersede CAS
(§4c) lost a race to a concurrent edit of the same `uid`; the patch was not
applied, re-`get` and retry, never a silent partial apply),
`WriteContentionError`/`WriteIOError` (§4c), `InvalidArgumentError` (no fields
at all in the patch — a zero-field `update` call is a client error, not a
silent no-op success, since the caller almost certainly meant a different
verb).

#### 6.3.4 `transition`

```ts
interface ITransitionInput {
  uid: string;
  by: string;
  toStatus: string;       // catalog name or uid
  note: string;           // REQUIRED unless project_policy.transition_requires_note is false (default true)
  citations?: Citation[]; // REQUIRED (≥1) when project_policy.citation_required is true AND toStatus resolves to a terminal status
}
```

Output:

```ts
interface ITransitionOutcome {
  uid: string;
  fromStatus: string;
  toStatus: string;
  closedAt?: string; // present iff toStatus.terminal — see the closed_at note below
  transitionUid: string; // the minted `transition` node's own uid, for audit-trail addressing
}
```

**`closed_at` placement:** the real `@adhd/sox-graph-store@0.9.1`
`node` table (verified: `NODE_TABLE_DDL_OPEN`, package dist) has a FIXED
column set with no dedicated `closed_at` column — every domain field beyond
`content`/`name` lives in the JSON `meta` blob (DATA_MODEL_v2 §3 states this
directly). So in SPEC-v2's graph-native re-interpretation
(§3: "a first-class row is a node"), `closed_at` is
`issue.meta.metadata.closedAt`, stamped by `touch` inside the SAME
transaction that writes the `transition` node, whenever `toStatus.terminal`
is true. This is not a downgrade: `NodeFilter.metadata` supports `gt`/`lt`/
`between` operators (verified, `dist/index.d.ts:157-170`), so
`filter.closedAt` range queries still push down to SQL exactly as a real
column would.

Errors: `IssueNotFoundError`, `CatalogNotFoundError('status', toStatus)`,
`NoteRequiredError` (policy-gated), `CitationRequiredError` (policy-gated,
terminal-only) — both replace v1's three-way
`requiresCitation`/`requiresReason` split (§6.2) with the single
`project_policy.citation_required` boolean; there is no more
terminal-done-vs-terminal-dismissed distinction to error on.
`WriteContentionError`/`WriteIOError` (§4c) surface an exhausted
driver-level retry on the underlying `immediate` transaction.

#### 6.3.5 `claim`

The ephemeral multi-agent lease, closed here in full (§6.2 flags it as
otherwise unaddressed elsewhere in this spec). Modeled as **node metadata, not an edge** —
deliberately, for two reasons: (1) it mutates far more often than any edge
in §3's table (claim → renew → renew → release, potentially dozens of times
over an issue's life) and `touch` is the cheap, edge-free metadata-mutation
primitive §3 already reserves for exactly this ("title/metadata → touch");
(2) an edge-based lease would need `invalidateEdge`+`writeEdge` cycling on
every renew, which is edge-history churn for what is fundamentally a mutable
`(claimedBy, claimedAt)` pair, not a fact worth its own bitemporal audit
trail (the `audit` node §6.3.5 still writes on every claim/release/renew
already gives the audit trail — a second edge-level history would be
redundant).

```ts
interface IClaimInput {
  uid: string;
  by: string; // the claimant
  action: 'claim' | 'release' | 'renew';
  force?: boolean; // human-confirmed override of a NON-stale claim (§6.2)
}
```

**Concurrency (the parallel-process invariant, ADR-0012):** `claim` is a
compare-and-swap, not a blind write. It runs inside ONE
`store.adapter.transaction(fn, {mode:'immediate'})` (§4c's stated write
pattern — `immediate` mode, never `GraphBackend.transaction(fn)`, which always
runs `deferred` and cannot request it) that (1) re-fetches
the node via `getNodeByUid` **on the transaction handle**, never a
pre-transaction read — mirroring exactly how §1's `NodeUniquenessPolicy`
is tx-threaded — (2) evaluates the claim/release/renew rule against that
fresh read, (3) `touch`es the merged metadata, all before the transaction
commits. Two concurrent `claim` calls against the same `uid` therefore
serialize through the transaction, and the loser sees a fresh
`claimedBy`/`claimedAt` rather than racing on a stale one.

Rule table (unchanged from v1's semantics, restated for the new
metadata-only shape):

| action | current `claimedBy` | outcome |
|---|---|---|
| `claim` | unset | write `{claimedBy: by, claimedAt: now}`; `status: 'claimed'` |
| `claim` | == `by` | no-op write of `claimedAt: now`; `status: 'held'`, `heldBy: by` (idempotent re-claim by the same agent) |
| `claim` | != `by`, age < `project_policy.claim_stale_after_min` (default 30), `!force` | **throws** `ClaimHeldError(heldBy, heldSince)` |
| `claim` | != `by`, age ≥ threshold, OR `force:true` | write `{claimedBy: by, claimedAt: now}`; `status: 'reclaimed-stale'`, `previousClaimant`: the old value |
| `release` | == `by` | clear both fields; `status: 'released'` |
| `release` | != `by` or unset | no write; `status: 'release-noop'`, `wasClaimedBy` echoes the prior value if any |
| `renew` | == `by` | bump `claimedAt: now`; `status: 'renewed'` (same-claimant renewal always succeeds, unchanged from v1) |
| `renew` | != `by` or unset | **throws** `ClaimHeldError` (renew is not a claim attempt) |

Every branch also carries `WriteContentionError`/`WriteIOError` (§4c) — an
exhausted driver-level retry on the CAS transaction above surfaces as one of
these before ever reaching the caller as a bare `WriteError`.

Output:

```ts
interface IClaimOutcome {
  uid: string;
  status: 'claimed' | 'held' | 'reclaimed-stale' | 'renewed' | 'released' | 'release-noop';
  claimedBy?: string;
  claimedAt?: string;
  heldBy?: string;
  heldSince?: string;
  previousClaimant?: string;
  wasClaimedBy?: string;
}
```

Every branch writes an `audit` node (`action: 'claimed'|'released'|'renewed'|'reclaimed-stale'`)
per §4a — claim/release/renew are state changes like any other.

`staleClaims` (v1 read) becomes `query`'s `view:"stale"` (§5, unchanged
name): `NodeFilter.metadata: { claimedAt: { lt: <now - threshold> }, claimedBy: { exists: true } }` —
pushed to SQL via the verified `MetadataFilter` operator set, never an
app-layer post-filter scan.

#### 6.3.6 `relate` / `move`

```ts
interface IRelateInput {
  sourceUid: string;
  targetUid: string;
  rel: 'relates_to' | 'supersedes' | 'blocks' | 'duplicate_of' | 'part_of';
  action: 'add' | 'remove';
  by: string;
}

interface IRelateOutcome {
  sourceUid: string;
  targetUid: string;
  rel: string;
  action: 'add' | 'remove';
  noop: boolean; // true when add found an existing edge, or remove found none — an idempotent call is stated, not disguised
}
```

Single-valued rels (`supersedes`, `duplicate_of` — each declared `1:n` in
§3, meaning ONE target per source) reject a second `add` with a DIFFERENT
target: `SingleValuedRelationConflictError(sourceUid, rel, existingTargetUid)`
(carrying forward BUG-025/BUG-044's "never silently pick one" rule). A
second `add` with the SAME target is `noop:true`, not an error.

```ts
interface IMoveIssueInput {
  uid: string;
  toComponent: string; // uid or name, resolved per §6.1
  by: string;
}
```

`move` is `invalidateEdge(old owns_component)` + `writeEdge(new
owns_component)` + audit, atomically (§4, `moveIssue`, unchanged). It is a
DISTINCT verb from `relate` because `owns_component` is a structural
placement (exactly one component per issue, enforced by having exactly one
live `owns_component` edge at a time), not a peer relation — collapsing it
into `relate`'s five-rel union would let a caller `relate(issue, component,
'owns_component', 'add')` without ever invalidating the old edge, silently
producing two live `owns_component` edges for one issue. Keeping `move` a
dedicated verb makes that impossible by construction.

Errors (both verbs): `IssueNotFoundError` (either endpoint),
`CatalogNotFoundError('component', toComponent)` (`move` only),
`SingleValuedRelationConflictError` (`relate` only), `InvalidArgumentError`
(`sourceUid === targetUid` on `relate` — a self-relation is always a client
error, never silently written), `WriteContentionError`/`WriteIOError` (§4c,
both verbs — an exhausted driver-level retry on the underlying `immediate`
transaction).

#### 6.3.7 `delete` (bi-temporal soft-delete)

```ts
interface IDeleteIssueInput {
  uid: string;
  reason: string; // REQUIRED — mirrors v1's softDeleteItem(reason), still real
  by: string;
}
```

Maps directly onto the library's `invalidate(nodeId, reason)` primitive
(§3: "bi-temporal — never a hard delete"). No content is destroyed; the
node stops appearing in default (`liveOnly`) queries. Output:
`{ uid, invalidated: true }`. Errors: `IssueNotFoundError`,
`InvalidArgumentError('reason', ...)` when blank, `WriteContentionError`/
`WriteIOError` (§4c).

### 6.4 `create`'s duplicate gate — resolved

**The tension, stated exactly:** §1 mandates `skipDedupe: true` on every
entity write, which disables the LIBRARY's global content-hash dedup —
because content must never collapse two rows into one (identity is `uid`,
never content). But v1's dedupe gate (`DedupeScanInput`,
`duplicateCandidates`, `force`/`duplicateAction`) was never about identity
collapse — it is a **filing-time interception product feature**: warn a
caller who is about to re-file something that already exists, before they
mint a redundant row. These are two unrelated mechanisms that happened to
share a name (`skipDedupe`) in v1. §4 already resolves the identity half
(`skipDedupe:true`, unconditionally). This subsection resolves the
product-feature half, which stays real:

1. **`createIssue` runs an app-level pre-write similarity scan** — never
   the library's disabled content-hash path. It calls the SAME
   `StoreSearchBackend.searchRanked` primitive §5a already wires for
   `view:"similar"` (`signals:[{text},{vec}]`), scoped to
   `filter.project` (the target project only — cross-project title
   collisions are not duplicates), over `{title, body}`.
2. **Threshold is data, not code** — extending DATA_MODEL_v2 §2's
   `project_policy` table with two more project-tunable columns:
   `dedupe_scan_enabled` (default `true`) and `dedupe_threshold` (default
   `0.8`, the fused `searchRanked` score above which a candidate counts as
   a likely duplicate). A project that files many superficially-similar-but-
   distinct issues can raise its own threshold or disable the scan; the
   default stays on for every project that never opts out.
3. **`duplicateAction` decides what happens when the scan finds ≥1
   candidate at or above threshold:**
   - `'abort'` (default) — nothing is written. Response:
     `{created:false, reason:'duplicate-suppressed', duplicateCandidates}`.
   - `'force'` — the scan still runs (candidates are still reported, for
     the caller's own audit trail) but the write proceeds regardless,
     producing a genuinely new `uid` (this is exactly where the library's
     `skipDedupe:true` matters: two issues with byte-identical bodies are
     two rows, per §1, and `force` is how a caller deliberately files one
     anyway).
   - `'comment'` — no new issue node is written. Instead, a `note` node
     (§3: `{author, text, at}`) is created and linked via `has_note` to the
     **top-scoring** candidate, with `text` set to the WOULD-BE issue's
     title+body verbatim (so the duplicate's content is never lost, just
     not promoted to its own row) and `author: by`. Response:
     `{created:false, commentedOn:{uid: topCandidate.uid, noteId}}`. This
     is a clean fit onto existing §3 primitives (no new node type,
     no dupe-counter field to maintain) rather than the current surface's
     `dupeHits` mechanism, which dies along with the rest of that
     interface's scaffolding.
4. **`searchRanked` unavailable (no embedding backend configured, §5a
   `rag_not_configured`)** degrades the scan to FTS-only (`signals:[{text}]`)
   rather than skipping it — a title/body keyword match is still a real
   duplicate signal even with zero vector infrastructure, so the gate never
   silently goes dark just because semantic search isn't wired up yet.

### 6.5 `query` — pagination and field projection, resolved

```ts
interface IIssueQueryInput {
  filter?: IIssueFilter;
  fields?: readonly IIssueField[];
  sort?: 'priority' | 'updated' | 'created' | 'relevance' | 'textMatch';
  direction?: 'asc' | 'desc';
  limit?: number;   // default 50, max 1000 (MAX_QUERY_LIMIT unchanged from v1) — see composition rule 6 below
  after?: string;   // opaque keyset cursor from a prior page's `nextCursor` — see rule 5
  view?: 'list' | 'ready' | 'graph' | 'order' | 'stale' | 'similar' | 'overlap'; // §5's existing view union, carried forward
}

interface IIssueFilter {
  project?: string;   // uid or name
  component?: string; // uid or name, scoped within project
  kind?: string | string[];
  status?: string | string[] | 'open' | 'closed' | 'all'; // v1's IStatusSelector, unchanged
  priority?: string | string[];
  assignee?: string;
  claimedBy?: string;
  author?: string; // resolves via authored_by edge traversal
  grep?: string;      // FTS keyword, title+body — stays keyword-only, never hybrid (unchanged rule)
  semantic?: string;  // routes to searchRanked (§5a) — composes with grep, neither swallows the other
  anchor?: string;    // item-anchored similarity seed (§6.1) — uid of the reference item
  closedAt?: { since?: string; until?: string };
  createdAt?: { since?: string; until?: string };
  updatedAt?: { since?: string; until?: string };
}
```

`fields` — the closed vocabulary (`IIssueField`), unknown name →
`BacklogValidationError` naming it, never a silent drop (`assertKnownFields`,
carried forward unchanged — this is a general correctness rule, not v1
scaffolding):

```
plain (cheap, always included when requested):
  uid, title, kind, status, priority, project, component,
  createdAt, updatedAt, assignee, author
pseudo (opt-in only — never in the default card, each costs a real extra read):
  body, citations, notes, auditTrail, blockers, related, closedAt,
  _score, _vector
```

Default (`fields` omitted): `['uid', 'kind', 'title', 'status', 'priority']`
— the exact five-field terse card v1's `DEFAULT_CARD_FIELDS` already
established; there was never a reason to change the default's shape, only
its key names (`humanId` → `uid`).

**Pagination — resolved fully, one composition algorithm:**

1. **Bounds.** `limit` must be a positive integer ≤ `MAX_QUERY_LIMIT` (1000,
   unchanged from v1). Absent → default `50`. Out of range or non-integral
   → `BacklogValidationError('limit', ...)`, never a silent clamp (unchanged
   `assertQueryLimit` rule — a cap that isn't an error is indistinguishable
   from a complete result, which is exactly BUG-BACKLOG-003's class of bug).
2. **Page shape** — every `query` response, regardless of `view`:
   ```ts
   interface IIssuePage {
     items: IIssueCard[];
     nextCursor?: string; // pass back as `after` for the next page; absent ⇒ no more pages
     hasMore: boolean;
   }
   ```
3. **Resolving edge-scoped filters to a candidate rowid set.** `kind`/
   `status`/`priority`/`project`/`component`/`author` are catalog/registry
   references living on EDGES (`has_kind`/`has_status`/`has_priority`/
   `owns_component`/`owns_project`/`authored_by`), not `NodeFilter` columns.
   For each such filter present: resolve the referenced catalog/registry
   node's internal rowid (via `getNodeByUid` if given as a `uid`, or
   `queryNodes({kind:'<catalog>', name})` if given as a name — §6.1), then
   call `getEdges({dst: thatRowid, rel: '<the has_* rel>'})` (verified
   primitive, `dist/index.d.ts:304-309` interface declaration, `692-697` in
   the concrete backend class) and collect the `src` values
   (candidate issue rowids). When more than one such filter is present,
   **intersect** the candidate sets (AND semantics — an issue must satisfy
   every edge-scoped filter given).
4. **Composing the final query.** Build one `NodeFilter`:
   `{ kind:'issue', ids: <the intersected candidate set, when any
   edge-scoped filter was given — omitted entirely when none was>,
   tCreatedAfter/tCreatedBefore (from filter.createdAt),
   tUpdatedAfter/tUpdatedBefore (from filter.updatedAt),
   metadata: { assignee, claimedBy, closedAt: {...} } (from the
   corresponding filter fields, using the verified operator set),
   after, limit: limit+1, orderBy, orderDir }`. `grep`/`semantic` route
   through `searchNodes`/`searchRanked` INSTEAD of `queryNodes`, passing the
   SAME `ids` restriction as their own `filter` argument (both accept one,
   verified: `searchNodes(query, {limit?, offset?, filter?: NodeFilter})`)
   so a keyword/semantic search still composes with every edge-scoped
   filter rather than searching the whole store and filtering after.
5. **Keyset stability (`after` given).** Per the verified library contract
   (`dist/index.d.ts:206-212`): `after` compiles to `WHERE rowid > ?
   ORDER BY rowid ASC`, **ignoring** `orderBy`/`offset` entirely. So: a
   caller that supplies `after` gets rows in insertion order and MAY NOT
   also supply `sort` — `query({after, sort:'priority'})` throws
   `InvalidArgumentError('sort', 'sort is incompatible with keyset
   pagination (after) — request the first page unsorted, or page by
   offset if a non-insertion order is required')`. This ordering is
   provably stable and gapless under concurrent writes: every page's
   cursor is a strictly-increasing rowid boundary, a concurrent INSERT
   always lands at a HIGHER rowid than anything already paged (so it can
   only ever appear on a LATER page, never re-appear on an earlier one or
   split one already returned), and a concurrent `invalidate` merely
   removes a row from a future page's `liveOnly` filter — it can never
   re-order or duplicate an already-returned row. This composition IS
   what acceptance criterion 8 (§9) tests.
6. **Offset-based paging (`after` absent, `offset` may be given via a
   second call incrementing a running total) supports arbitrary `sort`**
   (`priority`/`updated`/`created`/`relevance`/`textMatch`) but is
   EXPLICITLY not stable under concurrent writes — an insert/invalidate
   between two calls can shift the offset window, duplicating or skipping
   a row. This is the library's own documented tradeoff
   (`dist/index.d.ts:209`: "offset is O(offset) and unstable under
   concurrent writes; keyset is the pagination primitive"), restated here
   as a hard consumer-facing contract: a caller that needs a guaranteed-
   complete, non-overlapping traversal of a large result set MUST use
   `after`/insertion order; `sort` + `offset` is for a human-facing,
   best-effort "show me the top N by priority" view where an occasional
   missed/duplicated row under concurrent writes is an acceptable
   tradeoff for a meaningful order, never for a completeness-critical scan.
7. **`hasMore` / `nextCursor` derivation.** The store is queried with
   `limit+1` rows. If exactly `limit+1` rows come back, the last one is
   dropped from `items`, `hasMore:true`, and `nextCursor` is set to the
   LAST **returned** row's internal rowid, opaquely stringified (a decimal
   string — a consumer must never parse or otherwise interpret it, and
   must never persist it across an ETL rebuild, since rowids are
   per-store per §1). If `limit` or fewer rows come back, `hasMore:false`
   and `nextCursor` is absent.

### 6.6 The `admin` verb — action-by-action disposition

`admin` itself does not survive (§7 — it is one of the six wiped verbs).
Every action it carried is accounted for:

| v1 admin action | v2 disposition |
|---|---|
| `import`, `migration_status`, `set_migration_phase`, `reconcile_repo`, `migrate_model_v2` | already wiped by §7 (markdown `import`, migration-phase machinery, repo-migration module) — no v2 surface at all |
| `render`, `export` | folded into `query`'s output: `format:'markdown'` (new) alongside the existing `format:'json'` — a plain read, not an admin mutation. Markdown headers render the issue **title** (never `uid`); citations render `[target sha:…]` (unchanged from the current surface's stated projection rule) |
| `archive` | no longer a mutation at all — see §6.2's `ArchiveOpts` row: `status.terminal` is the only exclusion signal the default projection needs |
| `merge` | 1:1 mapping onto `relate('duplicate_of')` + `delete` — §6.2 |
| `embedding_backfill` | already specified: §4b's `reembed` (batch, backfill-only) |
| `embedding_health`, `list_near_duplicates` | fold into `query`'s `view:"similar"` (§5a) — a health/near-duplicate report is exactly "run the similarity view over the whole corpus," not a distinct admin code path |
| `doctor`, `prune`, `run_dedup_sweep`, `cluster_into_plans`, `promote_cluster_to_plan` | **not part of the v2 consumer surface.** These are one-shot/periodic maintenance operations, not a product feature a caller addresses by `uid`. Per this repo's own package-scaffolding rule ("reusable tooling belongs in a script/plugin, one-shot migrations are a throwaway script — never a mounted verb"), if any of these are still needed operationally they are scripts run directly against `v2-write.ts`/`v2-query.ts`, never re-admitted as a 20th grab-bag `admin` action — that grab-bag shape is precisely what the named, individually-typed verb surface (§4, §6.3) replaces. |
| `skill`, `version` | both are host-adjacent, store-free introspection — same carve-out class as `install`/`install-skill`/`serve` (server.ts:139's `BACKLOG_HOST_COMMANDS`), extended to include them, rather than mounted as data verbs. Neither ever opened the store in v1 either (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001's whole point), so nothing changes about how they run — only that they are formally carved out instead of living inside `admin`. |
| `batch` | not backlog-specific code — `apigen-plugin-batch`'s generic `batch_action` fan-out is inherited automatically the moment v2's nine verbs mount through the same apigen plugin surface (`usePlugins:[batchPlugin]`, unchanged from server.ts's current wiring). Nothing to design here. |

### 6.7 Transport surfaces

CLI/MCP/HTTP each mount the nine issue verbs plus §3a's registry verbs
through the same one-descriptor→four-projection mechanism `server.ts`
already uses (`describeMountedSurface`/`project(op)`) — unchanged
mechanism, new operation list. MCP tool names follow the existing
`backlog_<verb>` convention (`backlog_get`, `backlog_query`, `backlog_create`,
`backlog_update`, `backlog_transition`, `backlog_claim`, `backlog_relate`,
`backlog_move`, `backlog_delete`, plus `backlog_lookup` and the registry
CRUD verbs from §3a). CLI commands follow the same leaf-name convention
(`backlog get`, `backlog query`, ...). Every response is `uid`-keyed;
`BACKLOG.md`/markdown projection renders issue **titles** as headers (never
`uid`s) with `[target sha:…]` citations, per §6.6's `format:'markdown'`.
Web UI list/detail/stats views read the catalogs and edges directly through
`query`'s `view`/`groupBy` axes, exactly as the current surface's stats
views already do — no separate web-specific query path.

## 7. Wipe (full hard replacement — the v1 app layer is deleted)

The entire v1 application layer is deleted, not retired: `humanId` machinery,
`idOverride`, `importedFrom`, repo-string identity, the repo-migration module,
migration-phase machinery, `repoWarning`, the markdown `import` action,
`firstTerminalTransitionAt` reconstruction, hardcoded
terminal/citation/reason knobs, and the six-verb v1 surface it all served. The
**repo-nodes / repo-string machinery is replaced by the registry (§3a)**:
`parseRepoKey`/`canonicalRepoKey`, `resolveRepository`/`lookupRepository`,
`setRepositoryFork` (`DERIVED_FROM`), `dimensionGraph` (the second GraphBackend
with `IN_REPO`/`IN_PACKAGE`/`PROJECT_OF`/`AUTHORED_BY`/`REPORTED_BY`),
`findItemNodesInRepository`'s legacy-alias leg, and the package-key machinery —
all folded into first-class `project`/`component`/`location` nodes + `lookup`.
There
is no coexistence shim and no legacy-id fallback: the v2 layer is the only
surface, and old id-based references stop resolving by design. The store DATA is
migrated once by the ETL (§8); the store FILE is never mutated in place.

## 8. Migration (ETL)

**Direction, once, never in place.** The live v1 store (`entrypoint/backlog/dist`,
603 open / 1476 total items at last count — `backlog query --input
'{"limit":1,"filter":{}}'`, run 2026-09-04) is read through its existing public
API only; a brand-new v2 file is created with the open v2 schema and every live
v1 record is written into it fresh via the v2 write layer (§4), `skipDedupe:
true`. The old file is never opened for write and is retained untouched as the
pre-migration backup (DATA_MODEL_v2 §9). "Re-run" means: re-run this same
script against the same v2 target file, runnable only once `graph-store@0.9.1`
(§0) is the published dependency the write layer builds against — §8.7 makes
a re-run safe whether the target is empty or half-populated.

**Gate.** The ETL does not start until the BUG-039 write-safety proof
(DATA_MODEL_v2 §9 point 0, SPEC-v2 §10.4) is green on the exact v2 write path
it will use — never write real data onto an unproven write path.

### 8.1 Field mapping — `issue`

Source: `BacklogItem` (model.ts:128-170) as materialized by `toBacklogItem`
(store/mapping.ts:245-275) from `BacklogNodeMeta` (store/mapping.ts:111-185).

| v1 field | v2 destination | Transform |
|---|---|---|
| `nodeId` | — (no v2 identity meaning) | Used only as the ETL's own join key (§8.3); never written anywhere in v2. |
| `humanId` | — (no v2 field) | Not an identity. Recorded verbatim in the crosswalk (§8.3) and in the per-issue migration `audit` note (§8.2a) so it stays human-searchable. |
| `kind` | `kind` catalog row + `has_kind` edge | The write layer's hand-composed find-then-create (§4c: a `tx.executeGet` SELECT by `(kind:'kind', name:value)` against the SAME `immediate`-mode transaction, INSERT on a miss) — never a call to `findOrCreateNode()` itself, which §4c proves is two non-transactional autocommit statements. `kind` is open vocabulary in both v1 (humanId prefix, model.ts:134) and v2 (SPEC-v2 §0.2) — every distinct string observed (`BUG`, `DEBT`, `FEAT`, … through outliers like `nx`, `zz`, `docs` — confirmed live via `query --input '{"view":"summary"}'`'s `byKindAllStatuses`) becomes its own catalog row, no allowlist. |
| `family` | — (no v2 field) | `family` is purely `humanId`-derived (store/mapping.ts:191-193) and has no meaning once `humanId` is gone. Folded into the audit note (§8.2a). |
| `title` | `issue.title` | Verbatim. |
| `body` | `issue.body` | Verbatim, untouched — including any humanId-shaped text inside it (§8.3's "free text is not rewritten"). |
| `status` | `status` catalog row + `has_status` edge | The write layer's hand-composed find-then-create (§4c), scoped to `(kind:'status', name:value)`. Catalog seeded once, up front (§8.6 step 2) with `terminal` taken directly from `TERMINAL_STATUSES` (model.ts:56-68) — not re-derived per item. |
| `priority` | `priority` catalog row + `has_priority` edge, iff present | The write layer's hand-composed find-then-create (§4c), scoped to `(kind:'priority', name:value)`; `rank` seeded from the already-existing `PRIORITY_RANK` constant (store/query.ts:32: `CRITICAL:0, HIGH:1, MEDIUM:2, LOW:3`) — reused verbatim so every v1 sort-by-urgency comparator ports unchanged. No edge written when `priority` is absent (~36% of the corpus, per `byPriorityAllStatuses` summing to 937 of 1476) — never defaulted to a fabricated value. |
| `repo` | `project` catalog row (the write layer's hand-composed find-then-create, or `upsertProject` — §4c/§3a) | Normalized per §8.3, then an issue is never linked to a project directly — see `projectPath` below for the required `owns_component` hop. |
| `projectPath` | `component` row (`upsertComponent`) + `owns_component` edge | The write layer's hand-composed find-then-create (§4c) scoped by project `uid` (§1's edge-scoped uniqueness policy) — the same composition `upsertComponent` (§3a/§4) uses, never a call to `findOrCreateNode()`. **Gap resolved:** SPEC-v2's edge table has no direct project→issue edge — every issue must hang off a `component`. A v1 item with no `projectPath` (repo-level item) is filed under a synthetic **default component** named `(root)`, one per project, created the same way as any other component (unique per project, §1) — not a new edge kind, just a real component that happens to represent "no sub-area." |
| `plan` | — (no v2 field) | No plan catalog in this spec (§11: data-model changes beyond it are out of scope). Folded into the audit note (§8.2a). The v1 `MEMBER_OF` edge to the synthetic plan node (store/structure.ts:351-359) collapses into the same note — it is the graph realization of this same string, nothing more. |
| `importedFrom` | — (no v2 field) | The markdown-import subsystem is wiped (§7). Folded into the audit note. |
| `assignee` | — (no v2 field/edge) | SPEC-v2 defines no assignment concept (§3/§4 have no assign verb or edge). Folded into the audit note — a real capability gap versus v1, flagged for the reader, not silently absorbed. |
| `claimedBy` / `claimedAt` | — (not migrated) | An ephemeral lease (model.ts:152-154) from a decommissioned process is not actionable in the new store. Every v2 issue starts unclaimed. The fact of the lease (who, when) is still recorded in the audit note — discarding the STATE is a decision; discarding the FACT would be a silent drop. |
| `citations` | `citation` nodes + `has_citation` edges | §8.2 below. |
| `notes` | `note` nodes + `has_note` edges | §8.2 below — MINUS any note consumed as a transition's `note` (§8.2 transition reconstruction), which is not double-migrated. |
| `tags` (user tags only; reserved tags already stripped by `toBacklogItem`, mapping.ts:269) | — (no v2 field) | Folded into the audit note. |
| `createdAt` | `issue.created_at` | Verbatim. |
| `updatedAt` | `issue.updated_at` | Verbatim. |
| `author` | `agent` catalog row + `authored_by` edge, iff present | The write layer's hand-composed find-then-create (§4c), scoped to `(kind:'agent', name: canonicalIdentityKey(author))` — `canonicalIdentityKey` (model.ts:2306-2315) is reused verbatim so `researcher:a1b2c3` and `researcher:xyz` collapse to one `agent` row, exactly as AC-14 already requires live. |
| `reporter` | — (no v2 edge) | SPEC-v2 §3's edge table has `authored_by` only — no `reported_by` (the `REPORTED_BY` member on v1's `IEdgeOutcome.rel` union, model.ts:2569, never shipped as a real edge kind here). Folded into the audit note. |
| `closed_at` (no v1 field; realized as `issue.meta.metadata.closedAt`, not a column — §6.3.4) | `issue.meta.metadata.closedAt` | Reconstructed per the current (pre-replacement) production surface's own reconstruction pattern (`src/v2/get.ts:623-631`'s `firstTerminalTransitionAt`, itself wiped by §7 and superseded by §6.3.4's write-time `meta.metadata.closedAt` stamp) — reused here only as the RULE for what counts as the closing event, not as a surviving code path: first real persisted `transition` audit event whose `to` is terminal. For the 621-of-1476 items with no persisted transition history (§8.2's transition-reconstruction gap; live `coverage.itemsWithHistory: 855` of `itemsTotal: 1476`, `query --input '{"view":"summary"}'`), no genuine timestamp exists — `closed_at` falls back to `updatedAt` for a currently-terminal item, and this fallback is called out by name in that issue's synthesized transition note (§8.2) so it is never mistaken for a real reconstruction. |

### 8.2 Field mapping — events (citations, notes, transitions)

**Citations → `citation` node + `has_citation` edge**, one per v1 `Citation`
(model.ts:85-108):

| v1 field | v2 field | Transform |
|---|---|---|
| `file` | `target` | Verbatim (already repo-relative per the file's own doc comment, model.ts:86). |
| — (derived) | `target_type` | `'url'` if `file` parses as an absolute URL, else `'path'`. |
| — (v1 has none) | `at` | v1's `Citation` carries no timestamp of its own — even `auditTrail()` admits this and reuses `item.updatedAt` as its own best-effort proxy (store/query.ts:942-943). The ETL reuses the same existing proxy rather than inventing a second convention, and records "at is a proxy, not a genuine citation timestamp" in the audit note. |
| `lines` | folded into `target` string is NOT done (see below) | Not truncated. |
| — | `sha` | **DATA_MODEL_v2 §10 open point 1, resolved:** re-hash the *current* content at `target`, scoped to the issue's project `path` (only the `adhd` project has a known filesystem `path` per §8.3 — every citation belonging to any other project is therefore automatically unverifiable, for the same honest reason as a missing file). See §8.5 (Citation repair) for the full rule and the failure case. |
| `lines`, `context`, `symbol`, `blastRadius` | — (no v2 citation field) | None of these exist on v2's `citation` shape (SPEC-v2 §3: `{target, target_type, sha, line, at}`). Folded verbatim, per citation index, into the issue's migration audit note (§8.2a) — the exact line-range and blast-radius enrichment is never silently truncated to `line`'s single int, it just isn't a first-class column anymore. |
| — (parsed from `lines`) | `line` | Best-effort parse of the START line out of `lines` (e.g. `"42-58"` → `42`; bare `"42"` → `42`; absent → omitted). The full range lives in the audit note as above. |

**Notes → `note` node + `has_note` edge**, one per v1 `Note` (model.ts:122-126) —
the cleanest 1:1 mapping in this migration: `by`→`author`, `text`→`text`,
`at`→`at`, all verbatim, all real (v1 notes, unlike citations, always carry a
genuine timestamp). Exactly one exclusion: a note consumed by the transition
reconstruction below is migrated as that transition's `note`, not duplicated as
a separate `note` node.

**Transitions → `transition` node + `has_transition` edge.** v1's real,
persisted transition history lives in `audit-log.ts`'s events
(`writeAuditEvent`, store/audit-log.ts:66-99), written only for a `'transition'`
kind with `detail = {from, to, by, reason?}` (store/lifecycle.ts:104) — **note
that this detail object has no `note` field of its own.** The free-text note
(`opts.note`), when the caller supplied one, was pushed as a separate `Note`
entry in the SAME `mutateMetadata` call, stamped with the identical `by` and
the identical `nowIso` string (store/lifecycle.ts:88-93) — not merely close,
byte-identical, because both come from one JS statement. Reconstruction:

1. **Reason-carrying transitions** (terminal-dismissed statuses): `detail.reason`
   already holds the bare reason text (store/lifecycle.ts:104) — use it
   directly as `transition.note`. No join needed.
2. **Note-carrying transitions**: join the audit event to the `Note` whose
   `(by, at)` exactly matches `(detail.by, event.at)`. When found, that note's
   `text` becomes `transition.note`, and the note is EXCLUDED from the separate
   `note`-node migration above (it is not duplicated).
3. **Bare transitions** (no reason, no matching note — `opts.note` was
   optional and simply omitted): synthesize `transition.note =
   "[note_synthesized] <from> → <to> by <by>, no note recorded"` — reusing
   DATA_MODEL_v2 §9 point 3's own term verbatim. Never fabricate content that
   wasn't there.
4. **Items with zero persisted transition history** (the 621-of-1476 gap
   above — every item last touched before the audit-log fix landed, live
   `coverage.auditWindowStart: 2026-07-24T15:44:39.159Z`): the ETL writes
   exactly **one** synthetic `transition` node per such issue: `from_status =
   null` (genuinely unknown — never guess a plausible prior status),
   `to_status` = the item's current status, `agent` = the item's `author` (or
   the literal string `unknown` if even that is absent), `at` = `createdAt`,
   `note = "[note_synthesized] pre-audit-log history unrecoverable; status at
   migration time: <status>"`. `sha` is computed the normal way (§4a) over
   whatever was actually written — a hash of the record, not a truth claim
   about history. This is what makes v2's hard "no bare transition" rule
   (agent+note+sha always present) hold for every migrated issue without
   inventing a false narrative.
5. **`claim`/`renew`/`release` events** are not status transitions and have no
   v2 destination as `transition` nodes (v2 has no lease concept, per §8.1's
   `claimedBy` row). Folded verbatim into the audit note.

**The migration audit node (§8.2a).** Every migrated issue gets exactly one
extra `audit` node (§3's shape: `{actor, action, target_uid, from, to, note,
sha, at}`), `actor: 'etl'`, `action: 'migrated'`, linked by `audits` — this is
where every field above marked "folded into the audit note" actually lands, as
one JSON blob in `note`: `{v1Repo, v1HumanId, v1Family, v1Plan,
v1ImportedFrom, v1Assignee, v1Tags, v1Reporter, v1ClaimState?, v1RenamedFrom?
(the node's `renamedFrom` history, store/mapping.ts:142-151, when non-empty),
citationExtras: [{index, lines, context, symbol, blastRadius}]}`. This same
blob is what the crosswalk (§8.4) and the restart resume-set (§8.7) are
rebuilt from — there is no separate stamp on the issue's own metadata. Nothing
is ever silently dropped; it is either a first-class v2 field/edge, or it is here,
verbatim, once, per issue — never both silently discarded and unmentioned.

### 8.3 Edges

| v1 edge (direction) | v2 edge (direction) | Notes |
|---|---|---|
| `RELATES_TO` (issue→issue, one directed edge standing in for a symmetric relation — model.ts:2592-2599, store/link-related.spec.ts:68) | `relates_to` (issue→issue, n:m) | Same direction, copied once. |
| `SUPERSEDES` (new→old, store/structure.ts:267 via `graph.supersede()`) | `supersedes` (issue→issue, lowercase, catalog relation — SPEC-v2 §3) | Same direction (new→old). SPEC-v2 §3 explicitly keeps the two vocabularies (uppercase content-mutation vs. lowercase catalog relation) distinct; the ETL writes the catalog form since it is not performing a live content edit. |
| `SAME_AS` (drop→keep, store/structure.ts:334) | `duplicate_of` (issue→issue, 1:n) | v1 has no edge named `duplicate_of` at all — `SAME_AS` is `mergeItems`' actual mechanism and is the only source of duplicate-relation data. Same direction (dropped/duplicate → kept/canonical). |
| `PART_OF` (child→parent, store/structure.ts:300) | `part_of` (issue→issue, 1:n) | Same direction; matches SPEC-v2 §3's own framing ("hierarchical items, FEAT-005") exactly. |
| `DEPENDS_ON` (dependent→dependency, i.e. `src` can't proceed until `dst` is done — store/structure.ts:66, confirmed by `blockers()`'s own semantics at store/query.ts:806-813: it returns the non-terminal targets of `src`'s own `DEPENDS_ON` edges) | `blocks` (blocker→blocked, SPEC-v2 §3: "inverse = blocked_by, derived") | **Direction is REVERSED, not copied.** v1 `A DEPENDS_ON B` means B blocks A; v2's `blocks` edge is written `B → A`. SPEC-v2 §3's own edge table defines `depends_on` as `component → component` — a different, component-scoped relation with no v1 source data at all (this ETL writes zero rows into it; it is seeded, empty, for future component-dependency work). The issue-level blocking relation v1 actually has lives entirely in `blocks`. Getting this backwards silently inverts `topoOrder`/readiness semantics. |
| `MEMBER_OF` (item→plan node, store/structure.ts:351-386) | — | No v2 destination (§8.1's `plan` row). |
| `IN_REPO` / `IN_PACKAGE` / `PROJECT_OF` / `DERIVED_FROM` (repo-dimension scaffolding, store/repo-nodes.ts:130-148, store/audit-log.ts:99) | — (replaced, not migrated) | This machinery is explicitly wiped and replaced by the registry (§7); it is not copied as data. Its INFORMATION seeds the repo normalization decision below instead. |

### 8.4 Identity remapping

**uid assignment.** The ETL never mints or chooses a `uid`. Each v2 `writeNode`
call (§4, `skipDedupe: true`) returns a DB-generated `uid` (§1); the ETL reads
it off the just-written `NodeRecord` and records it.

**The crosswalk.** Keyed on `${normalizedRepo}::${humanId}` → `uid`, held
in-process as an in-memory `Map` while Pass 1 (§8.6) runs, appended to as each
issue's transaction commits — never durable by stamping the issue's own
metadata. Durability instead rides on the migration `audit` node §8.2a already
writes, in the SAME transaction, for every migrated issue
(`actor:'etl', action:'migrated'`, linked by `audits`): its `note` JSON already
carries `v1Repo`/`v1HumanId` (and `v1RenamedFrom` when the node was renamed,
§8.2a). On a fresh start this in-memory `Map` is simply empty; after a crash
the crosswalk is REBUILT by scanning those `audit` nodes and reading
`target_uid` + `v1Repo`/`v1HumanId`/`v1RenamedFrom` back out of each one's
`note` (never by a query against the issue nodes themselves) — the same scan
§8.7 uses to compute the resume-set. This keeps the crosswalk fully
restart-safe with zero permanent legacy-identity residue on the
live issue's own `meta.metadata` — an on-issue stamp would put `repo`/
`humanId` back onto the very node §0 anti-antipatterns 1 and 5 forbid them
from, and would be a second, redundant copy of data the migration `audit`
node already holds durably.

Every entry in a migrated issue's `renamedFrom` (store/mapping.ts:142-151 —
append-only history of prior `(repo, humanId)` identities the node carried
before a rename) is added to the crosswalk as an ADDITIONAL alias for the same
`uid`. v2 never resolves by old id at runtime (§7: "old id-based references
stop resolving by design"), but the ETL's OWN edge-rewriting pass (below) must
still resolve a v1 edge recorded against a pre-rename humanId to the correct,
current node.

**Repo-key normalization.** The live corpus (`byRepoAllStatuses`, `query
--input '{"view":"summary"}'`, run 2026-09-04) confirms both `"adhd"` (6
items) and `"PseudoSky/adhd"` (342 items) are live today, plus 15 other
distinct repo strings (`sox-ecosystem`, `claude-agents`, `claude-tools`,
`reverse-apis`, `global`, `scratch`, `legacy-repo`, three `zz-*-scratch-*`
probes, `refuter-test-repo`, `qusecure/ceo-report`, `id8/dot`, two
`PseudoSky/*` test repos — 17 distinct repo strings total). Resolution:

- `adhd` / `PseudoSky/adhd` reconcile to **one** `project` row, name `"adhd"`
  — the bare form v1's OWN existing `normalizeRepoKey` (model.ts:2219-2226:
  strip `.git`, take the last path segment) already treats as canonical, and
  the exact name SPEC-v2 §3's own worked example uses. `repoUrl` is seeded
  `git@github.com:PseudoSky/adhd.git` (SPEC-v2 §3's own example value) — the
  owner-qualified form is not lost, it moves to the field that means "git
  remote," not "display/slug name." `path` is seeded from the ETL process's
  own cwd (`/Users/nix/dev/node/adhd`), the one project this ETL can verify
  directly.
- **Every other distinct repo string becomes its own `project` row, 1:1,
  never merged into a shared bucket and never dropped** — this is the
  explicit decision DATA_MODEL_v2 §9 point 3 asks for regarding
  `global`/`scratch`/`legacy-repo`-shaped strings. Rationale: each already
  carries real, distinct issues (1 to 190 of them); silently merging
  unrelated repos to "unmanaged" would be a second instance of exactly the
  `adhd`/`PseudoSky/adhd` collapse-by-string-drift bug this ETL exists to
  fix, just aimed at genuinely different projects. `path`/`repoUrl` are left
  unset for all of these (the ETL has no reliable way to know another
  machine's checkout path) — a real registry gap (§3a), filled later by an
  operator's own `upsertProject`/`upsertLocation`, never fabricated here.
  This does not block issue migration: `owns_component`/`owns_project`
  wiring only needs the `project` row to exist, not its registry fields.

**Structural reference rewriting.** Every edge in §8.3 is rewritten through
the crosswalk (v1 `(repo, humanId)` → v2 `uid`) before being written — this is
the only rewriting this ETL performs. **Free text (`body`, `note.text`,
citation `context`) is never rewritten.** §7 already states the governing
rule: "old id-based references stop resolving by design" — a humanId
mentioned in prose is expected to go dark after cutover, and mangling
historical prose to keep it "resolving" would corrupt the record for a
guarantee the spec explicitly does not make. The ~320 items whose structured
`Citation.file` entries point at now-deleted `BACKLOG.md` files (a different
case — a real column, not prose) are handled by Citation repair below, not by
rewriting.

**Dangling-reference detection.** Scoped to the five structural edge kinds in
§8.3 (a closed, enumerable set — not an open-ended free-text scan). After Pass
1 completes and the crosswalk is final, every v1 edge endpoint referenced by
`relates_to`/`blocks`/`supersedes`/`duplicate_of`/`part_of` is checked against
the crosswalk. Any endpoint that fails to resolve — the referenced v1 node was
itself skipped or failed (§8.7) — is logged as a `danglingReference` (source
humanId, target humanId, edge kind) and the edge is not written. **A non-empty
`danglingReference` list is a hard fail of the acceptance gate (§8.7)** — it
means some other item's migration failed silently, not that the reference was
ever meant to dangle.

### 8.5 Citation repair (~320 items, `Citation.file` → now-deleted `BACKLOG.md` paths)

Resolves DATA_MODEL_v2 §10 point 1. For every citation:

1. Resolve the issue's owning project's `path` (only `adhd` has one — §8.4).
   No known project path ⇒ go to step 3 directly.
2. If `target` resolves to a real, readable file under that `path`: compute
   `sha256` of its CURRENT content and write it as `citation.sha` — a
   verified-at-migration-time hash, not the (nonexistent, per §8.2) original
   filing-time hash. `target` is carried verbatim, unrewritten (it was already
   correct, repo-relative — nothing to fix).
3. If `target` does not resolve (the file was deleted, moved, or belongs to a
   project with no known `path`): `citation.sha = "unverified"` — a fixed,
   non-hex sentinel string, deliberately never a plausible-looking fake hash,
   so a caller can tell "genuinely re-hashed" from "we could not verify" by
   checking `sha === "unverified"` without a new schema column. `target` is
   still carried verbatim — there is no correct replacement path to rewrite it
   to (the content moved into the graph itself when `BACKLOG.md` stopped being
   authoritative; it did not move to a new file). Never invent one.

The ETL run report counts citations landing in step 3 (`citationsUnverified`)
so an operator can see the true scope, separately from the acceptance gate
(§8.7), which does not require citations to verify — only that every citation
was migrated with a real `sha` value of one of the two kinds above, never a
missing or fabricated one.

### 8.6 Write ordering

1. **Preflight gate** (BUG-039 write-safety proof, §10.4) — must be green
   against this exact v2 file before step 2 runs.
2. **Seed the closed, statically-known catalogs**: `status` (from
   `BacklogStatus`'s full union, model.ts:11-34, `terminal` from
   `TERMINAL_STATUSES`) and `priority` (from `Priority`'s union, `rank` from
   `PRIORITY_RANK`, store/query.ts:32). These need no data scan — the vocabulary
   is a TypeScript union, known before any item is read.
3. **Seed `project` rows**, one per normalized repo string (§8.4).
4. **Seed the default `(root)` component per project** (§8.1) — needed before
   any repo-level issue can be filed.
5. **Pass 1 — issues + their own events, one issue per transaction**: for each
   live v1 item (`isLiveBacklogItemNode`, mapping.ts:241-243) AND every
   historically superseded/dropped-duplicate node the store still holds a
   record of (invalidated immediately below, in this same step): resolve/lazily-create its `kind`/`agent`/`component`
   catalog rows (`kind` and `agent` are open vocabulary, populated on first
   sight rather than pre-seeded — §8.1), write the `issue` node, `has_kind`/
   `has_status`/`has_priority`/`authored_by`/`owns_component` edges, its
   `citation`/`note`/`transition` children and their `has_*` edges, its one
   migration `audit` node (whose `note` carries `v1Repo`/`v1HumanId` — §8.2a/§8.4),
   record the `uid` in the crosswalk —
   ALL in one `store.adapter.transaction(fn, {mode:'immediate'})` (mirrors §4c's
   own convention exactly — the ETL's own catalog lookups by business key
   inside this same transaction are the identical check-then-act shape §4c
   requires `immediate` mode for, so the ETL needs the same guard the live
   write path does). If the
   v1 node was not live (a superseded ancestor or a dropped duplicate),
   immediately `invalidate(uid, reason)` using that node's own recorded reason
   (the `"[superseded by X] …"` / `"[merged into Y] …"` note text,
   store/structure.ts:280/326) — so v2's bi-temporal validity mirrors v1's
   liveness exactly, and the live-query surface hides it exactly as v1 did.
6. **Pass 2 — cross-issue edges**: now that the crosswalk is complete for
   every issue this ETL will ever write (Pass 1 does not depend on edge
   targets existing yet), write every `relates_to`/`blocks`/`supersedes`/
   `duplicate_of`/`part_of` edge (§8.3), rewritten through the crosswalk
   (§8.4). A single pass, no ordering constraint within it, because nothing in
   it can be a forward reference anymore — this is *why* edges are a separate
   pass from issues rather than interleaved: an issue created before a later
   item it `relates_to` would otherwise need a second pass anyway, so every
   edge just goes there uniformly.
7. **Reconciliation** (§8.7) — the acceptance gate. Nothing is considered
   migrated until this passes.

Rationale for this order: catalogs must exist before any row references them
(`has_status` needs a `status` row to point at); projects/components must
exist before any issue (`owns_component` needs a target); issues must exist
before their own events (an event edge points at its issue) and before Pass
2's cross-issue edges (which point at OTHER issues, hence the two-pass split
above rather than a fragile creation-order dependency).

### 8.7 Idempotency & restart

**The target may be a fresh empty file or a partially-populated one from an
interrupted prior run — the same logic handles both**, because "resume"
degrades to "start fresh" when there is nothing to resume from. Concretely:

- Catalog seeding (the write layer's hand-composed find-then-create, §4c —
  `upsertProject`/`upsertComponent` for registry rows, the same composition for
  the closed catalogs, step 2-4) is already idempotent by construction (§1) —
  re-running it on a partially-populated store is always safe, no
  special-casing needed.
- **Reconciling with §4's `skipDedupe: true`**: that flag exists precisely so
  the live write path never collapses two genuinely-distinct, identical-body
  issues (§1) — which means it CANNOT double as the ETL's own restart-safety
  net. A blind re-run would mint a second, content-identical `issue` row for
  every item already migrated. The migration `audit` node (§8.2a/§8.4) is what
  replaces the disabled backstop, scoped correctly (against the true v1
  `(repo, humanId)` identity, not content): before Pass 1 begins, the ETL
  scans every `audit` node with `actor:'etl', action:'migrated'` already
  written by a prior run, reads `v1Repo`/`v1HumanId` back out of each one's
  `note` (§8.4 — this is also how the in-memory crosswalk is rebuilt after a
  crash), builds the resume-set, and processes only the v1 items not already
  in it.
- Pass 2 (edges) is always safe to re-run in full, on every invocation,
  including a resume — each edge write is preceded by an existence check
  (the same `hasLiveEdge`-shaped pattern v1 already uses for exactly this
  reason, store/structure.ts:37-40, 65) so writing an edge that already exists
  is a no-op, not a duplicate. There is no separate edge-level progress marker
  to maintain; re-deriving and idempotently re-checking every edge on every
  run is cheap enough (bounded by the corpus's own edge count) that tracking
  partial edge progress would add complexity for no measurable benefit.
- A half-finished run is therefore detected the same way a fresh run is
  scoped: by the migration `audit`-node scan above, every time, not by a
  separate "was this run interrupted" flag.

### 8.8 Failure handling & the acceptance gate

**Transaction granularity is per-issue** (§8.6 step 5): one v1 item's full
bundle (issue + catalog edges + citations + notes + transitions + migration
audit + invalidate-if-not-live) is one `store.adapter.transaction(fn, {mode:'immediate'})` (§4c). A failure
anywhere in that bundle rolls back the WHOLE bundle — never a partially-written
issue — and is recorded in a `failed: [{repo, humanId, error}]` list. **The run
continues to the next item** rather than aborting the batch (mirrors
`audit-log.ts`'s own "contained, never silent" discipline, store/audit-log.ts:
90-99) — one malformed record must never block the other 1475.

**The acceptance gate — this migration is not complete until ALL of the
following hold, checked by a live query against the fresh v2 store, never
asserted from a remembered count:**

1. `failed` is empty. Any entry is a hard fail, surfaced loudly, never
   swallowed as a partial success.
2. Per entity kind, v1 source count equals v2 written count: live issues,
   citations, notes, transitions, and each catalog (`kind`, `status`,
   `priority`, `agent`, `project`, `component`) — "live issue count" measured
   through the ordinary default (non-invalidated) view on both sides, so
   historically-superseded/duplicate ancestors migrated-and-immediately-
   invalidated per §8.6 step 5 do not inflate this number on the v2 side any
   more than they do on the v1 side (`isLiveBacklogItemNode` already excludes
   them there too).
3. `danglingReference` (§8.4) is empty.
4. Every migrated `transition` node has a non-empty `agent`, `note`, and `sha`
   — the same hard invariant §4a states for the live write path, checked here
   for the historical import too.
5. This item-level gate composes with, and does not replace, the corpus-level
   parity checks already in §9 clause 6 (citation-set sampling, per-project
   `getSubgraph` counts) — both must pass before cutover.

## 9. Acceptance (negative-control teeth)

1. `rg 'humanId'` over the v2 layer is empty; identity is `uid`.
2. **Live-path identical-content:** two `createIssue` with identical body
   produce two distinct `uid`s (skipDedupe:true on the live path, not just ETL).
3. **Automatic audit:** every transition/update/move/invalidate/embedding write
   produces one audit node (`actor`+`action`+`sha`); a transition missing
   `agent`/`note`/`sha` is rejected (red without the check).
4. **On-write embedding:** writing an issue produces its vector via the
   observer; invalidating removes it.
5. **Uniqueness:** duplicate `project.name` rejects; duplicate `component.name`
   in different projects accepts (edge-scoped policy), same project rejects.
6. **Parity** (ETL): issue count, terminal-closed count, per-issue citation
   sets (100 sampled), `getSubgraph(project)` counts all match v1; every
   transition has `agent`+`note`+`sha`.
7. **Semantic:** `searchRanked` over the v2 store returns text+vec fused results.
8. **Keyset:** `queryNodes({after, limit})` pages stably, no gaps/dupes.
9. **Registry list:** `view:projects`/`components`/`locations` return the seeded
   nodes; a component list scoped by `filter.project` returns only that project's
   components.
10. **Registry lookup:** `lookup("memory_ping")` resolves to
    `project: sox-ecosystem` + `component: memory-server` + `location: tool
    memory_ping` with the project `path` and `repoUrl` — one call, no search.
11. **Registry detail:** `get {registry:"project",name:"adhd"}` returns `path`,
    `repoUrl`, and its linked `locations[]` + `components[]`; a worktree dir under
    the project resolves to the SAME project (no phantom row).
12. **Registry CRUD:** each registry upsert is idempotent on its OWN uniqueness
    key, and on nothing wider. `upsertProject` twice with the same `name` is one
    row. `upsertComponent` twice with the same `(project, name)` is one row —
    while the same `name` under a DIFFERENT `project` is a genuinely distinct
    second row, which is the half a `name`-only key would silently collapse.
    `upsertLocation` with the same `(component, locType, value)` is one row.
    All three resolve through the edge-scoped uniqueness policy inside the
    write layer's `immediate` transaction (§4c), never a scan; re-running the
    trio concurrently from two real OS processes still yields one row each.
13. **`get`:** `get({uid})` with no `fields` returns exactly the five-field default card (`uid,kind,title,status,priority`); requesting the pseudo field `body` returns it; `get` on a `uid` that resolves to no live node throws `IssueNotFoundError(uid)`.
14. **`update` touch + no-silent-discard:** `update({uid, by, title:'x'})` returns `changed:['title']`; a zero-field patch throws `InvalidArgumentError`; a call carrying `status` in its input is rejected naming `transition`, never silently applied as a status change (proves DEBT-010 cannot recur through `update`).
15. **`transition` closedAt stamp:** transitioning an issue to a `terminal` status stamps `issue.meta.metadata.closedAt` and the outcome's `closedAt`, and `filter.closedAt.since` retrieves it via a subsequent `query`; transitioning to a non-terminal status leaves `closedAt` unset.
16. **`claim` CAS lease:** `claim` on an unclaimed issue returns `status:'claimed'`; a second `claim` by a DIFFERENT agent within `claim_stale_after_min` throws `ClaimHeldError`; the same call with `force:true` returns `status:'reclaimed-stale'` with `previousClaimant` set to the ousted agent; two concurrent `claim` calls against the SAME fresh uid, run as real barrier-synchronized OS processes, never both report `status:'claimed'` — exactly one wins (red if the CAS transaction is downgraded off `immediate`).
17. **`relate`/`move` outcomes:** a second `relate(...,'supersedes','add')` naming a DIFFERENT target than an existing edge throws `SingleValuedRelationConflictError`; the SAME target returns `noop:true`; after `move`, exactly one live `owns_component` edge exists for the issue, both before and after — never two.
18. **`delete` is soft:** `delete(uid, reason)` returns `{invalidated:true}`; the issue disappears from a default `query` listing but `getNodeByUid(uid)` still resolves it (bi-temporal, never a hard delete).
19. **`create`'s duplicate gate:** filing a near-duplicate title/body in the same project with default `duplicateAction` returns `{created:false, reason:'duplicate-suppressed'}` and writes nothing; `duplicateAction:'force'` writes a genuinely new, distinct `uid` despite the match (and still reports `duplicateCandidates`); `duplicateAction:'comment'` writes zero issue rows and attaches a `note` to the top-scoring candidate instead.
20. **`query` sort/keyset conflict:** `query({after:<cursor>, sort:'priority'})` throws `InvalidArgumentError('sort', ...)` naming the incompatibility; the identical call without `sort` succeeds and pages in insertion order.
21. **Registry `rmLocation`:** `rmLocation(uid)` invalidates the location; a subsequent `lookup` on that `(locType,value)` no longer resolves it; the location's own record remains addressable by uid (bi-temporal, never hard-deleted).
22. **Concurrent write safety (BUG-039 gate):** the un-skipped, v2-repointed cross-process harness (§4c/§10.4) run against `createIssue` reports a fresh-reopen stored count exactly equal to the number of `ok`-reporting creates, for both the same-target and distinct-target cases, over two real OS processes with no serve-lock coordination; the identical run with the `immediate`-mode guard removed reports a stored count BELOW the expected total (the negative control proving the assertion has teeth).

## 10. Dependencies & sequencing

1. Library tier — published (FEAT-010..024, DEBT-011, BUG-040), plus the
   `graph-store` 0.9.1 patch that surfaces `NodeRecord.uid` + `getNodeByUid`
   (the stable-identity correction — the ONE library change this plan required).
2. **Bump deps + build v2 fresh, in ONE change** (full replacement — no v1
   build to protect): `entrypoint/backlog/package.json` bumps to graph-store
   0.9.1 / store-adapter 0.8.0 / vector-store 0.6.0 and ADDs hybrid-search
   0.4.2 / semantic 0.1.2 / embedding-provider 0.4.1, alongside the new
   `v2-write.ts` → `v2-query.ts` → consumers. The old v1 code is wiped in the
   same change; there is no intermediate state where both compile.
3. BUG-040 ETL re-run (restore 1339 transitions + 7 issues into the fresh v2 store).
4. **Gate before cutover: BUG-039 write-safety proof against the UUID write
   path — confirmed, not assumed, by the procedure in §10.4.**

### 10.4 Gate procedure

The BUG-039 write-safety proof (§10 point 4) is confirmed — never assumed — by
this procedure, run against the harness that already exists at
`entrypoint/backlog/src/store/concurrency-scale.spec.ts:346-451`
(`cross-process-writer.cjs` fixture).

**Before the command runs, two things in the existing harness must change — it is
not runnable as a v2 gate as written:**

1. **Un-skip it.** The BUG-039 describe block is `describe.skip(...)`
   (`concurrency-scale.spec.ts:419`). `-t "BUG-039"` filters test names; it does
   **not** override a `.skip` on the containing `describe`. Remove `.skip` first, or
   the command below reports zero tests run and reads as a clean exit rather than as
   "did not run."
2. **Repoint the fixture off the v1 surface.** `cross-process-writer.cjs` currently
   drives `createItem(ctx, { family, title, body, repo })` and reads back via
   `listItems(store, { repo, family })` (`cross-process-writer.cjs:26,52`;
   `concurrency-scale.spec.ts:19-20`) — `family`, `repo`, and `humanId` are v1
   identity machinery §7 wipes entirely. Before this harness can gate the v2 write
   path it must call the v2 `createIssue` verb (§4) against a seeded `project`/
   `component`, and its `storedCount` helper (`concurrency-scale.spec.ts:407-417`)
   must count issues via the v2 query layer (§5) scoped to that component, in place
   of `listItems({repo, family})`. The file-barrier synchronization, the
   `ready-<tag>`/`GO` handshake, and the two-writer/distinct-vs-same-target case
   split are unaffected — only the write/read calls the fixture makes change.

**Procedure:**

```bash
cd entrypoint/backlog
npx nx build backlog                # DIST_INDEX (concurrency-scale.spec.ts:32) must exist —
                                     # the fixture requires() it at REPRO_DIST and exits 1
                                     # (a startup failure, not a loss measurement) if it's stale/absent
npx vitest run src/store/concurrency-scale.spec.ts -t "BUG-039"
```

**What it asserts:** two real OS processes (`node cross-process-writer.cjs`, not
threads, not mocks — `concurrency-scale.spec.ts:365-378`) open the SAME on-disk v2
store with no serve-lock coordination between them, park on a file-based barrier so
both begin from the identical committed state, then both hammer `createIssue`
concurrently — one case with two distinct targets, one with the same target — for
250 iterations each. The assertion is a **fresh-reopen** count
(`storedCount`/`concurrency-scale.spec.ts:407-417` — never a writer's own in-process
handle, which can hold a stale snapshot) equaling exactly what was written: every
`ok`-reporting create actually persisted, nothing silently lost. The fixture itself
exits `0` on silent loss by design (`cross-process-writer.cjs:61-64`, "silent loss…
exits 0 so the SPEC's stored-count assertion is what detects it") — the vitest
process's own exit code on that count assertion is the gate, never the child writers'
exit codes or their stdout.

**Negative control (proves the assertion has teeth):** re-run the same command
against a build with the `immediate`-mode guard deliberately removed — either
downgrade the hand-composed transaction §4c specifies from `{mode: 'immediate'}`
back to the adapter default `deferred`, or split the business-key find back into two
autocommit statements (the exact shape `findOrCreateNode` has today,
`index.ts:1912-1916`) — and confirm the stored-count assertion goes **red** (a count
below the expected total, i.e. detected silent loss). A harness that stays green
against both the guarded and the deliberately-broken build proves nothing; this
control is what proves it is actually measuring the thing it claims to.

## 11. Out of scope

Library-tier changes beyond the `graph-store` 0.9.1 uid-surfacing patch (already
committed); data-model
changes beyond this spec; multi-tenancy/auth (identity = `agent` catalog;
access control out of scope).
