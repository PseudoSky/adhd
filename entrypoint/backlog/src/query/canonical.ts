/**
 * canonical.ts — the issue-level generalization of C1's one-hop redirect,
 * over the RESERVED `duplicate_of` relation ONLY (C9 `canonical.ts` row).
 *
 * `duplicate_of` is `n:1` on its source (`EDGE_KIND_TABLE`): a duplicate names
 * at most one thing it duplicates. So `A → C`, `B → C` is a forest whose every
 * member resolves to the SAME head `C` — exactly the "two duplicates, one
 * canonical" shape the reserved relation encodes. This module walks that chain
 * to its head (cycle-guarded and bounded, mirroring `currentUidOf`'s defensive
 * walk), then applies C1's `resolveLogicalIssue` (merge redirect + `SUPERSEDES`
 * chain) to the head.
 *
 * **The similarity path NEVER calls this.** `similar_to` is `n:m` and advisory;
 * it has no canonical head. This resolver exists only for the reviewed
 * actual-same judgement (`duplicate_of`), which stays reserved and untouched.
 *
 * `resolveCanonicalIssue` is read-only and NEVER throws on a linked uid: an
 * unresolvable or soft-deleted input is returned unchanged. A `duplicate_of`
 * cycle is impossible by construction (not DB-enforced) and is bounded rather
 * than spun on.
 */

import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { resolveLogicalIssue, resolveUidPrefix } from './resolve.js';

/** Upper bound on any chain walk here — a cycle is impossible by construction but must never spin (mirrors `currentUidOf`). */
const MAX_CHAIN_HOPS = 1000;

/**
 * Follow outgoing `duplicate_of` edges to the last live node in the chain.
 * Returns `start` when it has no live successor.
 */
async function walkDuplicateOfChain(
  graph: GraphBackend,
  start: NodeRecord
): Promise<NodeRecord> {
  const seen = new Set<number>([start.id]);
  let head = start;
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    const edges = await graph.getEdges({ src: head.id, rel: 'duplicate_of' });
    const nextId = edges.find((e) => !seen.has(e.dst))?.dst;
    if (nextId === undefined) return head;
    seen.add(nextId);
    const [next] = await graph.getNodesByIds([nextId]);
    if (!next || next.tInvalid !== undefined) return head;
    head = next;
  }
  return head;
}

/**
 * Resolve `uid` to the canonical head of its reserved `duplicate_of` chain.
 * Read-only; returns the input uid when it resolves to nothing or is unlinked.
 * Never throws on a linked uid.
 */
export async function resolveCanonicalIssue(
  graph: GraphBackend,
  uid: string
): Promise<string> {
  let start: NodeRecord;
  try {
    start = await resolveUidPrefix(graph, uid);
  } catch {
    return uid;
  }
  if (start.tInvalid !== undefined) return uid;
  const head = await walkDuplicateOfChain(graph, start);
  const logical = await resolveLogicalIssue(graph, head.uid);
  return logical.uid;
}

interface ITxCanonicalRow {
  rowid: number;
  uid: string;
  meta: string | null;
  t_invalid: string | null;
  is_superseded: number | null;
}

const TX_ROW_SELECT =
  'SELECT rowid, uid, meta, t_invalid, is_superseded FROM node';

function parseRedirect(meta: string | null): string | undefined {
  if (!meta) return undefined;
  try {
    const parsed = JSON.parse(meta) as Record<string, unknown>;
    return typeof parsed.redirectTo === 'string' ? parsed.redirectTo : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tx-scoped {@link resolveCanonicalIssue} for the reserved same-judgement
 * write path: the same chain walk (duplicate_of → one-hop redirect →
 * `SUPERSEDES` head), hand-composed against the transaction handle rather than
 * a bare `GraphBackend` (ADR-0002 — one concept, one algorithm).
 */
export async function resolveIssueCanonicalTx(
  tx: AdapterTransaction,
  uid: string
): Promise<string> {
  const startRow = await tx.executeGet<ITxCanonicalRow>(
    `${TX_ROW_SELECT} WHERE uid = ? LIMIT 1`,
    [uid]
  );
  if (!startRow) return uid;
  if (startRow.t_invalid !== null) return uid;
  let current: ITxCanonicalRow = startRow;

  // Reserve `duplicate_of` chain walk (n:1, so at most one outgoing edge).
  const seen = new Set<number>([current.rowid]);
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    const edge = await tx.executeGet<{ dst: number }>(
      "SELECT dst FROM edge WHERE src = ? AND rel = 'duplicate_of' AND t_invalid IS NULL ORDER BY rowid ASC LIMIT 1",
      [current.rowid]
    );
    if (!edge || seen.has(edge.dst)) break;
    seen.add(edge.dst);
    const next = await tx.executeGet<ITxCanonicalRow>(
      `${TX_ROW_SELECT} WHERE rowid = ?`,
      [edge.dst]
    );
    if (!next) break;
    if (next.t_invalid !== null) break;
    current = next;
  }

  // C1's one-hop merge redirect (project/component rows carry `redirectTo`;
  // honoured here for a redirect shape on an issue too, defensively).
  const redirectUid = parseRedirect(current.meta);
  if (redirectUid !== undefined) {
    const target = await tx.executeGet<ITxCanonicalRow>(
      `${TX_ROW_SELECT} WHERE uid = ? LIMIT 1`,
      [redirectUid]
    );
    if (target?.t_invalid === null) current = target;
  }

  // `SUPERSEDES` chain: the successor is the `src` of the edge whose `dst` is
  // the current node (update mints new and writes `SUPERSEDES` new→old).
  const seenSuccessors = new Set<number>();
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
    const successor = await tx.executeGet<{ src: number }>(
      "SELECT src FROM edge WHERE dst = ? AND rel = 'SUPERSEDES' AND t_invalid IS NULL ORDER BY rowid ASC LIMIT 1",
      [current.rowid]
    );
    if (!successor || seenSuccessors.has(successor.src)) break;
    seenSuccessors.add(successor.src);
    const next = await tx.executeGet<ITxCanonicalRow>(
      `${TX_ROW_SELECT} WHERE rowid = ?`,
      [successor.src]
    );
    if (!next) break;
    if (next.t_invalid !== null) break;
    current = next;
    if (next.is_superseded !== 1) break; // the head of the chain
  }

  return current.uid;
}
