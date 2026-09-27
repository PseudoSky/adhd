/**
 * redirect.ts — the ONE-HOP `Redirect` primitive for soft-retired registry rows
 * (C1, DESIGN §2 Primitive 1 / §6 Identity).
 *
 * **What a redirect is.** Retiring a duplicate `project` (or `component`) row
 * never hard-deletes it and never reuses its uid. Instead `write/merge-project.ts`
 * stamps the retired row with `t_invalid` and merges two keys into its `meta`:
 * `redirectTo` (the canonical survivor's uid) and `retiredAt`. The row remains
 * readable exactly once — as a pointer. {@link followRedirect} is the read-path
 * half of that contract: given a row, it returns the live survivor it names, or
 * `null` when the row carries no redirect at all.
 *
 * **One hop, by construction.** A redirect that points at another redirect is a
 * chain, not a redirect; following it would make "where does this token lead"
 * depend on how many merges happened to stack up, which is exactly the kind of
 * unbounded, order-dependent walk the design forbids. A chain longer than one
 * hop therefore throws rather than silently resolving to whatever happens to be
 * at the end — the same "never auto-select, refuse loudly" posture
 * `AmbiguousReferenceError` takes on the uid-prefix side. A redirect pointing at
 * a row that is missing or itself retired is likewise a broken invariant and
 * throws, never a silent `null` that a caller would read as "unresolved."
 *
 * ADR-0001: this module performs no writes and opens no transactions of its own
 * — it is a pure read against the committed snapshot, safe to call standalone.
 */

import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import { InvalidArgumentError } from '../write/errors.js';

/**
 * The stored shape of a soft-retired row's redirect. `toUid` is the canonical
 * live node the retired row points at; `reason` is the free-text explanation
 * recorded on the retired node's audit trail (and, when set, its
 * `meta.retiredReason`). Kept as a named contract so the merge writer and any
 * future reader share one shape rather than re-deriving it from `meta`.
 */
export interface IRedirect {
  /** The canonical uid this retired row points at. */
  toUid: string;
  /** Why the row was retired — recorded on the retired node's audit + meta. */
  reason: string;
}

/** The `meta` key a soft-retired row carries to point at its canonical survivor. */
const REDIRECT_META_KEY = 'redirectTo';

/**
 * If `record` is a soft-retired row carrying `meta.redirectTo`, return the
 * canonical live node it points at (one hop only; a redirect→redirect chain
 * longer than one hop throws). Otherwise `null`.
 *
 * `record` may itself be invalidated (`t_invalid` set) — that is the normal
 * case, since retiring a row is what gives it a redirect. The TARGET, by
 * contrast, must be a live node: a redirect into a tombstone is a broken
 * invariant, not an unresolved name, so it throws rather than degrading to
 * `null` (which a caller would misread as "this token leads nowhere").
 *
 * @throws InvalidArgumentError when the redirect target is missing/retired, or
 *   when the target is itself a redirect (a chain longer than one hop).
 */
export async function followRedirect(
  graph: GraphBackend,
  record: NodeRecord
): Promise<NodeRecord | null> {
  const rawTarget = record.metadata?.[REDIRECT_META_KEY];
  if (typeof rawTarget !== 'string' || rawTarget.length === 0) return null;

  const target = await graph.getNodeByUid(rawTarget);
  if (!target || target.tInvalid !== undefined) {
    throw new InvalidArgumentError(
      'redirectTo',
      `node "${record.uid}" redirects to "${rawTarget}", which is not a live node`
    );
  }

  const chained = target.metadata?.[REDIRECT_META_KEY];
  if (typeof chained === 'string' && chained.length > 0) {
    throw new InvalidArgumentError(
      'redirectTo',
      `redirect chain longer than one hop: "${record.uid}" -> "${rawTarget}" -> "${chained}"`
    );
  }

  return target;
}
