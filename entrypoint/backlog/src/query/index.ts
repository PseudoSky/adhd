/**
 * index.ts — the `@adhd/backlog` read/query layer's public surface
 * (SPEC.md §5, §5a, §6.1, §6.3.1, §6.5, §3a).
 *
 * **Layout:**
 * - `types.ts` — every shared TS shape (`IIssueCard`, `IIssueField`,
 *   `IIssueQueryInput`/`IIssueFilter`, `IIssuePage`, registry types). Import
 *   from here, not from `get.ts`/`query.ts`/`card.ts` directly, to avoid
 *   depending on an implementation module's re-export surface.
 * - `resolve.ts` — read-only (non-transactional) uid/name resolution and edge
 *   traversal, built directly on the bare `GraphBackend` (see that file's own
 *   doc comment for why this is safe, unlike `write/tx.ts`'s hand-composed
 *   forms). The six sibling write verbs (`update`/`transition`/`claim`/
 *   `relate`/`move`/`delete`) should import from here for any READ they need
 *   OUTSIDE their own `immediate` transaction (e.g. resolving a `filter`
 *   parameter, or re-reading a node post-commit to build their own outcome's
 *   card) — never re-implement uid/name resolution a third time.
 * - `card.ts` — `assembleIssueCard`/`assembleIssueCards`: projects a live
 *   `issue` `NodeRecord` onto a requested `IIssueField` list. The six sibling
 *   write verbs' own outcome shapes (`IUpdateOutcome`, `ITransitionOutcome`,
 *   etc.) embed card-shaped fields (SPEC.md §6.3) — call `assembleIssueCard`
 *   post-commit rather than hand-rolling a second field-projection pass.
 * - `get.ts` — the `get` verb (§6.3.1).
 * - `query.ts` — the `query` verb (§5, §5a, §6.5) and its `view` union
 *   (`list`/`ready`/`graph`/`order`/`stale`/`similar`/`overlap`).
 * - `views/registry.ts` — §3a's registry read surface (`projects`/`components`/
 *   `locations`/`lookup`/registry `get` detail).
 * - `views/stats.ts` — the stats/rollup read views (§5): the status-aware
 *   priority matrix (`priorityMatrix`, BUG-023), the `part_of` hierarchy
 *   rollup (`partOfRollup`, FEAT-005 — transitive, not one-level), and
 *   `validAt` point-in-time cumulative-open curves (`openCurve`).
 * - `views/semantic.ts` — the semantic read views (§5a, FEAT-022):
 *   `querySimilarView` (`view:'similar'`) and the shared fused-relevance
 *   ranking primitive (`rankByFusedRelevance`). `query.ts`'s `case 'similar':`
 *   dispatch calls `querySimilarView` directly — there is no second,
 *   embedding-only `view:'similar'` implementation left in `query.ts`.
 *
 * **Reconciliation note for the write layer.** `write/create-issue.ts`
 * declares its OWN `ICreateIssueCard` (a narrower, always-fully-populated
 * shape it builds inline from data it already has after a fresh insert — it
 * never needs a field-projected read; named distinctly from this module's
 * `IIssueCard` on purpose — see that file's doc comment for
 * BUG-APIGEN-CORE-CLIENT-BARE-NAME-COLLISION-001, a real apigen-core-client
 * extraction defect the original shared bare name `IIssueCard` triggered
 * once both types became simultaneously reachable from `api.d.ts`). This
 * module's {@link IIssueCard} (from `types.ts`) is the FIELDS-PROJECTED
 * read-layer shape every OTHER verb should use — the two are intentionally
 * not unified in this slice (unifying them means either widening
 * `create-issue.ts`'s always-populated shape to all-optional, or teaching
 * this module's card assembler to skip a post-insert read entirely; both are
 * a `create-issue.ts` edit, out of scope for a read-layer-only task). A
 * future consolidation should re-export `create-issue.ts`'s result through
 * THIS module's `IIssueCard` instead of maintaining two card shapes.
 */

export * from './types.js';
export * from './resolve.js';
export * from './card.js';
export * from './get.js';
export * from './query.js';
export * from './views/registry.js';
export * from './views/stats.js';
export * from './views/semantic.js';
