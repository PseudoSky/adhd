# Backlog v2 Application Layer — Specification (FEAT-017)

Status: PROPOSED v2 — revised after blind architect review + backlog-feature
audit. All library primitive names below were re-verified against the published
npm packages.

## 0. Context & non-negotiable principles

Full rebuild of the adhd-side backlog application layer on the sox library
tier. Library versions (verified on npm): `@adhd/sox-graph-store@0.9.0`,
`@adhd/sox-store-adapter@0.8.0`, `@adhd/sox-vector-store@0.6.0`,
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

- **Identity = `uid` (UUID).** `writeNode` generates it; the app exposes `uid`,
  uses `rowid` internally.
- **Content is NEVER identity.** The library's global content-hash dedup
  (`skipDedupe` default `false`) is a content-idempotency convenience, not
  identity. **Every live write-layer entity write passes `skipDedupe: true`:**
  `createIssue`, and `supersede`-backed body edits — so two identical-body
  issues are two rows (two `uid`s), never one collapsed row. The ETL already
  passes it (§8); the live path must too. (This was the blind review's blocker.)
- **Uniqueness = an injected `NodeUniquenessPolicy`**, not a DDL index:
  - flat catalogs (`status`/`priority`/`kind`/`agent`/`edge_kind`): name unique
    → `SELECT … WHERE kind=? AND name=?`.
  - `project`: name unique → flat `(kind='project', name)`.
  - `component` within a project: **the parent project `uid` is carried in
    `meta.metadata.projectUid`**; the policy resolves it via `tx`
    (`SELECT rowid FROM node WHERE uid=?`) then checks `owns_project` edges for
    an existing same-name component under that project. This is implementable
    because the parent is threaded into `meta` — the check runs BEFORE the
    component's own INSERT, against *other* components, not itself.
- The policy runs inside `writeNode`'s transaction (tx-threaded), so catalog
  upsert is atomic with the check.

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

- `project` — one canonical row; `name` unique.
- `component` — `name` unique within project; `meta.metadata.projectUid`.
- `location` — `type` (`path`|`remote_url`|`url`|`filesystem_path`) + `value`.
- `issue` — `title` (name), `body` (content); `kind`/`status`/`priority` as
  catalog refs (resolved via `findOrCreateNode`); `closed_at` stamped by the
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

## 4. Write layer (`v2-write.ts`)

Every write is one `backend.transaction(fn)` over `writeNode` + `writeEdge`(s)
+ audit; never the raw adapter. **All entity writes pass `skipDedupe: true`.**

- `createIssue(title, body, { project, component, kind, status, priority })`:
  resolve catalogs via `findOrCreateNode`; write the issue + `owns_component` +
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

### 5a. Semantic search (FEAT-022)

`view:similar`/`relevance`/`_score` route through
`StoreSearchBackend.searchRanked(query, limit)` with
`signals:[{text},{vec}]` + `rescore:[{kind:'temporal',decay}]`.
`semanticSearchNodes` DELEGATES to text+vec fusion (FEAT-022 §3 — no longer
vector-only); the embedding-only path is `searchRanked({vec, signals:[{vec}]})`.
A title/body text match surfaces even when its vector is not nearest.

## 6. Consumers

CLI/MCP/HTTP keyed by `uid`; `statusEvidence` (DEBT-010) transition shape;
web UI list/detail/stats over catalogs + edges; markdown projection (title
headers, `[target sha:…]` citations).

## 7. Retirement (legacy debt eliminated)

Delete on cutover: `humanId` machinery, `idOverride`, `importedFrom`,
repo-string identity, the repo-migration module, migration-phase machinery,
`repoWarning`, the markdown `import` action, `firstTerminalTransitionAt`
reconstruction, hardcoded terminal/citation/reason knobs (now `status.terminal`
+ `project_policy` data).

## 8. Migration (ETL)

Fresh write (already proven; `skipDedupe:true`, natural content, no prefix
hack). Restores 1339 transitions + 7 identical-title issues. Re-run required
now that `graph-store@0.9.0` is published.

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

## 10. Dependencies & sequencing

1. Library tier — published (FEAT-010..024, DEBT-011, BUG-040). **The adhd
   consumer must bump its deps:** `entrypoint/backlog/package.json` currently
   pins `graph-store ^0.8.6`/`store-adapter ^0.7.0`/`vector-store ^0.5.0` and
   lacks `hybrid-search`/`semantic`/`memory-core`. Bump to graph-store 0.9.0,
   store-adapter 0.8.0, vector-store 0.6.0, and ADD hybrid-search 0.4.2,
   semantic 0.1.2, embedding-provider 0.4.1 — before the write layer compiles.
2. BUG-040 ETL re-run.
3. `v2-write.ts` → `v2-query.ts` → consumers → retirement (bottom-up).
4. Gate: BUG-039 write-safety proof against the UUID write path (confirm, not
   assume).

## 11. Out of scope

Library-tier changes (published; new primitives are library tickets); data-model
changes beyond this spec; multi-tenancy/auth (identity = `agent` catalog;
access control out of scope).
