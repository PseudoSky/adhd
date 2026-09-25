# Backlog Application Layer — Specification (FEAT-017)

Status: IMPLEMENTED — the surface this spec describes is realized in `src/`
and shipped as `@adhd/backlog` (package version 1.0.0; see `CHANGELOG.md` for
release state). Revised after blind architect review + backlog-feature
audit. All library primitive names below were re-verified against the published
npm packages.

## 0. Context & non-negotiable principles

**This is the application layer, built fresh against the sox library tier** —
there is no coexistence with anything else, no dual-write bridge, and no
gradual deprecation window. Nothing about this build is staged against, or
constrained by, an earlier surface. The prior corpus is carried forward exactly
once, by the cutover ETL (§7a), into a freshly created store file — the file it
reads from is never mutated in place, and there is no code path anywhere in
this package that writes this schema's node/edge shapes onto an old-schema
file.

Library versions (verified on npm): `@adhd/sox-graph-store@0.9.1` (the 0.9.1
patch surfaces `NodeRecord.uid` + `getNodeByUid` — the stable-identity correction,
§1), `@adhd/sox-store-adapter@0.9.0` (the concurrency-mode enforcement module §4c
depends on — `resolveConcurrencyMode`/`VALID_CONCURRENCY_MODES` — ships starting
only in 0.9.0; 0.8.0 has no such module at all and its own README still documents
the `experimental.multiprocessWal:false` opt-out §4c requires be absent — see
§4c), `@adhd/sox-vector-store@0.6.0`, `@adhd/sox-hybrid-search@0.4.2`,
`@adhd/sox-semantic@0.1.2`, `@adhd/sox-embedding-provider@0.4.1`,
`@adhd/sox-memory-core@0.9.2`.

**Anti-antipatterns to NOT recreate:**

1. **No composite identity.** Identity is the DB-generated `uid`
   (UUID) exposed to consumers; `rowid` is internal. No allocator, no
   dedupe-scan, no id override, no import-provenance field, no repo-string identity.
   **BUG-039 (cross-process write loss) is HYPOTHESIZED to disappear with
   DB-generated ids** — §9.1 keeps the write-safety proof as the gate that
   CONFIRMS it, not as a foregone conclusion.
2. **No kind-derived-from-prefix.** `kind` is a catalog-backed reference.
3. **No closed `CHECK` on `kind`/`rel`.** Open schema + injected `TypePolicy`.
   (Note: the store's `source` column still carries its own `CHECK`; this rule
   is specifically about the kind/rel vocabulary, which is open.)
4. **No dual-stored repo.** `project` is one canonical row; membership is the
   `owns_project` edge.
5. **No unused type debt** — real columns/edges only; no `namespace`+metadata
   dual-write, no soft repo-scoping warning, no phase-tracking state machine.

## 1. Identity, dedup, & uniqueness

- **Identity = `uid` (UUID), now a first-class library surface.** `graph-store`
  ≥0.9.1 exposes `NodeRecord.uid` and `GraphBackend.getNodeByUid(uid)`, so the
  app layer keys the _consumer-facing_ identity on the stable, exportable UUID
  and resolves an external `uid` → node with one call. `rowid` (`NodeRecord.id`)
  remains the _internal_ edge identity (`writeEdge`/`getEdges` are
  `src`/`dst` rowids) — it is per-store and is NOT stable across a store
  rebuild, so it must never escape as an external reference.
- **Content is NEVER identity.** The library's global content-hash dedup
  (`skipDedupe` default `false`) is a content-idempotency convenience, not
  identity. **Every live write-layer entity write passes `skipDedupe: true`:**
  `createIssue`, and `supersede`-backed body edits — so two identical-body
  issues are two rows (two `uid`s), never one collapsed row. (This was the
  blind review's blocker.)
- **Uniqueness = a hand-composed find-then-create inside the write layer's own
  `immediate` transaction (§4c) + `NodeUniquenessPolicy` (edge-scoped) — never
  the library's `findOrCreateNode()`, which is two separate, non-transactional
  autocommit statements (a SELECT, then on a miss a bare `writeNode` call) with
  no transaction wrapping either. §4c proves this against the library source,
  and the primitive's own doc comment says so explicitly: under multi-writer
  the caller must wrap check+INSERT in one transaction itself.**
  - flat catalogs mintable on an unresolved NAME (`status`/`priority`/`kind`/
    `agent`) — auto-mintable from any issue-mutating verb that accepts them
    (§6.1's general rule) — and `project` (name unique, minted ONLY via the
    explicit `upsertProject` registry verb, NEVER via `createIssue` or any
    other issue verb, §6.1) → both resolved the SAME way mechanically: the
    write layer runs its own `tx.executeGet` SELECT by `(kind, name)`
    against the SAME `immediate`-mode transaction handle the verb already
    opened, and only on a miss issues the INSERT against that same `tx`
    (§4c) — never a call to `findOrCreateNode()` itself. `edge_kind` uses
    the identical `tx.executeGet` SELECT for the VALIDATION lookup §2's
    `source_kind`/`target_kind`/`multiplicity` check needs, but is NEVER
    caller-mintable: every `edge_kind` row is seeded once from §3's fixed
    edge table, and the one caller-supplied edge-type field, `relate`'s
    `rel` (§6.3.6), is a closed TypeScript union, never an open name — so
    there is no INSERT-on-miss path for it at all (§6.1).
  - `component` within a project: **the parent project `uid` is carried in
    `meta.metadata.projectUid`**; the injected `NodeUniquenessPolicy.check` reads
    it via the hand-composed, tx-scoped uid lookup §4c defines below —
    `tx.executeGet('SELECT rowid FROM node WHERE uid = ?', [projectUid])`,
    never a `getNodeByUid` call, which always runs against the bare adapter,
    never the open `tx` (§4c) — then checks `owns_project` edges for an
    existing same-name component under that project via the SAME `tx` handle
    (`tx.executeAll('SELECT ... FROM edge WHERE dst = ? AND rel = ?
AND t_invalid IS NULL', [projectRowid, 'owns_project'])`, never
    `getEdges()`, which is equally bare-adapter-only, §4c). This is
    implementable because the parent is threaded into `meta` — the check
    runs BEFORE the component's own INSERT, against _other_ components, not itself.
- The policy is tx-threaded, and therefore genuinely atomic with the check,
  ONLY because it runs inside the write layer's own `immediate` transaction
  (§4c) — `writeNode` called standalone runs against the bare adapter (no
  transaction at all), so the atomicity is a property of the write layer's own
  composition, never of `writeNode` or `NodeUniquenessPolicy` in isolation.

## 2. Catalogs (first-class data) + project policy

| catalog   | kind        | uniqueness | extra (metadata)                             |
| --------- | ----------- | ---------- | -------------------------------------------- |
| node kind | `kind`      | name       | `description`                                |
| edge kind | `edge_kind` | name       | `source_kind`, `target_kind`, `multiplicity` |
| status    | `status`    | name       | `terminal`                                   |
| priority  | `priority`  | name       | `rank`                                       |
| agent     | `agent`     | name       | —                                            |

`status.terminal` drives closedness. Per-project policy is DATA (rows), the home
of the hardcoded terminal/citation/reason knobs:

```
project_policy (project → policy): transition_requires_note (default true),
  citation_required (false), citation_requires_sha (default true — gates
  acceptance of an unverified citation, but only where verification is
  possible; see below), citation_allowed_external_roots (default
  `[]` — no machine-global root; typed, project-scoped external read roots; see
  below),
  default_status (catalog
  ref; falls back to a global OPEN-equivalent catalog row when unset),
  default_kind (catalog ref; falls back to the global "issue" catalog row
  when unset), dedupe_scan_enabled (default true, §6.4), dedupe_threshold
  (default 0.8, §6.4), claim_stale_after_min (default 30, §6.3.5)
project_status  (project → allowed status set)
project_kind    (project → allowed kind set)
project_field_requirement (project → required field)
```

`sha` is unconditionally computed by the write layer for every `citation`,
`transition`, and `audit` node — "automatic, cannot be forgotten" (§4a) —
so there is no `transition_requires_sha` column: a `transition`/`audit`
node's `sha` hashes its own canonical serialization (never an external
file), so it is always computable and §4a's "agent + note + sha REQUIRED"
is a genuine hard invariant, never policy-tunable. A `citation`'s `sha`, by
contrast, hashes EXTERNAL file content (§6.3.2) and can legitimately
fail to resolve to a real hash. `citation_requires_sha` is what that failure
composes with, and it applies ONLY where verification is possible — when the
owning project has a non-empty `metadata.path`. For such a project, `true`
(default) rejects a citation write whose `sha` would resolve to the
`"unverified"` sentinel with `CitationUnverifiableError`, and `false` accepts
it verbatim. A project with NO known `path` cannot hash any citation target at
all, so there is nothing for the gate to verify and nothing for it to reject:
the write succeeds and records `sha:"unverified"` verbatim whether
`citation_requires_sha` is `true` or `false`, matching the ETL's own
`computeCitationSha` precedent (§8.5).

A path-PRESENT project resolves a citation target by CANONICAL
(symlink-resolved) containment against its own `metadata.path` root PLUS every
root in `citation_allowed_external_roots` (BUG c6d35272). In-project
resolution stays the DEFAULT; the array names EXTERNAL absolute roots whose
evidence may also be cited. The runtime default is the EMPTY array — there is
NO machine-global default root — because the runtime's own data home
`~/.adhd/backlog` contains only the machine-global backlog store
(`production/data/backlog-v2.db`) and its `backup-*`/`backups/` snapshots
(plus a `test/` store): granting it would let a citation resolve INTO the
shared backlog graph (BUG 62059b57 follow-up). A project opts into specific
external roots by naming them here; an empty array (the default, or an explicit
`[]`) leaves the carve-out disabled. This is deliberately typed, per-project
config — never an environment toggle, and never a blanket "any absolute path".
A `..` traversal, a symlink inside the root that points outside it (the sibling
defect c6d90ddf), and an arbitrary absolute path outside every root all
resolve to `"unverified"` and are rejected by the default
`citation_requires_sha: true`; `CitationUnverifiableError` names the allowed
roots (or the project root when the allowlist is empty) and the
`project_policy.citationAllowedExternalRoots` field that controls them. Only the
resulting `sha` is persisted — never file content.

`project_status`/`project_kind` are enforced by the SAME write-layer step
that resolves the `status`/`kind` catalog row (§4c's hand-composed
find-then-create, used by `createIssue`/`update`/`transition`): once the row
is resolved (or auto-created, §6.1), the write layer checks the resolved
row's `name` against the project's `project_status`/`project_kind` set —
empty means "no restriction, anything in the global catalog is allowed" —
and throws `InvalidArgumentError('status'|'kind', value)` before the write
if the name falls outside a non-empty set. `project_field_requirement` is
enforced the same way, at the top of `createIssue`/`update`/`transition`:
for every `(project, field)` row present, a missing/blank value for that
field on the call throws `InvalidArgumentError(field, ...)` before any
write runs — the identical mechanism §6.3's `by` check already uses (line
700-701), generalized to any project-declared required field.

- **Edge-kind schema enforcement is a WRITE-LAYER responsibility, not
  `validateEdge`.** `TypePolicy.validateEdge(srcKind, rel, dstKind)` is a PURE
  three-string predicate (no I/O — FEAT-013). The write layer resolves the
  `edge_kind` catalog row by `rel` name, checks `source_kind`/`target_kind`
  match the resolved endpoints and that `multiplicity` isn't exceeded, THEN
  calls the SAME injected `TypePolicy` instance directly, in-process — never
  through `writeEdge`, which always runs against the bare adapter, never the
  write layer's own open `tx` (§4c) — before composing the edge INSERT itself
  against the transaction handle (§4c's extended hand-composed-SQL rule).
  Multiplicity/cardinality is therefore enforced by the app layer that
  can read the catalog — never smuggled into the pure seam.
- **What `multiplicity` means, precisely** (§3's `(1:n)`/`(n:1)`/`(n:m)`
  markers ARE the catalog's `multiplicity` values, read verbatim — no second
  vocabulary): `n:1` caps the SOURCE's out-degree at one for that `rel` (one
  target per source — e.g. `has_kind`: an issue has exactly one `has_kind`
  edge, many issues share a `kind`); `1:n` caps the TARGET's in-degree at one
  (one source per target — e.g. `owns_component`: an issue has exactly one
  owning component, one component owns many issues); `n:m` is uncapped on
  both sides. The write layer enforces whichever side the resolved `rel`'s
  row declares — the SAME check for every row, never two different checks
  keyed off which side happens to be "1."
- **`audits` is the one declared exception to "no polymorphic," and it is
  declared, not smuggled in.** Its `edge_kind` row carries the sentinel
  `source_kind: '*'`: the write layer's source-match step is skipped for this
  ONE row (any resolved source kind is accepted); `target_kind` (`audit`) and
  `multiplicity` (`1:n` — one source per target) are still checked exactly as
  for every other row — and, like `has_note`/`has_citation`/`has_transition`/
  `has_location` (also `1:n`), that check is trivially satisfied because the
  target is a fresh node minted and linked exactly once per write, never an
  existing node re-targeted. The one thing genuinely exceptional about
  `audits` is `source_kind: '*'` alone: an audit's subject is identified by
  its own `target_uid` metadata field (§3), never by the edge's
  `source_kind` — the edge exists for traversal (`auditTrail`, §6.5), the
  metadata field is what's authoritative. No other `edge_kind` row is
  permitted to use `'*'`.
- **This generic check IS `relate`'s enforcement — §6.3.6 hand-rolls
  nothing.** The single-valued-rel rejection described there for
  `supersedes`/`duplicate_of`/`part_of` (all three declared `n:1` in §3 — ONE
  target per source) is this same `edge_kind.multiplicity` gate, applied to
  those three rows; §6.3.6's prose states the gate's user-visible result for
  `relate` callers, it is not a second, independently-maintained check. A
  future rel declared `n:1` is enforced identically with no code change to
  `relate`.

## 3. Entities & edges (graph nodes; event model is graph-native)

**Nodes** (`writeNode`, `kind` + `name` + `metadata`):

- `project` — one canonical row; `name` (slug) unique. Carries the **navigation
  spine**: `meta.path` (absolute local root, e.g. `/Users/nix/dev/node/adhd`),
  `meta.repoUrl` (canonical git remote, e.g. `git@github.com:PseudoSky/adhd.git`),
  `meta.monorepo` (bool hint), optional `meta.description`. A worktree directory
  under the project resolves to the SAME project row — never a phantom row.
- `component` — `name` unique within project; `meta.metadata.projectUid`. The
  logical sub-unit (package/module/service/directory) with optional
  `meta.path` (repo-relative) + `meta.description`. Every project carries
  exactly one reserved default component named `(root)`, representing "no
  sub-area" — written atomically by `upsertProject` (§3a/§4) alongside the
  project node itself, never created lazily at issue-creation time. `(root)`
  is what `createIssue` (§6.3.2/§6.1) resolves to when its optional
  `component` field is omitted, guaranteeing every issue always gets exactly
  one live `owns_component` edge.
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
- **Event/evidence nodes — graph-native re-interpretation of DATA_MODEL.md's
  relational "tables"** (the graph store has no arbitrary tables; a "first-class
  row" is a node). This is a deliberate, stated divergence:
  - `note` — `{ author, text, at }` (metadata).
  - `citation` — `{ target, target_type, sha, line, at }`; content-addressed.
  - `transition` — `{ from_status, to_status, agent, note, sha, at }`.
  - `audit` — `{ actor, action, target_uid, from, to, note, sha, at }`.

**Edges** (typed rels, each name unique with ONE `(source_kind → target_kind)` —
no polymorphic `owns`, with exactly one declared exception, `audits`, whose
sentinel `source_kind: '*'` and its precise enforcement carve-out are stated
in §2):

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
audits         *         → audit       (1:n)   (subject-of-audit link — the ONE
                                                sentinel source_kind; §2)
depends_on     component → component   (n:m)
has_location   component → location    (1:n)
relates_to     issue     → issue       (n:m)
supersedes     issue     → issue       (n:1)   (issue relation, lowercase)
blocks         issue     → issue       (n:m)   (inverse = blocked_by, derived)
duplicate_of   issue     → issue       (n:1)
part_of        issue     → issue       (n:1)   (hierarchical items, FEAT-005)
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
- `lookup --input '{"q":"<tool|file|url>"}'` — resolve a tool/file/url to its
  owning project/component/location.
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

## 4. Write layer (`src/write/`)

Every write is one `store.adapter.transaction(fn, {mode:'immediate'})` (§4c)
over a hand-composed node write + hand-composed edge write(s) + audit —
never a call to the library's `writeNode`/`writeEdge`/`invalidateEdge`/
`getNodeByUid` themselves, all four of which run against the bare,
un-transacted adapter and so would autocommit (or read committed-only state)
outside the verb's own transaction if called from inside it (§4c proves this
for each, by source); never `GraphBackend.transaction(fn)`
(the graph-store's own composition method always runs at the adapter's
default `deferred` mode and cannot request `immediate` — §4c), and never the
raw adapter directly. **All entity writes pass `skipDedupe: true`.**

- `createIssue(title, body, { project, component, kind, status, priority })`:
  resolve catalogs via the write layer's hand-composed find-then-create (§4c).
  `component` is optional: given, it must resolve to an existing component
  under `project` (find-only — §6.3.2); omitted, it resolves instead to
  `project`'s reserved default component `(root)` (§3), a row `upsertProject`
  already guarantees is live — never minted here, in either case. Write the
  issue + `owns_component` (always, to whichever component resolved) +
  `has_kind`/`has_status`/`has_priority`/`authored_by` edges + a `created`
  audit row — atomically.
- `updateIssue(uid, patch)`:
  - **body change → `supersede`** (new node + `SUPERSEDES` edge) — the only
    content path; **title/metadata → `touch`**. Never `touch` a body.
  - status change → `transition` (§4a).
