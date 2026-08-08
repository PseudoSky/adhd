# Backlog Interface v2 — Consolidated 6-Tool Surface (Redesigned)

**Status:** DESIGN. Supersedes the prior INTERFACE_v2 mapping table (2026-07-30) and
the flat 38-command surface it mapped. This document is the contract an implementer
builds from; the prior version was a command-count consolidation without a query-layer
design, which is the layer this redesign centers.

**Grounding:** every capability below is verified against the live surface where noted:
`backlog --help` (38 commands), `entrypoint/backlog/src/store/query.ts` (real
`BacklogFilter` → `NodeFilter` mapping, `PRIORITY_RANK`, open/closed filter),
`entrypoint/backlog/src/model.ts:309` (`BacklogFilter` fields), RAG-SPEC.md §3.3
(semantic-search-behind-`listItems` seam), and design research 2026-08-08 (Linear
filing-time interception + projection discipline; Turso native vectors as the eventual
embedding substrate).

---

## 0. Design principles (the "why" — these are load-bearing, not decoration)

1. **Fewer tools is a feature, not a side effect.** 38 tools is a huge MCP/CLI surface
   for agents to discover and call; every tool an agent must consider costs context.
   36→6 is an 83% reduction. The consolidation is the *mechanism*; the *goal* is a
   surface an agent can hold in its head.
2. **Projection-first responses.** A read tool's default output is a terse card
   (id, title, status, priority) — never a full body. Full bodies and embedding blobs
   are opt-in via `fields`. (Live evidence: 36 items = 90KB of full bodies today; the
   context-blow is the tool's own fault, not the caller's.)
3. **Correct-by-construction reads.** Pagination must not silently truncate
   (BUG-003: ~145-row cap + misapplied offset). Filters must compose. A query that
   returns wrong data with no error is worse than a query that fails.
4. **Outcome-reporting mutations.** Every mutation returns what happened — created id,
   new status, changed fields, written edge — never bare `null`/`void` that is
   indistinguishable from silent failure (DEBT-BACKLOG-API-RETURN-VALUES-001,
   backlog-001).
5. **Semantic-ready surface.** The read surface is designed so keyword → hybrid →
   semantic is a *backend swap*, not a surface change. `grep` stays keyword; new
   `view:"similar"` and `sort:"relevance"` are the semantic hooks (RAG-SPEC §3.3
   upgrades the `listItems({grep})` call site behind an unchanged signature).
6. **Filing-time interception.** Creating a near-duplicate surfaces the canonical item
   with one action — do not file a duplicate silently (FEAT-013; Linear's modal
   pattern).
7. **Session context, where the transport allows it.** `repo`/`by` are implicit
   context where a transport actually has session state (a per-worktree CLI or an
   identified client). The MCP transport is stateless today — `by` is a required
   per-call parameter (`client.ts:170`) and there is no per-session identity channel.
   So: **`by` stays an explicit parameter** (the envelope requires it), and session
   context is an optimization for transports that can express it, never a removal of
   the explicit parameter. (See §9 Q5 — the open identity question.)

---

## 1. `backlog_get` — one item, deep context on demand

Maps: `get-item`, `audit-trail`, `blockers` (3 → 1).

```
backlog_get({ humanId, include?: string[], fields?: string[] })
```

- **Default:** terse card (`{ humanId, kind, title, status, priority, projectPath, updatedAt }`).
- `include: ["body"]` — full body. `include: ["audit_trail"]` — transition/claim event
  log (already persisted; audit-log.ts). `include: ["blockers"]` — dependency-blocked-by.
  `include: ["citations"]` — structured citations.
- **Outcome:** found → card (+ requested includes); not found → structured error
  distinguishing `not_found` / `ambiguous` (two live nodes share the humanId —
  `AmbiguousHumanIdError` already exists) / `soft_deleted` (BUG-BACKLOG-AUDIT-TRAIL-
  SOFTDELETE-001: audit history must remain reachable after soft-delete — note this
  requires a tombstone lookup path that the live store does not expose: `queryNodes`
  always filters `t_invalid IS NULL`, so the AC needs a new non-live query primitive,
  see §9).

