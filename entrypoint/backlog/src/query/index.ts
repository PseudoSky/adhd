/**
 * index.ts — the `@adhd/backlog` v2 read/query layer's public surface
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
 * - `registry.ts` — §3a's registry read surface (`projects`/`components`/
 *   `locations`/`lookup`/registry `get` detail).
 *
 * **Reconciliation note for the write layer.** `write/create-issue.ts`
 * declares its OWN `IIssueCard` (a narrower, always-fully-populated shape it
 * builds inline from data it already has after a fresh insert — it never
 * needs a field-projected read). This module's {@link IIssueCard} (from
 * `types.ts`) is the FIELDS-PROJECTED read-layer shape every OTHER verb
 * should use — the two are intentionally not unified in this slice (unifying
 * them means either widening `create-issue.ts`'s always-populated shape to
 * all-optional, or teaching this module's card assembler to skip a
 * post-insert read entirely; both are a `create-issue.ts` edit, out of scope
 * for a read-layer-only task). A future consolidation should re-export
 * `create-issue.ts`'s result through THIS module's `IIssueCard` instead of
 * maintaining two card shapes.
 */

export * from './types.js';
export * from './resolve.js';
export * from './card.js';
export * from './get.js';
export * from './query.js';
export * from './registry.js';
