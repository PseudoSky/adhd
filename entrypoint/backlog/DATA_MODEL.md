# Backlog Data Model

Status: the model this package writes to and reads from, as implemented in
`src/write/*` and `src/store/type-policy.ts`, over the shared `@adhd/sox-graph-store`
substrate (`@adhd/sox-store-adapter` is the store's only storage seam).

## 0. Design principles

1. **One identity, system-owned.** Every entity is a graph node carrying a
   library-minted `uid` (UUID). `uid` is the only identifier this package ever
   accepts as external input or returns to a caller — never a business key,
   never a composite, never an alias. `rowid` (the node table's internal
   numeric id) is used only for in-transaction edge wiring; it is per-store
   and not stable across a rebuild, so it never escapes as a consumer-facing
   reference.
2. **The graph store has no arbitrary tables — a "first-class record" is a
   node.** There is one `node` table and one `edge` table. Every entity this
   document describes — `project`, `component`, `location`, `issue`, every
   catalog row (`kind`, `status`, `priority`, `agent`, `edge_kind`), and every
   event/evidence row (`note`, `citation`, `transition`, `audit`) — is a row
   in the SAME `node` table, distinguished by its `kind` column. Structure
   (membership, ownership, dependency, catalog membership, issue relations)
   lives as typed rows in the SAME `edge` table, distinguished by `rel` —
   never as a string column pretending to be a foreign key.
3. **`kind` and `rel` are open, string-valued vocabularies.** The `TypePolicy`
   this package injects into every `GraphBackend` it opens
   (`src/store/type-policy.ts`'s `OPEN_TYPE_POLICY`) accepts every kind, every
   rel, and every `(sourceKind, rel, targetKind)` triple unconditionally —
   `validateKind`/`validateRel`/`validateEdge` are all no-ops. Real schema
   enforcement (which kinds exist, which rels connect which kinds, and at
   what cardinality) is a write-layer responsibility, described in §2 and §5
   below, never smuggled into that pure three-string predicate.
4. **Content is never identity.** Every write-layer node write passes
   `skipDedupe: true` — two identical-body issues are two distinct nodes with
   two distinct `uid`s, never collapsed into one row by the library's global
   content-hash dedup.
5. **Every mutation is documented and content-addressed.** A `transition`
   requires an agent, a note, and a `sha`; a `citation` requires a `sha`
   computed by re-hashing the cited content; every state-changing write emits
   an `audit` node whose own `sha` hashes its own canonical serialization.
   See §4 and §6.

## 1. Graph substrate

- **Nodes** carry `rowid` (internal), `uid` (external identity), `kind`,
  `name`, `content`, a `meta` JSON blob, and the bi-temporal columns
  `t_created`/`t_valid`/`t_invalid`. Every domain field beyond `name`/`content`
  lives inside `meta` — there is no per-kind column set.
- **Edges** carry `src`/`dst` (node `rowid`s), `rel`, and their own
  `t_valid`/`t_invalid`. `invalidateEdge` (bi-temporal edge retirement) is how
  a relation is dropped; `invalidate` (on a node) is how an entity is
  soft-deleted. Both are hand-composed against the write layer's own open
  transaction handle — never the library's bare-adapter primitives, which
  autocommit outside that transaction.
- **Uniqueness** is a hand-composed find-then-create: the write layer runs its
  own `SELECT ... WHERE kind = ? AND name = ? AND t_invalid IS NULL` against
  the SAME `immediate`-mode transaction the calling verb already opened, and
  only on a miss issues the INSERT against that same transaction handle —
  never the library's own `findOrCreateNode()`, which is two separate,
  non-transactional autocommit statements with no race-safety across
  concurrent writers.
- **`supersede`** (the library's own content-mutation primitive) is the only
  path that changes a node's `content` — `touch` cannot. It writes a
  hardcoded, uppercase `SUPERSEDES` rel; this is the content-versioning
  mechanism, distinct from the catalog's own lowercase `supersedes` issue
  relation (§5). The injected `TypePolicy` accepts both.

## 2. Catalogs (nodes, not separate tables)

Every catalog below is realized as ordinary nodes of a given `kind`, unique by
`name` among live rows — never a dedicated relational table:

| catalog | node `kind` | unique on | extra fields (in `meta`) |
|---|---|---|---|
| node kind | `kind` | `name` | `description` |
| edge kind | `edge_kind` | `name` | `source_kind`, `target_kind`, `multiplicity` |
| status | `status` | `name` | `terminal` |
| priority | `priority` | `name` | `rank` |
| agent | `agent` | `name` | — |

`status.terminal` drives closedness. `kind`/`status`/`priority`/`agent` are
mintable on an unresolved NAME by any issue-mutating verb that accepts them
(`create`, `update`, `transition`) — a uid-shaped ref that does not resolve
throws instead; minting never applies to a uid. `priority`'s mint rule sets a
fresh row's `rank` to one past the current max live rank, so a novel priority
can never silently outrank an existing one.

`edge_kind` is never caller-mintable. Every row is seeded once from the fixed
edge table in §5 (`EDGE_KIND_TABLE` in `src/write/catalog.ts`) — the write
layer self-heals a missing or malformed row from that same fixed table, but
there is no path for a caller-supplied `rel` name to mint a new row.

### Per-project policy

Per-project policy is DATA, not code — but it is not a separate relational
table either: it lives inside the owning `project` node's own `meta.metadata.policy`
object (§3), since it is 1:1 with a project, never many-to-many. Every field
defaults exactly as below when a project carries no `policy` object at all:

- `transitionRequiresNote` (default `true`)
- `citationRequired` (default `false`)
- `citationRequiresSha` (default `true` — gates acceptance of an unverified
  citation with `CitationUnverifiableError`)
- `defaultStatus` (catalog ref; falls back to the global default when unset)
- `defaultKind` (catalog ref; falls back to `'issue'` when unset)
- `dedupeScanEnabled` (default `true`), `dedupeThreshold` (default `0.8`)
- `claimStaleAfterMin` (default `30`)
- `allowedStatuses` — the status-name set a project may use; empty means "no
  restriction, anything in the global catalog is allowed"
- `allowedKinds` — the kind-name set a project may file; empty means the same
- `requiredFields` — field names a project requires present on every
  mutating write that touches them (enforced identically to the `by` check,
  at the top of `create`/`update`/`transition`)

There is no `transition_requires_sha` field: a `transition` or `audit` node's
`sha` hashes its OWN canonical serialization (never external content), so it
is always computable — §4's "agent + note + sha REQUIRED" is a hard
invariant, never policy-tunable. Only a `citation`'s `sha` (which hashes
external file content) can legitimately fail to resolve, which is what
`citationRequiresSha` gates.

## 3. Entities (graph nodes)

```
project      kind='project', name unique
  meta: { path, repoUrl, monorepo?, description?, policy? }
  -- the navigation spine: `path` is the absolute local root, `repoUrl` the
  -- canonical git remote. A worktree directory under the project resolves
  -- to the SAME project row. Minted only via the explicit upsertProject
  -- verb — never implicitly by createIssue or any other issue verb.

component    kind='component', name unique within project
  meta: { projectUid, path?, description? }
  -- ownership is the owns_project edge (§5), never a project-id column.
  -- Every project carries exactly one reserved default component named
  -- `(root)`, written atomically by upsertProject alongside the project
  -- node itself — never minted lazily at issue-creation time. `(root)` is
  -- what createIssue resolves to when its optional `component` input is
  -- omitted, so every issue always gets exactly one live owns_component edge.

location     kind='location'
  meta: { locType, value, componentUid }
  -- locType ∈ 'path' | 'url' | 'tool'; value's interpretation follows
  -- locType (path = filesystem path, url = full URL, tool = MCP tool / CLI
  -- command / symbol name). Unique per (component, locType, value).
  -- Belongs to exactly one component via has_location (§5).

issue        kind='issue', name=title, content=body
  meta: { assignee?, closedAt? }
  -- kind/status/priority are catalog refs reached via has_kind/has_status/
  -- has_priority edges (§5), never inline columns. closedAt is stamped, as
  -- meta.metadata.closedAt, by the transition that moves status to
  -- terminal, and cleared (never carried forward stale) by a transition
  -- that moves it back off terminal.
```

## 4. Event/evidence nodes (first-class rows, content-addressed)

These are the graph-native realization of "first-class event rows" — the
store has no dedicated event tables, so each is an ordinary node of its own
`kind`, linked to its subject issue by a dedicated edge:

```
note         kind='note'
  meta: { author, text, at }

citation     kind='citation'
  meta: { target, target_type, sha, line, at }
  -- content-addressed: sha is sha256 of the cited content at citation time.
  -- Verification = re-hash the target and compare. When no path is known
  -- for the owning project, or the target no longer resolves, sha is the
  -- fixed sentinel string "unverified" — never a fabricated hash, never a
  -- missing field.

transition   kind='transition'
  meta: { from_status, to_status, agent, note, sha, at }
  -- sha = sha256 over the canonical (sorted-key) JSON serialization of
  -- { issue_id: target_uid, from, to, agent_id: agent, note, at } — the
  -- same convention and helper (canonicalJSONStringify + sha256Hex) the
  -- audit sha below uses, applied identically rather than inventing a
  -- second scheme.

audit        kind='audit'
  meta: { actor, action, target_uid, from, to, note, sha, at }
  -- THE universal mutation record: every state-changing write emits exactly
  -- one audit node, inside the SAME transaction as the write it records.
  -- sha = sha256 over the canonical JSON serialization of
  -- { actor, action, target_uid, from, to, note, at }. action is a short verb
  -- like 'created' | 'claimed' | 'released' | 'renewed' | 'reclaimed-stale' |
  -- 'transitioned' | 'moved' | 'related' | 'unrelated' | 'deleted'.
```

## 5. Edge kinds (the fixed table)

```
owns_project    project    → component  (1:n)   -- project owns its components
owns_component  component  → issue      (1:n)   -- component owns its issues
has_kind        issue      → kind       (n:1)
has_status      issue      → status     (n:1)
has_priority    issue      → priority   (n:1)
authored_by     issue      → agent      (n:1)   -- notes/transitions/audits carry
                                                 -- their own agent in metadata instead
has_note        issue      → note       (1:n)
has_citation    issue      → citation   (1:n)
has_transition  issue      → transition (1:n)
audits          *          → audit      (1:n)   -- the one declared sentinel:
                                                 -- source_kind '*' (see below)
depends_on      component  → component  (n:m)   -- cross-project component dependency
has_location    component  → location   (1:n)
relates_to      issue      → issue      (n:m)
supersedes      issue      → issue      (n:1)   -- issue relation (lowercase);
                                                 -- distinct from the library's own
                                                 -- uppercase SUPERSEDES content rel (§1)
blocks          issue      → issue      (n:m)   -- inverse (blocked_by) is a
                                                 -- traversal-time derivation, never
                                                 -- a second stored edge kind
duplicate_of    issue      → issue      (n:1)
part_of         issue      → issue      (n:1)   -- split/rollup hierarchy
```

Every row above is a fixed, catalog-backed `edge_kind` entry (`name`,
`source_kind`, `target_kind`, `multiplicity`) — queryable and traversable
exactly like any other node, and enforced by the write layer, never by the
`TypePolicy` seam. `multiplicity` reads verbatim from this table: `n:1` caps
the SOURCE's out-degree at one for that `rel` (one target per source — e.g.
`has_kind`: an issue has exactly one `has_kind` edge); `1:n` caps the
TARGET's in-degree at one (one source per target — e.g. `owns_component`: an
issue has exactly one owning component); `n:m` is uncapped on both sides. The
write layer resolves the `edge_kind` row by `rel`, checks the resolved
endpoints and cardinality against it, and only then calls the injected
`TypePolicy` — a pure three-string predicate with no I/O.