- `moveIssue(uid, toComponent)` (FEAT-008): hand-composed edge-invalidate (old
  `owns_component`) + hand-composed edge-upsert (new `owns_component`) +
  audit, atomically, all against the SAME `tx` handle — mirroring
  `invalidateEdge`'s and `writeEdge`'s own SQL shape (§4c's extended rule)
  rather than calling either method, both of which run against the bare
  adapter and would autocommit outside this transaction.
- `relate(uid, targetUid, rel, action)` (BUG-025/BUG-044): returns a real
  outcome (`noop` vs `changed`); single-valued rels (`supersedes`,
  `duplicate_of`, `part_of`) reject a second target (§6.3.6).
- `transition(uid, toStatus, { agent, note })`: writes a `transition` node +
  `has_transition` edge + stamps `closed_at` when terminal.
- **Registry CRUD** (§3a): `upsertProject({ name, path, repoUrl, monorepo?,
description? })` (create-or-update by `name` — on first creation ONLY,
  also writes the reserved default `component` row named `(root)` + its
  `owns_project` edge, in the SAME transaction, so every project owns at
  least one component before any issue can be filed under it, §3/§6.3.2; a
  repeat `upsertProject` against an existing project finds `(root)` already
  live and writes nothing further for it — idempotent, never a second row),
  `upsertComponent({ project, name,
path? })` (upsert by `(project, name)`), `upsertLocation({ component, locType,
value })` (upsert by `(component, locType, value)`), `rmLocation(uid)`
  (invalidate). Each is ONE `store.adapter.transaction(fn, {mode:'immediate'})`
  (§4c) over a hand-composed node write + hand-composed `owns_project`/
  `has_location` edge write + audit, all against the SAME `tx` handle (§4c's
  extended rule) — never a call to the library's `writeNode`/`writeEdge`,
  which run against the bare adapter. No composite identifier, no repo-string,
  no second `dimensionGraph` store.

### 4a. Automatic audit logging

No bare mutation. Every state change writes an `audit` node
(`actor`/`action`/`target_uid`/`from`/`to`/`note`/`sha`/`at`) linked by an
`audits` edge, emitted by a single `writeAudit` helper at the end of each write
transaction — automatic, cannot be forgotten. `sha` = `sha256` over the
canonical serialization (content-addressing, DATA_MODEL.md §0.4/§4/§6).

- **Transitions** keep the hard invariant: `agent` + `note` + `sha` REQUIRED,
  validated on the write path (no bare transition).
- **Embeddings are audited by the WRITE LAYER**, not the observer: the
  `createEmbeddingObserver` (FEAT-021) has no graph-write handle, so the write
  layer records an `embedding_upserted`/`embedding_deleted`/`embedding_failed`
  audit row after the observer settles (it owns the actor context the
  observer lacks) — in its OWN follow-up `immediate` transaction, opened
  after the subject write's own transaction has already committed (the
  observer's outcome isn't knowable before then; §4b states exactly when it
  settles relative to `awaitEmbed`). The three outcomes are exhaustive:
  `embedding_upserted`/`embedding_deleted` on success, `embedding_failed`
  (`note` = the observer's caught error) when the embed round-trip rejects —
  never silently skipped, and never a false `embedding_upserted` recorded
  for a failed embed. This is the one audit class whose write is provably
  NOT inside the same transaction as its subject write (every other audit
  row is, per this section's opening paragraph) — a structural exception,
  not an oversight: the embed outcome is unknowable before the subject write
  commits.

### 4b. On-write embeddings (FEAT-021)

`createEmbeddingObserver(semanticBackend)` registered at open: embed-on-write,
delete-on-invalidate. It fires on the graph-store's own post-commit write
event — AFTER the write layer's `immediate` transaction has committed and
released its RESERVED lock, never inside it, so the embedding round-trip (a
network call to `semanticBackend`) never holds the write lock open and never
delays a concurrent writer (§4c). **Fire-and-forget by default:** the
write-layer verb (`create`/`update`) does not await the observer's promise
unless the caller passes `awaitEmbed:true` (§6.2), in which case the verb
awaits that SAME post-commit promise before returning to the caller — still
after the subject transaction has committed, so `awaitEmbed:true` adds
latency to the caller's own call, never lock-hold time to the store.
**"Degrades to a log" on failure** means: a rejected embed/delete never
throws back through the `create`/`update` call that triggered it (which, by
the time the observer settles, may already have returned to its caller) and
is never retried inline — the observer logs the error for operator
visibility, AND the write layer independently persists it durably as an
`embedding_failed` audit row (§4a), so the failure is never only a log line
a caller could miss. Batch re-embed (`reembed`/`deleteMany`, backfill-only)
is the sanctioned way to repair rows left un-embedded by a logged failure.

### 4c. Concurrency semantics & error taxonomy

**Ground truth:** this store is parallel-process by mandate. `@adhd/sox-store-adapter@0.9.0`'s
concurrency contract (`concurrency-mode.ts`, shipped compiled as `dist/concurrency-mode.d.ts`/
`dist/concurrency-mode.js` — no `.ts` source ships in the published package) resolves
exactly one mode per backend — Turso (the default backend) mandates `multiprocess-wal`
with **no opt-out** (`resolveConcurrencyMode`/`VALID_CONCURRENCY_MODES`,
`dist/concurrency-mode.d.ts:32-50` — **this enforcement module ships starting in 0.9.0
only; 0.8.0 has no `concurrency-mode.*` file at all, and 0.8.0's own README still
documents the opposite, a working `experimental.multiprocessWal:false` opt-out example
at `README.md:246,298` — hence the 0.9.0 pin, §0**); the embedded-driver fallback
mandates `single-writer` (one synchronous in-process connection —
`dist/concurrency-mode.d.ts:38-45`). Under `multiprocess-wal`, **multiple
processes hold concurrent write connections to the one store file; writers are
serialized, not concurrent** — `multiprocess_wal` extends single-writer WAL across
process boundaries via a `.tshm` coordinator holding a single-writer slot, absorbed by
the adapter's always-on busy timeout and bounded retry (ADR-0012 §1). This is
**explicitly not MVCC**: `BEGIN CONCURRENT` exists as a capability but no production
caller requests it, and it **throws on the embedded-driver adapter** (store-adapter
`README.md:102`) — disqualifying it as a mode this spec can rely on, since the spec
must hold on both backends. Ordering across processes is **not FIFO**: two racing
writers may commit in either order (ADR-0012 §1). Nothing below may be read as
single-writer/single-process — that invariant is superseded (ADR-0012, superseding
ADR-0007; ADR-0015's opt-out was never accepted).

#### Transaction mode per write class

Every the write layer verb opens **exactly one** transaction via
`store.adapter.transaction(fn, { mode: 'immediate' })` — the `StoreAdapter` the
backlog store exposes as `.adapter` (`graph-backlog-store.ts:27`, used directly by the
existing harness at `concurrency-scale.spec.ts:233`), **not**
`GraphBackend.transaction(fn)`. The graph-store's own composition method
(`transaction<T>(fn): Promise<T>`, `index.ts:747`, implemented as a bare
`return this.adapter.transaction(fn)` at `index.ts:2057-2059`) accepts no `opts` and
therefore always runs at the adapter's default `'deferred'` mode — it cannot request
`immediate`. the write layer must go one layer down to get mode control.

`immediate` (`BEGIN IMMEDIATE`, RESERVED lock **at BEGIN**) is the one mode this spec
uses, on every verb, for one reason: every write is a **check-then-act** operation
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

| Write-layer verb (§4)                                  | Mode        | Why                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createIssue`                                          | `immediate` | resolves `kind`/`status`/`priority` (and `project`/`component` if not already `uid`-resolved) by business key before the issue INSERT — a check-then-act composite                                                                           |
| `updateIssue` (body → supersede path)                  | `immediate` | must CAS the "not already superseded" check against the write (see below) — the library's own `supersede()` does not                                                                                                                         |
| `updateIssue` (title/metadata → touch path)            | `immediate` | `touch`'s own pre-check (`index.ts:1964-1968`, "not found or invalidated") is a check-then-act read outside any transaction when called standalone; composing it inside the write layer's own `immediate` transaction closes the same window |
| `moveIssue`                                            | `immediate` | must find the specific live `owns_component` edge before invalidating it and writing the replacement — a specific-edge check-then-act                                                                                                        |
| `relate`                                               | `immediate` | single-valued rels (`supersedes`, `duplicate_of`) must read "does a target already exist" before deciding `noop` vs `changed` vs reject                                                                                                      |
| `transition`                                           | `immediate` | reads current status to validate the `from_status`/terminal transition and decide `closed_at` stamping                                                                                                                                       |
| `claim`                                                | `immediate` | CAS-merges the `claimedBy`/`claimedAt` pair against a fresh read of the same uid, taken on the transaction handle — a specific-node check-then-act, identical shape to `transition`'s current-state read                                     |
| `upsertProject` / `upsertComponent` / `upsertLocation` | `immediate` | create-or-update by business key — the exact `findOrCreateNode` shape, composed by hand (below)                                                                                                                                              |
| `rmLocation`                                           | `immediate` | invalidate-by-uid after confirming the row is live, for uniformity with every other verb above (one mode, one decision, never re-litigated per verb)                                                                                         |

#### `findOrCreateNode` is not race-free — the write layer does not call it

`findOrCreateNode` (`index.ts:1907-1917`) runs
`this.adapter.executeGet(...)` (a SELECT against the base adapter) and then, only if
nothing was found, `this.writeNode(...)` — **two separate autocommit statements, no
transaction at all.** Its own doc comment says so explicitly: _"under multi-writer the
caller must wrap check+INSERT in one transaction or add a DDL backstop"_
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
the check, only when `writeNode` is _composed_ inside a transaction the app already
owns. Called standalone, `writeNode` always passes `this.adapter` (`index.ts:1825`),
i.e. runs inside nothing — the policy is atomic with the check only because the
write layer's own `immediate` transaction is what the hand-composed INSERT above
runs inside.

#### Edge writes and uid lookups inside a transaction: the same rule, extended

`writeEdge`, `invalidateEdge`, and `getNodeByUid` have the identical defect just
proven above for `writeNode`/`findOrCreateNode`: all three are declared on
`GraphBackend`, and every one of them runs against `this.adapter` — the bare,
un-transacted adapter — never against an open `AdapterTransaction`, and nothing
in the class reroutes `this.adapter` to the open `tx` for the duration of a
transaction callback. Verified against the same published dist:

- `writeEdge(src,dst,rel,meta)` (`dist/index.d.ts:303`) is `async writeEdge(...){
await this.writeEdgeInternal(...); }` (`dist/index.js:1835-1837`), whose body
  resolves endpoint kinds via `this.adapter.executeAll(...)` and inserts via
  `this.adapter.executeRun(...)` (`dist/index.js:1865-1899`) — `this.adapter`,
  always.
- `invalidateEdge(src,dst,rel,reason)` (`dist/index.d.ts:271`) is
  `this.adapter.executeGet(...)` then, on a hit, `this.adapter.executeRun(...)`
  (`dist/index.js:1846-1856`) — two separate autocommit statements against the
  bare adapter, no transaction at all.
- `getNodeByUid(uid)` (`dist/index.d.ts:285`) is one
  `this.adapter.executeGet('SELECT * FROM node WHERE uid = ?', [uid])`
  (`dist/index.js:1573-1576`).
- `transaction(fn)` itself — the method that would need to reroute
  `this.adapter` for any of the above to work from inside it — is `return
this.adapter.transaction(fn)` (`dist/index.js:1584-1586`): no context swap,
  `this.adapter` is never reassigned.

So a `writeEdge`/`invalidateEdge`/`getNodeByUid` call made from **inside** a
`store.adapter.transaction(fn, {mode:'immediate'})` callback still runs against
the bare adapter, autocommitting (or reading committed-only state) outside
that transaction — the identical "two separate autocommit statements" defect
just proven for `findOrCreateNode`, now proven for the edge-level and
uid-lookup primitives too. `AdapterTransaction` confirms there is nothing else
to call: it exposes only `executeGet`/`executeAll`/`executeRun`/`exec`
(`@adhd/sox-store-adapter@0.9.0`, `dist/types.d.ts:16-21`) — no graph-level
method exists on it at all.

Every place in this document that reads "atomically, inside the transaction"
for an edge write, an edge invalidate, or a uid-keyed read therefore means the
hand-composed form below, against the SAME `tx` handle the verb's `immediate`
transaction already opened — never a call to `writeEdge`/`invalidateEdge`/
`getNodeByUid` themselves:

- **uid → node, inside a tx:** `tx.executeGet('SELECT * FROM node WHERE uid =
?', [uid])`, mapped onto the fields the caller needs (`rowid`, `kind`,
  `meta`, `is_superseded`, …) — exactly what `getNodeByUid` does at
  `dist/index.js:1573-1576`, just issued against `tx`. This is what `claim`'s
  CAS (§6.3.5) and `NodeUniquenessPolicy`'s component-parent resolution (§1)
  both mean by "the transaction handle."
- **Edge write, inside a tx (upsert, re-livening included):** mirror
  `writeEdgeInternal`'s own INSERT exactly — `tx.executeRun(`INSERT INTO edge
  (src, dst, rel, weight, origin, meta, t_created, t_valid) VALUES (?, ?, ?,
  ?, 'user_asserted', ?, ?, ?) ON CONFLICT(src, dst, rel) DO UPDATE SET meta =
  excluded.meta, weight = excluded.weight, t_invalid = NULL, t_valid =
  excluded.t_valid`, [...])` (`dist/index.js:1894-1898`). This is also why a
  hand-composed edge write re-lives an invalidated edge exactly as the
  library's `writeEdge` does: same `ON CONFLICT` clause, same `t_invalid =
NULL`, just issued against `tx` instead of `this.adapter`.
  Endpoint-existence (`writeEdgeInternal`'s `NodeNotFoundError` guard,
  `dist/index.js:1881-1884`) is preserved via the SAME tx-scoped uid/rowid
  lookup above; edge-kind vocabulary validation
  (`TypePolicy.validateEdge`/`validateRel`, a PURE, no-I/O predicate — §2) is
  preserved by calling the injected `TypePolicy` directly, in-process — the
  write layer holds the same `TypePolicy` instance it passed to
  `createGraphBackend` (or `DEFAULT_TYPE_POLICY`, `dist/index.d.ts:373`, when
  none was supplied) — so no library call, transacted or not, is needed for
  that check at all.
- **Edge invalidate, inside a tx:** mirror `invalidateEdge` exactly —
  `tx.executeGet('SELECT rowid, meta FROM edge WHERE src = ? AND dst = ? AND
rel = ? AND t_invalid IS NULL', [...])`, then on a hit, `tx.executeRun(
'UPDATE edge SET t_invalid = ?, meta = ? WHERE rowid = ?', [...])`
  (`dist/index.js:1846-1855`) — same idempotent "already invalidated or
  absent → no-op" behavior, same `tx`.

This is not new machinery — it is the identical hand-composed-SQL rule this
section already states for `writeNode`/`findOrCreateNode`, extended to the two
other non-transactional primitives the rest of this document names. Every
mention below of `writeEdge`, `invalidateEdge`, or `getNodeByUid` "on the
transaction handle" means this hand-composed form, never the literal library
call.

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
  const newRowid = /* hand-composed INSERT INTO node(...), same tx, mirroring
     writeNodeInTx's column list (index.ts:1869-1883), skipDedupe: true */;
  const now = nowISO();
  await tx.executeRun(
    `INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created, t_valid)
     VALUES (?, ?, 'SUPERSEDES', 1.0, 'user_asserted', NULL, ?, ?)
     ON CONFLICT(src, dst, rel) DO UPDATE SET
       meta = excluded.meta, weight = excluded.weight,
       t_invalid = NULL, t_valid = excluded.t_valid`,
    [newRowid, oldRowid, now, now],
  ); // mirrors writeEdgeInternal's own upsert exactly (index.js:1894-1898),
     // issued against tx instead of this.adapter — never a writeEdge() call,
     // which runs against the bare adapter and would autocommit outside this
     // transaction (§4c, "edge writes and uid lookups inside a transaction")
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
why these are keyed on driver-specific signals — the embedded driver's `err.code`, Turso's message
text, since Turso's `err.code` carries no discriminating information). the write layer
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

| Class                                  | `code`         | Detected via                                                                                                                                                  | `retryable` |
| -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Lock/commit contention                 | `E_CONTENTION` | `isBusyError` / `isConcurrentConflict`                                                                                                                        | `true`      |
| Uniqueness/FK violation                | `E_CONSTRAINT` | `isUniqueConstraintError` / `isForeignKeyError` (includes the hand-composed CAS conflict above)                                                               | `false`     |
| App-level validation                   | `E_VALIDATION` | thrown before any driver call — missing `agent`/`note`/`sha` on a transition, a `kind`/`rel` outside the injected `TypePolicy`, a multiplicity violation (§2) | `false`     |
| Unclassified driver/connection failure | `E_IO`         | `isDatabaseError` catch-all                                                                                                                                   | `true`      |

A caller distinguishes RETRYABLE from TERMINAL from the **returned value alone** —
the `retryable` boolean field, never a message-text match, never a `code` allow-list
guess. This is the same discipline ADR-0012 §4 states for its own envelope
("`retryable: true` remains present in the final envelope even on exhaustion"), and
the reason `code` is a closed union rather than a passthrough of the driver's own
error name: a consumer written against `WriteError` never needs to know Turso emits
`GenericFailure` for everything (ADR-0012 §3) or that the embedded driver emits its own busy code — the
detection layer already normalized that away.

**Two failure-signaling shapes, reconciled into one contract.** `WriteError` above
is `store.adapter.transaction(fn, {mode:'immediate'})`'s own INTERNAL envelope for a
driver-level failure — the shape a the write layer verb's own catch block pattern-matches
on, never the shape a caller of `src/write/` or any transport (CLI/MCP/HTTP) ever
receives directly. Every §6.3 verb catches it at its own transaction call site and
does exactly one of two things: retries per the bound below (`E_CONTENTION` on
every write class, up to 3 attempts; `E_IO` on NO write class — see Retry
semantics below for why the audit row riding along in every transaction rules
this out uniformly, not just for keyless content-node subjects), or — on final
exhaustion of an `E_CONTENTION` retry loop, on the very first (and only)
occurrence of `E_IO`, or immediately for the CAS-detected `E_CONSTRAINT` case
above — re-throws a NEW, transport-facing, named class carrying the envelope's
fields forward: `WriteContentionError(retryAfterMs, cause)` (an exhausted
`E_CONTENTION`), `WriteIOError(cause)` (the first, and only, `E_IO` — never a
retried one), and
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
schedule at the write layer. `E_CONTENTION` is retried on every write class;
`E_IO` is retried on NO write class — the first `E_IO` is surfaced
immediately, for every verb without exception, never retried (see below: every
write-layer transaction always carries the §4a audit INSERT riding along
inside it, itself an un-guarded keyless-content-node write, a hazard no write
class is exempt from). `E_CONSTRAINT` and `E_VALIDATION`
are surfaced on the first attempt in every case — retrying a terminal failure
cannot change its outcome and would only mask the real conflict from the caller.

**Why retrying the whole closure is safe despite `skipDedupe: true` (§1) removing
content-hash dedup as an accidental idempotency guard** — split by entity class,
then unified by one hazard every class shares alike (the always-present audit
row, §4a):

- **Keyless content nodes** (`issue`, `note`, `citation`, `transition`, `audit`): these
  have no business key, so a naive retry that re-runs an already-committed INSERT
  would produce a second, distinct row with no dedupe safety net to collapse it back
  — exactly the risk `skipDedupe: true` opens up. The guard here is transactional
  for `E_CONTENTION` but does NOT extend to `E_IO` — the two retryable classes are
  not equally safe to retry, and this spec's rule for keyless nodes follows that
  split exactly:
  - `E_CONTENTION` (busy/lock detection) is always a BEGIN-phase failure under
    `immediate` mode (above: either the loser's own `BEGIN IMMEDIATE` fails busy
    before any statement in the callback runs, or the loser blocks and its own
    read then takes the "already done" branch) — in neither case has the loser's
    callback reached `COMMIT`. A retryable failure of this class is only ever
    raised as a **thrown** error out of `adapter.transaction(fn, opts)` before any
    commit was attempted, so retrying the closure from scratch cannot produce two
    committed rows; it can only ever produce the one row the
    eventually-successful attempt writes. This BEGIN-phase argument is
    identical for every write class in §4's table — it never depends on what
    the callback's subject write looks like — which is why `E_CONTENTION` is
    safe to retry uniformly, on every verb, including the business-keyed,
    `supersede`-CAS, and touch-based-CAS buckets below (`claim`/`moveIssue`/
    `update`'s touch path/`rmLocation`).
  - `E_IO` (the `isDatabaseError` catch-all for an unclassified driver/connection
    failure) carries no such guarantee. The published adapter's own
    `_runTransaction` retries ONLY a failure at `BEGIN` itself
    (`dist/turso-adapter.js:2345-2365`, verified against the published
    `@adhd/sox-store-adapter@0.9.0` package) — once inside the transaction, one
    `try` wraps BOTH `await fn(tx)` AND the later `await this.db.exec('COMMIT')`,
    and its `catch` attempts a `ROLLBACK` then rethrows the ORIGINAL error on the
    spot, never retried by the adapter itself (`dist/turso-adapter.js:2366-2386`).
    So the write layer's own outer 3-attempt loop is the ONLY retry protection an
    `E_IO` here ever gets, and it cannot distinguish "COMMIT never reached the
    server" from "COMMIT landed but the acknowledgment was lost" — a dropped
    connection during or immediately after COMMIT is exactly this case, and
    "rollback-before-rethrow" does not resolve it: a `ROLLBACK` issued after a
    `COMMIT` that already landed server-side does not undo it, and the adapter's
    own handling of a failed `ROLLBACK` says as much ("a failed ROLLBACK leaves
    transaction state uncertain," `dist/turso-adapter.js:2378-2383`). **This spec
    therefore does not auto-retry `E_IO` for keyless content-node writes:** the
    first `E_IO` is surfaced immediately as `WriteIOError(cause)`
    (`retryable: true` still set in the envelope, per ADR-0012 §4's contract) —
    the caller, who alone has the business context to check whether the write
    actually landed (e.g., a `query` before resubmitting), owns the decision to
    retry, not the write layer.
- **Business-keyed nodes** (catalogs; `project`/`component`/`location`): the
  hand-composed find-then-create (above) runs its find **inside the same
  retried `immediate` transaction**, so even in the limiting case where an
  earlier attempt's write somehow did land (the exact ambiguity the `E_IO`
  discussion above describes), the retry's own SELECT sees that row and takes
  the "found existing" branch rather than re-inserting — this is the exact
  hand-composed find-then-create + `NodeUniquenessPolicy` guard §1 describes,
  the write layer's own composition, never the library's `findOrCreateNode()`
  primitive itself. That guard makes the _subject_ node safe to retry under
  either `E_CONTENTION` or `E_IO`. But the transaction is not only the subject
  node: `writeAudit` (§4a) runs inside the SAME callback, against the SAME
  `tx`, and it is itself a keyless-content-node INSERT with no business key
  and no CAS guard of its own — the find-then-create guard above covers
  `project`/`component`/`location`; it does not, and structurally cannot,
  cover `audit`. A retry whose earlier attempt actually landed (the
  `E_IO`-ambiguous case) therefore correctly no-ops the catalog/registry row
  on the "found existing" branch, but still runs `writeAudit` again,
  unconditionally, producing a second, spurious `audit` row for one logical
  write. So business-keyed nodes get the SAME `E_IO` non-retry treatment as
  keyless content nodes, for a different reason: not because the node itself
  is unsafe to retry, but because the audit row riding along with it is.
- **The `supersede` CAS** (previous section): the single-row-conditional
  `UPDATE ... AND is_superseded = 0` is itself retry-safe — a retried
  attempt's UPDATE either affects the one row still eligible (if the prior
  attempt rolled back) or affects zero rows and surfaces `E_CONSTRAINT` (if
  the prior attempt somehow committed) — never a second supersede of the same
  target. But the same audit-row hazard applies regardless: `writeAudit` runs
  in the same callback and would fire a second time on a retry whose earlier
  attempt actually committed, exactly as in the business-keyed case above.
  `E_IO` is therefore not retried here either, for the audit row's sake, not
  the supersede row's.
- **Touch-based CAS writes** (`claim`/`release`/`renew`, `moveIssue`'s
  `invalidateEdge` + `writeEdge` pair, `update`'s title/metadata `touch`
  path, `rmLocation`): none of these ever INSERT a fresh, business-keyless
  row for their _subject_ — `touch` is a blind `UPDATE node SET … WHERE
rowid = ?` recomputed from a fresh in-transaction read on every attempt
  (verified, `@adhd/sox-graph-store@0.9.1` package dist, `dist/index.js:1482`
  — no re-insert risk: re-running it lands on the same row state whether or
  not a prior attempt already committed); `invalidateEdge` is documented
  idempotent — "an edge that is already invalidated (or absent) is a no-op"
  (`dist/index.js:1839-1840`, same package); `writeEdge` is an `INSERT ...
ON CONFLICT(src, dst, rel) DO UPDATE` upsert keyed on the edge's own
  `(src, dst, rel)` business key, not a bare INSERT (`dist/index.js:1894-
1898`, same package). None of the three can produce a duplicate row on a
  second run, so every subject write in this bucket — `claim`'s CAS-merged
  metadata, `moveIssue`'s edge swap, `update`'s touch path, `rmLocation`'s
  invalidate — is exactly as retry-safe as the business-keyed node case
  above, for `E_CONTENTION` and `E_IO` alike. The audit row is still the
  deciding factor: `writeAudit` rides along in the same callback here too,
  with the same no-business-key INSERT shape, so `E_IO` is not retried for
  this bucket either — for the audit row's sake, exactly as above, never
  because the touch/edge write itself is unsafe.

Collapsing all four buckets into one rule: **`E_IO` is never auto-retried by
the write layer, on any write-layer verb** — not because every subject write
is retry-unsafe (business-keyed nodes, the `supersede` CAS, and every
touch-based CAS write above are genuinely safe to retry on their own merits),
but because `writeAudit` (§4a) is an un-guarded keyless-content-node INSERT
that rides inside literally every write-layer transaction, with no exception
among the verbs in §4's table. `E_CONTENTION`, by contrast, is safe to retry
everywhere, on every verb without exception, because the BEGIN-phase argument
above never depends on what the callback's subject write looks like.

An exhausted retry — 3 attempts for `E_CONTENTION`, on every write class
without exception — or the single first-and-only attempt for `E_IO`, on every
write class without exception (above) — is surfaced to the caller as a
`WriteError` with `retryable: true` still set — the caller, not the write
layer, owns any retry beyond that (ADR-0012 §4). Silent loss — a retryable
failure disappearing with nothing reaching the caller — is explicitly the
failure mode this contract exists to prevent.

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

The requirement, stated precisely: `writeAudit`'s INSERT (and its `audits` edge —
composed by hand against `tx`, mirroring `writeEdgeInternal`'s upsert shape per §4c's
"edge writes and uid lookups inside a transaction" rule above; never a call to the
library's `writeEdge`, which runs against the bare adapter and would autocommit
outside this transaction) executes against the **same `tx` handle**, inside the
**same `immediate` transaction**, as the subject write it records — never a separate
call, never after the subject transaction has committed, never with its own
independent retry loop. A subject write
whose audit insert fails must roll back the subject write too (the single transaction
already guarantees this — there is no separate step to get wrong once the audit
INSERT lives inside the same `fn`). This closes off the exact race the postmortem
found: an audit write can no longer fail _after_ its subject has already durably
committed, because there is no "after" — they commit or roll back together, as one
statement sequence inside one `BEGIN IMMEDIATE`.

**The one structural exception is the embedding audit row** (§4a/§4b:
`embedding_upserted`/`embedding_deleted`/`embedding_failed`). Every OTHER audit
row above is written inside the subject's own transaction because the outcome
being recorded — an issue was created, a status changed, a claim was granted,
a catalog row was upserted — is already fully known to the write layer before
it ever opens that transaction's callback. The embed outcome is different in
kind: it depends on the `createEmbeddingObserver`'s post-commit round-trip to
`semanticBackend` (§4b), which cannot even START until the subject
transaction has committed — there is no way to know
"upserted / deleted / failed" before the fact it records has already
happened. So this ONE audit class is written in its OWN follow-up `immediate`
transaction, opened after the subject write's own transaction has already
committed, exactly as §4a states — never against the subject's `tx` handle,
because that handle no longer exists by the time the outcome is known. This is
a deliberate, narrow carve-out from the same-tx rule above, not a second
instance of it: every audit row this spec writes for an outcome that is known
at write time — every row in every table across §4, §6.3.1–§6.3.7, including
the `claim`/`release`/`renew` and `moveIssue` audit rows — still follows the
same-tx rule above with zero exceptions; only the embed outcome is
structurally unknowable early enough to follow it.

## 5. Query layer (`src/query/`)

Primitives: `queryNodes`, `countNodes`, `countBy`, `getNodesByIds`, `getEdges`
(edge-metadata), keyset `after`, `getSubgraph`/`getNeighbors`, `validAt`.

- Issues by project/component/kind/status/priority via filters + `has_*`/`owns_*`
  traversal.
- **`countBy` supports `'kind' | 'namespace' | 'agentId'` only** (verified,
  `@adhd/sox-graph-store@0.9.1 dist/index.d.ts:300`) — and none of the three
  is the domain BUG/DEBT/FEAT stat a caller actually wants. The library's
  `'kind'` argument groups by the generic `node.kind` STRUCTURAL-type column
  (verified, `NODE_TABLE_DDL_OPEN`, package dist, `dist/index.d.ts:58`:
  `'issue'|'project'|'component'|'status'|'priority'|'kind'|'agent'|
'citation'|'note'|'transition'|'audit'`), never the domain `kind` catalog
  (BUG/DEBT/FEAT), which — like status/priority — is a catalog reference
  living on the `has_kind` EDGE (§3, §6.1), not a `NodeFilter`/`countBy`
  column. So domain-kind counts are EDGE-SCOPED exactly like status/priority
  under this spec's own model (the library deliberately excludes edge-scoped
  references from `countBy`): count `has_kind`/`has_status`/`has_priority`
  edges per catalog node (a single grouped edge query), never
  `countBy('kind'|'status'|'priority')`. `namespace`/`agentId` are the
  library's own memory-graph scoping columns with no referent here: §0.5
  already bans namespace+metadata dual-write, and attribution runs
  through the `agent` catalog + `authored_by` edge (§3), never the
  library's raw `agent_id` node column — so neither `countBy` argument is
  ever meaningfully called from this application layer.
- **Stats are status-aware (BUG-023):** the priority matrix counts non-terminal
  (open) items by default; closed items only under an explicit terminal filter.
- Keyset pagination for stable listing; `validAt` for cumulative-open curves.
- **Hierarchical rollup (FEAT-005):** `part_of` + derived two-axis rollup.
- **Mounted stats/rollup reads:** the status-aware priority matrix, the
  `part_of` rollup and the cumulative-open curve above are each a first-class
  mounted op — `priority-matrix`, `part-of-rollup`, `open-curve` on the CLI
  (`backlog_priority_matrix`/`backlog_part_of_rollup`/`backlog_open_curve` on
  MCP), not `query.view` members (§6.7).
- **Registry views (§3a):** `view: projects|components|locations` (list), and
  the `lookup` verb (resolve a tool/file/url →
  project/component/location) — the agent navigation index, not an item list.

### 5a. Semantic search (FEAT-022)

`view:similar`/`relevance`/`_score` route through
`StoreSearchBackend.searchRanked(query, limit)` with
`signals:[{text},{vec}]` + `rescore:[{kind:'temporal',decay}]`.
`semanticSearchNodes` DELEGATES to text+vec fusion (FEAT-022 §3 — no longer
vector-only); the embedding-only path is `searchRanked({vec, signals:[{vec}]})`.
A title/body text match surfaces even when its vector is not nearest.

**`view:'similar'` requires `filter.anchor` OR `filter.semantic`** (exactly
one seed, either the uid of a reference issue whose own title+body becomes
the query text, or free text supplied directly) — neither given throws
`InvalidArgumentError('filter', ...)`. It also requires a configured search
backend (an embedding/vector provider injected into the store); with none
configured it throws `InvalidArgumentError('semantic', ...)` rather than
silently degrading to grep. The anchor issue itself is always excluded from
its own results.

### 5b. Lazy semantic-backend init (DEBT-BACKLOG-CLI-EAGER-EMBEDDING-001)

> **Historical note (pre-fix state).** The paragraphs under **The defect.**
> below describe the state BEFORE this item was fixed, in the tense they were
> written. They name `store/semantic-search.ts` and its
> `enableSemanticSearchFromConfig` singleton — a module the §7a cutover
> **deleted** (there is no `store/semantic-search.ts` in the package today).
> The shipped design is the single lazy gate described under **The fix**
> further down; this note exists so the defect section is not read as current.

**The defect.** Two independent sites bootstrap the real embedding/vector
stack unconditionally, on every verb dispatch, regardless of whether that
verb's own input ever touches the semantic channel:

1. `cli.ts`'s `getCtx()` and `server.ts`'s `startBacklogServer` each
   unconditionally `await enableSemanticSearchFromConfig(store,
   env.config.embedding)` (`store/semantic-search.ts`) immediately after
   opening the store — before any verb has even been selected.
2. `api.ts`'s `writeHandle`/`queryHandle` each unconditionally `await
   bootstrapSemanticStoreMembers(ctx.store.adapter, ctx.store.graph,
   ctx.env.config.embedding)` (`write/bootstrap.ts`) — and EVERY write verb
   (`create`, `update`, `transition`, `claim`, `relate`, `move`, `delete`,
   `upsertProject`, `upsertComponent`, `upsertLocation`, `rmLocation`) and the
   `query` verb call one of these two functions unconditionally.

With `embedding.enabled: true` — the real, deliberate production setting;
disabling it is not an available fix — both sites resolve a cold ONNX
(`fastembed`/`bge-base-en-v1.5`) model load and a Turso vector-space open on
**every process invocation**, independent of what the invoked verb does.
Measured cost: 1.3–2.5s+ added to every command. For the CLI (a one-shot
process — each command is a fresh process, so a per-adapter memo cache pays
its "once" cost on literally every invocation) this means `claim`,
`transition`, `delete`, `move`, `relate`, and every `upsert*`/`rmLocation`
call — none of which ever read `handle.search`/`handle.embedding` — pay the
full cost anyway. Worse: sites 1 and 2 are two structurally separate
bootstraps (`bootstrapSemanticBackend` in `store/semantic-search.ts` vs.
`deriveMembers` in `write/bootstrap.ts`), each independently calling
`createEmbeddingProvider`/`openTursoVectorStore` — so today, `create`/`update`
with embedding enabled pay the cold-load cost **twice**, sequentially, one
via `getCtx()` and a second, distinct one via `writeHandle`.

**Why the two bootstraps existed (and how the authoritative design resolves
them).** `write/bootstrap.ts`'s own header states it is *deliberately* not
built on `store/semantic-search.ts` — that module is "on the deletion list for
an imminent hard cutover" and is coupled to types outside this data model.
Tracing every consumer confirmed the two paths served genuinely disjoint
purposes:

- `handle.search` / `handle.embedding` (`write/bootstrap.ts`'s
  `bootstrapSemanticStoreMembers`, memoized per `StoreAdapter` in its own
  `membersCache` `WeakMap`) is what every REAL semantic operation reads:
  `create-issue.ts`'s duplicate-scan gate (`scanForDuplicates`,
  `handle.search`), `embedding-observer.ts`'s on-write embed round-trip for
  both `create` and `update` (`handle.embedding`), `query/query.ts`'s explicit
  `filter.semantic` branch (`queryList`, `handle.search`), and
  `query/views/semantic.ts`'s `view:'similar'` (`handle.search`).
- The old singleton (`store/semantic-search.ts`'s
  `configureSemanticBackend`/`isSemanticSearchReadable`) had exactly ONE live
  consumer left: `query/query.ts`'s `resolveTextInput`, which decided whether a
  bare `text` positional (the shared CLI-`search`/MCP/HTTP free-text field, §6)
  auto-routes to `semantic` or `grep`
  (`useSemantic = isSemanticSearchReadable() && handle.search !== undefined`).
  Nothing else in the live 14-verb surface read it — `filter.semantic`,
  `filter.anchor`, and `view:'similar'` all gate on `handle.search` alone,
  never on the singleton.

**The authoritative design: the singleton is deleted, not wrapped.** An earlier
draft of this section mandated keeping BOTH bootstraps — `Promise.all` over
`bootstrapSemanticStoreMembers` and a NEW `legacySingletonReady` twin memo
wrapping `enableSemanticSearchFromConfig` — premised on "the fix cannot simply
delete the `enableSemanticSearchFromConfig` call sites." That premise is
rejected. The design of record deletes those call sites (`cli.ts`'s `getCtx()`,
`server.ts`'s `startBacklogServer`) and replaces `resolveTextInput`'s
process-global `isSemanticSearchReadable()` latch with a per-query read of the
REAL vector table: `handle.search.spacePopulated()` — a one-row probe of the
live space — snapshotted onto `IQueryStoreHandle.spacePopulated` by `api.ts`'s
`queryHandle` before the (synchronous) routing decision reads it.
`resolveTextInput` routes to `semantic` iff `handle.search !== undefined &&
handle.spacePopulated === true`.

**Why the twin memo was rejected.**

1. **It preserves a hidden process-global.** The twin memo keeps
   `store/semantic-search.ts`'s module-level singleton registry alive as the
   routing authority — the exact hidden global `write/bootstrap.ts`'s own
   header says this layer deliberately eliminated (a hidden global is what let
   the production/test divergence this module fixes go unnoticed). Routing off
   a handle-carried, per-query probe has no hidden state.
2. **It is not ADR-0012-correct across processes.** `isSemanticSearchReadable()`
   is a PROCESS-global latch set once at boot from a single space probe: a host
   that boots against an empty space (a fresh store, or one populated by another
   process) latches `false` for its whole lifetime, so every `text:` search
   degrades to grep even after a real embed populates the space. The per-query
   `spacePopulated()` probe reads the durable vector table itself, so a second
   process's `create` is visible to the first process's very next `text:`
   query. `api.semantic-laziness.spec.ts`'s two-adapter case pins exactly this
   (a vector written through adapter A is routed to `semantic` by a `text:`
   query through adapter B on the same file); the twin memo cannot satisfy it.
3. **It is the only reconciliation with the module deletion.** The §7a cutover
   deletes `store/semantic-search.ts` (and its
   `enableSemanticSearchFromConfig`). A design that routes off that module's
   singleton cannot survive the module's own deletion; routing off
   `handle.search` + `spacePopulated()` is the only seam that both removes the
   double bootstrap AND leaves the routing decision addressable once the legacy
   module is gone.

**The fix: a single lazy gate, called only when a verb's own input needs
it.**

1. **Need is structural, not a maintained list.** A verb needs the semantic
   backend live iff it is `create` or `update` (on-write embedding — the
   dup-scan gate is a real read even when the write never later provides a
   `filter.semantic`), OR it is `query` with input matching the SAME
   "semantic inputs" vocabulary `env.ts`'s `embedding.enabled` doc comment
   already names: `filter.semantic`, `filter.anchor`, `view:'similar'`,
   `sort:'relevance'`, `fields` containing `'_vector'` — **plus** a bare
   `text` positional (§6), because deciding whether `text` auto-routes to
   `semantic` or `grep` itself requires knowing whether the backend is
   live. `get`, `lookup`, `transition`, `claim`, `relate`, `move`, `delete`,
   `upsertProject`, `upsertComponent`, `upsertLocation`, and `rmLocation`
   never need it — none of their write/query handles ever read
   `search`/`embedding`.
2. **One accessor, memoized per adapter.** `api.ts` gains
   `ensureSemanticReady(ctx: BacklogCtx): Promise<SemanticStoreMembers>` — the
   sole call site of `bootstrapSemanticStoreMembers` (already self-memoized via
   its own `membersCache`). There is no second bootstrap to combine: the legacy
   singleton is not part of this path, so the sequential-double-cost defect is
   removed by the legacy call's deletion, not by running two loads in parallel.
   `bootstrapSemanticStoreMembers`'s own "never throws" contract is unchanged.
3. **`writeHandle`/`queryHandle` take an explicit `needsSemantic: boolean`
   and only call `ensureSemanticReady` when it is `true`; false skips the
   accessor entirely and returns a handle whose `search`/`embedding` are
   absent** — the exact same "absent means unconfigured" shape these
   handles already produce today whenever the backend fails to start
   (BUG-045's rule, `api.ts`'s existing `writeHandle`/`queryHandle` doc
   comments), never a stub. The boolean is computed at each of `api.ts`'s
   14 verb call sites — `true`/`false` literals for the 12 verbs whose need
   is fixed regardless of input, and `queryNeedsSemanticBackend(input)` (a
   new pure predicate exported from `query/query.ts`, next to
   `resolveTextInput`) for `query`, whose need depends on the caller's
   input shape. This keeps "what needs it" visible at the exact call site
   that wires each verb, rather than a separately maintained list that
   drifts as verbs are added.
   `queryHandle` additionally takes `probeSpace: boolean` — `true` iff the
   caller passed a bare `text:` positional — and, when set, awaits
   `search.spacePopulated()` and snapshots the result onto
   `handle.spacePopulated` before returning. That snapshot is what
   `resolveTextInput` reads; it is the per-query replacement for the legacy
   singleton latch (see the rejection note above).
4. **`getCtx()` (`cli.ts`) and `startBacklogServer` (`server.ts`) stop
   calling `enableSemanticSearchFromConfig` entirely.** Opening the store
   no longer touches the embedding stack at all; only a verb dispatch that
   actually needs it does, via step 2/3 above.

**Never-throws is preserved exactly.** `ensureSemanticReady` performs no
error handling of its own — `bootstrapSemanticStoreMembers` already swallows
every soft failure internally (log + degrade to absent members, §5a's and this
section's own citations) — so a `create` whose embedding backend is broken
still writes the issue successfully with `handle.embedding` absent, exactly as
before this fix, and a `claim`/`transition`/`delete` never even attempts the
bootstrap, broken or not. (A member-less result is not cached: the
`membersCache` evicts it, so a transient failure self-heals on the next
semantic verb rather than latching for the process lifetime.)

**Implementation (authoritative — shipped in `4d54a54f`; this is the design of
record, and supersedes the earlier `Promise.all` + `legacySingletonReady`
draft):**

- `entrypoint/backlog/src/api.ts`:
  - Add `import type { SemanticStoreMembers } from './write/bootstrap.js';`
    (on the existing `bootstrapSemanticStoreMembers` import line) and
    `import { queryNeedsSemanticBackend } from './query/query.js';` (alongside
    the existing `queryIssuesWithMeta` import from the same file).
  - Add, near the existing `writeHandle`/`queryHandle`:
    ```ts
    async function ensureSemanticReady(
      ctx: BacklogCtx
    ): Promise<SemanticStoreMembers> {
      return bootstrapSemanticStoreMembers(
        ctx.store.adapter,
        ctx.store.graph,
        ctx.env.config.embedding
      );
    }
    ```
    (No `legacySingletonReady` memo and no `Promise.all` — see the rejection
    note above.)
  - Change `writeHandle`'s signature to `(ctx: BacklogCtx, opts: {
    needsSemantic: boolean })` and its body to
    `const { search, embedding } = opts.needsSemantic ? await ensureSemanticReady(ctx) : {};`
    (delete its direct `bootstrapSemanticStoreMembers` call).
  - Change `queryHandle`'s signature to `(ctx: BacklogCtx, opts: {
    needsSemantic: boolean; probeSpace: boolean })` and its body to:
    ```ts
    const { search } = opts.needsSemantic ? await ensureSemanticReady(ctx) : {};
    const spacePopulated =
      search !== undefined && opts.probeSpace
        ? await search.spacePopulated()
        : undefined;
    ```
    returning `graph`, an `assertVocabulary` thunk, and `search`/`spacePopulated`
    spread in only when defined.
  - Update every call site:
    - `create` → `writeHandle(ctx, { needsSemantic: true })`
    - `update` → `writeHandle(ctx, { needsSemantic: true })`
    - `transition`, `claim`, `relate`, `move`, `remove` (the `delete` verb),
      `upsertProject`, `upsertComponent`, `upsertLocation`, `rmLocation` →
      `writeHandle(ctx, { needsSemantic: false })`
    - `query` → `queryHandle(ctx, { needsSemantic:
      queryNeedsSemanticBackend(input), probeSpace: input.text !== undefined })`
- `entrypoint/backlog/src/query/query.ts`: add and export, next to
  `resolveTextInput`:
  ```ts
  export function queryNeedsSemanticBackend(input: IIssueQueryInput): boolean {
    return (
      input.text !== undefined ||
      input.filter?.semantic !== undefined ||
      input.filter?.anchor !== undefined ||
      input.view === 'similar' ||
      input.sort === 'relevance' ||
      (input.fields ?? []).includes('_vector')
    );
  }
  ```
  Change `resolveTextInput` to
  `const useSemantic = handle.search !== undefined && handle.spacePopulated === true;`
  and delete its `isSemanticSearchReadable` import. Add `spacePopulated():
  Promise<boolean>` to the `IQueryStoreHandle['search']` member shape and the
  optional `spacePopulated?: boolean` snapshot field (point 3 above).
- `entrypoint/backlog/src/cli.ts`: in `getCtx()`, delete the
  `await enableSemanticSearchFromConfig(store, env.config.embedding);` line and
  its doc comment, and remove the now-unused
  `enableSemanticSearchFromConfig` import.
- `entrypoint/backlog/src/server.ts`: in `startBacklogServer`, delete the
  `await enableSemanticSearchFromConfig(store, env.config.embedding);` line and
  its doc comment, and remove the now-unused import. The surrounding
  `try/catch` structure is unchanged — the `try` block still exists for
  `openGraphBacklogStore` itself (there is no serve-lock to release any more —
  see STATE.md A17).
- Test file `entrypoint/backlog/src/api.semantic-laziness.spec.ts` (in-process,
  real store, real `BacklogCtx` built via `buildBacklogEnv({..., namespace:
  'test' })` against a temp `dbPath`; `vi.mock('@adhd/sox-embedding-provider',
  ...)` with the deterministic fake from
  `src/test/helpers/fake-embedding-provider.ts`, and a per-call spy on
  `createEmbeddingProvider`, so every assertion is an invocation COUNT, never
  wall-clock):
  - `embedding.enabled: true`, each of `claim`/`transition`/`move`/`relate`/
    `delete`/`upsertProject`/`upsertComponent`/`upsertLocation`/`rmLocation`
    called once → the provider spy count stays `0` after each. (Proves point
    1's "never needed" set.)
  - `create`, then `update`, each called once → the provider is constructed
    exactly once across every verb (not `0`, not `2` — the
    sequential-double-bootstrap defect is gone) and the created/superseding
    rows carry the fake provider's model id (on-write embedding genuinely
    runs).
  - `query` with a plain `{ filter: { status } }` → count `0`; `query` with
    `{ filter: { semantic } }` → count `1` and a real ranked result.
  - **Empty-space control:** a bare `text:` against a store whose vector space
    is still empty routes to `grep` (the `searchRanked` spy stays at `0`) —
    proving routing keys on the live space being populated, not on a backend
    merely existing. **Positive control:** the same `text:` routes to
    `semantic` (`searchRanked` count `1`) after an on-write embed, with no
    restart.
  - **Cross-process control (ADR-0012):** a vector written through adapter A is
    routed to `semantic` by a `text:` query issued through a SECOND adapter on
    the same file — the property the rejected process-global latch could not
    provide.
  - **Negative control (mandatory, AGENTS.md §7):** revert `writeHandle` to its
    pre-fix unconditional `await bootstrapSemanticStoreMembers(...)` (no `opts`
    gate) and confirm the `claim`/`transition`/`delete` count-`0` assertions go
    RED. Then restore the fix.
  - **Never-throws preservation:** a second variant configures
    `embedding.enabled: true` with `@adhd/sox-embedding-provider` mocked to a
    `createEmbeddingProvider` that rejects, and asserts (a) `create` still
    returns a success envelope with the issue actually persisted
    (`handle.embedding` absent, dup-scan reports unavailable, write proceeds —
    §5b's "never-throws" paragraph), and (b) `claim`/`transition` still succeed
    without ever invoking the mocked (throwing) provider at all — proving the
    lazy gate, not the swallow-the-error path, keeps them fast.

### 5c. `--namespace` flag (replaces `--sandbox`)

**The defect this replaces.** `--sandbox` (`cli.ts`'s `stripSandboxFlag`) is a
boolean flag that conflates two things a caller should be able to control
independently: *which declared namespace an invocation resolves under* and
*whether the isolation root is a brand-new throwaway directory*. It also
carries an accidental-not-deliberate correctness property: an isolated
invocation gets `embedding.enabled: false` only because no `config.yaml`
happens to exist yet at its resolved root — a real file placed there by a
prior manual run would silently defeat that, reintroducing the exact
config-cascade bleed-through this whole mechanism exists to prevent (the
1213ms-vs-52ms measurement above `A13-PIVOT` in `STATE.md`). This section
replaces the boolean with an explicit `--namespace <value>` flag and closes
the accidental-default gap.

Every one of the four hard-won bug fixes carried by today's `--sandbox` path
is preserved below by construction, not by incidental overlap — each is
numbered and cross-referenced to the design decision that carries it forward.

#### D1. Surface: `--namespace <value>`, parsed anywhere in argv

`runBacklogCli` gains a value-taking flag, recognized and stripped anywhere
in `argv` (before verb dispatch), the same way `--help`/`--sandbox` already
are — a caller should not have to remember flag ordering. Replaces
`stripSandboxFlag`'s boolean scan:

```ts
export function stripNamespaceFlag(argv: readonly string[]): {
  argv: string[];
  namespace: string | undefined;
  /** `true` iff `--namespace`/`--namespace=` was present but supplied no
   *  value (bare trailing flag, or `--namespace=` with nothing after `=`) —
   *  distinct from "flag absent" so the caller can reject it (D3) instead of
   *  silently falling through to the default, the exact "explicit ask
   *  silently ignored" class D3 exists to kill. */
  missingValue: boolean;
  /** `true` iff `--namespace`/`--namespace=` appeared MORE THAN ONCE with
   *  two DIFFERING values — e.g. `--namespace test --namespace sandbox`.
   *  Every occurrence is always stripped from the returned `argv` (never
   *  just the first — a leaked, un-stripped second `--namespace <value>`
   *  would otherwise fall through into the verb argv and get rejected by
   *  the cli-output plugin's own generic, unrelated flag-parsing error
   *  instead of this flag's clean `invalid_argument` envelope, the exact
   *  cryptic-failure class D3 exists to kill). Two occurrences with the
   *  SAME value are not a conflict (idempotent, e.g. a wrapper script that
   *  always appends `--namespace $NS` and a caller who also typed it). */
  conflicting: boolean;
} {
  const values: string[] = [];
  let rest: string[] = [];
  let missingValue = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--namespace=')) {
      const value = arg.slice('--namespace='.length);
      if (value === '') missingValue = true;
      else values.push(value);
      continue;
    }
    if (arg === '--namespace') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        missingValue = true;
      } else {
        values.push(next);
        i++; // consume the value token too
      }
      continue;
    }
    rest.push(arg);
  }
  const distinct = new Set(values);
  return {
    argv: rest,
    namespace: values[values.length - 1],
    missingValue,
    conflicting: distinct.size > 1,
  };
}
```

Both `--namespace <value>` and `--namespace=<value>` are accepted — two real
spellings a caller reasonably types, and treating only one as valid would
itself be a silent-ignore trap for the other. Every occurrence is stripped
from the returned `argv` regardless of count (never just the first). A bare
`--namespace` with no following value (end of argv, or the next token is
itself another flag) sets `missingValue: true` rather than silently treating
the flag as absent; two occurrences with genuinely differing values set
`conflicting: true`. `runBacklogCli` checks `missingValue`/`conflicting`
before the D3 validity check and rejects either with the same
`invalid_argument` envelope — `missingValue` naming `"namespace"` and stating
a value is required, `conflicting` naming `"namespace"` and listing the
distinct values it saw.

`RunBacklogCliOpts.namespace` already exists (added for A10/`--sandbox`) and
needs no shape change — it remains the single explicit-parameter-first field
threaded into `buildBacklogEnv`. What changes is who sets it: a parsed
`--namespace <value>` (or a programmatic caller's `optsIn.namespace`) sets it
directly, instead of `--sandbox` hardcoding `'test'`.

#### D2. Default: `'production'`

Omitting `--namespace` resolves exactly as every existing production
invocation does today — no behavior change for the overwhelmingly common
case. This is enforced twice, redundantly and deliberately: `buildBacklogEnv`
already defaults `options.namespace ?? 'production'`, and
`backlogEnvironmentSpec.namespaces` keeps `'production'` first (the
framework's own `namespaces[0]` fallback, per `env.ts`'s existing comment on
why that ordering is load-bearing). `runBacklogCli` does not need its own
third default — it simply leaves `opts.namespace` unset when the flag is
absent and lets `buildBacklogEnv` do what it already does.

#### D3. Validation: reject an unrecognized value by name, with a suggestion

An unrecognized `--namespace` value must never resolve silently (that would
either fall through to `buildBacklogEnv`'s own default, silently ignoring a
caller's explicit ask, or — worse — get passed straight through to
`EnvironmentOptions.namespace`, minting a real, ungoverned root segment
outside the declared set). `runBacklogCli` validates the parsed value against
`backlogEnvironmentSpec.namespaces` before doing anything else with it,
reusing this package's own established pattern for an unresolved catalog
value (`query --input '{"filter":{"kind":"typo"}}'`, CHANGELOG's "suggesting
the nearest existing catalog name" entry) rather than a generic type error:

```ts
if (namespace !== undefined && !backlogEnvironmentSpec.namespaces?.includes(namespace)) {
  const valid = backlogEnvironmentSpec.namespaces ?? [];
  const suggestions = suggestClosestCatalogNames(namespace, valid);
  const detail =
    `must be one of ${valid.map((v) => `"${v}"`).join(', ')}` +
    (suggestions.length > 0
      ? ` (did you mean ${suggestions.map((s) => `"${s}"`).join(' or ')}?)`
      : '');
  const env = errorEnvelope('invalid_argument', `Invalid argument "namespace": ${detail}`);
  console.log(JSON.stringify(env));
  process.exitCode = exitCodeForEnvelope(env);
  return;
}
```

`suggestClosestCatalogNames` (`query/resolve.ts`) is already a pure
`(value, candidates, max) => string[]` function with no store/graph
dependency — reused verbatim, not reimplemented, per this package's own
reuse-over-duplication rule. The failure is emitted as the SAME
`{ok:false,error:{code:'invalid_argument',...}}` envelope shape every other
CLI failure produces (`envelope.ts`), with the same exit code (2) — a caller
scripting against this CLI sees one uniform failure shape whether the
rejection happened before or after command dispatch, never a bare
`console.error` + ad hoc exit code the way `--sandbox`'s silent-bypass
warning is today (that warning is a *warning*, not a rejection — it still
proceeds; this is a hard validation failure and must not proceed).

#### D4. `'sandbox'` is its own declared namespace, not an alias for `'test'`

`backlogEnvironmentSpec.namespaces` becomes `['production', 'test',
'sandbox']` — three declared values, not two with an alias.

**Why not alias `sandbox` onto the existing `test` namespace with
ephemeral-root-minting as a bolt-on:** the alternative reading would keep
`namespaces: ['production', 'test']` and treat `--namespace sandbox` as pure
syntax sugar for `{ namespace: 'test', adhdRoot: mkdtemp(...) }`. Rejected,
for three concrete reasons:

1. **`'test'` already has a stated, distinct purpose that this task's own
   framing introduces**: a deliberately-persisted, non-ephemeral namespace
   suited to something like a shared CI/team store that is expected to
   accumulate state across many invocations over time. An ephemeral,
   mint-a-fresh-root-every-time mode is the opposite lifecycle. Folding both
   under one directory-segment name (`.../backlog/test/...`) means two
   invocations with completely different lifetime guarantees become
   indistinguishable by the one field (`namespace`) that is supposed to
   describe exactly that.
2. **Observability breaks.** `sandbox-path`'s whole contract (D6, below) is
   "report the resolved isolation root + namespace so a caller can confirm
   what they are about to write into, without opening the store." If
   `--namespace sandbox` reported `namespace: 'test'` in that diagnostic, a
   caller who explicitly typed `sandbox` would see a different word reflected
   back — the exact kind of "looks like isolation but the label lies" trap
   `BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001` was about.
3. **No real cost avoided.** Aliasing saves exactly one array entry
   (`'sandbox'` vs `'test'` in `namespaces`); it buys nothing, since
   `adhdRoot` minting is already a fully separate code path regardless of
   which namespace name it is paired with.

Declaring `sandbox` as its own namespace costs nothing structurally —
`resolveRoots` (`environment-builder/src/roots.ts`) already treats
`namespace` as an opaque path segment, so a third value nests exactly like
the first two (`<root>/backlog/sandbox/...`).

#### D5. `sandbox` as a value layers ephemeral-root-minting on top of namespace selection (superset behavior)

`--namespace sandbox` does everything `--namespace test` would structurally
do (resolve under a `sandbox` root-namespace segment) **plus** mint a fresh
`mkdtempSync(join(tmpdir(), 'backlog-sandbox-'))` `adhdRoot`, exactly as
today's `--sandbox` boolean does — this is what makes it "a superset," per
the task framing. The two effects are independent knobs on the same
`RunBacklogCliOpts`:

- `namespace` (the path segment) — set to the parsed `--namespace` value,
  defaulting to `'production'` (D2).
- `adhdRoot` (the isolation-root base) — minted fresh ONLY when
  `namespace === 'sandbox'`, using the exact same guard logic `--sandbox`'s
  handling block already has (reused verbatim, just re-keyed off the new
  flag):

Every existing guarantee this block already carries forward unchanged:

| Guarantee | Fix ID | How D5 preserves it |
|---|---|---|
| An already-set ambient `ADHD_ROOT` that is not one of this tool's own sandbox tmpdirs must never be silently reused | `BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001` | The `looksLikeOwnSandboxDir` guard and its loud `console.error` + fresh-mint override are unchanged — still gated on `namespace === 'sandbox'` instead of the old `sandbox` boolean, same logic, same message. |
| A caller following the printed "pass `ADHD_ROOT=<path>` to reuse it" instruction must actually work | `BUG-BACKLOG-SANDBOX-ADHDROOT-UNWIRED-001` | The `process.env['ADHD_ROOT']` read into `opts.adhdRoot` (when `optsIn.adhdRoot` is unset) stays exactly where it is, before the `namespace === 'sandbox'` branch — an explicit `optsIn.adhdRoot` or a recognized ambient `ADHD_ROOT` still wins outright over minting a new one. |
| `APIGEN_IR_CACHE_FILE` redirects into the sandbox tmpdir | `BUG-BACKLOG-SANDBOX-IRCACHE-LEAK-001` | Unchanged — still guarded on `opts.adhdRoot !== undefined` (never on the flag name), so it fires identically whether `adhdRoot` came from a mint, a reuse, or a programmatic caller. |
| `--sandbox` sets an explicit `namespace` parameter as a second, structural layer of isolation independent of the `adhdRoot` swap | (A10's own fix, folded into this design) | Superseded by construction: `namespace` is now the PRIMARY explicit parameter (D1), no longer a side effect `--sandbox` sets internally — the same explicit-parameter-cannot-be-silently-defeated property A10 established, now the flag's whole point rather than one of its side effects. |
| The telemetry file sink must never write into the real `~/.adhd/sox-ecosystem/backlog/logs` tree under an isolated invocation | `BUG-BACKLOG-SANDBOX-TELEMETRY-001` | `index.ts`'s bin-entry guard — which calls `initTelemetry(...)` BEFORE `runBacklogCli` ever runs, so it cannot see `opts.namespace` — imports and calls `stripNamespaceFlag` (D1's replacement for `stripSandboxFlag`) directly on `process.argv.slice(2)`, the same "peek at the flag only to redirect `logDir`, never re-dispatch" pattern it already uses today. The redirect condition changes from `sandbox === true` to `namespace === 'sandbox'`; the minted `sandboxLogDir` (`mkdtempSync(join(tmpdir(), 'backlog-sandbox-logs-'))`) is unchanged. This guarantee was not named in the original "preserve" list handed to this design pass, but it is carried by the exact code this design replaces, so it is preserved here rather than silently dropped. |

Two ordering notes this table implies but does not otherwise state
explicitly: (1) `index.ts` and `cli.ts` each independently call
`stripNamespaceFlag` on their own copy of `process.argv` — exactly as
`stripSandboxFlag` is independently called twice today — so the two call
sites can never desync on which flag string they recognize, since both read
the same exported parser. (2) `--namespace sandbox serve` must work
identically to `--namespace sandbox <verb>`: A10 already threaded `namespace`
through `RunServeCommandOpts`/`StartOpts` down to `startBacklogServer`, and
D8's config-materialization write (below) happens in `runBacklogCli` before
the `serve` special-case dispatches to `runServeCommand` — so a sandboxed
`serve` invocation's config is written before `startBacklogServer` ever
constructs its own `Environment`, the same ordering every other sandboxed
verb gets.

#### D6. `sandbox-path` diagnostic — contract unchanged, payload unchanged in shape

`sandbox-path` keeps reporting the resolved isolation root, the effective db
path, and the effective `namespace`, without ever opening the store — the
same `buildBacklogEnv`/`resolveBacklogDbPath` path every real store-open site
resolves through (BUG-002 parity, already true today). `namespace` now
reflects whatever value was actually requested
(`'production'`/`'test'`/`'sandbox'`) rather than the old binary
`'test'`-or-`'production'` choice; the boolean `sandbox` field is removed
outright (replaced by the richer `namespace` field it was always a stand-in
for — see D7 on why it is not kept as a second, redundant field).

One field is genuinely NEW, not a rename: `embeddingEnabled: boolean`, read
straight off `env.config.embedding.enabled` after `buildBacklogEnv` resolves
— the same `env` this diagnostic already builds to compute `dbPath`, so this
costs one extra property read, no extra resolution work. This exists
specifically so D8's guarantee (the config-materialization fix) has a
**structural** assertion point: a test can confirm the resolved,
effective config value directly, rather than inferring it from wall-clock
timing (a real, but strictly weaker, proxy — see the Test plan). Final
payload shape: `{adhdRoot, namespace, dbPath, embeddingEnabled}`.

This is also a breaking shape change to `cli.spec.ts`'s own
`SandboxPathBody` test-helper type (currently modeling the old
`{sandbox, adhdRoot, namespace, dbPath}` shape, per the in-flight `A13-PIVOT`
helper work) — implementation must update that type alongside the runtime
payload, not treat it as a pre-existing test fixture to leave alone.

#### D7. Backward compatibility: hard removal, no deprecated alias

`--sandbox` (the boolean flag) is deleted outright in the same change that
adds `--namespace` — not kept as a deprecated alias for one release. This
package's own conventions make that the only choice consistent with how it
already treats itself: §0 states plainly that this application layer has "no
coexistence with anything else, no dual-write bridge, and no gradual
deprecation window," and the CHANGELOG's own `Unreleased` section shows
`--sandbox` itself has never shipped in a published version — there is no
external consumer to break, so a deprecation window would protect nobody and
would just be a second flag surface to maintain and eventually delete anyway.
`stripSandboxFlag` is deleted and replaced by `stripNamespaceFlag` (D1); the
`--help` text's `--sandbox` line is replaced by a `--namespace <value>` line
naming the three valid values.

#### D8. Explicit sandbox config materialization (the "properly set up" ask)

**The gap.** Today, an isolated invocation gets `embedding.enabled: false`
purely because no `config.yaml` exists yet at its resolved global root — an
accident of a fresh directory, not a decision this tool ever makes. A stray
`config.yaml` left over from an earlier manual experiment at that same
resolved path (or, for the reused-`ADHD_ROOT` case `BUG-BACKLOG-SANDBOX-ADHDROOT-UNWIRED-001`
explicitly supports, a config a caller wrote into a sandbox root themselves
on a prior invocation) would silently reintroduce the exact bleed-through
this whole mechanism exists to prevent, indistinguishable from the correct
case by anything short of opening the file.

**The fix: write a real `config.yaml`, not an in-code override.**
`runBacklogCli`, immediately after resolving `opts.adhdRoot` for a
`namespace === 'sandbox'` invocation and before ever calling
`buildBacklogEnv`, writes:

```ts
const sandboxConfigDir = join(opts.adhdRoot, 'backlog', 'sandbox');
mkdirSync(sandboxConfigDir, { recursive: true });
writeFileSync(
  join(sandboxConfigDir, 'config.yaml'),
  '# Written by --namespace sandbox on every invocation — DELIBERATE, not\n' +
    "# an absence-of-file default. embedding.enabled is off so a sandboxed\n" +
    '# run never pays a real model-load cost or opens a real vector store.\n' +
    'embedding:\n' +
    '  enabled: false\n'
);
```

This targets exactly the file `environment-builder/src/layer-files.ts`'s
`loadLayerFiles` already reads for the `global` root
(`join(roots.global, CONFIG_FILENAME)`), and `roots.global` for a
sandbox invocation is `join(adhdRoot, 'backlog', 'sandbox')` — the identical
path `resolveRoots` (`environment-builder/src/roots.ts`) computes internally,
since `adhdRoot` overrides the global-root base directly. No new
`@adhd/environment` capability is needed.

**Why a written file, not an in-code override layer, even though the
in-code form would be structurally undefeatable by any stray file at all.**
Both would close the gap; they are not equally cheap. `EnvironmentOptions`
(`environment-base-spec/src/index.ts`) has no config-override field today —
`resolveConfig`'s cascade (`config-resolver.ts`) is env var → local file →
project file → global file → system file → spec default, with no sixth,
caller-injected tier. Adding one means extending
`@adhd/environment-base-spec`'s public options shape and
`environment-builder`'s resolver precedence — a cross-package change whose
blast radius is every consumer of the framework, not just this CLI, to buy a
guarantee this CLI can already get for free: because the write above happens
unconditionally on every `sandbox` invocation, immediately before
`buildBacklogEnv` reads the file layers, it **overwrites** whatever was at
that exact path a moment before — the deliberate value wins by mtime, not by
outranking a stray file that is still permitted to exist. A written file also
satisfies the user's own "inspectable" framing directly: `cat
<adhdRoot>/backlog/sandbox/config.yaml` shows a human exactly why embeddings
are off, with a comment saying so, which an in-code override could never
show without also being read out of the source.

**`ADHD_BACKLOG_EMBEDDING_ENABLED` still outranks the written file, and
that is intended, not an oversight.** The env var is the top tier of
`config-resolver.ts`'s cascade, above every file layer — a sandboxed
invocation with that env var explicitly set to `true` still resolves
`embedding.enabled: true`, D8's written `config.yaml` notwithstanding. This
is correct: an explicit env var is a deliberate, conscious ask from whoever
is invoking the CLI (a caller who set it clearly wants embeddings on for
this run, sandbox or not), categorically different from a *stray* file
nobody consciously placed there for this invocation. D8 closes the
accidental-file gap; it does not, and should not, override a caller's
explicit env-var request.

**Scoped to `sandbox` only, not also `test`.** `test` is deliberately the
persisted, non-ephemeral namespace (D4) — a team standing up a shared
CI/testing store under it may have legitimate reasons to hand-author its own
`config.yaml` there (e.g. deliberately turning embeddings ON to test the RAG
path against a stable non-production store). Auto-overwriting that file on
every invocation would fight an intentional configuration this design has no
business overriding. `sandbox`'s ephemeral, throwaway-by-construction
lifecycle has no such competing use case: nothing is ever meant to persist
custom config there across runs.

**Open, explicitly unresolved residual gap.** The write above targets the
`global`-scope root (`resolveBacklogScope`'s own default when no scope is
given). If a caller combines `--namespace sandbox` with an explicit
`--scope project` (or `ADHD_BACKLOG_SCOPE=project`) while invoked from a
directory that itself has a checked-in `.adhd/backlog/sandbox/config.yaml`,
that PROJECT-layer file resolves via `ctx.projectRoot` (the real cwd's
project marker), not via `adhdRoot` — `adhdRoot` only overrides the
`global`/`system` root bases (`roots.ts`'s `resolveRoots`), never the project
root. Per the cascade's own precedence (`config-resolver.ts`:
system → global → project → local, project outranks global), such a
project-layer file would still win over this fix's deliberate global-layer
write. This is a real, narrow gap, not swept under: it requires a
project-scoped sandbox combined with a repo that happens to carry that exact
committed file, which is not this session's default path (`resolveBacklogScope`
defaults to `'global'`, not `'project'`), but it is not solved by D8 as
written. Flagged here for the same reason `A13-PIVOT` flagged its own
ambiguity rather than silently guessing — a project-scope-aware sandbox
config write is real, additional work, not yet designed, and should be
confirmed as in-scope or explicitly deferred before implementation closes
this section out.

#### Open question already raised by `A13-PIVOT`, resolved here

**Does "support the standard adhd scopes" mean unifying `--scope` and
`--namespace`, or does `--namespace` validate against the declared namespace
list while the existing, separate `--scope` flag stays untouched?** This
design proceeds on the second reading — the one `STATE.md`'s `A13-PIVOT`
entry already flagged as lower-risk — and states the reasoning in the open,
per that entry's own instruction, rather than silently committing to it a
second time.

The two concepts are genuinely orthogonal in the framework this package
already sits on, not just historically separate by accident: `scope`
(`global`/`project`/`system`) answers **where** a root lives — which of three
physical base directories (`~/.adhd`, `<repo>/.adhd`, the OS app-support dir)
an invocation's files resolve under. `namespace` answers **which parallel
store instance** exists at that location. `resolveRoots` composes them
multiplicatively, not as alternatives: every root is
`<base>/<project>/<namespace>` (`roots.ts`) — `scope` picks the `<base>`,
`namespace` picks the trailing segment underneath it. Collapsing them into
one flag/one concept would mean giving up real, currently-expressible
combinations for no stated gain: a `project`-scoped repo's real store and a
`project`-scoped repo's `sandbox` isolation run would become
indistinguishable requests, since there would be no second axis left to say
"same place, different instance." Nothing in the user's two verbatim
requests — "support the standard adhd scopes" and the sandbox-config
follow-up — asks for that collapse; "standard adhd scopes" reads most
naturally as "the same closed vocabulary every other `@adhd/environment`
consumer already validates against" (i.e., `Scope`'s `'global'|'project'|
'system'` are a solved, existing concept to point at for shape/rigor, not a
literal instruction to fold two flags into one). If this reading is wrong,
the concrete alternative (a single flag whose value can be either a scope
name or a namespace name, disambiguated by which declared set it matches)
is a materially bigger change — it would need its own collision-handling
design (what happens if a project someday declares a namespace also named
`'global'`?) — and should be scoped as its own follow-on rather than folded
silently into this one.

#### Test plan

New/changed tests, following AGENTS.md §7 (real components, negative
controls with teeth, no proxy assertions, no wall-clock-only proofs):

1. **Real isolation under a genuinely dirty machine config (the headline
   proof).** A real spawned-bin test (`cli.spec.ts`) invoking `--namespace
   sandbox sandbox-path` (and a second real verb call) while the actual
   machine's `~/.adhd/backlog/production/config.yaml` has
   `embedding.enabled: true` (true on this machine today, per `STATE.md`) —
   asserts (a) the reported `namespace` is `'sandbox'`, (b) the reported
   `dbPath` is under a fresh `backlog-sandbox-*` tmpdir, never under the real
   `~/.adhd` tree, (c) the reported `embeddingEnabled` (D6's new structural
   field) is `false`, and (d) a real end-to-end command's wall-clock lands in
   the fast-path band the ~52ms measurement established (bounded generously,
   e.g. `< 300ms`, never a tight timing assertion) rather than the ~1213ms
   embedding-load band. (c) is the structural proof; (d) is kept alongside it
   because the user explicitly asked for the 52ms-vs-1213ms measurement to be
   reproduced, but (d) alone would let a slow CI box fail a correct build, so
   it is never the sole assertion.
2. **The negative control for D8 specifically — the actual proof that closes
   the accidental-vs-deliberate gap.** Before invoking `--namespace sandbox`,
   the test:
   - Mints its own sandbox-shaped root itself, via
     `mkdtempSync(join(tmpdir(), 'backlog-sandbox-'))` — matching the
     `looksLikeOwnSandboxDir` naming pattern the silent-bypass guard checks
     for. A root created any other way is REJECTED by that guard (loud
     warning + fresh mint), which would make the pre-planted file below
     unreachable and the test pass vacuously regardless of whether D8's write
     exists.
   - Pre-plants a real `config.yaml` with `embedding.enabled: true` at
     `<thatRoot>/backlog/sandbox/config.yaml` — the exact path D8's own write
     targets.
   - Invokes `--namespace sandbox sandbox-path` with `ADHD_ROOT=<thatRoot>`
     set (the documented reuse contract, `BUG-BACKLOG-SANDBOX-ADHDROOT-UNWIRED-001`),
     so the mint-guard recognizes and reuses this exact root rather than
     minting a fresh one.
   - Asserts the reported `embeddingEnabled` (D6) is `false` — i.e. D8's
     write genuinely overwrote the planted stray file, not merely that no
     file existed to begin with.
   - **Negative control, mandatory:** temporarily remove D8's `writeFileSync`
     call and confirm this exact assertion goes RED (the planted `true`
     survives untouched). Restore the write. Without this step the test above
     could pass by coincidence (e.g. some unrelated code path also happening
     to reset the field) rather than because D8's write ran — D8 is the
     entirety of part B's ask, and it is the one decision in this section
     that most needs teeth, not just a green assertion.
3. **Unrecognized `--namespace` value.** A real spawned-bin test asserting
   `--namespace bogus <any command>` exits with code `2`, and the printed
   envelope's `error.code` is `'invalid_argument'` and `error.message` names
   all three valid values (`"production"`, `"test"`, `"sandbox"`) — plus a
   second case with a near-miss typo (`"sandboxx"` or `"produciton"`)
   asserting the message includes a "did you mean" suggestion naming the
   correct value, proving `suggestClosestCatalogNames` reuse actually fires.
4. **Explicit, non-default namespace still reaches a real store correctly.**
   `--namespace production` (typed explicitly, not omitted) against a real
   `ADHD_ROOT`-scoped test root resolves to the same path an omitted flag
   would, and a `create` immediately followed by a `get` against that same
   explicit namespace round-trips the real item — proving explicit
   `'production'` is not silently treated differently from the default.
5. **Every preserved guarantee from D5's table gets its own test, not an
   assertion of overlap:**
   - `BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001` — re-run of the existing
     `cli.spec.ts` case (an already-set, non-sandbox `ADHD_ROOT` in the
     parent env before `--namespace sandbox` runs), re-keyed off the new flag,
     confirming the loud-warning-and-fresh-mint behavior still holds.
   - `BUG-BACKLOG-SANDBOX-ADHDROOT-UNWIRED-001` — re-run of the existing
     reuse-across-two-calls case, re-keyed off `--namespace sandbox`.
   - `BUG-BACKLOG-SANDBOX-IRCACHE-LEAK-001` — re-run of the existing
     `APIGEN_IR_CACHE_FILE` redirect assertion, confirming it still fires
     whenever `opts.adhdRoot` is set, regardless of which namespace value
     produced it.
   - `sandbox-path`'s store-free contract — a test asserting `sandbox-path`
     under `--namespace sandbox` never causes a store file to be created
     (matching the existing store-free assertion, re-pointed at the new
     flag).
   - `BUG-BACKLOG-SANDBOX-TELEMETRY-001` — re-run of the existing
     `cli.spec.ts` case asserting a real `create` under `--namespace sandbox`
     leaves no `*.jsonl` file under the real (faked-`HOME`-for-the-test)
     `~/.adhd/sox-ecosystem/backlog/logs`, re-keyed off the new flag; this
     guarantee was not in the task's original "preserve" list but is carried
     by the code this design replaces (`index.ts`'s bin-entry guard, D5's
     table), so it gets the same re-run-not-assumed treatment as the other
     four.
6. **Negative control for the validation gate itself (D3).** Temporarily
   remove the `backlogEnvironmentSpec.namespaces?.includes(namespace)` guard
   and confirm test 3 goes RED (an unrecognized value would otherwise either
   silently fall through to `buildBacklogEnv`'s default or propagate an
   ungoverned namespace string into `EnvironmentOptions.namespace`) — then
   restore the guard.
7. **`--namespace`/`--namespace=` with no value.** A real spawned-bin test
   asserting a bare trailing `--namespace` (nothing after it) and
   `--namespace=` (empty value) both exit `2` with an `invalid_argument`
   envelope naming `"namespace"` and stating a value is required — proving
   `stripNamespaceFlag`'s `missingValue` signal (D1) is wired to a real
   rejection, not silently treated as "flag absent, use the default."
8. **Both accepted flag spellings.** A real spawned-bin test confirming
   `--namespace=sandbox` produces the identical effective `namespace`/`dbPath`
   (via `sandbox-path`) as `--namespace sandbox` — the two-spelling
   acceptance in D1 is itself covered, not merely asserted in prose.
9. **`--namespace sandbox serve` startup.** A real spawned test starting
   `serve` under `--namespace sandbox`, confirming (via the server's own
   status/health surface, never a raw file peek) it reports the same
   `namespace: 'sandbox'` and a `dbPath` under the minted tmpdir that a
   one-shot verb under the identical flag would — proving A10's
   `RunServeCommandOpts`/`StartOpts` threading and D8's config write both
   still reach the long-lived server lifecycle, not just the one-shot CLI
   dispatch path.
10. **Conflicting repeated `--namespace` values.** A real spawned-bin test
    asserting `--namespace test --namespace sandbox <verb>` exits `2` with an
    `invalid_argument` envelope naming `"namespace"` and listing both
    conflicting values, and — critically — that the verb's own argv never
    saw a leaked, un-stripped second `--namespace sandbox` token (i.e. the
    cli-output plugin's own generic flag-table error never fires; only this
    flag's clean envelope does). A companion case asserts
    `--namespace sandbox --namespace sandbox <verb>` (same value twice) is
    NOT rejected as conflicting — proving `stripNamespaceFlag`'s
    distinct-value check, not a bare repeat-count check.

#### Implementation plan (per-file, so nothing is left implicit)

- `entrypoint/backlog/src/cli.ts`:
  - Delete `stripSandboxFlag`; add `stripNamespaceFlag` (D1) in its place,
    same export visibility.
  - Delete the whole `--sandbox` handling block (the `sandbox`-boolean
    branch, `looksLikeOwnSandboxDir`'s call site, the `if (opts.namespace
    === undefined) opts.namespace = 'test'` line) and replace it with:
    validate `missingValue`/`conflicting` (reject via `errorEnvelope` +
    `exitCodeForEnvelope`, D3's pattern), validate the resolved namespace
    value against `backlogEnvironmentSpec.namespaces` (D3), then — only when
    the resolved namespace is `'sandbox'` — run the existing
    `looksLikeOwnSandboxDir` guard / mint-or-reuse `adhdRoot` logic
    (unchanged internals, just re-gated) followed by D8's `mkdirSync` +
    `writeFileSync` of `config.yaml`.
  - `sandbox-path`'s handler: drop the `sandbox` boolean from the printed
    JSON, add `embeddingEnabled: env.config.embedding.enabled` (D6).
  - The `--help` text block has TWO `--sandbox` mentions, not one: the
    `--sandbox` flag line itself, AND `sandbox-path`'s own listed description
    ("see --sandbox below"). Both are rewritten to describe `--namespace
    <value>` and its three valid values.
  - `RunBacklogCliOpts.namespace`'s doc comment (currently "`--sandbox` sets
    this to `'test'` below") is updated to describe the new flag instead.
- `entrypoint/backlog/src/index.ts` (D5's fifth guarantee row):
  - Replace the `stripSandboxFlag` import and its
    `const { sandbox } = stripSandboxFlag(...)` call with
    `stripNamespaceFlag`; the `sandboxLogDir` mint condition changes from
    `sandbox` to `namespace === 'sandbox'`.
  - The barrel re-export at the bottom of this file (`stripSandboxFlag`
    alongside `runBacklogCli` and others in the public `@adhd/backlog`
    export surface) is renamed to re-export `stripNamespaceFlag` in its
    place — this is a public API surface change for the package, not just an
    internal rename, and needs the same CHANGELOG treatment A10's
    `namespace` addition already got.
- `entrypoint/backlog/src/env.ts`: `backlogEnvironmentSpec.namespaces`
  becomes `['production', 'test', 'sandbox']` (D4); no other field changes.
- `entrypoint/backlog/src/cli.spec.ts`: `SandboxPathBody`'s shape updates to
  drop `sandbox` and add `embeddingEnabled` (D6); every existing
  `--sandbox`-flag-driven test call site (the ~40 `runBin`/`mintSandbox`
  helper consumers `A13` is already mid-flight on) is re-pointed at
  `--namespace sandbox` — this SPEC section does not re-litigate A13's own
  helper-rework plan, only the flag surface A13's helpers must now target.
- `entrypoint/backlog/src/serve.ts` / `server.ts`: no signature change needed
  — `RunServeCommandOpts.namespace`/`StartOpts.namespace` already exist
  (A10) and are set from the same resolved `opts.namespace` `cli.ts` already
  threads through today; only the value flowing through them changes.

## 6. Consumers

This section specifies the **issue** verb surface (CLI/MCP/HTTP), at the same
implementable depth as §3a's registry surface. It accounts for every field a
prior 38-export surface and its consolidated six-verb successor
(`IBacklogGetInput`/`IBacklogQueryInput`/`IBacklogCreateInput`/
`IBacklogUpdateInput`/`IBacklogRelateInput`/`IBacklogAdminInput`) once
carried, per §6.2's table: kept as-is, folded into a new shape with a stated
mapping, or deliberately dropped with a stated reason. Nothing vanishes
silently.

### 6.1 Addressing: identity, project scoping, and lookup

- **Identity is `uid`.** There is no composite `(repo, id)` key, and no
  per-repo numbering. Every issue verb below that
  addresses one issue takes `uid: string` — a value obtained from a prior
  `query`/`create`/`relate` response, never typed by hand. `getNodeByUid`
  (`@adhd/sox-graph-store@0.9.1`, verified: `dist/index.d.ts:285`) is the one
  resolution primitive; a `uid` with no matching live node throws
  `IssueNotFoundError(uid)`.
- **`repo` is replaced by `project`.** A prior surface required `repo: string`
  on every verb because its per-repo string id was only unique within a repo;
  `uid` is globally unique,
  so no verb _requires_ a scoping key any more. `project` survives as an
  optional **filter/creation** input, not an addressing key: `create` takes
  `project` to place the new issue under `owns_component`'s chain (§3, §4) —
  under the named `component` when one is given, or under `project`'s
  reserved default component `(root)` when `component` is omitted, so a new
  issue is never left without a live `owns_component` edge (§3/§8
  AC-23) — and `query`'s `filter.project` narrows a listing. Every place that accepts
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
  of erroring. Omitting `component` entirely is a THIRD case, distinct from
  both a resolved name and an unresolved one: there is no name to resolve or
  fail to resolve, so `createIssue` instead falls back to `project`'s
  reserved default component `(root)` (§3) — a row `upsertProject` already
  guarantees is live before this call ever runs, so this is a plain resolve
  of an existing row, never vivification; the same "never mints" rule holds
  for the omitted case exactly as for a misspelled one. `createIssue({project: "adph", ...})` (typo) throws
  `CatalogNotFoundError('project', 'adph')` naming the mismatch — a hard
  error rather than a soft warning, so a typo'd project name can never
  silently drift the registry (§7). On
  **read** paths (`query` filters), an unresolved `name` is not an error —
  it resolves to zero matches, same as any other filter that matches
  nothing.

- **How a human or agent gets a `uid` at all — the two-step pattern.**
  §3a's `lookup` is registry-only (project/component/location — "where does
  this live"); it does **not** resolve issues, and conflating the two would
  be wrong: `lookup` answers a structural question with one correct answer
  per input, while resolving "the issue about X" is inherently a _search_
  with zero, one, or many matches. So issue addressing is **discover, then
  act** — the same shape a coding agent already uses for `rg` before `Edit`:

  1. `query({filter:{grep:"..."} , fields:["uid","title"]})` (or
     `filter.semantic`, §5a) returns a small card list, each carrying `uid`.
  2. The caller picks the right card's `uid` and passes it to
     `get`/`update`/`transition`/`claim`/`relate`/`move`/`delete`.

  A verb that needs to seed a traversal from an existing item (the
  `blockerImpact`/`view:"order"` seed field) takes the SAME
  `uid`-typed field, named `anchor` for symmetry with §5a's existing
  `filter.anchor` (semantic item-anchored similarity) — one seed-field name
  for both traversal and similarity, since both mean "start from this item."

### 6.2 Verb input surface — decisions and exclusions

This section accounts for every field a prior 38-export surface and its
consolidated six-verb successor once carried, resolving each into exactly one
of: kept as-is, folded into a new shape with a stated mapping, or excluded
from the surface with a stated reason. Nothing here is silently dropped.

| Concept                                                                                                                                                                                    | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A composite `(repo, id)` identifier                                                                                                                                                        | Not part of the surface. Identity is `uid`, DB-generated, with no allocator and no per-repo numbering (§1, §6.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `repo` as an addressing key on every verb                                                                                                                                                  | Not part of the surface as an addressing key — a per-repo string id needed repo-scoping to disambiguate; `uid` never does. `project` survives only as an optional filter/creation field (§6.1).                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `family` as a parsed classifier prefix                                                                                                                                                     | Not part of the surface — there is no id to parse a prefix from. `kind` (catalog ref) is the open-vocabulary classifier; a project that wants finer-grained families files them as distinct `kind` catalog rows (§2 — extensible by row, no code change).                                                                                                                                                                                                                                                                                                                                                                          |
| A caller-supplied id override at creation time                                                                                                                                             | Not part of the surface — every `create` mints a fresh `uid` unconditionally, never caller-chosen (§0 anti-antipattern 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| An import-provenance/ownership field on the issue                                                                                                                                          | Not part of the surface as a mutable field — provenance is the `audit` node's `actor`/`action`/`sha` (§4a), not a field on the issue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| An opt-in symbol/path/errorText dedupe-scan input                                                                                                                                          | Subsumed into `create`'s always-on duplicate gate (§6.4); `symbol`/`path`/`errorText` become the ranking hints passed as `filter.files`/`filter.grep`-equivalent terms to the same `searchRanked` call §6.4 already makes.                                                                                                                                                                                                                                                                                                                                                                                                         |
| A bare boolean bypass-dedupe flag                                                                                                                                                          | `duplicateAction: 'force'` (§6.4) — same effect, sitting in the same enum as `abort`/`comment` rather than a bare boolean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `citations` at creation time                                                                                                                                                               | Kept, unchanged in spirit: `create`'s input carries `citations?: Citation[]`, written as `citation` nodes + `has_citation` edges in the same transaction (§3, §4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `awaitEmbed` on `create`/`update`                                                                                                                                                          | Kept verbatim (RAG-SPEC durability for short-lived processes) — §4b's on-write embedding observer is fire-and-forget by default; `awaitEmbed:true` waits for it, same contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Two separate accountability roles (`author`/`reporter`)                                                                                                                                    | **Collapsed to one**: §3 line 136 declares exactly one edge, `authored_by` (issue→agent, n:1) — no `reported_by` edge exists in the edge table. `author` is the sole accountability edge.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A plan-slug string plus a dedicated membership edge                                                                                                                                        | Folded into the existing `part_of` edge (§3): a plan is itself an `issue` (kind catalog row, e.g. `kind:"plan"` — no new node type, matching this spec's own "the plan parent IS an item" doctrine); attaching an item to a plan is `relate(childUid, planUid, 'part_of', 'add')`. The plan-native resume view (`view:"plan"`'s rollup/ready/blocked/delta/myClaims/asOf aggregate) is **out of scope for this section** — it is a §5 query-layer concern once `part_of` traversal is queryable, not an issue-verb input shape.                                                                                                    |
| Durable `assignee` ownership, distinct from an ephemeral claim                                                                                                                             | Kept: `issue.meta.metadata.assignee` (plain scalar, no edge — see §6.3 `claim`'s rationale for why this and `claimedBy`/`claimedAt` are metadata, not edges), mutated via `update`'s `assignee` field, filterable via `NodeFilter.metadata.assignee` (`{eq: "..."}`, verified operator: `@adhd/sox-graph-store@0.9.1 dist/index.d.ts:157-170`).                                                                                                                                                                                                                                                                                    |
| The ephemeral claim-lease system (`claimedBy`/`claimedAt`, a stale-after threshold, a force override, a held-error)                                                                        | Kept in full, designed onto the graph model as its own `claim` write-layer verb (§6.3.5) — `claimedBy`/`claimedAt` live in `issue.meta.metadata` (mutated via `touch`, CAS-checked inside the write transaction); the stale-after threshold lives as **data**: `project_policy.claim_stale_after_min` (default `30`), consistent with DATA_MODEL.md §2's "policy about actions is data, not code" pattern already applied to `citation_required`/`transition_requires_note`; per-call `force` (human-confirmed override of a non-stale claim) survives as a literal argument, since that is a caller decision, not project policy. |
| A terminal-dismissed-only free-text field, distinct from a general note, driven by a three-way status categorization                                                                       | **Collapsed into `note`** — DATA_MODEL.md §3's `transition` node has exactly one free-text field, `note`, and §2's `project_policy` has one boolean, `citation_required` (not three status-category-specific rules). `status.terminal` (a single bool) plus `project_policy.citation_required` (a single bool, project-tunable) is the entire evidence gate.                                                                                                                                                                                                                                                                       |
| Evidence (`citations`/`reason`) bundled onto a generic `update` alongside a status change                                                                                                  | Superseded by `transition`'s own input shape (§6.3.4), which HAS the `citations`/`note` fields directly — there is no separate generic `update` path into a status change any more (§6.3.3 `update` explicitly rejects `status`), so evidence attached to the wrong verb cannot recur structurally (fixes DEBT-010).                                                                                                                                                                                                                                                                                                               |
| `duplicateAction` on `create`                                                                                                                                                              | Kept, redesigned in full in §6.4 with the enum `'abort'\|'force'\|'comment'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Splitting a freshly-minted parent into N children                                                                                                                                          | Kept: `create`'s `children?: ICreateIssueInput[]` field (§6.3.2) creates each child then `relate`s it `part_of` the freshly-created parent, atomically, in the same write transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Splitting an EXISTING, already-live parent into N children                                                                                                                                 | **No dedicated field — composed from two already-specified primitives, not dropped:** `create`'s `children` only fires alongside a freshly-minted parent (§6.3.2); splitting into an EXISTING parent is instead one `create` per child (no `children`, no `supersedes`) followed by `relate(childUid, existingParentUid, 'part_of', 'add')` (§6.3.6) for each — reaching the identical outcome (N children, each with one live `part_of` edge to the same parent) without a third verb.                                                                                                                                            |
| Content-mutation supersession at create time                                                                                                                                               | Kept: `create`'s `supersedes?: uid` field (§6.3.2) is sugar for `updateIssue(uid, {body: ...})`'s `supersede` path (§4) run against an EXISTING issue rather than minting via `create` — see §6.3.2 for the exact composition.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Cross-repo disambiguation on a relate/dependency input                                                                                                                                     | Not part of the surface — `uid` is globally unique across every project in the store, so a `relate` between two issues in different projects needs no repo parameter at all; `relate(sourceUid, targetUid, rel, action)` just works.                                                                                                                                                                                                                                                                                                                                                                                               |
| A dedicated repo-string-collision-repair operation                                                                                                                                         | Not part of the surface — folded into first-class `project`/`component`/`location` nodes (§3a).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| An issue-to-issue dependency edge, with its own blockers/ready/graph/order reads                                                                                                           | **Mapped to `blocks`** (§3: `blocks issue → issue (n:m), inverse = blocked_by, derived`) — `relate(blockerUid, blockedUid, 'blocks', 'add')` records "X blocks Y" subject-first; `blockers`/`readyItems`/`dependencyGraph`/`topoOrder` all become `query` views over `blocks`/`blocked_by` traversal (view names `ready`/`graph`/`order`). §3's edge table has no issue-to-issue `depends_on` — only `depends_on: component → component`.                                                                                                                                                                                          |
| Merging two issues (keep one, drop the other)                                                                                                                                              | 1:1 mapping onto existing primitives, no new mechanism needed: `relate(dropUid, keepUid, 'duplicate_of', 'add')` then `delete(dropUid, reason)` (§6.3.7's `invalidate`).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| The pairwise-intersection axis selector and its item-set input                                                                                                                             | Kept as query-layer concerns, **not** an issue-verb input: the axis selector renames to `axis` (vocabulary `file`\|`project`\|`component`\|`author` — `package` renamed `component`) and the item-set input renames to `uids: string[]`; both are `query`'s `view:"overlap"` parameters (§5), out of scope for the write-facing verbs this section specifies.                                                                                                                                                                                                                                                                      |
| A mutating "hide terminal items from the default projection" action                                                                                                                        | **No replacement as a mutation** — `status.terminal` (already stamped by the terminal `transition`, §4a) is itself the exclusion signal; the default `render`/`query` projection already excludes terminal items unless `filter.status` explicitly asks for them. A markdown changelog section is produced by rendering `filter.status:['terminal set']` through the same `render` output, never a second code path.                                                                                                                                                                                                               |
| A single grab-bag mutation verb carrying an open-ended `action` string (render/export/merge/embedding maintenance/one-shot maintenance ops/host introspection/batch fan-out, among others) | Not part of the surface at all — disposition per action, §6.6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `limit`/`offset`, a fixed max query limit                                                                                                                                                  | Kept, redesigned onto keyset in §6.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A closed field-projection vocabulary with an unknown-field guard (context-blow defense)                                                                                                    | Kept, redesigned in §6.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 6.3 Issue verbs

Nine verbs, one mounted operation each (same one-descriptor→four-transport
projection server.ts already uses, §9): `get`, `query`, `create`, `update`,
`transition`, `claim`, `relate`, `move`, `delete`. (Registry verbs — `lookup`,
`upsertProject`/`upsertComponent`/`upsertLocation`/`rmLocation` — are §3a's,
not restated here.)

Every mutating verb requires `by: string` (the acting agent or human, as identity,
resolved through the `agent` catalog via the write layer's hand-composed
find-then-create (§4c) — unchanged from
the current surface's §7.5 attribution rule) and writes exactly one `audit`
node (§4a). A missing/blank `by` on a mutating verb throws
`InvalidArgumentError('by', ...)` before any write runs.

#### 6.3.1 `get`

```ts
interface IIssueGetInput {
  uid: string;
  fields?: readonly IIssueField[]; // default: the SAME five-field card as §6.5/AC-13 — ['uid','kind','title','status','priority']
}
```

Output: `IIssueCard` (§6.5) projected to the requested fields.
Errors: `IssueNotFoundError(uid)` when no live node carries `uid`;
`StaleSupersedeError(uid, successorUid)` when `uid` names a SUPERSEDED node.

A superseded row is deliberately left `t_invalid IS NULL` (§4c), so it is
still "live" by the only predicate `get` used to apply — and `get` therefore
returned the frozen pre-edit card with no signal that the issue had been
edited or had moved. It now rejects instead, matching the guard the six write
verbs already share (`resolveLiveIssueTx`): a uid that was valid once and
names a real row is **stale**, not **wrong**, and the two are reported
differently on purpose.

Because a body edit mints a NEW uid, the write path's "re-get and retry" is
not actionable on the read path — re-getting the same uid fails identically,
forever. `StaleSupersedeError.successorUid` therefore carries the uid the
issue lives under NOW: the read path walks the `SUPERSEDES` chain to its
**head**, so a citation written several edits ago resolves to today's issue
rather than to an intermediate superseded node. It is `undefined` only when
no successor is reachable (the chain dead-ends, or the successor is itself
soft-deleted) — absent means "not known here", never "none exists".

The same rule applies wherever a caller names one issue by uid on the read
path — `view:'similar'`'s `filter.anchor` and the stats/graph root both
resolve through the same function, and anchoring a search or a dependency
walk on a superseded node is the same stale-reference error. Listings are
unaffected: `query` never resolves rows by uid, so a superseded row in the
corpus never makes a listing throw.

#### 6.3.2 `create`

```ts
interface ICreateIssueInput {
  title: string;
  body: string;
  project: string; // uid or name — resolved per §6.1; REQUIRED (every issue has a component chain)
  component?: string; // uid or name, scoped within `project`; RESOLVED ONLY, never created — the write layer's hand-composed find-then-create (§4c) runs its find-half alone here: a name that resolves to an existing component under `project` is used as-is, and an unresolved name throws CatalogNotFoundError('component', name) rather than silently forking a new component (see §6.1's project-vs-component asymmetry: components are NOT auto-vivified by createIssue, use upsertComponent first). OMITTED (undefined) is a distinct third case, never an error: it resolves to `project`'s reserved default component `(root)`, already guaranteed live by `upsertProject` (§3/§4/§6.1) — every issue gets exactly one `owns_component` edge whether or not the caller names a component (§8 AC-23).
  kind?: string; // catalog name or uid; default catalog row "issue" if the project defines no default; an unresolved NAME mints a new kind catalog row (§2/§6.1's general rule — kind is open vocabulary, no allowlist) with no extra metadata beyond `name`; a uid-shaped `kind` that does not resolve instead throws CatalogNotFoundError('kind', ref) — minting never applies to a uid (§6.1)
  status?: string; // catalog name or uid; default is the project's configured initial status (project_policy — falls back to a global default "OPEN"-equivalent catalog row); an unresolved name MINTS a new status catalog row (§2, unlike `component` above) with terminal:false — a novel status name is presumed non-terminal until an operator deliberately reconciles it, so a typo can never silently close or exclude items under an unrecognized status; a uid-shaped `status` that does not resolve instead throws CatalogNotFoundError('status', ref) — minting never applies to a uid (§6.1)
  priority?: string; // catalog name or uid; optional; an unresolved name mints a new priority catalog row (§2) with rank set to one past the current max rank (i.e. lowest urgency) — a novel priority can never silently outrank an existing one; a uid-shaped `priority` that does not resolve instead throws CatalogNotFoundError('priority', ref) — minting never applies to a uid (§6.1)
  citations?: Citation[];
  author?: string; // catalog agent name/uid; defaults to `by`; an unresolved NAME mints a new `agent` catalog row (§6.1's general rule), exactly like `kind`/`status`/`priority` above; a uid-shaped `author` that does not resolve instead throws CatalogNotFoundError('agent', ref) — minting never applies to a uid (§6.1)
  assignee?: string; // plain metadata scalar (§6.2)
  gitContext?: string; // plain metadata scalar (§6.2) — the item-level disclosure-contract git context (repo AGENTS.md "Cite what you read": the FIRST element of a `Citations:` block is `<active git context>`). ITEM-level, never a per-citation field; rendered once at the head of the item's `Citations:` block (§6.6). Omitted ⇒ nothing stored, every read/render path unchanged.
  awaitEmbed?: boolean;
  // duplicate-gate controls — §6.4
  duplicateAction?: 'abort' | 'force' | 'comment'; // default 'abort'
  // structural sugar — §6.2
  children?: ICreateIssueInput[]; // each created, then `part_of` the freshly-minted parent, one transaction — see composition below
  supersedes?: string; // uid of an existing issue this create supersedes — see composition below
}

interface Citation {
  file: string;
  lines?: string;
  context?: string;
  symbol?: string;
  blastRadius?: CitationBlastRadius; // still real, still best-effort
}
```

**`children` composition (how N+1 writes land in ONE transaction):** a
`create` call with `children` present still opens exactly the one
`store.adapter.transaction(fn, {mode:'immediate'})` §4c mandates per
verb — that rule is per PUBLIC VERB INVOCATION, not per node written. The
parent's INSERT and every child's INSERT/edge/`part_of`-edge/audit writes
all run, in sequence, through the SAME internal tx-threaded helpers §4c
already defines for catalog resolution (a function taking the open `tx`
handle, never opening one of its own) — a child is never dispatched as an
independent public `create` call, which would attempt a second `BEGIN
IMMEDIATE` nested inside the first; no savepoint/nested-transaction
primitive is exposed by the store-adapter's `transaction()` API (§4c) for
that to use even if it were attempted. Any child's catalog-resolution or
duplicate-gate failure aborts the WHOLE transaction — a parent committed
with only some of its children is never an observable state; the caller
retries the entire `create` call.

**`supersedes` composition (resolves the create/update overlap):** when
`supersedes` is given, `create` does NOT mint a standalone new issue —
instead it runs §4's `updateIssue(supersedes, {body: input.body})`
(the `supersede`-backed content path) and returns that result mapped onto
`ICreateOutcome`'s shape (`created: true`, `item`: the NEW node the
`supersede` primitive minted, `supersededUid: input.supersedes`). The
REMAINING `ICreateIssueInput` fields are each disposed of explicitly below
— no field is silently dropped, and none is covered by a vague "every
other field": every field maps onto exactly one of these named paths.

- **`title`, `kind`, `priority`, `author`, `assignee`, `gitContext`** —
  applied via a
  following `touch`/edge-write against the same new node, atomically,
  inside the SAME transaction the `supersede` call opened — mirroring
  exactly the touch+edge-rewrite `update` (§6.3.3) already defines for
  each of these fields (an unresolved `kind`/`priority`/`author` NAME
  still auto-mints, §6.1's general rule, identically to a standalone
  `update` call; `assignee`/`gitContext` are plain metadata scalars, §6.2).
- **`project`/`component`** — handled separately, never via a generic
  edge-write: `owns_component`'s invalidate-old+write-new sequence is
  reserved to `move` (§6.3.6) specifically to guarantee at most one live
  edge ever exists, so a `create+supersedes` call naming a `project`/
  `component` different from the target's current placement runs `move`'s
  own `invalidateEdge(old owns_component)` + `writeEdge(new owns_component)`
  sequence internally — inside the SAME transaction, immediately after the
  supersede write, never as an ad hoc edge-write outside that sequence. A
  `project`/`component` matching the target's current placement is a no-op
  (nothing invalidated or rewritten); an unresolved `project`/`component`
  NAME throws exactly as a standalone `move`/`create` would (§6.1) —
  `create+supersedes` never auto-vivifies either.
- **`status`** — mutually exclusive with `supersedes`, for the identical
  structural reason `update` bans a `status` field outright (§6.3.3): a
  status change carries its own evidence gate (`note`/`citations`,
  policy-checked — and `ICreateIssueInput` has no `note` field to satisfy
  `project_policy.transition_requires_note`, which defaults to `true`,
  §6.3.4) and `closed_at` stamping, neither of which `create`'s input
  shape or a `touch`-based composition can express. `create` throws
  `InvalidArgumentError('status', ...)` if both `status` and `supersedes`
  are given together; the caller instead omits `status` from the
  `create`+`supersedes` call and follows it with a separate `transition`
  call against the NEW node's `uid` (`ICreateOutcome.uid`/`.item.uid`,
  §6.3.4). This keeps §6.2's DEBT-010 claim literally true — there
  remains exactly ONE path into a status change, `transition`, never a
  second one folded into `create`.
