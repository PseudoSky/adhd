# Backlog Data Model v2 — Proposed Specification

Status: PROPOSED — design for architect-decision review. Supersedes the identity
spine, entity, and relation model of SPEC.md §3 / DESIGN.md §2.1-2.2.

## 0. Design principles

1. **One identity, system-owned.** Every entity has a UUID primary key. No
   user-specifiable, composite, or derived identifiers anywhere. No legacy ids,
   no aliases, no mapping tables.
2. **Everything first-class is a catalog.** Node kinds, edge kinds, statuses,
   priorities, agents — all data, extensible without code, filterable in queries.
3. **Relationships are graph edges with typed kinds.** Membership, ownership,
   dependency, and issue relations live in the graph — never as string columns
   or FKs pretending to be structure.
4. **Every mutation is documented and content-addressed.** Transitions require
   agent + note + SHA; citations require SHA.
5. **First-class node and edge kinds are a designed capability of the store.**
   `@adhd/sox-graph-store` ≥0.6.0 ships an open-schema vocabulary: fresh-store
   `node.kind` / `edge.rel` are plain `TEXT` with an injectable application-level
   `TypePolicy` (`validateKind`/`validateRel`) enforcing the vocabulary on write
   (CAPABILITY-CATALOG.md:184). Older stores migrate via the operator-invoked,
   offline, verified-and-reversible `migrateToOpenSchema` path (PKT-61/BL-442,
   ADR-0010 D3). This model adopts that capability directly.

## 1. Graph substrate

- **Node kinds** and **edge kinds** are both catalog-backed, first-class,
  extensible-by-row values — the same support class.
- The domain `kind` and `edge_kind` catalogs (§2) are enforced by a
  `TypePolicy` injected at the write boundary, replacing the old closed-enum
  rejection behavior. Absent an injected policy the store's
  `DEFAULT_TYPE_POLICY` applies (the legacy six-kind / ten-rel vocabulary); the
  remodel injects its own catalog-backed policy.
- Existing stores that still carry the legacy SQL `CHECK (kind IN (...))` /
  `CHECK (rel IN (...))` enums are migrated once via `migrateToOpenSchema`
  (backup → rebuild → verify → rollback-on-failure; the skipDrop-interleaved
  sequencing reused from `ensureCheckConstraints()`).
- `migrateToOpenSchema` is a **one-time legacy-debt repayment** for the 0.5.x
  DDL that baked closed enums in; the remodel invokes it exactly once at
  migration time and it is then retired — fresh stores are open by default and
  never touch it. It is NOT part of the ongoing model.

## 2. Catalogs (extensible data, not code)

```
kind         (id uuid pk, name text unique, description text)
  -- node kinds: 'project', 'component', 'location', 'issue', 'agent'
  -- extensible: add a row, no code change

edge_kind    (id uuid pk, name text unique,
              source_kind_id fk -> kind.id, target_kind_id fk -> kind.id,
              multiplicity text,          -- '1:1' | '1:n' | 'n:m'
              description text)
  -- the edge-type catalog: queryable, filterable, extensible by row insert —
  -- the same first-class support as node kinds.

status       (id uuid pk, name text unique, terminal bool not null)
  -- terminal drives the closedness knob (open = non-terminal). No
  -- requires_reason / requires_citation columns: those were policy about
  -- actions, subsumed by the transition-documentation rule (§4).

priority     (id uuid pk, name text unique, rank int not null unique)
  -- a ranked table, not a bare number: extensible AND ordered.

agent        (id uuid pk, name text unique)
  -- who/what performed work: a human role, a tool, an agent id

-- per-project policy (projects are configurable; the defaults are the
-- global catalogs, and a project may narrow or tighten them):
project_field_requirement (project_id fk -> project.id, field text, required bool)
  -- which fields a project REQUIRES on its issues (e.g. body, priority,
  -- citation, plan). Default: none beyond title.
project_status   (project_id fk -> project.id, status_id fk -> status.id)
  -- the status vocabulary a project may use (empty = global default set).
project_kind     (project_id fk -> project.id, kind_id fk -> kind.id)
  -- the kinds a project may file (empty = global default set).
project_policy   (project_id fk -> project.id,
                  transition_requires_note bool,  -- default true
                  transition_requires_sha bool,   -- default true
                  citation_required bool,         -- default false
                  citation_requires_sha bool)     -- default true
  -- per-project tightening of the global integrity rules (§6). This is the
  -- configurable home of what used to be hardcoded terminal/citation/reason
  -- policy (BUG-037: a project can make DEFERRED terminal by adding it to
  -- its status vocabulary with terminal=true — data, not code).
```

