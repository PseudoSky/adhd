# Backlog Interface v2 — Consolidated 6-Tool Surface (Redesigned)

**Status:** DESIGN. Supersedes the prior INTERFACE_v2 mapping table (2026-07-30) and
the flat 38-command surface it mapped. This document is the contract an implementer
builds from; the prior version was a command-count consolidation without a query-layer
design, which is the layer this redesign centers.

**Grounding:** every capability below is verified against the live surface where noted:
`backlog --help` (38 commands), `entrypoint/backlog/src/store/query.ts` (real
`BacklogFilter` → `NodeFilter` mapping, `PRIORITY_RANK`, open/closed filter),
`entrypoint/backlog/src/model.ts:309` (`BacklogFilter` fields), RAG-SPEC.md §3.3
(semantic-search-behind-`listItems` seam), PLUGIN_ARCHITECTURE.md (embedding via the
sox-owned embedding service), GRAPH_MODEL_v2.md (dimensional filter surface), and
design research 2026-08-08 (Linear filing-time interception + projection discipline;
Turso native vectors as the embedding substrate).

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
   the explicit parameter. (See §9 Q5 — resolved: `by` is explicit on all mutations.)

---

## 1. `backlog_get` — one item, deep context on demand

Maps: `get-item`, `audit-trail`, `blockers` (3 → 1).

```
backlog_get({ humanId, fields?: string[] })
```

- **Default:** terse card (`{ humanId, kind, title, status, priority, projectPath, updatedAt }`).
- `fields` is the **one projection mechanism for every read tool** (§2.4/§7.3). Pseudo-fields
  in the `fields` vocabulary: `body` (full body), `audit_trail` (transition/claim event log —
  already persisted; audit-log.ts), `blockers` (dependency-blocked-by), `citations` (structured
  citations), `rollup` (per-item two-axis derivation, §5a.5). There is no separate `include`
  ladder — `backlog_get({ humanId, fields: ["humanId","title","body","audit_trail"] })` and
  `backlog_query`'s `fields` speak the same grammar.
- **Outcome:** found → card (+ requested fields); not found → `{ ok: false, error: { code:
  "item_not_found" } }` with exit code 1 (never `ok:true, data:null` — see §7.2/AC-6);
  `ambiguous` (two live nodes share the humanId — `AmbiguousHumanIdError` already exists);
  `soft_deleted` (BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001: audit history must remain
  reachable after soft-delete — `getNode(id)` already reads `t_invalid` rows
  unconditionally (graph-store index.ts:1168-1171) and `auditTrail` already uses it
  (query.ts:254); the real gap is only resolving `(repo, humanId)` → nodeId without the
  live-only `queryNodes` filter — a smaller primitive than a full non-live query path,
  see §9).

**Why this shape:** one tool for "what is this item" instead of three entry points
that force the caller to know which depth it wants before looking. `fields` is a
progressive-disclosure vocabulary, not a menu of separate tools — and one vocabulary
across every read tool, so an agent learns projection once.

---

## 2. `backlog_query` — the query layer (this is the design center)

Maps: `list-items`, `ready-items`, `topo-order`, `dependency-graph`,
plus the *unbuilt* read features: aggregate/export (FEAT-010), group-bys (FEAT-007),
similarity (FEAT-011), projection (new) (6 → 1).

```
backlog_query({
  view: "list" | "ready" | "order" | "graph" | "stale" | "summary" | "grouped" | "similar" | "plan" | "overlap",
  filter?: BacklogFilter,
  fields?: string[],          // projection — default terse card; same vocabulary as backlog_get
  sort?: "priority" | "updated" | "created" | "demand" | "relevance",
  limit?: number, offset?: number | cursor?: string,
  groupBy?: "kind" | "family" | "priority" | "status" | "projectPath" | "file"
         | "repo" | "author" | "reporter" | "project" | "packagePath" | "plan" | "assignee",
  // Flag sugar (§2.1a) — each compiles into `filter`; JSON stays for compound queries:
  repo?: string, author?: string, reporter?: string, kind?: string, status?: string,
  since?: string,            // ISO or "today"|"yesterday"|"3d" → filter.dateRange.updated.since
  format?: "json" | "table", // table for humans on summary/grouped/plan; default json
  humanIds?: string[],       // view:"overlap" payload — the set to compute pairwise intersections over (§5a.3)
  overlapBy?: "file" | "project" | "package" | "author",  // view:"overlap" axis (default "file"); NOT the actor `by` — see C5/§5a.3
  text?: string              // natural-language query (also the CLI positional form) — §2.1b
})
```

- `view` has **no `spotlight`** — `view:list` with default sort (`priority`, non-terminal
  only) is exactly today's spotlight semantics (§2.3); `view:ready` (unblocked + unclaimed)
  remains the distinct "work next" view. `order` (renamed from `topo` — the word means
  nothing to a new user) returns the topological order with wave numbers. `stale` returns
  items with claims older than the lease window (the stale-claims read, moved out of
  admin — see §6). 10 views total.
- **One closedness knob:** `status` is the single selector — `"open" | "closed" | "all" |
  <specific status>` (default `"open"`). There is no `includeClosed`; the two-knob
  composition (`{status:"closed", includeClosed:true}`) is undefined and abolished.
- **Time boundaries are one grammar** (F7): there is no top-level `since` and no
  `window.since` — every time-boundary query uses `filter.dateRange` (§2.1), and
  `view:summary` / `view:plan` read `filter.dateRange.updated` for their windows. The plan
  view additionally returns an `asOf` checkpoint token (§2.2) so a resuming agent passes a
  token, never a hand-persisted timestamp.
- `groupBy` accepts the **dimensional axes** (repo, author, reporter, project, packagePath,
  plan, assignee) in addition to the classic fields — aggregate-by-reporter is a first-class
  grouping, not an afterthought. `file` groups by the optional `files[]` field (§5a.3); it is
  a files-backed axis — empty groups when items carry no `files`.

### 2.1a Flag sugar (the ergonomics fix)

Single-key filters are the 80% case and should not require quoting JSON in a shell. The
flag forms **compile into `filter`** — one grammar, two spellings:

- `--repo X --author Z --status open --kind BUG` → `filter: { repo: "X", author: "Z", status: "open", kind: "BUG" }`.
- `--since yesterday` → `filter.dateRange.updated.since` with natural-language dates
  (`today`, `yesterday`, `Nd` = N days ago) resolved to ISO server-side.
- Unknown flag / unknown filter key → `validation` error (exit 2) — **never a silent no-op**.
- JSON `--filter` remains for compound/nested queries; the two forms merge (flags AND JSON).

