# Citation-driven component linking — discovery, the `implicates` edge, backfill, and query surface

**Status:** DESIGN SPEC (uncommitted; no code touched). Author: architect, 2026-09-22.
**Target branch:** `.worktrees/backlog-v2` (the replacement branch that ships post-cutover).
**Write location:** written in the **main repo** (`/Users/nix/dev/node/adhd`); the
`.worktrees/backlog-v2` tree was read-only for this pass. Move/commit it onto `backlog-v2`
as the owner sees fit (same posture as `report/deferral-cleanup-plan.md` and
`report/registry-surface-redesign.md`).
**ADR note:** the `adhd` repo has no `docs/decisions/`; the governing catalog is
`/Users/nix/dev/ai/sox-ecosystem/docs/decisions/` (0001–0020). This design complies with
**ADR-0010** (open node/edge typing — a new rel is a row, validated by an injected policy),
**ADR-0012** (parallel-process enabled — every write is one `BEGIN IMMEDIATE` transaction with
bounded retry), and **ADR-0013** (feature switches are typed config, never env vars — this
design introduces **no** env toggle; linking is always on).
**Relationship to `report/registry-surface-redesign.md`:** that spec owns the **registry verb
shapes** (`registry-get`/`list`/`upsert`/`delete`). This spec owns the **semantics** — what a
component `path` means, the derived-link edge, the linker, the backfill, and the query surface.
The seam is stated explicitly in §7.

---

## 0. Method + evidence base

Every claim below is from a file read, not inferred. Line references are to the
`.worktrees/backlog-v2` tree unless a path names the main repo.

| Evidence                                                                                                  | Location                                                  |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `IOverlapAxis = 'file' \| 'project' \| 'component' \| 'author'`                                           | `src/query/types.ts:268`                                  |
| `overlapAxis` / `overlapUids` inputs; `IOverlapGroup` output                                              | `src/query/types.ts:299-301,330-334`                      |
| The 10 `IIssueView` values                                                                                | `src/query/types.ts:254-264`                              |
| `IIssueQueryResult` union                                                                                 | `src/query/types.ts:370-381`                              |
| `IIssueFilter` (`component` at :209; `projectPath` at :233)                                               | `src/query/types.ts:205-237`                              |
| Registry read types (`IComponentSummary.path`, `IProjectSummary.path/repoUrl`)                            | `src/query/types.ts:387-411`                              |
| `IIssueCitation` (`file`/`lines`/`sha`)                                                                   | `src/query/types.ts:108-125`                              |
| `IIssueCard` (single `component`)                                                                         | `src/query/types.ts:159-190`                              |
| `queryOverlap` — `file` axis reads `c.metadata.target`; `project`/`component` via `resolveIssuePlacement` | `src/query/query.ts:889-968`                              |
| `resolveIssuePlacement` — single `owns_component` → `owns_project`                                        | `src/query/resolve.ts:228-249`                            |
| Direction-aware edge filter resolution (reads the `edge_kind` row)                                        | `src/query/resolve.ts:286-329`                            |
| `resolveCitations` — maps citation node `meta.target`→`file`, `meta.line`→`lines`                         | `src/query/card.ts:110-131`                               |
| `ICitationInput {file, lines?, context?, symbol?, blastRadius?}`                                          | `src/write/create-issue.ts:74-81`                         |
| Citation node write (`meta:{target, target_type:'path', sha, line, …}`) + `has_citation` edge             | `src/write/create-issue.ts:928-966`                       |
| Citation write on `transition`                                                                            | `src/write/transition.ts:88,135,520,540`                  |
| `EDGE_KIND_TABLE` — the 17 declared rels                                                                  | `src/write/catalog.ts:311-409`                            |
| `resolveEdgeKindTx` — self-heals a row from the table                                                     | `src/write/catalog.ts:452-509`                            |
| `projectHasKnownPath` — reads `project.metadata.path`                                                     | `src/write/catalog.ts:603-628`                            |
| `upsertProject` by `name` (mints `(root)` component)                                                      | `src/write/catalog.ts:655-707`                            |
| `upsertComponent` by `(project,name)` with `path`                                                         | `src/write/catalog.ts:839-950`                            |
| `upsertLocation` by `(component,locType,value)`                                                           | `src/write/catalog.ts:992-1146`                           |
| `IWriteEdgeTxInput` carries `metadata?` + `weight?`                                                       | `src/write/tx.ts:506-528`                                 |
| `IEdgeKindRule {rel, sourceKind, targetKind, multiplicity}`                                               | `src/write/tx.ts:496-504`                                 |
| `OPEN_TYPE_POLICY` — `validateRel` is permissive                                                          | `src/store/type-policy.ts:21-31`                          |
| `carryForwardResidualEdgesTx` — both directions, copies `origin`/`meta`; excludes 5 rels                  | `src/write/update.ts:536-637,977-982`                     |
| `relate` — issue↔issue only, closed 5-rel set                                                             | `src/write/relate.ts:86-111`                              |
| `relate` cross-project gap resolved by construction                                                       | `src/write/relate.ts:52-65`                               |
| Skill "filing rule"; "No other component is ever auto-created"                                            | `skill/SKILL.md:333-376`                                  |
| Repo-string split, measured (`PseudoSky/adhd:384`, `adhd:57`)                                             | main `docs/product/dispatcher-platform/GAP-MATRIX.md:160` |
| v2 ETL reconciles the repo fork to ONE `project` row                                                      | main `entrypoint/backlog/DATA_MODEL_v2.md:93-96,216-254`  |
| The re-cutover step this must land before                                                                 | main `report/deferral-cleanup-plan.md:328-333`            |

