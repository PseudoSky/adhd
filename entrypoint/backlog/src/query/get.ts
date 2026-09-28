/**
 * get.ts — the `get` verb (SPEC.md §6.3.1).
 */

import type { GraphBackend } from '@adhd/sox-graph-store';
import { assertKnownIssueFields } from './card.js';
import { assembleIssueCard } from './card.js';
import { resolveIssueByUid } from './resolve.js';
import { BacklogValidationError } from '../write/errors.js';
import {
  DEFAULT_ISSUE_CARD_FIELDS,
  type IIssueCard,
  type IIssueGetByUidInput,
} from './types.js';

/**
 * Fetch one issue by `uid`, projected to the requested `fields` (default:
 * the same five-field card `query` defaults to, SPEC.md §6.3.1/§6.5/AC-13).
 *
 * `lastN`/`after` bound the sub-collection pseudo fields (`auditTrail`/
 * `citations`/`related`/`blockers`) — `lastN` keeps the LAST N rows in each
 * resolver's own order (the audit trail's oldest-first order is sliced to its
 * newest tail), `after` resumes strictly after a uid. Both are opt-in; absent
 * means the unbounded behavior every existing caller already had.
 *
 * Errors: `IssueNotFoundError(uid)` (no live node carries `uid`),
 * `BacklogValidationError('fields'|'lastN', ...)` (an unknown field name, or
 * a non-positive/non-integer `lastN`).
 */
export async function getIssue(
  graph: GraphBackend,
  input: IIssueGetByUidInput
): Promise<IIssueCard> {
  assertKnownIssueFields(input.fields);
  if (
    input.lastN !== undefined &&
    (!Number.isInteger(input.lastN) || input.lastN <= 0)
  ) {
    throw new BacklogValidationError(
      'lastN',
      `must be a positive integer, got ${input.lastN}`
    );
  }
  const fields = input.fields ?? DEFAULT_ISSUE_CARD_FIELDS;
  const issue = await resolveIssueByUid(graph, input.uid);
  const bounds =
    input.lastN !== undefined || input.after !== undefined
      ? { lastN: input.lastN, after: input.after }
      : undefined;
  // C6 — a single-item `get` derives its verdict through rung 3 by default
  // (the list views stay at rung 2); a caller may raise it via `deriveThrough`.
  return assembleIssueCard(graph, issue, fields, {
    bounds,
    verdictRung: input.deriveThrough ?? 3,
  });
}