## 3. Entities (graph nodes)

```
project      (id uuid pk, name text not null unique, created_at)
  -- was 'repo'. ONE canonical row per logical project; the old adhd /
  -- PseudoSky/adhd fork is reconciled to a single row at ETL time,
  -- permanently (no alias table).

component    (id uuid pk, name text not null)
  -- was projectPath / sub-area. Ownership is the OWNS edge from project
  -- (§5) — no project_id string column.

location     (id uuid pk, type text not null, value text not null)
  -- 0..n per component via the HAS_LOCATION edge. type ∈ {path, remote_url,
  -- url, filesystem_path}; the VALUE's interpretation is determined by type.

issue        (id uuid pk,
              kind_id fk -> kind.id,
              status_id fk -> status.id,
              priority_id fk -> priority.id,
              title text not null,
              body text,
              created_at, updated_at, closed_at)
  -- NO humanId. NO repo string. NO idOverride. NO importedFrom.
  -- Membership in a component is the OWNS edge, not a column.
  -- closed_at stamped by the transition that moves status to terminal.
```

## 4. Event/evidence tables (first-class rows, all content-addressed)

```
note         (id uuid pk, issue_id fk -> issue.id,
              author fk -> agent.id, text text not null, at)

citation     (id uuid pk, issue_id fk -> issue.id,
              target text not null, target_type text not null,  -- path | url
              sha text not null,        -- sha256 of the cited content at citation time
              line int, at)
  -- citations are content-addressed: verify by re-hashing the target and
  -- comparing. A changed file fails verification loudly.

transition   (id uuid pk, issue_id fk -> issue.id,
              from_status_id fk -> status.id, to_status_id fk -> status.id,
              agent_id fk -> agent.id,   -- REQUIRED
              note text not null,        -- REQUIRED: the agent + all action details
              sha text not null,         -- sha256 over the canonical transition record
              at)
  -- THE universal mutation rule: no transition exists without agent + note
  -- + sha. Enforced at the write path; there is no bare transition.
```

## 5. Edge kinds (the typed catalog — first-class, same as node kinds)

```
owns          project     → component     (1:n)   -- project owns its components
owns          component   → issue         (1:n)   -- component owns its issues
depends_on    component   → component     (n:m)   -- cross-project: proj1.cmp → proj2.cmp
has_location  component   → location      (1:n)
relates_to    issue       → issue         (n:m)
supersedes    issue       → issue         (1:n)
blocks        issue       → issue         (n:m)   -- traversable inverse: blocked_by
duplicate_of  issue       → issue         (1:n)
part_of       issue       → issue         (1:n)   -- split/rollup hierarchy
```

All edge kinds are rows in `edge_kind`, so visualization and queries are
data-driven: `getNeighbors(project) → owns → components → owns → issues`,
`depends_on` traversal across projects, relation traversal on issues. New edge
kinds = new rows (plus TypePolicy extension), no code.

## 6. Integrity rules (hard requirements)

1. **Every transition requires** `agent_id` + `note` (documenting the agent and
   all details of the actions performed) + `sha`. No exceptions; the write path
   rejects a transition missing any of the three.
2. **Every citation requires** `sha` (sha256 of the cited content at citation
   time). Verification = re-hash and compare.
3. **No humanId** anywhere — UUID is the only identifier; no legacy ids, no
   `legacy_ref`, no `repo_alias`, no `importedFrom`, no `idOverride`.
4. **Closedness knob** = `status.terminal`; `issue.closed_at` is stamped by the
   terminal transition.
5. **Edge kinds are first-class data** — extensible and filterable exactly like
   node kinds.

## 7. Projection & consumers

- `BACKLOG.md` / markdown: a pure view. Headers = issue **title** (a readable
  view, not an identity map); UUIDs are not rendered. Parity gate re-derived
  from the new model.
- Citations render as `[target sha:…]` — the SHA is part of the citation,
  visible and verifiable.
- CLI / MCP / HTTP: identity = UUID; filters by kind, status (incl. lifecycle
  via terminal), priority rank, component, project, and graph traversal
  (dependencies, relations).
- Web UI: list/detail/stats keyed by UUID; the stats views (priority matrix,
  citation heatmap, timelines) read the catalogs and edges directly.

## 8. Debt eliminated (the remap)