**Governing prior research (researcher, 2026-09-22; 14 findings in memory).** The core is a
**lexicographically-sorted prefix array + binary search with a segment-boundary guard** —
order-independent, O(log n), dependency-free. CODEOWNERS' last-match-wins precedence is an
**antipattern** for an unordered component set (it makes backfill and incremental recompute
disagree). The derived-link pattern is **recompute-on-write + idempotent backfill + a
`provenance` discriminator**; identity is resolved through a canonical-slug + alias table.
No off-the-shelf package solves derived issue↔component linking from file paths.

---

## 1. What exists today (and the exact gap)

1. **Citations are first-class nodes.** A citation carries a file path in `meta.target`
   (`create-issue.ts:944`), linked to its issue by a `has_citation` edge (`:953-964`), and read
   back as `IIssueCitation.file` (`card.ts:120-130`). A citation's `lines`/`sha`/`symbol` live
   beside it. **The file path is already persisted and addressable — nothing new is needed to
   get it.**
2. **Placement is single-valued.** An issue has exactly ONE home component: the `owns_component`
   edge (`component → issue`, `1:n`), enforced by AC-17 and re-pointed by `move`. The read path
   resolves it via `resolveIssuePlacement` (`resolve.ts:228-249`), and `IIssueCard.component` is
   a single uid (`types.ts:166`). **This is a placement, not evidence — it cannot express "this
   issue touches three packages in two projects".**
3. **The registry already carries the paths the linker needs.** `component.meta.path` and
   `project.meta.path` are written by `upsertComponent`/`upsertProject` and surfaced by
   `IComponentSummary.path`/`IProjectSummary.path`. Path locations (`locType:'path'`) are
   per-file anchors owned by a component. `projectHasKnownPath` (`catalog.ts:603-628`) already
   establishes that `project.metadata.path` is the canonical root for filesystem resolution.
4. **The edge substrate is open and metadata-capable.** `EDGE_KIND_TABLE` declares every rel
   with `(sourceKind, targetKind, multiplicity)`; `resolveEdgeKindTx` self-heals a missing
   `edge_kind` row from that table; `OPEN_TYPE_POLICY.validateRel` is permissive, so **a new rel
   needs only a table row — no policy edit** (ADR-0010). `IWriteEdgeTxInput` already accepts
   `metadata` (`tx.ts:514`), and the edge table already has `origin`/`meta` columns
   (`update.ts:593,617-630`). **Provenance is first-class storage, not a workaround.**
5. **The `overlap` view already reads citations — but only for the `file` axis.** `queryOverlap`
   (`query.ts:927-943`) groups the `file` axis by `c.metadata.target`; the `component` axis
   (`:957-962`) groups by the single `resolveIssuePlacement` component. So overlap today cannot
   see a multi-component issue.

**The gap, precisely:** nothing maps a citation's `file` to the owning component(s), and nothing
writes a many-to-many issue↔component relation. The registry paths exist, the citation paths
exist, the edge substrate exists — **the derivation between them does not.**

---

## 2. Discovery — citation path → owning component(s)

A pure function `resolveCitationTargets(canonicalPath, index)` where `index` is the resolved
registry prefix set. Deterministic, no clock, no I/O (see §2.4).

### 2.1 Canonicalization (`canonicalizeCitationPath`)

Given `citation.file`:

