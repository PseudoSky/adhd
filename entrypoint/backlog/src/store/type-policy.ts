/**
 * type-policy.ts — the ONE open-vocabulary `TypePolicy` this package injects
 * into every `GraphBackend` it opens.
 *
 * DATA_MODEL.md §0 point 5 requires an open-schema policy be injected: `kind`,
 * `status` and `priority` are open vocabularies (SPEC.md §0.2 — every distinct
 * string observed in the corpus becomes its own catalog row, no allowlist), so
 * a validating policy would reject legitimate data the moment a new kind
 * appears. The graph store's DEFAULT policy is not open, which is why leaving
 * it unset is a defect and not merely a default.
 *
 * This lived in two separate copies (the ETL's `store-bootstrap.ts` and the
 * test helper's `open-test-issue-store.ts`) while the production store opened
 * with no policy at all — so the two paths that were exercised agreed with
 * each other and disagreed with the one that ships. Single definition here,
 * imported by all three (CLAUDE.md's "Two-Use Refactor Rule").
 */
import type { TypePolicy } from '@adhd/sox-graph-store';

/** Unconditionally permissive — see this file's own doc comment for why. */
export const OPEN_TYPE_POLICY: TypePolicy = {
  validateKind(): void {
    /* open vocabulary: every kind is allowed */
  },
  validateRel(): void {
    /* open vocabulary: every rel is allowed */
  },
  validateEdge(): void {
    /* open vocabulary: every (srcKind, rel, dstKind) triple is allowed */
  },
};
