/**
 * edges.ts — Pass 2: cross-issue structural edges (SPEC.md §8.3/§8.6 step 6).
 * Runs only after Pass 1's crosswalk is complete for every issue this ETL
 * will ever write (resumed + freshly imported) — every edge endpoint is
 * therefore either resolvable or a genuine dangling reference (§8.4).
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { resolveEdgeKindTx } from '../../src/write/catalog.js';
import { type IWriteStoreHandle, executeWriteTransaction, getNodeByUidTx, nowISO, writeEdgeTx } from '../../src/write/tx.js';
import type { IRawEdgeRow } from './corpus-types.js';

export interface IDanglingReference {
  srcRowid: number;
  dstRowid: number;
  rel: string;
  targetRel: string;
  reason: 'source-endpoint-unresolved' | 'target-endpoint-unresolved' | 'endpoint-not-an-imported-item';
}

export interface IPass2Result {
  edgesWritten: number;
  danglingReferences: IDanglingReference[];
  /** source `rel` values this ETL deliberately does not map to any backlog edge (SPEC.md §8.3's own table, plus the disclosed `ASSIGNED_TO` gap — see the ETL run report). Counted so nothing "just doesn't show up" unexplained. */
  droppedByRel: Record<string, number>;
}

/** SPEC.md §8.3 — source `rel` → backlog `rel`, same direction unless noted. `DEPENDS_ON` is REVERSED (dependent→dependency in the source becomes blocker→blocked in the backlog schema). */
const REL_MAP: Record<string, { targetRel: string; reversed: boolean }> = {
  RELATES_TO: { targetRel: 'relates_to', reversed: false },
  SUPERSEDES: { targetRel: 'supersedes', reversed: false },
  SAME_AS: { targetRel: 'duplicate_of', reversed: false },
  PART_OF: { targetRel: 'part_of', reversed: false },
  DEPENDS_ON: { targetRel: 'blocks', reversed: true },
};

/** source `rel` values with NO backlog destination — dropped, with the reason each is safe to drop (SPEC.md §8.3, plus the `ASSIGNED_TO` gap this ETL discloses since §8.3's own table is silent on it). */
const DROPPED_RELS = new Set(['MEMBER_OF', 'IN_REPO', 'IN_PACKAGE', 'PROJECT_OF', 'DERIVED_FROM', 'ASSIGNED_TO']);

export async function writeCrossIssueEdges(
  handle: IWriteStoreHandle,
  edges: readonly IRawEdgeRow[],
  crosswalk: ReadonlyMap<number, string>,
  knownItemRowids: ReadonlySet<number>,
): Promise<IPass2Result> {
  const danglingReferences: IDanglingReference[] = [];
  const droppedByRel: Record<string, number> = {};
  let edgesWritten = 0;

  const structural = edges.filter((e) => {
    if (REL_MAP[e.rel]) return true;
    if (DROPPED_RELS.has(e.rel)) {
      droppedByRel[e.rel] = (droppedByRel[e.rel] ?? 0) + 1;
      return false;
    }
    // A `rel` neither mapped nor in the acknowledged drop-list is a genuine
    // schema surprise (the source `edge` CHECK constraint's full union is
    // MENTIONS/SUPPORTS/RELATES_TO/SUPERSEDES/DERIVED_FROM/MEMBER_OF/
    // PART_OF/SAME_AS/ASSIGNED_TO/DEPENDS_ON — every one of those ten is
    // accounted for above, so this branch is unreachable against the
    // frozen corpus; kept as a loud failure rather than a silent drop in
    // case a future re-extract ever adds one).
    throw new Error(`edges.ts: unmapped, undropped source edge rel "${e.rel}" (rowid=${e.rowid}) — the ETL's REL_MAP/DROPPED_RELS table is incomplete.`);
  });

  if (structural.length === 0) return { edgesWritten, danglingReferences, droppedByRel };

  await executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();
    const ruleCache = new Map<string, Awaited<ReturnType<typeof resolveEdgeKindTx>>>();
    const getRule = async (rel: string) => {
      const cached = ruleCache.get(rel);
      if (cached) return cached;
      const rule = await resolveEdgeKindTx(tx, rel);
      ruleCache.set(rel, rule);
      return rule;
    };

    for (const edge of structural) {
      const mapping = REL_MAP[edge.rel];
      const srcSourceNodeId = mapping.reversed ? edge.dst : edge.src;
      const dstSourceNodeId = mapping.reversed ? edge.src : edge.dst;

      const srcUid = crosswalk.get(srcSourceNodeId);
      const dstUid = crosswalk.get(dstSourceNodeId);
      if (srcUid === undefined) {
        danglingReferences.push({
          srcRowid: srcSourceNodeId, dstRowid: dstSourceNodeId, rel: edge.rel, targetRel: mapping.targetRel,
          reason: knownItemRowids.has(srcSourceNodeId) ? 'source-endpoint-unresolved' : 'endpoint-not-an-imported-item',
        });
        continue;
      }
      if (dstUid === undefined) {
        danglingReferences.push({
          srcRowid: srcSourceNodeId, dstRowid: dstSourceNodeId, rel: edge.rel, targetRel: mapping.targetRel,
          reason: knownItemRowids.has(dstSourceNodeId) ? 'target-endpoint-unresolved' : 'endpoint-not-an-imported-item',
        });
        continue;
      }

      const [srcRow, dstRow] = await Promise.all([getNodeByUidTx(tx, srcUid), getNodeByUidTx(tx, dstUid)]);
      if (!srcRow || !dstRow) {
        // The crosswalk claimed these uids exist (from a prior or this-run
        // audit note) but a live row no longer resolves — a genuine
        // dangling reference, not a lookup bug (an item's uid never
        // changes once minted; only invalidation could make `getNodeByUidTx`
        // return a row with `tInvalid !== null`, which it still DOES
        // return — `getNodeByUidTx` doesn't filter on liveness — so a
        // `null` here means the rowid truly doesn't exist).
        danglingReferences.push({ srcRowid: srcSourceNodeId, dstRowid: dstSourceNodeId, rel: edge.rel, targetRel: mapping.targetRel, reason: 'source-endpoint-unresolved' });
        continue;
      }

      const rule = await getRule(mapping.targetRel);
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: srcRow.rowid, srcUid: srcRow.uid, srcKind: srcRow.kind,
        dstRowid: dstRow.rowid, dstUid: dstRow.uid, dstKind: dstRow.kind,
        rel: mapping.targetRel, rule, typePolicy: handle.typePolicy,
      });
      edgesWritten += 1;
    }
  });

  return { edgesWritten, danglingReferences, droppedByRel };
}