1. Trim; reject empty → **unresolved** (`empty-path`).
2. Defensively strip a trailing `:<line>` / `:<line>-<line>` and a `file://` scheme. (The write
   path already separates `file`/`lines`, but ETL'd and hand-written citations embed them.)
3. Normalize separators to `/`; collapse `//`; resolve `.`/`..` **lexically** (no filesystem
   access, so a `..` cannot escape the tree and matching stays pure).
4. Classify **absolute** vs **relative**. Absolute paths match against absolute project roots;
   relative paths match against relative component paths.

### 2.2 The prefix index

Built from live rows only:

- every `component` with `meta.path` → `{prefix, componentUid, projectUid, kind:'component'}`;
- every `location` with `locType:'path'` → `{prefix, componentUid, projectUid, kind:'location'}`
  (a file anchor is _more specific_ than its component directory, so it wins by longest prefix);
- every `project` with `meta.path` → `{prefix, projectUid, kind:'project'}` (rolls up to that
  project's reserved `(root)` component).

Sorted lexicographically. Lookup = binary search for the greatest prefix ≤ the path, with a
**segment-boundary guard**: match iff `path === prefix` **or** `path.startsWith(prefix + '/')`.
The guard is mandatory — without it `packages/foo` wrongly matches `packages/foobar/x.ts`.

### 2.3 Longest-prefix match, order-independent

The longest matching prefix wins. There is **no last-match-wins** (that is the CODEOWNERS
antipattern the research flags — it makes backfill and incremental recompute disagree). Equal
longest matches from two entries is **ambiguity**, never a silent first-registered pick.

### 2.4 Auto-upsert of discovered components (the "automatic" part)

When **no component prefix matches** but a **project root** does, the linker detects a package
root between the project root and the file:

1. Walk up from the file's directory to the nearest ancestor that is a **manifest boundary**
   (`package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `*.csproj`), stopping at the
   project root.
2. That directory is the **discovered component root**. Find-or-create a component for it —
   **idempotent by path**, not by name: find a live component whose `meta.path` equals the
   detected root (or is an ancestor of the citation path); only mint if none exists. This means
   a human-registered component (`upsert-component {name:'auth-service', path:'packages/auth'}`)
   is **reused**, never duplicated.
3. The minted component carries `metadata.discovered: true`, `metadata.discoveredAt`, and
   `metadata.discoveredFrom: <citationUid>` — so a registry listing can distinguish
   **declared** from **discovered** components, and a later human `upsert-component` on the
   same `(project, name)` merges into it (the `upsertComponent` merge-not-replace rule,
   `catalog.ts:643-653`).
4. The manifest walk reads the filesystem, so it runs **pre-transaction** — the same discipline
   `create-issue.ts:932-936` already uses for citation shas ("never re-reads the filesystem
   inside the write lock"). Its result is passed into the transaction as a resolved root.

**Bounded, not unbounded.** Discovery only fires when the citation resolves under a
**registered project root**. A citation outside every registered root is unresolved — it never
mints a project and never mints a component. This is the containment that keeps the registry
from growing on every stray path.

### 2.5 Ambiguity and unresolved handling

| Case                                          | Outcome                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| One component prefix matches                  | one derived edge                                        |
| Path location + its component both match      | the **location** (longer prefix) wins                   |
| Two projects' roots both match (nested roots) | the **deeper** root wins (longest prefix)               |
| Two entries share the same longest prefix     | **ambiguity** — signal, write **no** edge for that path |
| Project root matches, no component            | **auto-upsert** the discovered component (§2.4)         |
| No project root matches                       | **unresolved** (`outside-registered-root`)              |
| Empty / malformed path                        | **unresolved** (`empty-path`)                           |

Nothing is ever silently guessed. The `move`/`relate` precedent ("never silently pick one") is
the governing rule.

---

## 3. Linking model

### 3.1 Decision — a new typed edge `implicates` (issue → component, `n:m`), not a join table

The graph's edge substrate is the model. A new rel is one row in `EDGE_KIND_TABLE` plus a
TypePolicy that already permits it (ADR-0010) — no join table, no new storage mechanism, and
the residual carry-forward sweep (`update.ts:580-637`) already handles unknown rels.

```
{ rel: 'implicates', sourceKind: 'issue', targetKind: 'component', multiplicity: 'n:m' }
```

- **Why `implicates` and not `owns_component`.** `owns_component` is the single _home placement_
  (AC-17, re-pointed by `move`). Overloading it to mean "touches" would break AC-17, `move`, and
  the skill's documented placement rule. The derived link is a **separate, additive, many-to-many**
  assertion.
- **Why issue → component (not component → issue).** It reads as "the issue implicates the
  component", and the derived edge travels with the issue through a body-change supersede
  (`carryForwardResidualEdgesTx` sweeps both directions, `update.ts:588-596`). Direction is a
  deliberate, stated choice; the read path resolves it from the `edge_kind` row either way
  (`resolve.ts:286-329`), so it is not load-bearing for query correctness.
- **Multiple projects fall out for free**: an issue with `implicates` edges to components owned
  by different `owns_project` parents spans projects. That is the owner's core requirement.

### 3.2 Provenance — `meta` on the edge, `derived` vs `asserted`

```jsonc
// edge (issue → component), rel 'implicates'
meta: {
  "provenance": "derived",       // 'derived' | 'asserted'
  "via": "<citation uid>",        // the citation this link came from
  "path": "packages/auth/src/x.ts", // the canonicalized citation path
  "prefix": "packages/auth",      // the matched registry prefix
  "matchKind": "component"        // 'component' | 'location' | 'project'
}
```

- The recompute **only invalidates edges whose `meta.provenance === 'derived'`**. An
  `asserted` link is never touched by the linker.
- **No verb writes an `asserted` link today** — `relate` is issue↔issue with a closed 5-rel set
  (`relate.ts:86-100`). The field exists now so that the day a manual-assert verb lands, the
  recompute cannot clobber it. Manual assertion is **out of scope for this slice**; the spec
  defines the field, not the verb.
- `writeEdgeTx` already accepts `metadata` (`tx.ts:514`), so no new edge-write machinery is
  needed. (If the implementation also wants the `origin` column set to `'derived'` for symmetry
  with `update.ts`'s `'user_asserted'`, that is a one-line addition to `writeEdgeTx`'s INSERT —
  optional, not required by the model.)

### 3.3 Recompute — idempotent, delete-then-recompute

`recomputeIssueLinks(tx, issueRowid, issueUid)`:

1. Read the issue's live citations (outgoing `has_citation` → citation nodes → `meta.target`).
2. Compute the match set (pure, §2).
3. Invalidate every live `implicates` edge **from this issue with `provenance:'derived'`** whose
   `(componentUid, prefix, via)` is not in the new set.
4. Upsert the new set (`writeEdgeTx` with the meta above; `ON CONFLICT` re-livens).
5. Return `{ linked: [...], unresolved: [...], ambiguous: [...] }`.

Re-running is a no-op-equivalent. The function is the **only** writer of `implicates` edges.

### 3.4 Trigger points

| Verb                             | Behavior                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`                         | after the citation nodes land, **same `immediate` tx** (`create-issue.ts:928-966`)                                                                                                                            |
| `transition`                     | after the citation nodes land, **same `immediate` tx** (`transition.ts:520-540`)                                                                                                                              |
| `update` (body-change supersede) | **carry forward for free** — the residual sweep copies the `implicates` edges with their `meta` onto the successor. No recompute needed (the citations are carried verbatim, so the derivation is unchanged). |
| registry `path` change           | **targeted recompute** (§3.5)                                                                                                                                                                                 |

`move` does **not** recompute: the derived links are citation evidence, independent of home
placement.

### 3.5 Registry-change invalidation (the commonly-forgotten trigger)

A `component`/`project` `path` upsert can invalidate many derived edges at once. When a
registry write changes a `path`:

1. Query live citations whose `meta.target` falls under the **old** or **new** prefix.
2. Recompute the links for each distinct owning issue.

Without this, a moved package silently strands every derived edge. This is the trigger the
research flags as the one designs forget.

### 3.6 Composition with the existing model

- **`owns_component`**: untouched. Placement and evidence are independent; the linker never
  reads or writes `owns_component`.
- **`relate`**: untouched. `implicates` is deliberately **not** in `relate`'s closed set
  (`relate.ts:94-100`), so a caller cannot hand-write a derived edge.
- **`move`**: untouched.
- **Delete/cascade**: a component delete must account for derived edges — see §7(b).

---

## 4. Backfill + normalization prerequisites

### 4.1 The prerequisite set (must hold before the backfill runs)

The backfill bakes in whatever project identity exists at run time. If a repo is split across
two `project` rows, every derived link fragments across them. **Therefore:**

1. **The v2 ETL must have reconciled the repo fork** (`adhd` / `PseudoSky/adhd`) to **one**
   `project` row — `DATA_MODEL_v2.md:93-96` ("ONE canonical row per logical project; the old
   adhd / PseudoSky/adhd fork is reconciled to a single row at ETL time, permanently"). The
   measured split (`PseudoSky/adhd:384` / `adhd:57`, `GAP-MATRIX.md:160`) is the **v1**
   expression of this; its v2 fix is the ETL reconciliation. The v1 items
   `BUG-BACKLOG-REPO-SPLIT-001` / `DEBT-BACKLOG-REPO-MOVE-001` are closed by the ETL, not by
   this spec.
2. **Duplicate project identities** (`sox-ecosystem` vs `PseudoSky/sox-ecosystem`, etc.) must
   each collapse to one row, by the same ETL pass.
3. **Every project that owns citations must have `meta.path` set.** This is the sharpest
   prerequisite: `deferral-cleanup-plan.md:56` records **38/40 projects are path-less** today.
   With no project path, no citation can resolve. The backfill must **refuse** (or emit a
   blocking report) when a project with citations has no path — never silently produce zero
   links.

### 4.2 The backfill itself

- **Vehicle:** a `tools/` script with an nx target — **not a mounted verb.** The v2 surface is
  14 fixed verbs (SPEC-v2 §6.6 rejects the `admin` grab-bag), and the ETL precedent
  (`tools/etl/`) is the house pattern for one-shot/operator tooling. Reusable (registry changes
  re-invoke it), so it lives under `entrypoint/backlog/tools/` rather than as a throwaway.
- **Determinism:** iterate live issues ordered by `rowid` (stable), one transaction per bounded
  batch; each issue's recompute is the §3.3 pure function. Same store + same codebase ⇒ same
  edges. Re-running changes nothing.
- **Scale:** ~1,700 items (`deferral-cleanup-plan.md` read the graph at 1701 items). The prefix
  index is built **once** and reused across the whole run.
- **Output:** a report — `{issues, edgesWritten, edgesInvalidated, unresolved:[…], ambiguous:[…],
pathlessProjects:[…]}` — so the operator sees exactly what did not resolve. Exit non-zero if
  any project with citations is path-less (the blocking condition).

---

## 5. Query surface

### 5.1 "All open issues touching component X"

Add a **new** filter field rather than overloading `filter.component`:

```ts
// query/types.ts — IIssueFilter (additive)
/** Matches issues with a live `implicates` edge to the resolved component (uid or name, scoped by `project`). Distinct from `component`, which is the single home placement. */
implicatesComponent?: string;
/** Matches issues with a live `implicates` edge to any component owned by the resolved project. */
implicatesProject?: string;
```

- **Why a new field, not a change to `component`.** `filter.component` means the **home
  placement** and is load-bearing for the skill's filing rule, `move`, and AC-17. Changing it to
  union placement + derived would silently redefine every existing component-scoped scan. This
  is an owner-facing choice (§13, Q1).
- Resolution reuses `resolveEdgeScopedCandidates` (`resolve.ts:286-304`), whose direction is
  read from the `edge_kind` row — so it stays correct for the new rel automatically.
- **ADR-0017 applies:** a present-but-empty scope selects nothing. `implicatesComponent: ""`
  resolves to zero, never "no filter".

### 5.2 "Issues spanning projects Y and Z"

Add:

```ts
/** Matches issues that implicate at least one component in EACH listed project (all-of). Non-empty required. */
implicatesProjects?: readonly string[];
```

- **All-of semantics** (the issue must touch _every_ listed project). This is the cross-project
  requirement. `implicatesProjects: ['Y','Z']` + `status:'open'` is the "spans Y and Z" query.
- **Why a filter, not a `view`.** It composes with status/sort/paging/fields for free; a new
  `view:'cross-project'` would duplicate the list machinery for no gain (rejected).
- ADR-0017: `implicatesProjects: []` selects nothing.

### 5.3 `view:'overlap'` — extend by a new axis, never by changing an existing one

```ts
// query/types.ts:268
export type IOverlapAxis = 'file' | 'project' | 'component' | 'author' | 'implicates';
```

- The new `implicates` axis groups each issue by **every** component it implicates (multi-valued,
  exactly like the existing `file` axis at `query.ts:927-943`), then keeps groups with ≥2
  members. That yields pairwise component/project overlap over citation-derived reality.
- **The four existing axes' semantics are unchanged** — the `component` axis still groups by the
  single placement. Extending it to union placement + derived would change a shipped contract,
  which the brief forbids. New axis, zero breakage.
- The `file` axis already works and stays as-is.

### 5.4 Card surface

Add an opt-in **pseudo** field (an edge traversal, so not in the default card):

```ts
// IIssuePseudoField — add 'implicates'
implicates?: Array<{
  componentUid: string; componentName: string;
  projectUid: string; projectName: string;
  provenance: 'derived' | 'asserted';
}>;
```

`IIssueCard.component` (the home placement) is unchanged.

---

## 6. Write path, failures, and performance

- **When linking runs:** inside the **same `immediate` transaction** as the citation write, after
  the citations land. Atomic with the citations — no post-commit window, no eventual-consistency
  gap. ADR-0012-safe (one tx, the existing bounded busy-retry).
- **FS detection is pre-transaction.** The manifest walk (§2.4) runs before the tx opens, exactly
  as citation shas already do (`create-issue.ts:932-936`) — never a filesystem read inside the
  write lock.
- **Unresolved citations are non-fatal.** The write succeeds; the outcome carries
  `data.linkage = { linked, unresolved:[{file, reason}], ambiguous:[{file, candidates}] }`. A
  citation outside every registered root is common (a global config, a doc) and must never fail
  the write, and must never fabricate a link.
- **Never hand-maintained.** No mounted verb writes `implicates`. The linker is the sole writer
  of `provenance:'derived'` edges, so the relation cannot drift from the citations.
- **Bulk-import performance.** The prefix index is built **once per transaction** (or cached
  per store-open, invalidated on a registry write) and reused across every issue in an ETL
  batch. Each citation match is O(log n) binary search; edges are deduped by component uid. The
  ETL's "one transaction per source item" bundling (`upsertProjectTx`'s stated purpose,
  `catalog.ts:709-722`) is preserved.

---

## 7. The seam with the registry-verb spec (explicit)

`report/registry-surface-redesign.md` owns the **verb shapes**. This spec owns the **semantics**.
They touch in exactly three places:

**(a) Auto-upsert calls the write layer, not a verb.** Discovery's find-or-create calls the
existing `upsertComponentTx` (`catalog.ts:839-950`, unchanged). It adds **no** mounted verb and
changes **no** registry input shape. The registry redesign's `registry-upsert {kind:'component'}`
is the human path; discovery is an internal caller of the same write-layer function.

**(b) `registry-delete`'s component guard must include `implicates`.** The redesign's §3.4
refuses to delete a component with a live `owns_component` or `has_location` edge. It does not
yet name `implicates`. **If it does not, deleting a component leaves dangling derived edges.**
Either the guard must add live `implicates` edges to its blocker count, or delete must
cascade-invalidate them (they are `provenance:'derived'`, so invalidating them is safe). This
spec recommends the **guard** (refuse-if-referenced), consistent with the redesign's stated safe
default.

**(c) A registry `path` change is the invalidation trigger** (§3.5). The redesign's
`registry-upsert` is the call site; this spec owns the recompute it must schedule.

---

## 8. Docs and skill

| Doc                                          | Change                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill/SKILL.md:344-367`                     | Amend **"No other component is ever auto-created"**: distinguish **declared** components (`upsert-component`) from **discovered** ones (auto-created by the linker from citation paths). Add a **"Citations drive linking"** subsection: file citations with precise, repo-relative paths — **the path is the linking key**; a vague path links to nothing. |
| `skill/SKILL.md:352-367` ("The filing rule") | Restate: file the correct **project** (the linker needs a registered root to resolve); the component links then follow from the citations. Component-less filing is still legal (lands on `(root)`) but now costs less, because citations still derive the real links.                                                                                      |
| `DATA_MODEL.md` §3/§5                        | Add the `implicates` edge row + its provenance meta; note the derived-vs-asserted discriminator.                                                                                                                                                                                                                                                            |
| `SPEC.md` / `DESIGN.md`                      | Document the linker, the two new filters, the new overlap axis, and the `implicates` pseudo-field.                                                                                                                                                                                                                                                          |
| `CHANGELOG.md`                               | New entry (new edge kind + query surface).                                                                                                                                                                                                                                                                                                                  |

---

## 9. Constraints and cutover

- **No env toggle (ADR-0013).** Linking is always on. There is no `*_ENABLED` switch and no
  "experimental" flag. Any tuning constant (e.g. a max prefix depth) is **typed config with an
  explicit default**, never an env var.
- **One-call resolution + deterministic.** A single `query` call answers "issues touching X" /
  "spans Y and Z"; the derivation is a pure function of (registry, citations, codebase).
- **Don't break the `overlap` contract.** The four existing axes are untouched; the new axis is
  additive.
- **Land relative to the v1/v2 cutover.** This is a **v2** feature — it needs citation nodes and
  the open edge typing, both v2-only. Land on `backlog-v2` **before** the L0-step-2 re-cutover
  (`deferral-cleanup-plan.md:328-333`), so the shipped frozen build carries it. The **backfill**
  runs against the fresh v2 store **after** the ETL reconciliation and **before** cutover
  verification — the same posture as `registry-surface-redesign.md` §5.5.

---

## 10. Interface changes (BEFORE / AFTER)

### `src/write/catalog.ts` — `EDGE_KIND_TABLE`

```ts
// BEFORE — 17 rels; no issue→component rel beyond owns_component (component→issue)
// AFTER — one added row:
{ rel: 'implicates', sourceKind: 'issue', targetKind: 'component', multiplicity: 'n:m' },
```

`OPEN_TYPE_POLICY` needs **no** change (permissive `validateRel`, `type-policy.ts:25-27`).
`resolveEdgeKindTx` self-heals the `edge_kind` row from this table.

### New: `src/write/link-citations.ts`

```ts
export interface ICitationLinkOutcome {
  linked: Array<{ componentUid: string; projectUid: string; via: string; path: string; prefix: string }>;
  unresolved: Array<{ file: string; reason: 'empty-path' | 'outside-registered-root' }>;
  ambiguous: Array<{ file: string; candidates: string[] }>;
}

/** Pure: canonicalize + longest-prefix match. No I/O. */
export function resolveCitationTargets(canonicalPath: string, index: IPrefixIndex): Array<{ componentUid: string; projectUid: string; prefix: string; matchKind: 'component' | 'location' | 'project' }>;

/** Tx-scoped: delete-then-recompute the issue's derived `implicates` edges. Idempotent. */
export async function recomputeIssueLinksTx(tx: AdapterTransaction, handle: Pick<IWriteStoreHandle, 'typePolicy'>, params: { issueRowid: number; issueUid: string; at: string; discoveredRoots?: readonly string[] }): Promise<ICitationLinkOutcome>;
```

### `src/query/types.ts`

```ts
// BEFORE
export type IOverlapAxis = 'file' | 'project' | 'component' | 'author';
export interface IIssueFilter {
  /* … component?, projectPath? … */
}
export type IIssuePseudoField = 'body' | 'citations' | 'notes' | 'auditTrail' | 'blockers' | 'related' | '_score' | '_vector';

// AFTER
export type IOverlapAxis = 'file' | 'project' | 'component' | 'author' | 'implicates';
export interface IIssueFilter {
  /* … unchanged … */
  implicatesComponent?: string;
  implicatesProject?: string;
  implicatesProjects?: readonly string[];
}
export type IIssuePseudoField = /* … */ 'implicates';
// IIssueCard gains: implicates?: Array<{componentUid;componentName;projectUid;projectName;provenance}>
```

### `src/query/query.ts`

- `queryOverlap` (`:904-968`): add the `implicates` branch (multi-valued, mirrors the `file`
  branch at `:927-943`).
- `queryIssues` filter handling: resolve `implicatesComponent`/`implicatesProject`/
  `implicatesProjects` through `resolveEdgeScopedCandidates` and intersect the candidate sets.

---

## 11. Independent segments (for the executor)

| #   | Segment                                  | Files                                                                          | Depends on | Read tok | Out tok |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------ | ---------- | -------- | ------- |
| 1   | Edge kind row                            | `write/catalog.ts` (`EDGE_KIND_TABLE`)                                         | —          | ~80      | ~30     |
| 2   | Linker core (pure + tx)                  | `write/link-citations.ts` (new)                                                | 1          | ~250     | ~600    |
| 3   | Create/transition hooks                  | `write/create-issue.ts`, `write/transition.ts`                                 | 2          | ~200     | ~120    |
| 4   | Query types                              | `query/types.ts`                                                               | —          | ~200     | ~120    |
| 5   | Query filters + overlap axis             | `query/query.ts`, `query/resolve.ts`                                           | 2,4        | ~250     | ~300    |
| 6   | Card pseudo-field                        | `query/card.ts`                                                                | 4          | ~120     | ~120    |
| 7   | Backfill tool                            | `tools/recompute-links.ts` (new) + `project.json` target                       | 2          | ~100     | ~400    |
| 8   | Registry-delete guard + path-change hook | `write/catalog.ts` (delete guard), `write/catalog.ts`/`link-citations.ts`      | 2          | ~150     | ~150    |
| 9   | Skill + docs                             | `skill/SKILL.md`, `DATA_MODEL.md`, `SPEC.md`, `CHANGELOG.md`                   | 3          | ~300     | ~450    |
| 10  | Tests (with teeth)                       | new `write/link-citations.spec.ts`, `write/link-backfill.spec.ts`, query specs | 2,5,7      | ~150     | ~600    |

Segments 1 and 4 are independent and parallel; 2 gates 3/5/6/7/8.

Verify with `npx nx build backlog` + `npx nx lint backlog` + `npx nx test backlog`.

---

## 12. Test cases (with teeth)

### Unit — `write/link-citations.spec.ts`

- **Segment-boundary guard:** prefix `packages/foo` does **not** match `packages/foobar/x.ts`
  (negative control: drop the `/` guard → RED).
- **Longest prefix wins:** a path location (`packages/auth/src/index.ts`) beats its component
  (`packages/auth`); the location's component is the match.
- **Order-independence:** shuffle the index insertion order → identical result (the CODEOWNERS
  antipattern pin).
- **`..` cannot escape:** `packages/a/../../etc/passwd` normalizes without touching the FS.
- **Ambiguity:** two components with the same prefix → `ambiguous`, **no** edge written.
- **Unresolved:** a path outside every root → `unresolved`, **no** edge, write still succeeds.
- **Idempotency:** recompute twice → the same live edge set, no duplicate rows.

### Integration — `write/link-backfill.spec.ts` (real store)

- Create an issue with three citations across two projects → assert three live `implicates`
  edges with `provenance:'derived'`, each carrying the right `via`/`prefix`.
- **Discovery:** a citation under a registered project root but in an unregistered package →
  a component is auto-minted with `metadata.discovered:true`; a second identical citation does
  **not** mint a second component (idempotent by path).
- **Carry-forward:** `update` with a new body (supersede) → the `implicates` edges survive onto
  the successor with their `meta` intact (pin the residual sweep's coverage of the new rel).
- **Registry path change:** move a component's path → the affected issues' edges recompute.
- **Manual edge untouched:** hand-write an `asserted` `implicates` edge → recompute leaves it
  alone (negative control: make recompute ignore `provenance` → RED).
- **Backfill determinism:** run the tool twice on a fixture store → byte-identical edge set.

### Query — real store

- `filter.implicatesComponent:'X'` + `status:'open'` returns exactly the issues with a derived
  edge to X (not the ones merely placed on X).
- `filter.implicatesProjects:['Y','Z']` returns only issues touching **both**.
- ADR-0017: `implicatesProjects: []` returns zero, never the whole store.
- `view:'overlap', overlapAxis:'implicates'` groups a multi-component issue into every group;
  the four existing axes' outputs are **unchanged** (regression pin).
- `fields:['implicates']` returns the component+project pairs.

### Consumer proof (AGENTS.md §7)

- Drive the **real built CLI**: create an issue with a cross-project citation, then
  `query --input '{"filter":{"implicatesComponent":"…"}}'` and assert the issue appears; key on
  the exit code, not stdout.

---

## 13. Open questions for the owner

1. **`filter.component` — extend or add?** Recommend **add** `implicatesComponent` (keep
   `component` = home placement). Extending `component` to union placement+derived would make
   "all issues touching X" a one-word change but silently redefine every existing
   component-scoped scan and the skill's documented semantics.
2. **Auto-discovery — on by default, or only when the project root is registered?** Recommend
   the bounded form (§2.4): mint a discovered component **only** under a registered project
   root. Unbounded minting risks registry bloat.
3. **Discovered vs declared — should a discovered component ever auto-promote?** Recommend: a
   human `upsert-component` on the same `(project, name)` merges into it and clears
   `metadata.discovered`. Confirm.
4. **`registry-delete` on a component with live `implicates` edges** — refuse (recommended,
   consistent with the redesign's safe default) or cascade-invalidate the derived edges?
5. **The backfill's blocking condition.** Should a path-less project **fail** the backfill
   (recommended — never silently produce zero links) or warn and skip?
6. **`implicates` direction** — issue→component (recommended; travels with the issue on
   supersede) or component→issue (mirrors `owns_component`)? Both query correctly; the choice is
   about which direction the residual sweep handles most naturally.
7. **Manual-assert verb** — out of scope here. Is a future `implicate(uid, componentUid, action)`
   wanted, or is citation-derivation the only way links should ever exist?

---

_No code was written or modified by this pass. The `.worktrees/backlog-v2` tree was read-only
throughout. All line references are to the `backlog-v2` worktree unless a path names the main
repo._