**Why this shape:** one tool for "what is this item" instead of three entry points
that force the caller to know which depth it wants before looking. `include` is a
progressive-disclosure ladder, not a menu of separate tools.

---

## 2. `backlog_query` — the query layer (this is the design center)

Maps: `list-items`, `ready-items`, `spotlight`, `topo-order`, `dependency-graph`,
plus the *unbuilt* read features: aggregate/export (FEAT-010), group-bys (FEAT-007),
similarity (FEAT-011), projection (new) (6 → 1).

```
backlog_query({
  view: "list" | "ready" | "spotlight" | "topo" | "graph" | "summary" | "grouped" | "similar",
  filter?: BacklogFilter,
  fields?: string[],          // projection — default terse card
  sort?: "priority" | "updated" | "created" | "demand" | "relevance",
  limit?: number, offset?: number | cursor?: string,
  groupBy?: "kind" | "family" | "priority" | "status" | "projectPath" | "file",
  includeClosed?: boolean     // default false (non-terminal only)
})
```

### 2.1 Filter (the `BacklogFilter` contract — verified against model.ts:309)

All of the shipped fields stay and compose (AND semantics):
`repo, projectPath, status | "open" | "closed", kind, family, priority, plan,
assignee, claimedBy, tags[], grep, importedFrom, rootLevel, excludeArchived,
limit, offset` — plus the fields that land with their parent epics:

| Field | Lands with | Notes |
|---|---|---|
| `author`, `reporter` | FEAT-012 | graph nodes/edges; aggregate-by-reporter query is the point |
| `dupeHitsMin` | FEAT-013 | demand signal: "items re-filed ≥ N times" |
| `dateRange` (created/updated) | EPIC-B | currently absent; needed for "since last triage" |
| `semantic` (query string) | EPIC-G | routed to the embedding matcher; **not** `grep` — `grep` stays FTS keyword so semantic is additive |

**The behavioral fixes that are hard requirements (BUG-003 — mechanism corrected by
independent review 2026-08-08, verified against code):**