| Today | v2 |
|---|---|
| humanId + `(repo, humanId)` composite | UUID PK — DB-generated in the insert transaction |
| BUG-039 allocator race / silent write loss | DB-generated ids remove the ENTIRE provisioning machinery (no scan, no dedupe-scan-in-transaction, no collision) |
| dual-stored repo (`namespace` + metadata) + fork | single `project` row; ETL reconciles once |
| `importedFrom` / `idOverride` / `legacy-repo` / BL- ids | deleted; provenance = audit event; no legacy ids at all |
| kind derived from id prefix | `kind_id` column |
| `computeNextHumanId` / `allocateHumanIdAndInsert` / id-uniqueness machinery | deleted — the DB owns identity |
| terminal + requires_reason/citation in code | `status.terminal` + `project_policy` (data) |
| `reconcile_repo` / `migrateRepoItemNode` / `planRepoMigration` (repo-migration module) | deleted — edges + ETL; nothing to reconcile |
| MIGRATION.md phase-1..5 + `migration.phase` + `set_migration_phase` | retired — the ETL replaces the phase machinery |
| `repoWarning` ("repo X is new to this store") | deleted — projects are created via the project table, not implied by a string |
| markdown `import` admin action (the import lineage path) | retired — the ETL is the one-time import; export/render remain as projection |
| closedness knob special filter values (`filter.status: 'open'/'closed'`) | `status.terminal` — a real column, not magic filter words |
| `firstTerminalTransitionAt` / closedAt-from-audit reconstruction | stored `closed_at`; reconstruction used exactly once by the ETL, then deleted |
| `migrateToOpenSchema` | one-time legacy repayment for the 0.5.x closed-CHECK DDL, then retired |
| closedness knob in query code | `status.terminal` |

## 9. Migration path — FRESH WRITE (the same db file is never migrated)

**Directive:** the existing store file is NEVER modified, migrated in place, or
schema-surgeried. The data is READ from it (read-only, via its public API) and
WRITTEN FRESH into a brand-new db file with the v2 open schema. `migrateToOpenSchema`
is never invoked — a fresh file is open by default and the legacy closed-CHECK
DDL never exists in it. The old file is retained, untouched, as a read-only
legacy artifact (and the pre-migration backup).

0. **GATE — BUG-039 write-safety proof.** The distinct-family cross-process
   loss (observed 160/250, 246/250) was never root-caused; the hypothesis is
   that it is ALSO id-provisioning machinery (allocator + dedupe scans inside
   the write transaction under stale cross-process snapshots). DB-generated ids
   must PROVE it resolves: the v2 write path runs the cross-process harness
   (same-family AND distinct-family controls) clean before any migration
   proceeds. If it does not, the write/transaction path is fixed first —
   never write onto an unsafe write path.
1. **Backup** the old store (existing backup-manifest discipline), from a fully
   quiesced store.
2. **Create the fresh v2 file** with the open-schema DDL (§2-§5): catalogs
   (kind, edge_kind, status, priority, agent) seeded, project policy tables
   seeded from current defaults. No legacy CHECKs — they never exist here.
3. **ETL (read-old → write-fresh):** `repo`→`project` (fork reconciled;
   non-project repo strings like `global`/`scratch`/`legacy-repo` get an
   explicit decision — unmanaged bucket or project — never silently merged or
   dropped), `projectPath`→`component` (edge-wired), items→`issue`
   (kind/status/priority mapped to catalog rows, DB-generated id, `closed_at`
   derived once from audit), citations→rows with **sha computed from target
   content**, audit history→`transition`/`note` rows (agent + note + sha;
   historical transitions WITHOUT notes are recorded with the audit detail
   verbatim and flagged `note_synthesized` — never fabricated), project
   policies seeded, owns edges written (project→component→issue), old strings
   discarded.
4. **Parallel validation**: the fresh v2 store runs read-only beside the old
   store; parity checks (counts, closedness, citation sets, edge endpoints)
   must match before cutover.
5. **Consumers** (CLI/MCP/HTTP/web UI) switch to the v2 surface; old id-based
   references stop resolving by design. The old file remains as a read-only
   legacy artifact until a later, deliberate retirement.

## 10. Open points (for architect-decision)

1. **Citation sha on migration**: existing citations' target content may have
   changed since filing — migrate with sha of *current* content (verified at
   migration time, noted as such), or sha unknown → mark unverified?
2. **Transition sha semantics**: sha256 over the canonical serialization of
   `(issue_id, from, to, agent_id, note, at)` — confirm.
3. **Location typing**: `type` as a string enum vs another catalog table
   (`location_type`) — lean catalog, same first-class rationale.
4. **`blocks` inverse traversal** exposed as a first-class edge kind
   (`blocked_by`) or derived from `blocks` — lean derived, no second row.
5. **TypePolicy injection point**: how the remodel's catalog-backed policy is
   wired into `openGraphBacklogStore` (constructor option vs. post-open setter)
   — confirm the seam.