- **`citations`** — written as `citation` nodes + `has_citation` edges
  against the new node in the same transaction, exactly as a standalone
  `create`'s citation handling (§6.2) — independent of `touch`, since
  `IUpdateIssueInput` carries no `citations` field to mirror.
- **`awaitEmbed`** — applied to the new node's on-write embedding exactly
  as a standalone `create` (§4b): waits for the fire-and-forget embed
  observer when `true`, fire-and-forget otherwise.
- **`duplicateAction`** — inapplicable, stated explicitly rather than
  silently ignored: the duplicate gate (§6.4) exists to catch an
  ACCIDENTAL near-duplicate of an unknown existing issue at creation time,
  and `supersedes` already names the exact existing issue being revised —
  there is no duplicate to detect. `create` throws
  `InvalidArgumentError('duplicateAction', ...)` if both `duplicateAction`
  and `supersedes` are given together, rather than silently dropping one.
- **`children`** — mutually exclusive with `supersedes`, for the same
  reason `children` requires "the freshly-minted parent" (this section's
  own `children` field comment, above): `children`'s parent identity comes
  from a plain `createIssue` INSERT, which a `create+supersedes` call
  never performs. `create` throws `InvalidArgumentError('children', ...)`
  if both `children` and `supersedes` are given together.

Output:

```ts
interface ICreateOutcome {
  created: boolean; // false ⇒ nothing written; see duplicateCandidates/reason
  uid?: string; // present iff created
  item?: IIssueCard; // present iff created
  duplicateCandidates?: IDuplicateCandidate[]; // present when the gate fired (§6.4) or on comment
  reason?: 'duplicate-suppressed'; // present iff !created — only one suppression class survives (§6.4)
  supersededUid?: string; // present iff input.supersedes was given
  commentedOn?: { uid: string; noteId: string }; // present iff duplicateAction:'comment' fired
}
```

Errors: `CatalogNotFoundError('project'|'component'|'kind'|'status'|'priority', ref)`
(`'component'` fires only when a name/uid was GIVEN and did not resolve —
omitting `component` entirely never throws it, resolving instead to
`project`'s reserved `(root)` default, §6.3.2's `component` comment/§8
AC-23),
`InvalidArgumentError` (missing `title`/`body`/`project`, or `citations[i].file`
empty), `StaleSupersedeError(uid)` (only when `supersedes` is given — the
body-change CAS (§4c) lost a race to a concurrent edit of the same target;
nothing was written, re-`get` and retry),
`CitationUnverifiableError(target, allowedExternalRoots)` (policy-gated via
`project_policy.citation_requires_sha`, §2, and only where verification is
possible — a project with a known `path`; a given citation's `file` did not
resolve to a real, hashable file INSIDE the project root or any
`citation_allowed_external_roots` entry, and the project requires one. The
message names those roots (or the project root when the allowlist is empty). A
path-less project records `sha:"unverified"` verbatim instead),
`WriteContentionError`/`WriteIOError`
(§4c — an exhausted driver-level retry on the underlying `immediate`
transaction). `DuplicateSuppressedError` is NOT thrown — a suppressed create is a
**success response** with `created:false` — a caller must check the
flag, never a try/catch, because "no write happened" is not exceptional.