The stored bug's "~145-row cap" is a transport-level truncation, not a store cap:
`queryNodes` has no default limit (limit emitted only when `filter.limit !== undefined`),
and the only store-side cap is the grep path's `searchNodes(..., { limit: filter.limit ?? 1000 })`
(`query.ts:82-85`; `searchNodes`' own default is 50). The real defects are:

- **limit × post-filter composition:** `open`/`closed`, `rootLevel`, and
  `excludeArchived` are JS post-filters applied *after* limit/offset
  (`query.ts:39-43,53-71,100`). So `{ status: "open", limit: 145 }` silently returns
  fewer than 145, and `{ grep, status: "open", limit: 10 }` can return zero open items
  while open matches exist. **Fix:** these filters must push down to the store query
  (or the truncation must be surfaced, never silent). This is the correctness fix the
  query layer cannot ship without.
- **offset after FTS rank:** in the grep path, offset is a post-hoc `slice()` on the
  bm25-ranked list (`query.ts:83,87`) — which is the mechanism behind the observed
  `offset:145 → open-item #80`. **Fix:** `offset` must apply to the same ordering the
  results come from.
- **`{ total, returned }` needs an upstream primitive:** `searchNodes` has no `offset`
  parameter and `countNodes` takes a `NodeFilter`, not an FTS query. The total/offset
  contract for grep queries requires a `@adhd/sox-graph-store` change (unowned upstream;
  sequence with DEBT-SOX-001 / EPIC-F) or a documented full-fetch-then-slice with an
  explicit performance budget.
- `MAX_LIMIT` (1000) is a validation error, never a silent cap.

### 2.2 Views

| view | Returns | Maps to |
|---|---|---|
| `list` | terse cards | list-items |
| `ready` | items claimable now (no blockers, non-terminal, unclaimed) | ready-items |
| `spotlight` | priority-ranked actionable set (note: today's `spotlight` ranks by priority only — no unblocked check; unblocked is `ready`'s domain; keep the distinction) | spotlight |
| `topo` | topological order (note: today's `topoOrder` emits only an order — wave numbers are a NEW computation this view adds, not a shipped behavior) | topo-order |
| `graph` | dependency edges | dependency-graph |
| `summary` | **NEW (FEAT-010):** aggregate/export of transition history — per-status counts, per-item timelines, transition deltas over a date range; the "stats are uncomputable" gap closed. **Requires a window parameter, not just a filter:** `window?: { since, until, bucket: "day"|"week"|"month" }` emitting transition counts bucketed by period plus **median/p90 time-to-resolution and time-in-status** (FEAT-010's explicit metrics: cycle time, throughput over a window, reopen rate, aging distribution). **Constraint:** audit events only exist for activity since the audit-log fix landed — pre-existing items have no transition/claim history (DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001, owned here) | unbuilt → new |
| `grouped` | **NEW (FEAT-007):** `groupBy`-keyed buckets with counts and per-bucket item lists — "all HIGH items per family", "open bugs touching file X". Query-time bucketing only; persistent grouping is the rollup primitive (§5a) | unbuilt → new |
| `similar` | **NEW (FEAT-011):** top-k semantically similar items + score + overlap reason (shared files, shared citations). V1 can be FTS-overlap; the endpoint contract stays when the matcher becomes embeddings | unbuilt → new |

### 2.3 Sort + ranking

- `priority` (default): `PRIORITY_RANK` (CRITICAL < HIGH < MEDIUM < LOW) — verified in
  query.ts:14.
- `updated` / `created`: recency.
- `demand` (**NEW, FEAT-013**): the weighted dupe-counter score — duplicate-attempt
  count + important flags merged onto the canonical item. This is the automatic-
  prioritization surface: an item re-filed 5 times ranks above one filed once.
- `relevance` (**NEW, EPIC-G**): embedding similarity when the semantic layer lands.

### 2.4 Projection (the context-blow fix)

- Default `fields`: `[humanId, kind, title, status, priority]`. Everything else opt-in.
- **Embedding blobs are never in a default projection** (Linear's explicit lesson:
  "ensure the giant blob column is not being selected in queries unnecessarily").
- `view:"summary"`/`view:"grouped"` return aggregated shapes, not item bodies.

---

## 3. `backlog_create` — instantiation + filing-time interception

Maps: `create-item`, `split-item`, `supersede-item` (3 → 1).

```
backlog_create({ input, splitFrom?: humanId, supersedes?: humanId, reason?: string })
```

- **Filing-time interception (the design's flagship, FEAT-013):** before creating,
  run the dedupe scan (crud.ts:112 `dedupeScan`). If candidates are found:
  - Return `{ duplicateCandidates: [cards with scores], canonical }` and **do not
    create** unless the caller confirms (`confirm: true`).
  - One-action path: "file as comment on canonical" — converts the draft into an
    `append-note` on the canonical item and **increments its dupe counter**
    (idempotent under CAS; a confirmed re-file counts once).
- **Silent-drop guard (BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001, CRITICAL —
  mechanism corrected by review 2026-08-08):** the create path already returns
  `{ created: false, duplicateCandidates }` on both dedupe-suppression
  (`crud.ts:250-253`) and id-collision (`crud.ts:242-248`), and content-hash collapse
  is structurally impossible for item nodes (per-repo/humanId uniqueness marker in
  `buildNodeContent`, `mapping.ts:135-137`). The *actual* silent-drop paths are
  **`splitItemNode`** (discards the `created` flag and reports the canonical item as
  if created — `structure.ts:142-144`) and **`supersedeItemNode`** (skips the dedupe
  scan entirely — `structure.ts:89-121`). The guard must enforce interception at the
  OP layer for split/supersede, not just create. The return contract is
  `{ ok, created: boolean, humanId?, duplicateCandidates?, reason? }`.
- `supersede-item` and `split-item` are create-variants — same interception rules.

---

## 4. `backlog_update` — all mutations

Maps: `update-item`, `transition-status`, `resolve-item`, `set-priority`, `assign-item`,
`start-work`, `claim-item`, `release-claim`, `renew-claim`, `append-note`,
`add-citation`, `soft-delete-item` (12 → 1).

```
backlog_update({ humanId, patch?, status?, claim?: "claim"|"release"|"renew",
                 assignedTo?, addNote?, addCitation?, softDeleteReason? })
```

- **Outcome contract (DEBT-API-RETURN-VALUES + backlog-001):** every mutation returns
  `{ ok, humanId, changed: [...fields], newStatus?, claimState?, noteId?, edge? }`.
  `link_related`-style void success is abolished — a mutation either reports its
  effect or errors.
- **`by`/identity comes from session context** — never a per-call parameter.
- **repo mutation** (DEBT-BACKLOG-REPO-MOVE-001): `patch: { repo }` becomes legal once
  repo is a graph node (EPIC-A); until then the tool rejects it with a clear
  `unsupported` error rather than pretending.

---

## 5. `backlog_relate` — graph edges

Maps: `add-dependency`, `remove-dependency`, `link-related`, `attach-to-plan` (4 → 1).

```
backlog_relate({ sourceId, targetId, relation: "dependency"|"related"|"plan",
                 action: "add"|"remove" })
```

- Returns the written/removed edge `{ from, to, rel, action }` — outcome-reporting
  (fixes backlog-001: `link_related` returned `{result:null}` with no way to know).
- With EPIC-A: `relation` widens to repo/project edges (repo→project, repo→repo deps).

---

## 5a. Grouping / task-packet primitive (FEAT-005 — owner-requested 2026-08-08)

**"A packet is not a new concept. A packet is an item that has children."** The
owner's design thesis, absorbed wholesale: title/body/acceptance/dependencies/children
is an epic, and the tool already models `requires:` (dependency), `blockers`,
`topo_order`, `ready_items`, and parent/child (`split-item`). The real gap is two
capabilities, one optional, plus one explicit refusal.

### 5a.1 Two-axis rollup on read (FEAT-005 Stage 1)

Any item with children exposes a **computed** rollup (derived at read time, never
materialized — materializing recreates the drift problem):

```
rollup: { childrenTotal: 3, childrenClosed: 3, childrenOpen: [],
          selfVerified: false }     // does this item carry its OWN closing evidence?
```

Two axes, not one — a single boolean cannot express "not started" vs "shipped,
nobody transitioned it" (the consumer had 7/28 packets in exactly that invisible
state) or the inverse (children closed, parent's acceptance unmet). The four
combinations are all meaningful. **Derive on read; closing a child changes the
parent's rollup with no write to the parent.**

### 5a.2 Evidence-gated terminal transitions (FEAT-005 Stage 2 — highest value, cheapest)

`backlog_update` refuses a transition to a terminal status (`RESOLVED`/`DONE`/
`FIXED`/`SHIPPED`/`VERIFIED`) unless the item carries **at least one citation**.
Opt-in per repo; a **typed error**, not a silent drop. Encodes the consumer's
governing rule ("a status marker records a verified outcome, never an inference")
into the tool instead of prose agents are asked to remember.

### 5a.3 Optional `files` + overlap query (FEAT-005 Stage 3 — lowest confidence)

Optional `files: string[]` on an item, plus `backlog_query({ view: "overlap",
humanIds: [...] })` returning pairwise intersections. **An input to wave selection,
not a scheduler** — the tool reports declared overlap; it never reads the
filesystem, never chooses the wave.

### 5a.4 Explicitly NOT modeled (the refusal)

Waves (ephemeral dispatch decisions — persist nothing), tier/turn budgets
(free `tags`/metadata at most), acceptance clauses as structured data (body text),
markdown regeneration (ADR-0011 killed the split-brain; don't rebuild it). The
interface exposes the *inputs* (`ready_items`, `topo_order`, `overlap`); the
orchestrator decides.

### 5a.5 Mapping

- Rollup → `backlog_get({ include: ["rollup"] })` **and** `rollup` as a projected
  field in `backlog_query` list views (computed per item on read) — a plan overview
  needs all children's rollups in one call, not N single-item calls. `backlog_query(
  { view: "list", filter: { plan: "PLAN-001" }, fields: [..., "rollup"] })`.
- Plan grouping axis → `filter: { plan }` (attach-to-plan) for "everything in this
  plan" queries; the plan parent itself is an item, so `plan` is a query filter, not
  a special type.
- Evidence gate → `backlog_update` validation, per-repo opt-in.
- Overlap → `backlog_query({ view: "overlap" })`.
- Parent/child → already `backlog_create({ splitFrom, children })`.

### 5a.6 The resumable-plan workflow (how the pieces compose)

The canonical medium-size plan flow, all on the 6-tool surface, no new primitives:
create plan parent → `splitFrom` into work items → `relate` dependency edges →
`query view:"ready"` for the dispatchable set → `query view:"overlap"` for the
file-collision check → `update {claim}` + work + `update {status, addCitation}`
(evidence gate) → **resume with one `get {include:["rollup","audit_trail"]}`** →
close parent with its own citation → `query view:"summary"` for the retrospective.
Waves/turn-budgets stay in the orchestrator (refused by design, §5a.4); the plan
structure is durable in the graph, the dispatch is ephemeral.

---

## 6. `backlog_admin` — bulk, maintenance, system

Maps: `archive-resolved`, `export-json`, `import-from-markdown`, `render-to-markdown`,
`merge-items`, `migration-status`, `set-migration-phase`, `stale-claims`, `stats` (9),
PLUS the three unmapped live commands `version`, `skill`, `batch` (spec gap — live CLI
has 38 commands, the 07-30 spec mapped 36), PLUS `doctor` (FEAT-008) and `prune`
(FEAT-009) (9 → 1).

```
backlog_admin({ action: "archive"|"export"|"import"|"render"|"merge"|"stats"|
                        "migration_status"|"set_migration_phase"|"stale_claims"|
                        "version"|"skill"|"batch"|"doctor"|"prune",
                params? })
```

- `batch` is the apigen-plugin-batch mount (`_batch/action`) given a discoverable home
  (BUG-BACKLOG-BATCH-CLI-001 — the current surface is undocumented; every natural
  invocation fails with exit 2/4). `params: { operation, items[], concurrency?,
  mode?, onItemError?, itemTimeoutMs? }` — the documented JSON-blob convention applies.
- `skill` (install-skill) and `version` get first-class entries (both shipped, both
  invisible — BUG-BACKLOG-001 was exactly this class, resolved).
- `doctor` (FEAT-008) and `prune` (FEAT-009) land as maintenance actions.

**Host-command carve-out (review finding R5, verified against cli.ts:243-265):**
`install-skill`/`install` and `serve` are special-cased in the CLI *before* the apigen
command table — `install-skill`/`install` are pure filesystem/config operations that
must NEVER open the store (cli.ts:243-256), and `serve` starts a long-lived HTTP/MCP
listener with a different lifecycle (cli.ts:262-265). These are **not** data ops and
must NOT be routed through `backlog_admin` (a data tool with lazy store opening).
They are explicitly outside the 6-tool surface: `install`/`install-skill` remain host
commands, and `serve` remains a launcher. The 6-tool surface is a *data* surface; the
absorption claim "38 → 6" counts only data ops. This carve-out is a stated
non-absorption, not an oversight.

---

## 7. Cross-cutting contracts (the teeth)

1. **Response envelope:** every tool returns `{ ok: boolean, data?, error?: { code,
   message, details? } }`. No bare `null`/`void` success anywhere. Error codes:
   `not_found`, `ambiguous`, `invalid_argument`, `duplicate_candidate`,
   `dedupe_suppressed`, `unsupported`, `store_busy`, `validation`, `soft_deleted`.
2. **Exit codes (CLI):** preserved and documented — 0 success, 2 bad flag, 4 unknown
   command (verified against the live bin).
3. **Projection discipline:** read tools default to terse cards; bodies and embedding
   blobs are opt-in via `fields`. Default card shape is uniform across tools
   (`humanId, kind, title, status, priority` — §2.4; `backlog_get` adds `projectPath,
   updatedAt` as its single-item affordance, stated not implied).
4. **Pagination:** `MAX_LIMIT` explicit; `offset` applied to result ordering;
   `{ total, returned }` in the response envelope. **Upstream dependency (R3):**
   `searchNodes` has no `offset` param and `countNodes` takes a `NodeFilter`, not an
   FTS query — the grep-path total/offset contract requires a `@adhd/sox-graph-store`
   change, sequenced with DEBT-SOX-001/EPIC-F. Without it, grep queries degrade to
   documented full-fetch-then-slice with a performance budget.
5. **Session context:** `by` stays an explicit parameter on mutations (MCP is
   stateless — see §0.7 and §9 Q5); `repo` likewise stays explicit until EPIC-A's
   repo-node lands. Session-context optimization applies only where the transport
   has real session state.
6. **Semantic seam:** `filter.grep` = keyword/FTS (unchanged semantics). New
   `filter.semantic`, `view:"similar"`, `sort:"relevance"` route to the embedding
   matcher when EPIC-G lands. The surface never changes shape at the swap.
7. **CLI stdout shape change is a breaking migration, not an implementation detail:**
   today the CLI prints the raw JSON result via apigen-plugin-cli-output; the envelope
   wraps that. Every script parsing `backlog list-items` output breaks. This is part of
   the backward-compat question (§9 Q4) and must be enumerated in the migration plan:
   SKILL.md (the only documented surface, 36 commands), the three spec suites
   (`cli.spec.ts`, `server.mcp.spec.ts`, `install.e2e.spec.ts`), parity scripts, and
   this repo's AGENTS.md Disclosure section all hard-code flat names.

---

## 8. What this absorbs (ticket → AC mapping)

| Ticket | Under this design |
|---|---|
| FEAT-BACKLOG-003 (flag conventions) | AC: all six tools follow the documented convention |
| BUG-BACKLOG-BATCH-CLI-001 | AC: `backlog_admin({action:"batch"})` discoverable + documented |
| BUG-BACKLOG-NO-COMMAND-LEVEL-TESTS-001 | AC: every tool driven through the real server by tests |
| DEBT-BACKLOG-API-RETURN-VALUES + backlog-001 | AC: outcome envelope on every mutation |
| BUG-BACKLOG-MCP-NOT-LOADABLE-001 | AC: all six load in a fresh session (rename invalidates old evidence) |
| DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001 | **Already RESOLVED in code** (cli.ts lazy `getCtx`, never opens store for `--help`/no-args — verified 2026-08-08); retained as a regression AC, not a fix |
| BUG-BACKLOG-003 (pagination) | AC: §2.1 pagination contract (composition fix + offset ordering + total/returned; the ~145 cap is transport-level, the real bugs are limit×post-filter and offset-after-rank) |
| DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001 | AC: `view:"summary"` must own the partial-history constraint (audit events only exist post-fix; pre-existing items have no history) |
| FEAT-010 (aggregate/export) | AC: `view:"summary"` with `window` param (since/until/bucket) + median/p90 time-to-resolution + time-in-status |
| FEAT-005 (grouping primitive) | AC: §5a — two-axis rollup, evidence-gated terminal transitions, `files`/`overlap` |
| FEAT-007 (group-bys) | AC: `view:"grouped"` + `groupBy` |
| FEAT-013 (dupe counter) | AC: `sort:"demand"`, `filter.dupeHitsMin`, create-flow interception |
| FEAT-012 (author/reporter) | AC: filter fields + aggregate-by-reporter + session context |
| FEAT-011 (usefulness) | AC: `view:"similar"` + semantic seam |
| FEAT-008 (doctor), FEAT-009 (prune) | AC: `backlog_admin` actions |
| BUG-AUDIT-TRAIL-SOFTDELETE | AC: `backlog_get` include ladder reaches soft-deleted history |
| DEBT-REPO-MOVE (repo mutation) | AC: `patch.repo` once EPIC-A lands |

**Not absorbed (stays separate):** BUG-APIGEN-058 (IR cache — apigen layer), the
embedding substrate itself (EPIC-G), the repo/project node model (EPIC-A),
`install`/`install-skill`/`serve` (host commands — see §6 carve-out).
Note: the CRITICAL silent-drop class is absorbed as the §3 OP-layer interception
guard (split/supersede, not just create); `computeNextHumanId` stays EPIC-A.

---

## 9. Open design questions (flagged, not silently decided)

1. **Cursor vs offset pagination** — restated around the real constraint: the grep
   path has no `offset` primitive upstream (`searchNodes`), so the offset-vs-cursor
   choice is entangled with the graph-store change in §7.4 (R3). If EPIC-F lands the
   graph-store upgrade, cursor becomes viable; until then offset with documented
   full-fetch-then-slice. Do not decide cursor before the upstream question is settled.
2. **`view:"similar"` v1 matcher** — FTS-overlap (ships now) vs sox-analysis
   `detectNearDupPairs` (needs the vector layer). V1 endpoint contract is fixed; the
   matcher is swappable.
3. **`sort:"demand"` weighting** — exact weights for dupeHits vs priority vs recency
   are a tuning decision; the surface ships with a documented default, tunable later.
4. **Backward compat window (MUST be resolved, not deferred)** — flat names
   (`backlog_list_items`) get a documented deprecation path or a compat alias during
   the migration. The breakage surface must be enumerated first: SKILL.md (the only
   documented surface, 36 commands), `cli.spec.ts`/`server.mcp.spec.ts`/
   `install.e2e.spec.ts` (spawned-binary + real-MCP tests naming `backlog_client_d_*`),
   parity scripts, AGENTS.md Disclosure section (names `backlog_create_item`/
   `backlog_list_items`/`mcp__backlog__*`), AND the CLI stdout shape change (§7.7).
   The window length is an operator call; the enumeration is not optional.
5. **Session identity (MUST be resolved — R6, blocks principle 7 and the
   `backlog_update` signature as written)** — how does `by`/`repo` come from "session
   context" when the MCP transport is stateless and `by` is today a required per-call
   param (`client.ts:170-183`)? Options: keep `by` explicit everywhere (chosen in §0.7
   for now); add an identify-yourself tool; or define transport-level session state.
   This is the biggest unowned question in the design.
6. **Admin authorization** — `backlog_admin` bundles `set_migration_phase`
   ("admin-only" by convention, SKILL.md) with merge/prune/import/soft-delete, and MCP
   exposes all tools equally. What is the gate? (Today: none beyond convention.)
7. **Soft-deleted tombstone lookup** — `queryNodes` always filters `t_invalid IS NULL`
   (sox-graph-store index.ts:787-789,1174), so `backlog_get`'s soft-deleted
   audit-reachability AC needs a new non-live query path (raw-SQL escape-hatch
   precedent exists at crud.ts:373-375).
8. **Filter/limit composition semantics** — where do `open`/`closed`/`rootLevel`/
   `excludeArchived` post-filters move (store push-down vs documented truncation) once
   the query layer owns correctness? (R2 — the fix direction is set; the mechanism
   needs a home.)