`audits` is the one declared exception to "no polymorphic edge": its row
carries the sentinel `source_kind: '*'`, so the source-match step is skipped
for it alone — `target_kind` (`audit`) and `multiplicity` (`1:n`) are still
checked exactly like every other row. An audit's subject is identified by its
own `target_uid` metadata field, never by the edge's source kind; the edge
exists purely for traversal.

`relate`'s five closed rel values (`relates_to`, `supersedes`, `blocks`,
`duplicate_of`, `part_of`) hand-roll no multiplicity logic of their own — the
single-valued-rel rejection for `supersedes`/`duplicate_of`/`part_of` (all
three `n:1`) is this same generic `edge_kind.multiplicity` gate, applied to
those three rows.

## 6. Integrity rules (hard requirements)

1. **Every transition requires** an agent, a `note` (unless the owning
   project's policy sets `transitionRequiresNote: false`), and a `sha` — the
   write path rejects a transition missing the required fields.
2. **Every citation requires** a `sha` — sha256 of the cited content at
   citation time, or the fixed sentinel `"unverified"` when the content
   cannot be resolved. Verification = re-hash and compare.
3. **`uid` is the only identifier** — no legacy ids, no aliases, no mapping
   tables, no id derived from a string prefix or a repo/name composite.
4. **Closedness knob = `status.terminal`**; `issue.meta.metadata.closedAt` is
   stamped by the transition that moves status onto a terminal row, and
   cleared by a transition that moves it back off.
5. **Every state-changing write emits exactly one `audit` node**, in the same
   transaction as the write it records — automatic, never a call site's
   choice to skip it. A no-op call (e.g. `relate`'s `add` on an already-live
   edge, or `move` onto the issue's current placement) writes nothing and
   emits no audit, since nothing changed.
6. **Edge kinds are first-class, fixed catalog data** — extensible only by
   extending the fixed table in §5 (which requires a code change, since
   `relate`'s `rel` parameter is a closed union), never by an unvalidated
   caller-supplied rel name.

## 7. Registry (project / component / location)

`project` / `component` / `location` are a first-class, queryable navigation
index, not merely write-layer resolution targets — an agent's go-to for
"where does this live?" before it ever touches the filesystem or a search
index.

- **Resolution (`lookup`)** classifies a query string into one `locType`
  (`tool` when it has no `/` or scheme and matches a known MCP/CLI/symbol
  name; `url` when it parses as one; `path` otherwise, normalized to
  absolute via the project's own `path` when repo-relative), matches a
  `location` node by `(locType, normalized value)` — exact first, then a
  suffix/prefix fallback for repo-relative paths — and walks
  `has_location` → component → `owns_project` → project. The result is
  `{ project, component, location }`, plus a `hint` when only a
  project-level or path-prefix match exists — never a silent null.
- **CRUD** goes through the write layer's dedicated registry verbs:
  `upsertProject` (by `name`), `upsertComponent` (by `(project, name)`),
  `upsertLocation` (by `(component, locType, value)`), and `rmLocation` —
  never a hand-rolled scan or an implicit mint from an issue verb.

## 8. Projection & consumers

- `BACKLOG.md` / markdown is a pure, generated view: headers render the
  issue **title** (a readable label, not an identity map) — `uid`s are not
  rendered inline. A hand edit to the rendered file is overwritten on the
  next render.
- Citations render as `[target sha:…]` — the `sha` is part of the citation,
  visible and independently verifiable.
- CLI / MCP / HTTP address every entity by `uid` and filter by kind, status
  (including lifecycle via `terminal`), priority rank, component, project,
  and graph traversal (dependencies, relations, the registry chain in §7).
