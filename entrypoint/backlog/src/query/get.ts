/**
 * get.ts — the `get` verb (SPEC.md §6.3.1).
 */

import type { GraphBackend } from '@adhd/sox-graph-store';
import { assertKnownIssueFields } from './card.js';
import { assembleIssueCard } from './card.js';
import { resolveIssueByUid } from './resolve.js';
import { DEFAULT_ISSUE_CARD_FIELDS, type IIssueCard, type IIssueGetInput } from './types.js';

/**
 * Fetch one issue by `uid`, projected to the requested `fields` (default:
 * the same five-field card `query` defaults to, SPEC.md §6.3.1/§6.5/AC-13).
 *
 * Errors: `IssueNotFoundError(uid)` (no live node carries `uid`),
 * `BacklogValidationError('fields', ...)` (an unknown field name).
 */
export async function getIssue(graph: GraphBackend, input: IIssueGetInput): Promise<IIssueCard> {
  assertKnownIssueFields(input.fields);
  const fields = input.fields ?? DEFAULT_ISSUE_CARD_FIELDS;
  const issue = await resolveIssueByUid(graph, input.uid);
  return assembleIssueCard(graph, issue, fields);
}