**The agent-error trap is closed:** `view`, `sort`, `groupBy` are top-level parameters, and
putting them *inside* `--filter` (e.g. `--filter '{"view":"list"}'`) is a targeted
`invalid_argument` naming the stray keys — never a silent pass.

### 2.1b Natural-language query (`text` / the positional form)

The single most common ask — "show me what's relevant" — gets a first-class surface:

```
backlog query "nx bugs and apigen"
backlog query --text "nx bugs and apigen"          // same, explicit
backlog query "what changed since yesterday"       // time expressions compile too
```

The positional/`text` form is **semantic search first, planner refinement second** —
it is NOT a parser that strips the string into filters. The **entire string is the
semantic query** (paraphrase-aware, the full natural language goes to the embedding
matcher when configured), and the query planner runs **alongside** it, layering
extraction on top — never subtracting from it:

1. **Semantic channel (the primary surface):** the whole string routes to the
   embedding matcher (`semanticSearch` / `filter.semantic`), so `"nx bugs and
   apigen"` finds items that *mean* the same thing even when they use different
   words. Without embeddings configured, the whole string falls back to FTS (`grep`)
   — the planner never requires EPIC-G to function.
2. **Unscoped by default — cross-repo recall is the contract.** The positional form
   searches **every repo, every project** unless the caller explicitly scopes with
   flag sugar (`--repo X`, `--package Y`). Dimensional extraction NEVER narrows the
   semantic recall implicitly: an item about apigen work living in the `adhd` repo
   must rank even when the query contains "apigen" and `adhd` is not the extracted
   package. The only way to scope is to say so — explicit flags are the only filters.
3. **Dimensional extraction = ranking signals + surfaced suggestions, not filters.**
   Known vocabulary resolved against the graph (repo names, project keys, package
   paths, kind words, status words, plan slugs) becomes **boosts** to the semantic
   score and is listed in `data.query.extracted` as `{ term, type, confidence,
   applied: "boost" }` — the user sees every guess and can escalate any of them to a
   filter with a flag. Unambiguous *structural* words (status words like "done",
   kind words like "bug") MAY become filters — but always surfaced in `data.query`,
   never silent.
4. **Time expressions** — `"since yesterday"`, `"last week"` → `filter.dateRange`.
5. **Ranking** — `sort: "relevance"` (semantic) when embeddings are configured, with
   extracted dimensions contributing as boosts; `priority` as the FTS fallback.
6. **Transparency** — the compiled plan is returned in the envelope as
   `data.query: { semantic, filter, boosts, extracted: [...] }`, so an agent or human
   sees exactly what the string became (the full semantic query AND the refinements —
   including what was NOT filtered) and can correct either. Ambiguous extractions
   surface in `warnings` (§7.1) — never silent.

**Pure semantic search stays explicit.** `view:"similar"` + `filter.semantic` (or
`filter.anchor`) is the raw vector-recall surface with no extraction layer — for
callers who want candidates + scores + overlap reasons, not refined results. The two
are documented, distinct paths: the positional form is "give me what's relevant",
`view:similar` is "show me what's like this".

**Parity:** the positional form's *refined* result must be reproducible — the same
`data.query` re-run as the explicit `view:list` + filter + semantic composes to the
same items (AC-27). The semantic channel is the full string in both spellings; the
planner's boosts/refinements are what differ between the two forms.

### 2.1 Filter (the `BacklogFilter` contract — verified against model.ts:309)

All of the shipped fields stay and compose (AND semantics):
`repo, projectPath, status | "open" | "closed", kind, family, priority, plan,
assignee, claimedBy, tags[], grep, importedFrom, rootLevel, excludeArchived,
limit, offset` — plus the fields that land with their parent epics:

