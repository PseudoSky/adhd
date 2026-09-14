/**
 * corpus-loader.ts — reads the FROZEN `corpus.jsonl`/`edges.jsonl` extract
 * (scratchpad/extract/report.md) off disk into memory. This is the ETL's
 * ONLY source of data — no old in-tree store module is ever imported, and
 * the source `.jsonl` files themselves are only ever read, never written
 * (this module has no `fs.write*` call at all).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IAuditEventRow, IItemRow, IRawAuditMeta, IRawEdgeRow, IRawItemMeta, IRawNodeRow } from './corpus-types.js';

export interface ILoadedCorpus {
  /** Every backlog-item row (live + invalidated), sorted by `rowid` ascending — a deterministic, restart-stable processing order. */
  items: IItemRow[];
  /** Every backlog-audit-event row whose `meta.kind === 'transition'` or `'claim'` AND whose `itemNodeId` resolves to a real item rowid, grouped by that `itemNodeId`, each group sorted by `at` ascending. Malformed/anomalous audit-event rows (no resolvable `itemNodeId`, e.g. the corrupted `kind:'FEAT'` row this corpus contains — see the ETL run report) are recorded separately in {@link ILoadedCorpus.anomalousAuditEvents}, never silently merged in. */
  transitionEventsByItemRowid: Map<number, IRawAuditMeta[]>;
  claimEventsByItemRowid: Map<number, IRawAuditMeta[]>;
  anomalousAuditEvents: IAuditEventRow[];
  /** Every edge row, live only (`t_invalid IS NULL` — this store has zero invalidated edges, but the filter is applied on principle, not by observed accident). */
  edges: IRawEdgeRow[];
}

function parseJsonLines<T>(path: string): T[] {
  const raw = readFileSync(path, 'utf8');
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Loads `corpus.jsonl` + `edges.jsonl` from `extractDir` and indexes them
 * for the two-pass ETL. `rowid` (the source node's own internal id, called
 * `nodeId` on `BacklogItem` — SPEC.md §8.3: "used only as the ETL's own
 * join key") is the join key throughout: audit events join to their item via
 * `meta.itemNodeId`, and Pass-2 edges join via their raw `src`/`dst`
 * integers — both are already the exact source `rowid` values this loader
 * indexes by, so no business-key (`repo`/`sourceRef`) lookup is ever needed
 * to resolve a STRUCTURAL reference within a single run (SPEC.md's own
 * `(repo, sourceRef)` crosswalk is reused later, in `identity.ts`, purely
 * for the DURABLE cross-restart resume set — a different concern).
 */
export function loadCorpus(extractDir: string): ILoadedCorpus {
  const nodeRows = parseJsonLines<IRawNodeRow>(join(extractDir, 'corpus.jsonl'));
  const edgeRows = parseJsonLines<IRawEdgeRow>(join(extractDir, 'edges.jsonl'));

  const items: IItemRow[] = [];
  const auditEventRows: IAuditEventRow[] = [];

  for (const row of nodeRows) {
    const ex = row._extract;
    if (ex.is_backlog_item) {
      const metaParsed = isPlainObject(ex.meta_parsed) ? (ex.meta_parsed as IRawItemMeta) : {};
      items.push({ ...row, itemMeta: metaParsed });
    } else if (ex.is_backlog_audit_event) {
      const metaParsed = isPlainObject(ex.meta_parsed) ? (ex.meta_parsed as IRawAuditMeta) : {};
      auditEventRows.push({ ...row, auditMeta: metaParsed });
    }
    // backlog-plan and the sole entity(`someone`) rows: neither is imported
    // as a first-class backlog node (SPEC.md §8.1/§8.3 — folded into audit
    // notes or dropped with the information preserved elsewhere); nothing to
    // index for them here.
  }
  items.sort((a, b) => a.rowid - b.rowid);

  const transitionEventsByItemRowid = new Map<number, IRawAuditMeta[]>();
  const claimEventsByItemRowid = new Map<number, IRawAuditMeta[]>();
  const anomalousAuditEvents: IAuditEventRow[] = [];

  for (const row of auditEventRows) {
    const { auditMeta } = row;
    const itemNodeId = auditMeta.itemNodeId;
    if (typeof itemNodeId !== 'number' || !auditMeta.at || (auditMeta.kind !== 'transition' && auditMeta.kind !== 'claim')) {
      // Genuine source-data anomaly (e.g. this corpus's one `kind:'FEAT'`
      // audit-event row whose `meta` is a full item snapshot, not the
      // expected `{itemNodeId, kind, at, detail}` shape). Recorded for the
      // run report's disclosure, never silently dropped and never forced
      // into the reconstruction it doesn't fit.
      anomalousAuditEvents.push(row);
      continue;
    }
    const bucket = auditMeta.kind === 'transition' ? transitionEventsByItemRowid : claimEventsByItemRowid;
    const arr = bucket.get(itemNodeId) ?? [];
    arr.push(auditMeta);
    bucket.set(itemNodeId, arr);
  }
  for (const arr of transitionEventsByItemRowid.values()) arr.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const arr of claimEventsByItemRowid.values()) arr.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const edges = edgeRows.filter((e) => e._extract.state === 'live');

  return { items, transitionEventsByItemRowid, claimEventsByItemRowid, anomalousAuditEvents, edges };
}