#### 6.3.3 `update`

```ts
interface IUpdateIssueInput {
  uid: string;
  by: string;
  title?: string; // → touch (metadata/name only)
  body?: string; // → supersede (§3: "body change → supersede... never touch a body")
  kind?: string; // → touch + has_kind edge rewrite (hand-composed edge invalidate-old + upsert-new, same tx — §4c)
  priority?: string; // → touch + has_priority edge rewrite
  assignee?: string; // → touch (metadata scalar, §6.2)
  author?: string; // → touch + authored_by edge rewrite
  awaitEmbed?: boolean;
}
```

`status` is **deliberately absent** — a status change is ALWAYS `transition`
(§6.3.4), never `update`. This is a structural fix of DEBT-010, whose original
failure mode was accepting both a top-level `status` and a bundled patch
`status`, which is exactly how evidence ended up silently dropped when bundled
wrong. Removing the field from `update` entirely — rather than accepting it and
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
`assertNoSilentlyDiscardedPatchKeys` invariant — a general correctness rule,
not surface-specific machinery).

Errors: `IssueNotFoundError`, `CatalogNotFoundError('kind'|'priority'|'agent',
ref)` (uid-shaped ref only — `update` never auto-mints from a uid; an
unresolved NAME instead auto-mints per §6.1's general rule: `kind`/
`priority` mint exactly as §6.3.2 states, `author` resolves through the same
flat-catalog find-then-create as the `agent` catalog), `StaleSupersedeError(uid)` (body-change path only — the supersede CAS
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
  toStatus: string; // catalog name or uid
  note?: string; // REQUIRED unless project_policy.transition_requires_note is false (default true) — optional in the type; the write layer enforces the policy-gated requirement at runtime, never at the TS level (see `NoteRequiredError` below)
  citations?: Citation[]; // REQUIRED (≥1) when project_policy.citation_required is true AND toStatus resolves to a terminal status
  gitContext?: string; // plain metadata scalar (§6.2) — the item-level disclosure-contract git context, the same field `create`'s input carries (repo AGENTS.md "Cite what you read"). Supplied ⇒ it UPDATES the issue's stored value on the metadata touch this verb already performs; omitted ⇒ the existing value is left untouched. ITEM-level, never per-citation; rendered once at the head of the item's `Citations:` block (§6.6).
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
`content`/`name` lives in the JSON `meta` blob (DATA_MODEL.md §3 states this
directly). So in this spec’s graph-native re-interpretation
(§3: "a first-class row is a node"), `closed_at` is
`issue.meta.metadata.closedAt`, stamped by `touch` inside the SAME
transaction that writes the `transition` node, whenever `toStatus.terminal`
is true — and CLEARED (removed from the metadata object) in that same
`touch` call whenever a transition's `toStatus` is NON-terminal, including a
reopen of a previously-terminal issue. This clearing is not optional
housekeeping: `touch(nodeId, meta)` REPLACES the entire `meta` column
wholesale from the caller-supplied object rather than merging into it
(verified, `@adhd/sox-graph-store@0.9.1` package dist, `dist/index.js:1482-
1524` — `if (meta.metadata !== undefined) { … params.push(JSON.stringify(
meta.metadata)) }`, one full-blob `UPDATE`, no merge with the existing row).
So the write layer must build the new metadata object with `closedAt`
explicitly omitted whenever `toStatus.terminal` is false; carrying the prior
value forward — the natural bug if an implementer spreads the existing
metadata and only overwrites `claimedBy`/`status`-adjacent keys — leaves a
reopened issue's `closedAt` stamped with its LAST closing timestamp,
indistinguishable from a currently-closed issue. This is not a downgrade:
`NodeFilter.metadata` supports `gt`/`lt`/`between` operators (verified,
`dist/index.d.ts:157-170`), so `filter.closedAt` range queries still push
down to SQL exactly as a real column would — PROVIDED `closedAt` is cleared
on reopen; a stale value would corrupt exactly this range-query guarantee
(a reopened issue would keep matching `filter.closedAt.until` as though
still closed).

Errors: `IssueNotFoundError`, `CatalogNotFoundError('status', toStatus)`
(uid-shaped `toStatus` only — an unresolved NAME instead auto-mints a new
status catalog row with `terminal:false`, exactly as `create`'s `status`
field (§6.3.2) and §6.1's general rule — a novel status reached via
`transition` can no more silently close/exclude items than one reached via
`create`),
`NoteRequiredError` (policy-gated), `CitationRequiredError` (policy-gated,
terminal-only) — together they resolve the three-way
`requiresCitation`/`requiresReason` split (§6.2) into the single
`project_policy.citation_required` boolean; there is no more
terminal-done-vs-terminal-dismissed distinction to error on.
`CitationUnverifiableError(target, allowedExternalRoots)` (policy-gated via
`project_policy.citation_requires_sha`, §2, and only where verification is
possible — a project with a known `path`; a given citation's `sha` resolved
to the `"unverified"` sentinel because its canonical path lay outside the
project root AND every `citation_allowed_external_roots` entry, and the
project requires a real hash. The message names those roots (or the project root
when the allowlist is empty). A path-less project records `sha:"unverified"`
verbatim instead).
`ClaimHeldError(heldBy, heldSince)`: a live claim (§6.3.5) is a real
concurrency guard, not advisory metadata — a `transition` targeting an issue
whose `claimedBy` is set to someone OTHER than `input.by` **throws** unless
that claim is stale (same `project_policy.claim_stale_after_min` threshold
§6.3.5's own rule table uses, default 30 minutes). There is no `force`
override on `transition` the way `claim` has one — `force` is `claim`'s own
human-confirmed-override concept (§6.2), not a `transition` concern, so a
caller who genuinely needs to override a live claim must go through `claim`
itself first. An issue with no live claim at all, or claimed by `input.by`
itself, transitions exactly as before this rule existed — this is
additive, never a behavior change on the unclaimed path.
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
the node via the hand-composed, tx-scoped uid lookup (`tx.executeGet('SELECT *
FROM node WHERE uid = ?', [uid])`, §4c — never a `getNodeByUid` call, which
always runs against the bare adapter, never the open `tx`), never a
pre-transaction read — mirroring exactly how §1's `NodeUniquenessPolicy`
is tx-threaded — (2) evaluates the claim/release/renew rule against that
fresh read, (3) `touch`es the merged metadata, all before the transaction
commits. Two concurrent `claim` calls against the same `uid` therefore
serialize through the transaction, and the loser sees a fresh
`claimedBy`/`claimedAt` rather than racing on a stale one.

**Terminal-status precondition (checked BEFORE the `claimedBy` rule table
below, `action:'claim'` only):** an issue whose current status resolves to
`terminal:true` (§6.1) has nothing left to lease — `action:'claim'` **throws**
`IssueTerminalError(uid, status)` outright, regardless of whether the issue
is currently claimed by anyone. Re-open it via `transition` (§6.3.4) to a
non-terminal status first. `release`/`renew` are exempt from this
precondition: releasing or renewing a lease on an issue that closed out from
under the claimant is cleanup, not a new claim attempt, and must still
succeed so a claimant is never stuck holding a phantom lease it can no
longer clear.

Rule table (metadata-only shape, `action:'claim'` rows apply only once the
terminal-status precondition above has passed):

| action    | current `claimedBy`                                                          | outcome                                                                                                 |
| --------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `claim`   | unset                                                                        | write `{claimedBy: by, claimedAt: now}`; `status: 'claimed'`                                            |
| `claim`   | == `by`                                                                      | no-op write of `claimedAt: now`; `status: 'held'`, `heldBy: by` (idempotent re-claim by the same agent) |
| `claim`   | != `by`, age < `project_policy.claim_stale_after_min` (default 30), `!force` | **throws** `ClaimHeldError(heldBy, heldSince)`                                                          |
| `claim`   | != `by`, age ≥ threshold, OR `force:true`                                    | write `{claimedBy: by, claimedAt: now}`; `status: 'reclaimed-stale'`, `previousClaimant`: the old value |
| `release` | == `by`                                                                      | clear both fields; `status: 'released'`                                                                 |
| `release` | != `by` or unset                                                             | no write; `status: 'release-noop'`, `wasClaimedBy` echoes the prior value if any                        |
| `renew`   | == `by`                                                                      | bump `claimedAt: now`; `status: 'renewed'` (same-claimant renewal always succeeds)                      |
| `renew`   | != `by` or unset                                                             | **throws** `ClaimHeldError` (renew is not a claim attempt)                                              |

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

Reading stale claims is `query`'s `view:"stale"` (§5):
`NodeFilter.metadata: { claimedAt: { lt: <now - threshold> }, claimedBy: { exists: true } }` —
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

Single-valued rels (`supersedes`, `duplicate_of`, `part_of` — each declared
`n:1` in §3, meaning ONE target per source) reject a second `add` with a
DIFFERENT target: `SingleValuedRelationConflictError(sourceUid, rel,
existingTargetUid)` (carrying forward BUG-025/BUG-044's "never silently pick
one" rule). A second `add` with the SAME target is `noop:true`, not an
error. This is the generic `edge_kind.multiplicity` check (§2) applied to
these three `n:1` rows — not a separate list hardcoded into `relate` — so
`part_of` (an item has exactly one live parent — §6.2's plan-attachment,
§6.3.2's `children` composition) is rejected identically to the other two,
and any future `n:1` rel is covered the same way with no change here.

```ts
interface IMoveIssueInput {
  uid: string;
  toComponent: string; // uid or name, resolved per §6.1
  by: string;
}
```

`move` is a hand-composed edge-invalidate (old `owns_component`) + hand-composed
edge-upsert (new `owns_component`) + audit, atomically, against the SAME `tx`
handle (§4, `moveIssue`; §4c — never a call to the library's `invalidateEdge`/
`writeEdge`, both of which run against the bare adapter and would autocommit
outside this transaction). It is a
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
  reason: string; // REQUIRED — a soft delete always records why
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
never content). But the dedupe gate this section specifies (`duplicateCandidates`,
`force`/`duplicateAction`) was never about identity
collapse — it is a **filing-time interception product feature**: warn a
caller who is about to re-file something that already exists, before they
mint a redundant row. These are two unrelated mechanisms that happen to
share the name `skipDedupe`. §4 already resolves the identity half
(`skipDedupe:true`, unconditionally). This subsection resolves the
product-feature half, which stays real:

1. **`createIssue` runs an app-level pre-write similarity scan** — never
   the library's disabled content-hash path. It calls the SAME
   `StoreSearchBackend.searchRanked` primitive §5a already wires for
   `view:"similar"` (`signals:[{text},{vec}]`), scoped to
   `filter.project` (the target project only — cross-project title
   collisions are not duplicates), over `{title, body}`. This scan runs
   **before** the `immediate` transaction opens, never inside it:
   `searchRanked` is an external, potentially network-backed round-trip (an
   embedding-service call), and holding the RESERVED lock across that
   round-trip would stall every other concurrent writer for its duration —
   the exact failure mode §4c's `immediate`-mode table exists to prevent
   for every check-then-act it covers. That placement makes the scan
   deliberately **not** a CAS: two concurrent `createIssue` calls filing
   near-identical content can both see zero candidates and both commit,
   producing two rows that no transaction boundary closes the window on.
   This is an accepted gap, not an oversight — the duplicate gate is a
   filing-time UX feature (warn a human filer before they mint a redundant
   row), never a uniqueness invariant. §1 already establishes identity is
   `uid`, never content, so two duplicate rows landing from a lost race are
   a missed warning, not a correctness defect — unlike every row in §4c's
   mode table, which protects a real invariant (single-valued rels, claim
   leases, edge cardinality) and therefore does need the airtight CAS
   `immediate` provides.
2. **Threshold is data, not code** — extending DATA_MODEL.md §2's
   `project_policy` table with two more project-tunable columns:
   `dedupe_scan_enabled` (default `true`) and `dedupe_threshold` (default
   `0.8`, the fused `searchRanked` score above which a candidate counts as
   a likely duplicate). A project that files many superficially-similar-but-
   distinct issues can raise its own threshold or disable the scan; the
   default stays on for every project that never opts out.
3. **`duplicateAction` decides what happens when the scan finds ≥1
   candidate at or above threshold.** Zero candidates at/above
   `dedupe_threshold` is not a branch of `duplicateAction` at all: whichever
   action was requested (`'abort'`/`'force'`/`'comment'`), a scan that
   finds nothing proceeds straight to a normal create (`{created:true,
uid}`, no `duplicateCandidates` field) — there is nothing for `'abort'`
   to suppress, `'force'` to write past, or `'comment'` to attach to. With
   ≥1 candidate:
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
  limit?: number; // default 50, max 1000 (MAX_QUERY_LIMIT) — see composition rule 6 below
  offset?: number; // offset-based paging when `after` is absent — see rule 6; mutually exclusive with `after` (rule 5), unstable under concurrent writes by design
  after?: string; // opaque keyset cursor from a prior page's `nextCursor` — see rule 5
  view?: 'list' | 'ready' | 'graph' | 'order' | 'stale' | 'similar' | 'overlap'
    | 'projects' | 'components' | 'locations'; // §5's existing view union, carried forward, plus §3a's registry LIST views (`projects`/`components`/`locations` — every live project/component/location row, optionally scoped by `filter.project`/`filter.component`)
  format?: 'json' | 'markdown'; // default 'json'; 'markdown' renders this same page as issue-titled headers + `[target sha:…]` citations, never a second code path (§6.6) — and, when the card carries one, the item-level `gitContext` once at the head of its `Citations:` block (`Citations: [<active git context>]`, the disclosure format's first element). Only supported for the four item-list views (`list`/`ready`/`stale`/`similar`); any other view rejects it with `InvalidArgumentError('format', ...)`
}

interface IIssueFilter {
  project?: string; // uid or name
  component?: string; // uid or name, scoped within project
  kind?: string | string[];
  status?: string | string[] | 'open' | 'closed' | 'all'; // IStatusSelector
  priority?: string | string[];
  assignee?: string;
  claimedBy?: string;
  author?: string; // resolves via authored_by edge traversal
  grep?: string; // FTS keyword, title+body — stays keyword-only, never hybrid (unchanged rule)
  semantic?: string; // routes to searchRanked (§5a) — composes with grep, neither swallows the other; ALSO the free-text seed for view:'similar' when filter.anchor is not given (§5a)
  anchor?: string; // item-anchored similarity seed (§6.1) — uid of the reference item; view:'similar' requires this OR filter.semantic (§5a)
  closedAt?: { since?: string; until?: string };
  createdAt?: { since?: string; until?: string };
  updatedAt?: { since?: string; until?: string };
}
```

`fields` — the closed vocabulary (`IIssueField`), unknown name →
`BacklogValidationError` naming it, never a silent drop (`assertKnownFields`
— a general correctness rule):

```
plain (cheap, always included when requested):
  uid, title, kind, status, priority, project, component,
  createdAt, updatedAt, assignee, author, closedAt, gitContext
pseudo (opt-in only — never in the default card, each costs a real extra read):
  body, citations, notes, auditTrail, blockers, related,
  _score, _vector
```

`closedAt` is classified `plain`, not `pseudo`: it is a scalar key inside the
SAME `issue.meta.metadata` JSON blob `assignee` already lives in (§6.3.4),
read in the identical single-row fetch — there is no second query, unlike
every genuine `pseudo` field (`citations`/`notes`/`auditTrail`/`blockers`/
`related` each require a separate edge traversal to another node kind;
`_score`/`_vector` only exist on a `searchRanked` response; `body` is
excluded for context-size reasons, §6.2's 'context-blow defense', not read
cost). Classifying it `pseudo` under this section's own stated criterion
('each costs a real extra read') was inconsistent with `assignee`'s `plain`
classification given they are mechanistically identical. `gitContext` is
`plain` for the same reason — a sibling of `assignee` in the same metadata
blob, read in the same single-row fetch.

Default (`fields` omitted): `['uid', 'kind', 'title', 'status', 'priority']`
— the five-field terse card (`DEFAULT_CARD_FIELDS`), keyed on `uid`.

**Pagination — resolved fully, one composition algorithm:**

1. **Bounds.** `limit` must be a positive integer ≤ `MAX_QUERY_LIMIT` (1000).
   Absent → default `50`. Out of range or non-integral
   → `BacklogValidationError('limit', ...)`, never a silent clamp (the
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
   every edge-scoped filter given). **`kind`/`status`/`priority` values are
   validated against the catalog's own live rows** (DATA_MODEL.md §0.2/§2:
   each is an open string vocabulary realized as ordinary catalog nodes, so
   there is no fixed enum to validate against — the catalog's live rows ARE
   the real value space). A `filter.kind`/`filter.status`/`filter.priority`
   value that matches NO live catalog row (neither by uid nor by name)
   throws `BacklogValidationError` naming the unresolved value(s) and, when
   feasible, suggesting the nearest existing name(s) by edit distance —
   never silently proceeding to a `{total:0, items:[]}` result
   indistinguishable from filtering by a real, sparse (currently zero-issue)
   value, which still returns cleanly empty exactly as before. `project`/
   `component`/`author`/`plan` filter values keep the pre-existing "unresolved
   name is not an error, resolves to zero matches" read-path rule (§6.1) —
   they are registry/agent references, not open catalog vocabularies, so this
   validation does not extend to them.
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
   filter rather than searching the whole store and filtering after. **When
   BOTH `grep` and `semantic` are given** (`filter.semantic`'s own comment,
   above: 'composes with grep, neither swallows the other'), the mechanism
   is: run them as two INDEPENDENT scans over that same edge-restricted
   candidate set — `searchNodes(grepQuery, {filter})` (FTS-only, per
   `grep`'s keyword-only rule) and `searchRanked({vec: embed(semanticQuery),
signals:[{vec}]}, limit)` (the embedding-only path, §5a; verified,
   `@adhd/sox-hybrid-search@0.4.2 dist/index.d.ts:29-34` — `SearchQuery`
   takes one `text`/`vec` pair, never two independently-scored query
   strings, so `grep` and `semantic` cannot be fused into one `searchRanked`
   call) — then INTERSECT the two candidate id sets, the SAME AND-
   composition rule 3 already applies across multiple edge-scoped filters.
   The surfaced `_score`/ordering come from the semantic pass; grep's pass
   only gates membership. This is exactly how 'a title/body text match
   surfaces even when its vector is not nearest' (§5a) holds when both are
   given: grep's intersection guarantees the row is present at all,
   semantic's ranking decides where it sorts.
5. **Keyset stability (`after` given).** Per the verified library contract
   (`dist/index.d.ts:206-212`): `after` compiles to `WHERE rowid > ?
ORDER BY rowid ASC`, **ignoring** `orderBy`/`offset` entirely. So: a
   caller that supplies `after` gets rows in insertion order and MAY NOT
   also supply `sort` — `query({after, sort:'priority'})` throws
   `InvalidArgumentError('sort', 'sort is incompatible with keyset
pagination (after) — request the first page unsorted, or page by
offset if a non-insertion order is required')`. The SAME incompatibility
   holds against `filter.grep`/`filter.semantic`: both route through
   `searchNodes`/`searchRanked` (rule 4), which order by FTS/fusion score,
   never by rowid — `searchRanked(query, limit)` (verified,
   `@adhd/sox-hybrid-search@0.4.2 dist/index.d.ts:204`) takes no `after`/
   keyset parameter at all, and `searchNodes`'s own `opts` (verified,
   `@adhd/sox-graph-store@0.9.1 dist/index.d.ts:293-296`) exposes `offset`,
   never `after`, at its top level — so `query({after, filter:{grep:...}})`
   (or `semantic`) throws the same `InvalidArgumentError('after', 'after
(keyset) is incompatible with grep/semantic search — these route through
the ranked search primitives, which have no rowid-ordered keyset
contract; page a searched result set by sort + offset (rule 6) instead')`.
   This ordering is
   provably stable and gapless under concurrent writes: every page's
   cursor is a strictly-increasing rowid boundary, a concurrent INSERT
   always lands at a HIGHER rowid than anything already paged (so it can
   only ever appear on a LATER page, never re-appear on an earlier one or
   split one already returned), and a concurrent `invalidate` merely
   removes a row from a future page's `liveOnly` filter — it can never
   re-order or duplicate an already-returned row. This composition IS
   what acceptance criterion 8 (§8) tests.
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
   must never persist it across a store rebuild, since rowids are
   per-store per §1). If `limit` or fewer rows come back, `hasMore:false`
   and `nextCursor` is absent.

### 6.6 The `admin` verb — action-by-action disposition

There is no `admin` verb — it is one of six verbs this application layer does
not carry (§7). Every action once carried under `admin` is accounted for:

| Admin action                                                                                       | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `import`, the phase-status/phase-setting actions, `reconcile_repo`, and the model-transform action | none of these have any surface here at all — this application layer carries no markdown `import`, no phase-tracking machinery, and no repo-reconciliation module                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `render`, `export`                                                                                 | folded into `query`'s output: `format:'markdown'` (new) alongside the existing `format:'json'` — a plain read, not an admin mutation. Markdown headers render the issue **title** (never `uid`); citations render `[target sha:…]` (unchanged from the current surface's stated projection rule), and the item-level `gitContext` renders once at the head of the `Citations:` block when present (`Citations: [<active git context>]`, the disclosure format's first element)                                                                                                                                                                                                                                                                    |
| `archive`                                                                                          | no longer a mutation at all — see §6.2's `ArchiveOpts` row: `status.terminal` is the only exclusion signal the default projection needs                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `merge`                                                                                            | 1:1 mapping onto `relate('duplicate_of')` + `delete` — §6.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `embedding_backfill`                                                                               | already specified: §4b's `reembed` (batch, backfill-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `embedding_health`, `list_near_duplicates`                                                         | fold into `query`'s `view:"similar"` (§5a) — a health/near-duplicate report is exactly "run the similarity view over the whole corpus," not a distinct admin code path                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `doctor`, `prune`, `run_dedup_sweep`, `cluster_into_plans`, `promote_cluster_to_plan`              | **not part of this consumer surface.** These are one-shot/periodic maintenance operations, not a product feature a caller addresses by `uid`. Per this repo's own package-scaffolding rule (reusable tooling belongs in a script or plugin; a one-shot data transform is a throwaway script — never a mounted verb), if any of these are still needed operationally they are scripts run directly against `src/write/`/`src/query/`, never re-admitted as a 20th grab-bag `admin` action — that grab-bag shape is precisely what the named, individually-typed verb surface (§4, §6.3) replaces. |
| `skill`, `version`                                                                                 | both are host-adjacent, store-free introspection — same carve-out class as `install`/`install-skill`/`serve` (server.ts:139's `BACKLOG_HOST_COMMANDS`), extended to include them, rather than mounted as data verbs. Neither opens the store (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001's whole point), so nothing changes about how they run — only that they are formally carved out instead of living inside `admin`.                                                                                                                                                                             |
| `batch`                                                                                            | not backlog-specific code — `apigen-plugin-batch`'s generic `batch_action` fan-out is inherited automatically the moment this application layer's nine verbs mount through the same apigen plugin surface (`usePlugins:[batchPlugin]`, unchanged from server.ts's current wiring). Nothing to design here.                                                                                                                                                                                                                                                                                       |

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
`uid`s) with `[target sha:…]` citations, per §6.6's `format:'markdown'` — the
item-level `gitContext`, when present, leading that `Citations:` block once.
Web UI list/detail views read the catalogs and edges directly through
`query`'s `view` axes and the three mounted stats/rollup reads
(`priority-matrix`/`part-of-rollup`/`open-curve`), exactly as every transport
does — no separate web-specific query path.

## 7. Removed application-layer machinery

This application layer carries none of the following: the source item's
human-readable identifier machinery, `idOverride`, `importedFrom`, repo-string
identity, phase-tracking machinery, `repoWarning`, a markdown `import` action,
`firstTerminalTransitionAt` reconstruction, or the hardcoded terminal/citation/
reason knobs — and none of the six-verb surface that once carried them.
Repo-string identity is provided instead by the registry (§3a): there is no
`parseRepoKey`/`canonicalRepoKey`, no `resolveRepository`/`lookupRepository`,
no `setRepositoryFork` (`DERIVED_FROM`), no second `GraphBackend` dimension
(`IN_REPO`/`IN_PACKAGE`/`PROJECT_OF`/`AUTHORED_BY`/`REPORTED_BY`), no
legacy-alias resolution leg on node lookup, and no package-key machinery. All
of that is provided instead by first-class `project`/`component`/`location`
nodes plus `lookup`.

There is no coexistence shim and no legacy-id fallback: this is the only
surface, and identifiers other than `uid` do not resolve, by design.

## 7a. Data cutover (ETL)

**Direction, once, never in place.** The real store's existing corpus is
carried onto this schema by a one-time load (`tools/etl/`) that reads the
OLD-schema file and writes a FRESHLY CREATED store file — the file it reads
from is never mutated in place, and this package's live write layer never
targets an old-schema file directly (§0). It runs exactly once, immediately
before production traffic is pointed at the new file, and the tooling has no
further job once that happens — there is no ongoing or staged process here,
only a single cutover moment.

**Status: the tooling has been proven once; the real cutover has not
happened yet.** A proving run was executed against a corpus snapshot to
answer one question — can this data model hold the real corpus without
losing anything — and the answer was yes:

- 1763 source items → 1763 imported, 0 failed; 205 cross-issue edges written,
  0 dangling references; post-run 1511 live / 252 invalidated.
- Comparison 1 (issue counts): source 1763/1511/252 = target, exact.
- Comparison 2 (status histogram): all 18 statuses match exactly.
- Comparison 3 (citation sets): 100 sampled issues, per-issue sets equal.
- Comparison 4 (project→component→issue two-hop reachability): **diverged**
  at proving time — source 1763, target 1261, a 502-item gap. Root cause:
  `tools/etl/catalog-upsert.ts`'s `upsertComponentTx` minted a component
  node without the `owns_project` edge back to its project, unlike real
  `upsertComponent`, which writes node+edge in one transaction — 108 of 145
  target components were left unreachable, owning exactly the missing 502
  issues. **Fixed**: `upsertComponentTx` now takes the write handle and
  writes `owns_project` in the same transaction as the mint, mirroring
  `upsertProjectTx`'s own `(root)`-component pattern.
- **Superseded by a structural fix**: `tools/etl/catalog-upsert.ts` no longer
  hand-rolls its own find-then-create SQL for `project`/`component` at all —
  that duplication (predating the real `upsertProject`/`upsertComponent`
  registry verbs' existence) was the root cause of the bug above, and a
  second hand-rolled copy can regress the same way a third time. `src/write/
  catalog.ts`'s `upsertProject`/`upsertComponent` are now split into a
  transaction-PARTICIPANT core (`upsertProjectTx`/`upsertComponentTx`, taking
  the caller's own open `tx`) and a thin `executeWriteTransaction`-opening
  public wrapper — the ETL's `import-item.ts` bundles an entire source item's
  writes into ONE caller-owned `immediate` transaction (this section, above)
  and cannot nest a second `executeWriteTransaction` inside it, so it now
  calls the real `*Tx` cores directly instead of a parallel implementation.
  `tools/etl/catalog-upsert.ts` is a thin adapter only: it maps the ETL's own
  input shape onto the real verbs' `IUpsertProjectInput`/
  `IUpsertComponentInput`, and re-fetches `rowid` via `getNodeByUidTx` (needed
  by every downstream `writeEdgeTx` call; deliberately not part of either
  outcome type's public, business-facing contract). Re-proven against an
  1788-item re-run of the current corpus: all four comparisons clean,
  including comparison 4's `owns_project` reachability walk.

Because the proving run's snapshot predates real production activity that
has continued to land on the OLD file since, **the proving run's numbers are
not the cutover's numbers** — the real cutover must re-run this tooling
against a copy of the CURRENT live corpus, not the snapshot above, before
production is pointed anywhere new.

**Before the real cutover:**

1. Re-run `tools/etl/run-etl.ts` against a **read-only copy** of the real
   production file (never the live file itself) to pick up everything
   written since the proving run.
2. Re-verify all four comparisons clean — including comparison 4, now that
   its root cause is fixed.
3. Only then, as an explicit, separately-approved step: point production's
   `db.path` config at the new file, with a timestamped backup of the old
   file taken first (mirroring the existing `backup-YYYYMMDD-HHMMSS/`
   convention already used for this store).

Nothing in the published package imports `tools/etl/`; it is cutover tooling,
not a runtime dependency, and carries no further job once the real cutover
above is complete.

## 8. Acceptance (negative-control teeth)

1. Identity in this application layer is `uid` alone; no field or code path
   resolves it by a human-readable name of any kind.
2. **Live-path identical-content:** two `createIssue` calls with
   byte-identical `{title, body}` in the same project, the second passed
   `duplicateAction:'force'`, produce two distinct `uid`s (skipDedupe:true
   on the live path — `force` is the one `duplicateAction`
   §6.4 point 3 guarantees this for; the default `'abort'` suppressing that
   same identical pair instead is AC-19's assertion, not this one).
3. **Automatic audit:** every transition/update/move/invalidate/embedding write
   produces one audit node (`actor`+`action`+`sha`); a transition missing
   `agent`/`note`/`sha` is rejected (red without the check).
4. **On-write embedding:** writing an issue produces its vector via the
   observer; invalidating removes it.
5. **Uniqueness is edge-scoped, enforced inside the write transaction:** two
   `upsertProject` calls with the same `name` resolve to ONE row — the second
   is a resolve, never a second row and never an error. Two `upsertComponent`
   calls with the same `name` under DIFFERENT projects are two genuinely
   distinct rows, while the same `name` under the SAME project is one — the
   half a global `name` key would silently collapse. Red if the policy is
   widened to a global name scan (`src/write/catalog-verbs.spec.ts`).
6. **A body edit carries the issue's WHOLE graph onto its successor:** after
   `update({uid, body})` the superseded node is absent from every listing and
   its successor holds every edge the issue had — `blocks`, `depends_on`,
   `relates_to`, `part_of`, `duplicate_of`, the lowercase `supersedes`,
   `has_note`, `has_citation`, `has_transition` and `audits` — swept in BOTH
   directions, since an issue is the SOURCE of `has_note` but the TARGET of
   `blocks`; and `openCurve` counts each identity CHAIN once per instant,
   never once per node. Removing the carry-forward sweep, or the chain-head
   resolution, turns these red (`src/query/superseded-views.spec.ts`,
   `src/query/superseded-listing.spec.ts`, `src/write/update.spec.ts`).
7. **Semantic:** `searchRanked` over this store returns text+vec fused results.
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
13. **`get`:** `get({uid})` with no `fields` returns exactly the five-field default card (`uid,kind,title,status,priority`); requesting the pseudo field `body` returns it; `get` on a `uid` that resolves to no live node throws `IssueNotFoundError(uid)`; `get` on a SUPERSEDED `uid` throws `StaleSupersedeError` — never the frozen pre-edit card — carrying `successorUid`, and after N successive body edits the uid from before the first edit reports the CURRENT head, not an intermediate node (a single-hop walk fails this).
14. **`update` touch + no-silent-discard:** `update({uid, by, title:'x'})` returns `changed:['title']`; a zero-field patch throws `InvalidArgumentError`; a call carrying `status` in its input is rejected naming `transition`, never silently applied as a status change (proves DEBT-010 cannot recur through `update`).
15. **`transition` closedAt stamp:** transitioning an issue to a `terminal` status stamps `issue.meta.metadata.closedAt` and the outcome's `closedAt`, and `filter.closedAt.since` retrieves it via a subsequent `query`; transitioning a currently-terminal issue to a non-terminal status (reopen) CLEARS `issue.meta.metadata.closedAt` in the same `touch` call, and a subsequent `query({filter:{closedAt:{since:<the old closedAt>}}})` no longer matches the reopened issue — proving the stale-timestamp case has teeth, not just an unset-on-first-transition case.
16. **`claim` CAS lease:** `claim` on an unclaimed issue returns `status:'claimed'`; a second `claim` by a DIFFERENT agent within `claim_stale_after_min` throws `ClaimHeldError`; the same call with `force:true` returns `status:'reclaimed-stale'` with `previousClaimant` set to the ousted agent; two concurrent `claim` calls against the SAME fresh uid, run as real barrier-synchronized OS processes, never both report `status:'claimed'` — exactly one wins (red if the CAS transaction is downgraded off `immediate`).
17. **`relate`/`move` outcomes:** a second `relate(...,'supersedes','add')` naming a DIFFERENT target than an existing edge throws `SingleValuedRelationConflictError`; the SAME target returns `noop:true`; after `move`, exactly one live `owns_component` edge exists for the issue, both before and after — never two.
18. **`delete` is soft:** `delete(uid, reason)` returns `{invalidated:true}`; the issue disappears from a default `query` listing but `getNodeByUid(uid)` still resolves it (bi-temporal, never a hard delete).
19. **`create`'s duplicate gate:** filing a near-duplicate title/body in the same project with default `duplicateAction` returns `{created:false, reason:'duplicate-suppressed'}` and writes nothing; `duplicateAction:'force'` writes a genuinely new, distinct `uid` despite the match (and still reports `duplicateCandidates`); `duplicateAction:'comment'` writes zero issue rows and attaches a `note` to the top-scoring candidate instead.
20. **`query` sort/keyset conflict:** `query({after:<cursor>, sort:'priority'})` throws `InvalidArgumentError('sort', ...)` naming the incompatibility; the identical call without `sort` succeeds and pages in insertion order.
21. **Registry `rmLocation`:** `rmLocation(uid)` invalidates the location; a subsequent `lookup` on that `(locType,value)` no longer resolves it; the location's own record remains addressable by uid (bi-temporal, never hard-deleted).
22. **Concurrent write safety (BUG-039 gate):** the un-skipped, repointed cross-process harness (§4c/§9.1) run against `createIssue` reports a fresh-reopen stored count exactly equal to the number of `ok`-reporting creates, for both the same-target and distinct-target cases, over two real OS processes with no serve-lock coordination. **Negative control:** the identical run with `skipDedupe: true` stripped (`ADHD_BACKLOG_UNSAFE_DEDUPE_MODE=on`) reports a stored count BELOW the expected total — deterministically one row where two were reported `ok` — proving the exact-count assertion has teeth.

    The control targets the dedupe guard rather than the transaction-mode guard, deliberately and not as a weakening. Stripping `immediate` mode alone has **no deterministic observable on this path**, because §1 makes every live entity write `crypto.randomUUID()`-keyed with `skipDedupe: true` unconditional: two concurrent `createIssue` inserts have no unique constraint and no content hash to collide on, with or without `BEGIN IMMEDIATE`, so there is nothing for a lost-update to lose. An assertion that went red only when the OS scheduler cooperated would be a flaky proof, which §9.1 is explicit is not a proof at all. The transaction-mode guard is load-bearing on the OTHER write shape — the business-key find-then-create behind `upsertProject`/`upsertComponent`/`upsertLocation` (§4c), where a read-miss on both sides genuinely does mint two rows — and `write/catalog-verbs.spec.ts`'s cross-process control exercises that lever directly.

23. **`create` with no `component` defaults to `(root)`, never orphaned:** `createIssue({title, body, project:'adhd'})` — `component` omitted entirely — writes exactly one `owns_component` edge, to `project`'s reserved default component `(root)` (§3/§6.3.2), and never throws `CatalogNotFoundError('component', ...)`; a subsequent `query({filter:{project:'adhd'}})` (§6.5 rule 3) returns the new `uid` in its results, proving the issue is reachable through the project filter rather than orphaned; two separate no-`component` `createIssue` calls against the same project resolve to the SAME `(root)` component row (`get({registry:'component', name:'(root)', filter:{project:'adhd'}})` returns one row, not two) — proving the fallback is a resolve of an already-guaranteed row, never a per-call mint.

## 9. Dependencies & sequencing

1. Library tier — published (FEAT-010..024, DEBT-011, BUG-040), plus the
   `graph-store` 0.9.1 patch that surfaces `NodeRecord.uid` + `getNodeByUid`
   (the stable-identity correction — the ONE library change this plan required).
2. **Bump dependencies and build this application layer in ONE change** (a
   single atomic cutover — no parallel build to protect):
   `entrypoint/backlog/package.json` bumps to graph-store
   0.9.1 / store-adapter 0.9.0 / vector-store 0.6.0 and ADDs hybrid-search
   0.4.2 / semantic 0.1.2 / embedding-provider 0.4.1, alongside the new
   `src/write/` → `src/query/` → consumers. This is the entire application
   layer, written in the same change; there is no intermediate state where
   two implementations compile side by side.
3. **Gate before the store takes its first live write: the BUG-039
   write-safety proof against the UUID write path — confirmed, not assumed,
   by the procedure in §9.1.** Never write real data onto an unproven write
   path. This is also what resolves BUG-040 in practice: the library's global
   content-hash dedup no longer collapses distinct transitions and issues,
   because every live write-layer entity write passes `skipDedupe: true`
   (§1).

### 9.1 Gate procedure

The BUG-039 write-safety proof (§9 point 3) is confirmed — never assumed — by
this procedure, run against the harness that already exists at
`entrypoint/backlog/src/store/concurrency-scale.spec.ts:346-451`
(`cross-process-writer.cjs` fixture).

**Before the command runs, two things in the existing harness must change — it is
not runnable as a gate for this application layer as written:**

1. **Un-skip it.** The BUG-039 describe block is `describe.skip(...)`
   (`concurrency-scale.spec.ts:419`). `-t "BUG-039"` filters test names; it does
   **not** override a `.skip` on the containing `describe`. Remove `.skip` first, or
   the command below reports zero tests run and reads as a clean exit rather than as
   "did not run."
2. **Repoint the fixture off the source-identity surface.** `cross-process-writer.cjs` currently
   drives `createItem(ctx, { family, title, body, repo })` and reads back via
   `listItems(store, { repo, family })` (`cross-process-writer.cjs:26,52`;
   `concurrency-scale.spec.ts:19-20`) — `family`, `repo`, and the human-readable
   identifier are identity machinery §7 carries none of. Before this harness can
   gate this write path it must call the `createIssue` verb (§4) against a seeded
   `project`/`component`, and its `storedCount` helper (`concurrency-scale.spec.ts:407-417`)
   must count issues via the query layer (§5) scoped to that component, in place
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
threads, not mocks — `concurrency-scale.spec.ts:365-378`) open the SAME on-disk
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

## 10. Out of scope

Library-tier changes beyond the `graph-store` 0.9.1 uid-surfacing patch (already
committed); data-model
changes beyond this spec; multi-tenancy/auth (identity = `agent` catalog;
access control out of scope).