| Field | Lands with | Notes |
|---|---|---|
| `author`, `reporter` | FEAT-012 | graph nodes/edges; aggregate-by-reporter query is the point |
| `dupeHitsMin` | FEAT-013 | demand signal: "items re-filed ≥ N times" |
| `dateRange` (`{ created?: { since, until }, updated?: { since, until } }`) | **query layer** | the ONE time-boundary grammar for the whole surface — "since last triage", `view:summary` windows, `view:plan` delta all read it. Not deferred. **Mechanism (owned, not implied):** the `created` axis maps to the existing `NodeFilter.tCreatedAfter/tCreatedBefore` (graph-store index.ts:509-529); the **`updated` axis requires an upstream `NodeFilter.tUpdatedAfter/tUpdatedBefore` predicate**, added in EPIC-F co-located with the R3 `searchNodes`-offset change (the design already owns an upstream touch). Until EPIC-F lands it, `dimensional.ts` specifies a raw-SQL range predicate over the `t_updated` column (index.ts:87,1127) — the spec names the mechanism, not an implicit gap |
| `semantic` (query string) | EPIC-G | routed to the embedding matcher; **not** `grep` — `grep` stays FTS keyword so semantic is additive |
| `anchor` (humanId) | EPIC-G | item-anchored similarity: `view:"similar"` with `filter.anchor` returns items like the referenced item (nearest neighbor to its vector) — "what's like BUG-42" without pasting its title into `semantic` |
| `hasAcceptanceCriteria` / `missingAcceptanceCriteria` | **query layer** | §5a.7 — acceptance-criteria *presence* filter (a recognized body-section convention or `metadata.criteria`); never parses clause content |
| `missingCitation` | **query layer** | §5a.7 — items with zero citations (the read-side mirror of the §5a.2 evidence gate) |

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
| `list` | terse cards, priority-sorted non-terminal by default | list-items |
| `ready` | items claimable now (no blockers, non-terminal, unclaimed) | ready-items |
| `order` | topological order + wave numbers (renamed from `topo` — same computation) | topo-order |
| `graph` | dependency edges | dependency-graph |
| `stale` | items whose claims are older than the lease window (the stale-claims read, moved out of admin — a filter preset over claim age) | stale-claims |
| `summary` | **NEW (FEAT-010):** aggregate/export of transition history — per-status counts, per-item timelines, transition deltas over a date range; the "stats are uncomputable" gap closed. Window comes from `filter.dateRange.updated` (default: last 30 days, `bucket` defaults `"day"`). Emits transition counts bucketed by period plus **median/p90 time-to-resolution and time-in-status** (cycle time, throughput over a window, reopen rate, aging distribution). **Always carries `coverage: { itemsWithHistory, itemsTotal, auditWindowStart }`** — partial audit history (pre-fix items have no transition/claim history, DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001) is visible, never silent. Absorbs v1 `admin:stats` — one "how many X" surface | unbuilt → new |
| `grouped` | **NEW (FEAT-007):** `groupBy`-keyed buckets. Default shape: counts-only `{ buckets: [{ key, count }] }`; per-bucket item lists opt-in via `fields: ["items"]`. "all HIGH items per family", "open bugs per reporter". Query-time bucketing only; persistent grouping is the rollup primitive (§5a) | unbuilt → new |
| `similar` | **NEW (FEAT-011):** top-k semantically similar items + score + overlap reason (shared files, shared citations). Two anchors: `filter.semantic` (free-text query) or `filter.anchor` (item-anchored — nearest neighbor to that item's vector). V1 can be FTS-overlap; the endpoint contract stays when the matcher becomes embeddings | unbuilt → new |
| `plan` | **NEW (FEAT-015):** the native resume surface. One call answers "pick up where I left off": plan card + two-axis rollup, ready set, blocked set (with which dep), **delta since `filter.dateRange.updated.since`** (audit events after a timestamp — the session-boundary primitive), **needs-human set derived from existing state** (non-terminal, unclaimed items blocked on nothing external — i.e. awaiting outside input; `awaiting_input`/`open_question` statuses become *additional* members when EPIC-B adds them), **and `myClaims`** (items the caller holds, when `filter.claimedBy` is passed — an interrupted agent's own in-progress work is visible in the resume call, never requiring a second query). **Returns `asOf: <token>`** — a checkpoint the resuming agent passes back as `filter.dateRange.updated.since` on the next call, so the timestamp is tool-native, never a hand-persisted ledger entry. Pure read composition over rollup + ready + order + audit-window + status filter — no new storage | unbuilt → new |
| `overlap` | **NEW (FEAT-005 Stage 3):** pairwise `files[]` intersections for a set of humanIds — `humanIds: [...]` — the wave-selection collision check. An input to wave selection, not a scheduler (§5a.3) | unbuilt → new |

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
backlog_create({ input, splitFrom?: humanId, children?: CreateItemInput[], supersedes?: humanId, reason?: string, duplicateAction?: "abort" | "file" | "comment" })
```

- **Filing-time interception (the design's flagship, FEAT-013):** before creating,
  run the dedupe scan (crud.ts:112 `dedupeScan`). If candidates are found:
  - Return `{ duplicateCandidates: [cards with scores], canonical }` and **do not
    create** — unless the caller chooses explicitly via `duplicateAction`.
  - `duplicateAction: "abort"` (default) — refuse the create, return the candidates.
  - `duplicateAction: "file"` — confirmed re-file (idempotent under CAS; counts once).
  - `duplicateAction: "comment"` — the one-action path: converts the draft into an
    `append-note` on the canonical item and **increments its dupe counter**.
  - The switch is named in the signature, so an agent can choose discoverably —
    never a guessed `confirm` boolean. Interception is active on batch/import too,
    with the same per-item `duplicateAction`; a migration/backfill run may pass
    `duplicateAction: "file"` to bypass interception deliberately.
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
- `supersede-item` and `split-item` are create-variants — same interception rules
  and the same `duplicateAction` switch; `children` is the split-item payload
  (each child is a real `CreateItemInput`).

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
- **`by`/identity is an explicit parameter on mutations** — MCP transports are stateless,
  so `by` stays a per-call parameter (a required `by: string` on `backlog_update` /
  `backlog_create` / `backlog_relate`; session-aware transports may elide it via a
  documented transport-level identity, §0.7). An unattributed mutation is rejected
  with `invalid_argument`, never silently stamped.
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
**Default ON, opt-out per repo** — this is a *continuation* of the v1 rule (v1
already enforces `requiresCitation` unconditionally: model.ts:75, lifecycle.ts:65),
not a new opt-in feature; the design must not silently weaken an existing mandatory
gate. A repo that opts out does so explicitly and documents the loosening. The
typed error (not a silent drop) encodes the governing rule ("a status marker
records a verified outcome, never an inference") into the tool instead of prose
agents are asked to remember. The read-side mirror is `filter.missingCitation`
(§5a.7).

### 5a.3 Optional `files` + overlap query (FEAT-005 Stage 3 — lowest confidence)

Optional `files: string[]` on an item, plus `backlog_query({ view: "overlap",
humanIds: [...] })` returning pairwise intersections. **An input to wave selection,
not a scheduler** — the tool reports declared overlap; it never reads the
filesystem, never chooses the wave. `view:"overlap"` is a first-class view (in the
§2 enum); `groupBy:"file"` is its files-backed grouping axis — empty groups when
items carry no `files`.

**The overlap axis (`overlapBy`) generalizes beyond files.** Overlap is "two tasks touch
the same unit of work" — and the unit can be a file, a package, a project, or an
author. `view:"overlap"` takes `overlapBy: "file" | "project" | "package" | "author"`
(default `"file"`): `overlapBy:"project"` reports tasks whose `PROJECT_OF`/repo-projection
overlaps (the wave-collision question at project granularity), `overlapBy:"package"` tasks
in the same package, `overlapBy:"author"` tasks authored by the same identity. The result
shape is uniform: pairwise `{ a, b, shared: [...] }` with the shared unit list. **Naming:**
the axis is `overlapBy`, never `by` — `by` is reserved for the actor identity on
mutations (§4/§7.5); the two must not share a parameter name in the same tool family.

### 5a.4 Explicitly NOT modeled (the refusal)

Waves (ephemeral dispatch decisions — persist nothing), tier/turn budgets
(free `tags`/metadata at most), acceptance clauses as structured data (body text —
*but their presence is queryable, see §5a.7*), markdown regeneration (ADR-0011
killed the split-brain; don't rebuild it). The interface exposes the *inputs*
(`ready_items`, `topo_order`, `overlap`); the orchestrator decides.

### 5a.5 Mapping

- Rollup → `backlog_get({ fields: [..., "rollup"] })` **and** `rollup` as a projected
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
(evidence gate) → **resume with one `query { view: "plan", filter: { plan, claimedBy:
<me> }, filter.dateRange.updated.since: <asOf> }`** — the resume call carries the
caller's own claims, so the interrupted agent's in-progress work is in the same
envelope as the ready/blocked sets → close parent with its own citation →
`query view:"summary"` for the retrospective.
Waves/turn-budgets stay in the orchestrator (refused by design, §5a.4); the plan
structure is durable in the graph, the dispatch is ephemeral.

**Resume is a tool surface, not a memory exercise.** The session-resume use case
(canonical example: a product agent's planning session that must survive death) is
answered natively by `backlog_query({ view: "plan", filter: { plan, claimedBy } })`
(FEAT-015) — one call returns the rollup, the ready set, the blocked set, the
audit-delta since the checkpoint, the needs-human set, **the caller's own claims
(`myClaims`)**, and an **`asOf` checkpoint token** passed back as
`filter.dateRange.updated.since` on the next call — the timestamp is tool-native,
never a hand-persisted ledger entry. An agent resuming a plan should need exactly
one call and no hand-written ledger. If a plan cannot be resumed from a single tool
call, that is an interface defect, not a workflow gap.

### 5a.7 Plan-analysis queries (the "what's wrong with this plan" surface)

The plan-analysis use cases are **compositions of the existing surface** — overlap
views plus completeness filters — not a new tool. Canonical queries:

| Ask | Expression |
|---|---|
| Overlapping tasks by file | `view:"overlap"` + `overlapBy:"file"` (default) |
| Overlapping tasks by project | `view:"overlap"` + `overlapBy:"project"` |
| Overlapping tasks by package | `view:"overlap"` + `overlapBy:"package"` |
| Tasks lacking acceptance criteria | `view:"list"` + `filter: { missingAcceptanceCriteria: true }` |
| Tasks with acceptance criteria | `view:"list"` + `filter: { hasAcceptanceCriteria: true }` |
| Tasks lacking any citation (evidence gap) | `view:"list"` + `filter: { missingCitation: true }` |
| Plan members not assigned/claimed | `view:"plan"` (the ready/blocked split already shows this) |
| Plan members with no children (leaves) | `view:"list"` + `filter: { plan }` + `fields: [...,"rollup"]` — leaves have `childrenTotal: 0` |

**Acceptance-criteria presence is a filter, not a schema change.** §5a.4 keeps
acceptance *clauses* as body text — but their *presence* is queryable. `criteria` is a
recognized body-section convention (a `## Criteria` / `## Acceptance` heading in the
body, or a structured `metadata.criteria` array where a caller supplies one). The
filters `hasAcceptanceCriteria` / `missingAcceptanceCriteria` detect that signal; they
never parse or validate clause content. The evidence-gate citation requirement (§5a.2)
is the same class: `missingCitation` is the read-side mirror of the write-side gate.

### 5a.8 Plan-graph intelligence contract (Phase 3 — RAG-SPEC §5 ops on the surface)

The plan-graph operations (`criticalPath`, `blockerImpact`, `planReadiness`,
`recommendNextWork`, `suggestDependencies`, `suggestRelated`) are **view compositions
with a pinned output shape** — the contract is defined here so Phase 3 never invents
it at implementation time:

| Operation | Surface | Output shape |
|---|---|---|
| `criticalPath` | `view:"plan"` with a `weightFn` param (`"count"` \| `"priority"`) | `{ plan, criticalChain: humanId[], length, endItem }` — the weighted longest path through `DEPENDS_ON` |
| `blockerImpact` | `view:"order"` + `filter:{ humanId }` | `{ humanId, impactedCount, impactedOpenCount, impactedHumanIds }` — the backward-reachable set |
| `planReadiness` | `view:"plan"` | `{ planSlug, totalCount, doneCount, readyCount, blockedCount, hasCycle, percentComplete, nextRecommended }` |
| `recommendNextWork` | `view:"ready"` + `sort:"priority"` with the critical-path/impact ranking | ranked terse cards (the ready set, impact-ranked) |
| `suggestDependencies` / `suggestRelated` | `view:"similar"` + `filter:{ anchor, suggest: "dependencies" \| "related" }` | candidates + scores (read-only; the confirm gate is structural — no write path) |

`criticalPath`, `blockerImpact`, and `planReadiness` are pure graph traversal over
`DEPENDS_ON` (no embedding dependency — RAG-SPEC §5, Phase 3) and can ship with or
ahead of the embedding layer; `suggestDependencies`/`suggestRelated` require the
vector channel.

---

## 6. `backlog_admin` — bulk, maintenance, system

Maps: `archive-resolved`, `export-json`, `import-from-markdown`, `render-to-markdown`,
`merge-items`, `migration-status`, `set-migration-phase` (7),
PLUS the three unmapped live commands `version`, `skill`, `batch` (spec gap — live CLI
has 38 commands, the 07-30 spec mapped 36), PLUS `doctor` (FEAT-008) and `prune`
(FEAT-009) (7 → 1).

```
backlog_admin({ action: "archive"|"export"|"import"|"render"|"merge"|
                        "migration_status"|"set_migration_phase"|
                        "version"|"skill"|"batch"|"doctor"|"prune"
                        |"run_dedup_sweep"|"cluster_into_plans"|"promote_cluster_to_plan"
                        |"embedding_backfill"|"embedding_health"|"list_near_duplicates",
                params? })
```

- `stats` and `stale-claims` are **not** admin actions — both are reads. "How many X" is
  `view:"summary"` (§2.2); stale claims is `view:"stale"` (§2.2, a read filter preset).
  Admin is **maintenance and system operations** — bulk mutation, export/import/render
  (bulk data ops), migration, version/skill/batch, and the maintenance actions. The
  reads that remain (`export`, `render`, `migration_status`) are bulk/system operations,
  stated, not read-tools-in-disguise.
- `batch` is the apigen-plugin-batch mount (`_batch/action`) given a discoverable home
  (BUG-BACKLOG-BATCH-CLI-001 — the current surface is undocumented; every natural
  invocation fails with exit 2/4). `params: { operation, items[], concurrency?,
  mode?, onItemError?, itemTimeoutMs? }` — the documented JSON-blob convention applies.
- `skill` (install-skill) and `version` get first-class entries (both shipped, both
  invisible — BUG-BACKLOG-001 was exactly this class, resolved).
- `doctor` (FEAT-008) and `prune` (FEAT-009) land as maintenance actions.
- **EPIC-G actions** (run_dedup_sweep, cluster_into_plans, promote_cluster_to_plan,
  embedding_backfill, embedding_health, list_near_duplicates) land with the embedding
  layer — the read side of those capabilities lives in `backlog_query` views
  (`similar`, `sort:relevance`); the write/ops side lives here.
- **The action union is versioned and documented.** The growth rule: when the union
  approaches ~25 actions, split a `backlog_system` tool — the "6 tools" claim stays
  honest by explicit governance, not by accretion.

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
   `not_found` (unknown command / unresolvable identifier), `item_not_found`
   (single-item lookup miss — distinct code, exit 1), `ambiguous`, `invalid_argument`,
   `duplicate_candidate`, `dedupe_suppressed`, `unsupported`, `store_busy`,
   `validation`, `soft_deleted`, `rag_not_configured`, `internal`. `error.details` may
   carry `retryable: boolean` and `retryAfterMs` for transient codes (`store_busy`) —
   an agent knows whether to retry and with what backoff, never hot-loops. The
   envelope may additionally carry `warnings?: string[]` on a successful read — for
   non-fatal ambiguity surfaced at resolution time (e.g. a bare repo name matching
   multiple nodes, GRAPH_MODEL §3). **A read never silently narrows; ambiguity is
   either a warning or the `ambiguous` error, never quiet.**
2. **Exit codes (CLI):** 0 success; **1 single-item not-found** — a distinct `item_not_found` error code (NOT the generic `not_found`); 2 bad flag (`invalid_argument`); 4 unknown command (generic `not_found`). Verified against the live bin's `CLI_EXIT_CODE` (apigen-base-errors errors.ts:58-63): `invalid_argument: 2, not_found: 4, internal: 1`. The design does **not** remap `internal` (1) or generic `not_found` (4) — `item_not_found` is a new code mapped to exit 1, so "single item missing" is distinguishable from "unknown command" (4) and from "server internal error" (1) by scripters. An empty *list* result is `ok:true, data:[]`, exit 0 (a list is never "not found").
3. **Projection discipline:** read tools default to terse cards; bodies and embedding
   blobs are opt-in via `fields`. **One `fields` grammar across all read tools**
   (`backlog_get` and `backlog_query` share the vocabulary; pseudo-fields `body`,
   `audit_trail`, `blockers`, `citations`, `rollup`, `_score`, `_vector`). Default card
   shape is uniform across tools (`humanId, kind, title, status, priority` — §2.4;
   `backlog_get` adds `projectPath, updatedAt` as its single-item affordance, stated
   not implied). On the CLI, `--fields` is a comma-separated list; on MCP/REST it is a
   JSON string array — stated, so the grammar break is documented not silent.
   `--format table` renders `summary`/`grouped`/`plan` as aligned tables for humans;
   `json` (default) stays agent-native.
4. **Pagination:** `MAX_LIMIT` explicit; `offset` applied to result ordering;
   `{ total, returned }` in the response envelope. **Upstream dependency (R3):**
   `searchNodes` has no `offset` param and `countNodes` takes a `NodeFilter`, not an
   FTS query — the grep-path total/offset contract requires a `@adhd/sox-graph-store`
   change, sequenced with DEBT-SOX-001/EPIC-F. Without it, grep queries degrade to
   documented full-fetch-then-slice with a performance budget.
5. **Session context:** `by` is an explicit parameter on mutations. On the CLI, `by`
   resolves from the identity chain unless `--by` is passed: env override → `git config
   user.name` → reject with `invalid_argument` (the documented `currentActor()`
   precedent). On MCP/REST, `by` is **mandatory** per-call (stateless transports).
   `repo` likewise stays explicit until EPIC-A's repo-node lands. Session-context
   optimization applies only where the transport has real session state.
6. **Semantic seam:** `filter.grep` = keyword/FTS, always — it never becomes hybrid
   when embeddings land (see AC-11; RAG-SPEC §3.1 agrees). `filter.semantic`,
   `filter.anchor`, `view:"similar"`, `sort:"relevance"` route to the embedding
   matcher when EPIC-G lands. The surface never changes shape at the swap. The dual
   expression is documented, not ambiguous: `view:list --sort relevance` = ranked
   cards; `view:similar` = candidates + scores + overlap reasons.
7. **Time boundaries:** one grammar — `filter.dateRange` (§2.1), with CLI sugar
   `--since` / `--until` accepting ISO or natural language (`today`, `yesterday`,
   `Nd` = N days ago) compiled server-side. No top-level `since`, no `window.since`.
   `view:"summary"` and `view:"plan"` read `filter.dateRange.updated`; the plan view
   returns an `asOf` checkpoint token to pass back as the next `since`.
8. **Filter validation:** `BacklogFilter` is schema-validated with
   `additionalProperties: false` — an unknown filter key is a `validation` error (exit
   2), never a silent no-op. Top-level parameters nested inside the filter
   (`view`, `sort`, `groupBy` inside `--filter`) are a targeted `invalid_argument`
   naming the stray keys — the most common agent error gets an actionable message,
   not a silent "works-by-accident" result.
9. **CLI stdout shape change is a breaking migration, not an implementation detail:**
   today the CLI prints the raw JSON result via apigen-plugin-cli-output; the envelope
   wraps that. Every script parsing `backlog list-items` output breaks. This is part of
   the backward-compat question (§9 Q4) and must be enumerated in the migration plan:
   SKILL.md (the only documented surface, 36 commands), the three spec suites
   (`cli.spec.ts`, `server.mcp.spec.ts`, `install.e2e.spec.ts`), parity scripts, and
   this repo's AGENTS.md Disclosure section all hard-code flat names. **Migration
   order: SKILL.md ships the 6-tool surface FIRST** — it is the only documented
   surface, and leaving it last strands every agent mid-window on stale flat names.
   **Shell completion** for the enum flags (`--view`, `--sort`, `--group-by`,
   `--status`, filter keys) ships with the 6-tool surface, generated from the same
   operation descriptors AC-0 requires — the single highest-leverage human
   affordance on a 6-verb × 10-view × 20-key surface.

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
| DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001 | AC: `view:"summary"` must own the partial-history constraint and surface it via `coverage` (audit events only exist post-fix; pre-existing items have no history) |
| FEAT-010 (aggregate/export) | AC: `view:"summary"` reading `filter.dateRange` + `coverage` + median/p90 time-to-resolution + time-in-status (absorbs v1 `admin:stats`) |
| FEAT-005 (grouping primitive) | AC: §5a — two-axis rollup, evidence-gated terminal transitions, `files`/`overlap` |
| FEAT-007 (group-bys) | AC: `view:"grouped"` + `groupBy` |
| FEAT-013 (dupe counter) | AC: `sort:"demand"`, `filter.dupeHitsMin`, create-flow interception |
| FEAT-012 (author/reporter) | AC: filter fields + `groupBy` dimensional axes + aggregate-by-reporter |
| FEAT-011 (usefulness) | AC: `view:"similar"` (semantic + anchor) + semantic seam |
| RAG-SPEC §5 plan-graph ops (Phase 3) | AC: §5a.8 contract + AC-30 — `criticalPath`/`blockerImpact`/`planReadiness`/`recommendNextWork`/`suggest*` have pinned view compositions and output shapes |
| FEAT-008 (doctor), FEAT-009 (prune) | AC: `backlog_admin` actions |
| BUG-AUDIT-TRAIL-SOFTDELETE | AC: `backlog_get` fields reach soft-deleted history |
| DEBT-REPO-MOVE (repo mutation) | AC: `patch.repo` once EPIC-A lands |

**Not absorbed (stays separate):** BUG-APIGEN-058 (IR cache — apigen layer), the
embedding substrate itself (EPIC-G), the repo/project node model (EPIC-A),
`install`/`install-skill`/`serve` (host commands — see §6 carve-out).
Note: the CRITICAL silent-drop class is absorbed as the §3 OP-layer interception
guard (split/supersede, not just create); `computeNextHumanId` stays EPIC-A.

---

## 10. Acceptance criteria — exact expected usages (verifiable contracts)

Each usage below is a hard acceptance criterion. "Verifies" names the real seam a test drives (built CLI binary, live Fastify server, MCP host call) — proxy assertions (spec-file existence, source-level checks) are not acceptable.

### 10.0 The one-package → four-mount apigen contract

Backlog composes **one** apigen package (`buildBacklogApigenPackage`) and mounts the same operation set to all four transports: `apigen-plugin-cli-output` (CLI), `apigen-plugin-mcp` (MCP), `apigen-plugin-api-fastify` (REST), `apigen-plugin-openapi` (OpenAPI doc). No codegen, no per-transport operation definitions — the OpenAPI document is derived from the same operation descriptors the CLI and MCP serve.

**AC-0:** One operation definition serves all four transports. Verifies: a single `buildBacklogApigenPackage` call produces the operation set; the CLI, the MCP `tools/list`, and the Fastify route table all expose the same 6 verbs (`get`, `query`, `create`, `update`, `relate`, `admin`); **`install`/`serve` are NOT among the six** (negative assertion — the host carve-out is pinned, so a future accidental absorption fails the AC); the OpenAPI document lists every exposed operation with its request/response shapes derived from the same descriptors (not hand-written).

### 10.1 `backlog serve` — Fastify REST + OpenAPI

`backlog serve` launches the long-lived listener with `--transport mcp|http|both` (default `mcp`, unchanged), `--port`, `--host`. `--transport http` (or `both`) serves the 6-tool surface as Fastify REST; the OpenAPI 3.1 document is served at the `_meta/openapi` route via `apigen-plugin-openapi`.

**AC-1 (serve http):** `backlog serve --transport http --port 8787` starts a Fastify listener on `:8787`; `GET /` lists the served operations (the mount root is pinned — one spelling, not "or"); each of `get/query/create/update/relate/admin` is reachable as an HTTP route with JSON bodies in the response envelope `{ ok, data?, error? }`. Verifies: `curl GET /` asserts the operation list; one representative route per verb is called over real HTTP.
**AC-2 (openapi doc):** against the same server, `GET /meta/openapi` returns a valid OpenAPI 3.1 document whose `paths` cover every served operation; the document is derived from the operation descriptors (no hand-written spec). (The route is `/meta/openapi` — `apigen-plugin-openapi`'s `syntheticOp` strips the leading underscore from the namespace for routing, plugin.ts:68-69; the design accepts the plugin's convention.) Verifies: fetch the live route, parse with a real OpenAPI validator, assert every served operation appears.
**AC-3 (both):** `backlog serve --transport both` exposes HTTP REST *and* MCP (stdio) simultaneously; each surface works independently.
**AC-4 (mcp unchanged):** `backlog serve --transport mcp` (default) behaves exactly as today — MCP over stdio, spawnable via `.mcp.json`.

### 10.2 CLI verb surface (the 6-tool consolidation)

Flat verbs (`list-items`, `get-item`, `ready-items`, `topo-order`, `dependency-graph`, …) collapse into the six verbs (spotlight's semantics are `view:list` with default sort — no separate verb). Exit codes: 0 success, 1 single-item not-found (`item_not_found`), 2 bad flag, 4 unknown command. The envelope wraps stdout (`{ ok, data?, error? }`), and `--fields`/`--filter`/`--view`/`--sort`/`--limit`/`--offset` are the universal flag grammar.

**AC-5 (verb collapse):** `backlog list-items` and `backlog spotlight` are rejected with exit 4 and a pointer to `backlog query`; `backlog query --view list` returns the same items (and `--view list` with default sort equals today's spotlight semantics). `view:order` (renamed from `topo`) returns the same topological order `topo-order` does today; `view:stale` returns the same items `stale-claims` does today. Verifies: run the built binary both ways.
**AC-6 (envelope + exit codes):** every CLI command prints the envelope; a not-found single-item `backlog get` returns `{ ok: false, error: { code: "item_not_found" } }` with **exit code 1** — never `ok:true, data:null` and never the generic `not_found` code; an empty *list* result is `ok:true, data: []` with exit 0; unknown command returns generic `not_found` + exit 4; bad flag returns `invalid_argument` + exit 2; an internal error is exit 1 with a distinct `internal` code (the `item_not_found`/`internal` collision is impossible — different codes). Verifies: drive the built binary across success/not-found/empty-list/bad-flag/unknown-command, assert code + exit per case.

### 10.3 Multi-repo

**AC-7 (single-repo filter):** `backlog query --view list --filter '{"repo":"adhd"}'` returns only items whose canonical repo node is `adhd` — including items filed under an alias string (fork-key reconciliation: `PseudoSky/adhd` items are included). Verifies: real items filed under both keys, run the query, assert the union and no foreign-repo items.
**AC-8 (cross-repo):** with repo A item `DEPENDS_ON` repo B item (via item-level edge), `backlog query --view graph --filter '{"repo":"A"}'` surfaces the dependency; the project-level "which projects depend on repo B" query (EPIC-A `aggregateBy`/project traversal) returns the project of A. Verifies: real edges, run both queries.

### 10.4 Semantic searching

**AC-9 (semantic filter, scoped):** `backlog query --view list --filter '{"repo":"adhd","semantic":"sign-in button unresponsive"}' --sort relevance` returns the semantically-closest items *within repo adhd* — a paraphrased match ranks above an exact-word match in a different repo. **Negative control:** zero the vector weight (the RAG-SPEC §8 test-1 control) — the paraphrase drops out of the top ranks, proving the vector channel contributes. Verifies: real embeddings via the embedding service; assert repo scoping (no foreign-repo item), paraphrase ranking, and the zero-weight control.
**AC-10 (similar view, two anchors):** `backlog query --view similar --filter '{"repo":"adhd","semantic":"..."}' --fields humanId,title,_score` returns top-k with `_score` from the matcher; `--filter '{"anchor":"BUG-42"}'` returns items nearest to BUG-42's own vector (item-anchored similarity — "what's like BUG-42" needs no pasted title). **Negative control:** same zero-vector-weight control as AC-9 — with the semantic channel disabled the two anchors return no meaningful neighbors.
**AC-11 (grep stays distinct):** `--filter '{"grep":"sign-in"}'` returns pure FTS keyword matches (exact/word, no paraphrase) — and stays FTS-only after embeddings land (never hybrid); `--filter '{"semantic":"..."}'` returns embedding matches; the two compose (`{"grep":"sign-in","semantic":"..."}`) without one swallowing the other.
**AC-12 (degrade):** against a store with no embedding configured, `semantic`/`similar`/`relevance` return `{ ok:false, error:{ code: "rag_not_configured" } }` while `grep` and dimensional queries still work.

### 10.5 User tracking (author / reporter)

**AC-13 (filter by author/reporter):** `backlog query --view list --filter '{"repo":"adhd","author":"Z"}'` and `--filter '{"reporter":"Z"}'` return exactly the items with those role edges; items missing the field are excluded when the filter is present.
**AC-14 (aggregate-by-reporter, stable across agent runs):** `backlog query --view grouped --filter '{"kind":"BUG"}' --group-by reporter` returns `{ buckets: [{ key, count }] }` matching a manual count per reporter — **where items filed by `researcher:x` and `researcher:y` land in ONE `researcher` bucket** (identity canonicalization, GRAPH_MODEL §2.1.1). Verifies: real items from two runs of the same agent name, assert the aggregate is stable — never per-process-run buckets.

### 10.6 Rollup stats

**AC-15 (windowed summary):** `backlog query --view summary --filter '{"dateRange":{"updated":{"since":"<date>"}}}'` (bucket defaults `"day"`; window defaults to last 30 days when `dateRange` is absent) returns per-status counts, median/p90 time-to-resolution, and reopen rate over the window — matching a manual computation from the audit log for the same window — **and always carries `coverage: { itemsWithHistory, itemsTotal, auditWindowStart }`**. **Negative control:** an item whose transitions fall *outside* the window must not contribute to the window's counts (the bound is honored, not computed from all history).
**AC-16 (plan resume — testable now):** `backlog query --view plan --filter '{"plan":"<slug>","claimedBy":"<me>","dateRange":{"updated":{"since":"<asOf>"}}}'` returns the plan card + two-axis rollup (`childrenClosed`/`selfVerified`), ready set, blocked set (with which dependency), the delta of transitions since `<asOf>`, the **needs-human set (derived from existing state: non-terminal, unclaimed items blocked on nothing external — testable without EPIC-B statuses)**, the **`myClaims` set (the caller's own in-progress items, from `filter.claimedBy`)**, **and an `asOf` checkpoint token** the caller passes back as the next `since` — one call answers "where was I" for the interrupted agent, no stale ledger, no hand-persisted timestamp. **The `asOf` provenance is pinned:** call the view twice — first call's `asOf` becomes the second call's `since` — and assert the delta *shrinks* (the token is real, not a hand-persisted ISO timestamp; a fresh session using the returned token resumes correctly).
**AC-17 (dupe-counter demand):** `backlog query --view list --sort demand` ranks an item re-filed N times above one filed once (FEAT-013 counter); `--filter '{"dupeHitsMin":2}'` returns only re-filed items. **Negative control:** under weighting perturbations (e.g. recency-heavy demand), the once-filed item stays *below* the re-filed item — the dupe counter is the dominant demand term, not an incidental tiebreak.

### 10.7 Field selection (projection)

**AC-18 (default card):** every list/query response defaults to `humanId, kind, title, status, priority`; full bodies and embedding blobs are never present without an explicit `--fields`.
**AC-19 (opt-in):** `--fields humanId,title,body,citations,author,reporter,_score` returns exactly those fields; an unknown field is a `validation` error (exit 2), never a silent omission.
**AC-20 (blob opt-in):** embedding vectors are returned only when explicitly requested (e.g. `--fields ...,_vector`); `view:summary`/`view:grouped` never return item bodies or blobs.

### 10.8 The one-package mount is proven by real transports

**AC-21:** `nx run backlog:verify-dist-load` green; `cli.spec.ts`/`server.mcp.spec.ts`/`install.e2e.spec.ts` drive the real built artifacts; a new `serve.http.spec.ts` drives the real Fastify server (spawn `backlog serve --transport http`, call routes over real HTTP, assert envelope + OpenAPI doc). Every AC above that names a CLI/HTTP invocation is exercised through its real seam.

### 10.9 Round-2 contracts (ergonomics + identity)

**AC-22 (flag sugar):** `backlog query --repo adhd --author Z --status open --kind BUG` returns exactly what `backlog query --view list --filter '{"repo":"adhd","author":"Z","status":"open","kind":"BUG"}'` returns — the flag forms compile into the filter (one grammar, two spellings). `--since yesterday` resolves to `filter.dateRange.updated.since` server-side. Verifies: run the built binary both spellings, assert identical results.

**AC-23 (filter validation):** `--filter '{"view":"list"}'` and `--filter '{"sort":"relevance"}'` (top-level params nested inside the filter — the common agent error) return a targeted `invalid_argument` naming the stray keys, exit 2 — never a silent no-op; an unknown filter key returns `validation` (exit 2), matching AC-19's fields behavior. Verifies: drive the built binary with each wrong invocation, assert the error and exit code.

**AC-24 (ambiguity is never silent):** with two genuinely different repos sharing a bare name segment, `backlog query --view list --repo <bare>` returns `ok:true` with the resolved repo's items **and a `warnings` entry naming the ambiguity** — never a silent narrow. Verifies: real repos, assert the warning presence and correct narrowing.

**AC-25 (count-only is pinned):** `backlog query --view list --filter '{"status":"open"}' --limit 5` returns `{ total: <all open>, returned: 5 }` in the envelope — the `{total, returned}` contract is asserted, not assumed. Verifies: real items, assert total is the true count and returned equals the limit.

**AC-26 (CLI identity chain):** `backlog update --human-id X --status IN_PROGRESS` without `--by` succeeds when `git config user.name` (or the env override) resolves — the CLI derives `by` from the identity chain; MCP/REST still reject an absent `by` with `invalid_argument`. Verifies: run the built binary with and without the env override, assert the attribution.

### 10.10 Natural-language query + plan analysis

**AC-27 (NL query: semantic-first, cross-repo, planner as boost):** `backlog query "nx bugs and apigen"` sends the **full string** to the semantic matcher (paraphrase-recall: an item about "nx build failures" ranks even though no word matches) and is **unscoped by default** — an item about apigen work in the `adhd` repo ranks even though "apigen" is a package in another repo, because extraction never narrows semantic recall (only explicit `--repo`/`--package` flags scope). The envelope's `data.query` shows the compiled `{ semantic: "nx bugs and apigen", filter: {}, boosts: [{ term: "apigen", type: "package", confidence, applied: "boost" }], sort: "relevance", extracted: [...] }` — the semantic channel carries the entire string, never a remainder, and the refinements are boosts + surfaced suggestions, never silent implicit filters. Verifies: real items + real embeddings; (a) a paraphrased item ranks via full-string semantic; (b) a semantically relevant item in a *different* repo than an extracted term ranks (cross-repo recall); (c) explicit `--repo adhd` scopes the same query and the item in the other repo drops; (d) the same `data.query` re-run as the explicit `view:list` + filter + semantic form returns the same items; (e) without embeddings the full string falls back to FTS and still works.
**AC-28 (overlap by project):** `backlog query --view overlap --overlap-by project --humanIds "[A,B,C]"` returns pairwise `{ a, b, shared }` where `shared` lists the overlapping projects — **and `--overlap-by file` on the same set returns a *different* result** (distinct axes produce distinct sets, asserted not assumed). Verifies: real items with project edges, assert the pairwise result AND the file-vs-project difference.
**AC-29 (acceptance-criteria presence):** `backlog query --view list --filter '{"plan":"<slug>","missingAcceptanceCriteria":true}'` returns exactly the plan's members whose body lacks a criteria section (or `metadata.criteria`) — and `--filter '{"hasAcceptanceCriteria":true}'` returns the complement. `--filter '{"missingCitation":true}'` returns members with zero citations. Verifies: real items with and without criteria/citations, assert exact membership.

**AC-30 (plan-graph ops have a pinned contract):** a real `DEPENDS_ON` chain A→B→C plus an independent D: `view:"plan"` + `weightFn:"count"` returns `{ criticalChain, length, endItem }` with the chain end and length strictly greater than D's path; `view:"order"` + `filter:{ humanId:"D" }` returns `blockerImpact { impactedCount: 3, impactedOpenCount, impactedHumanIds }` (the transitive cone, not just direct dependents); `view:"ready"` + the impact ranking returns D's dependents in impact order. Negative control: cap traversal depth at 1 — the impact count drops to 1, proving transitivity is exercised.

**AC-31 (ready view + groupBy axes are driven, not prose-only):** `backlog query --view ready` returns exactly the non-terminal, unclaimed, unblocked items (a superset of nothing else); each remaining `groupBy` axis returns the documented `{ buckets: [{ key, count }] }` shape on real data — at minimum `repo`, `author`, `project`, `status`, `kind` (the dimensional and classic axes the other ACs leave undriven). Verifies: real items spanning all axes, assert exact bucket membership per axis.

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
5. **Session identity (RESOLVED — `by` is explicit)** — MCP transports are stateless, so
   `by` is a required per-call parameter on all mutations (§4/§7.5); session-aware
   transports may elide it via a documented transport-level identity. This resolution
   closes the former R6 blocker: the `backlog_update` signature carries `by` visibly,
   and an unattributed mutation is rejected rather than silently stamped.
6. **Admin authorization** — `backlog_admin` bundles `set_migration_phase`
   ("admin-only" by convention, SKILL.md) with merge/prune/import/soft-delete, and MCP
   exposes all tools equally. What is the gate? (Today: none beyond convention.)
7. **Soft-deleted tombstone lookup** — `queryNodes` always filters `t_invalid IS NULL`
   (sox-graph-store index.ts:787-789,1174), so `backlog_get`'s soft-deleted
   audit-reachability needs a way to resolve `(repo, humanId)` → nodeId for a
   soft-deleted item. `getNode(id)` reads invalidated rows unconditionally
   (index.ts:1168-1171) and `auditTrail` already calls it on invalidated deps
   (query.ts:254) — so the missing primitive is a **non-live identifier resolution**,
   not a full tombstone query path. Raw-SQL escape-hatch precedent: crud.ts:373-375.
 8. **Filter/limit composition semantics** — where do `open`/`closed`/`rootLevel`/
    `excludeArchived` post-filters move (store push-down vs documented truncation) once
    the query layer owns correctness? (R2 — the fix direction is set; the mechanism
    needs a home.)
9. **Identity canonicalization (RESOLVED)** — author/reporter identity canonicalizes to
   the stable agent/person name (strip the `:instanceId` suffix) via
   `canonicalIdentityKey`; claim identity stays ephemeral per-instance (GRAPH_MODEL
   §2.1.1). AC-14 proves aggregate stability across agent runs.
10. **`duplicateAction: "abort"` granularity in batch/import (RESOLVED)** — per-item
    skip-with-report, not whole-batch abort: a duplicate in a 200-item import skips that
    item (reported in the result, matching v1 `ImportResult.errors`) and the batch
    continues. Whole-batch abort on one dupe is a footgun.
11. **Plan needs-human derivation (RESOLVED)** — derived from existing state now
    (non-terminal, unclaimed, blocked on nothing external); `awaiting_input`/
    `open_question` statuses become additional members when EPIC-B adds them. AC-16 is
    testable without EPIC-B.
12. **Query-time ambiguity (RESOLVED)** — envelope `warnings` array on a successful read
    when a bare repo name resolves ambiguously; never a silent narrow (§7.1, AC-24).
13. **`--since` natural-language dates (RESOLVED)** — CLI sugar accepts ISO *and*
    `today` / `yesterday` / `Nd`, compiled server-side into `filter.dateRange`; the
    one-grammar contract is preserved (§2.1a, AC-22).
14. **`store/query.ts` ownership (RESOLVED — A then B)** — EPIC-A owns the file first
    (dimensional routing through `dimensional.ts`, GRAPH_MODEL §4), EPIC-B builds on
    A's output (the push-down/offset fixes, §2.1). The order is stated so the two epics
    never edit the same function in parallel. `BacklogFilter` field ownership is per the
    §2.1 "lands with" table — the epic that *adds* a field list is the one that owns the
    type; consuming epics extend, never restructure.
