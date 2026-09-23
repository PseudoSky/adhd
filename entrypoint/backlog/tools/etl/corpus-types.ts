/**
 * corpus-types.ts — the shape of one line of the FROZEN
 * `corpus.jsonl`/`edges.jsonl` (scratchpad/extract/report.md). These are raw
 * `node`/`edge` table rows from the pre-existing store, read directly off
 * disk — this module never imports any old in-tree store code.
 *
 * `IRawItemMeta.humanId` / `IRawRenamedFromEntry.humanId` are the LITERAL
 * key names the frozen fixture's own JSON uses on disk — read here as raw
 * external data, not chosen vocabulary. `sourceRefOf()` below is the single
 * accessor every downstream module goes through instead of touching
 * `.humanId` directly; everywhere past that boundary (including the
 * `sourceRef`/`sourceRenamedFrom` provenance fields this ETL persists) uses
 * `sourceRef`, never `humanId`.
 */

export interface IRawCitation {
  file: string;
  lines?: string;
  context?: string;
  symbol?: string;
  blastRadius?: unknown;
}

export interface IRawNote {
  by: string;
  at: string;
  text: string;
}

export interface IRawRenamedFromEntry {
  repo: string;
  humanId: string;
  at: string;
}

/** `BacklogNodeMeta` (store/mapping.ts:111-185) as persisted in `node.meta` — only the fields `toBacklogItem` actually projects (SPEC.md §8.1's declared import source), plus `renamedFrom` (read directly, since `toBacklogItem` drops it — SPEC.md §8.4). */
export interface IRawItemMeta {
  humanId?: string;
  kind?: string;
  family?: string;
  title?: string;
  body?: string;
  status?: string;
  priority?: string;
  repo?: string;
  projectPath?: string;
  plan?: string;
  importedFrom?: string;
  assignee?: string;
  claimedBy?: string;
  claimedAt?: string;
  citations?: IRawCitation[];
  notes?: IRawNote[];
  createdAt?: string;
  updatedAt?: string;
  author?: string;
  reporter?: string;
  renamedFrom?: IRawRenamedFromEntry[];
  invalidatedReason?: string;
  invalidatedAt?: string;
  // Deliberately NOT typed here: archivedAt/dedupeSymbol/dedupePath/
  // dedupeErrorText/embedModel/embedContentHash. `toBacklogItem`
  // (store/mapping.ts:245-275) never copies these onto the `BacklogItem`
  // shape SPEC.md §8.1 scopes the import to — they are out of scope,
  // identically to how the live read path already treats them.
}

/**
 * The ONE accessor that touches the raw `.humanId` fixture key (see this
 * file's own doc comment) — every caller past this point uses `sourceRef`.
 */
export function sourceRefOf(meta: Pick<IRawItemMeta, 'humanId'>): string | undefined {
  return meta.humanId;
}

export interface IRawAuditDetail {
  from?: string;
  to?: string;
  by?: string;
  reason?: string;
  status?: string; // 'claim' kind events: {status, by}
}

export interface IRawAuditMeta {
  itemNodeId?: number;
  kind?: string; // 'transition' | 'claim' | (anomalous free values)
  at?: string;
  detail?: IRawAuditDetail;
}

export interface IRawPlanMeta {
  planSlug?: string;
}

export interface INodeExtract {
  state: 'live' | 'invalidated';
  invalidated_reason: string | null;
  invalidated_at_meta: string | null;
  tags_parsed: string[];
  meta_parsed: Record<string, unknown> | { __unparseable__: true; raw: unknown } | null;
  is_backlog_item: boolean;
  is_backlog_audit_event: boolean;
  is_backlog_plan: boolean;
}

export interface IRawNodeRow {
  rowid: number;
  uid: string;
  kind: string;
  content: string | null;
  name: string | null;
  summary: string | null;
  topic: string | null;
  tags: string | null;
  importance: number | null;
  confidence: number | null;
  content_hash: string | null;
  namespace: string | null;
  meta: string | null;
  agent_id: string | null;
  session_id: string | null;
  source: string | null;
  project_path: string | null;
  level: number | null;
  resume_state: string | null;
  t_occurred: string | null;
  t_expires: string | null;
  t_created: string;
  t_valid: string | null;
  t_invalid: string | null;
  is_superseded: number;
  access_count: number;
  last_access: string | null;
  t_updated: string | null;
  _extract: INodeExtract;
}

export interface IEdgeExtract {
  state: 'live' | 'invalidated';
  meta_parsed: Record<string, unknown> | null;
}

export interface IRawEdgeRow {
  rowid: number;
  src: number;
  dst: number;
  rel: string;
  weight: number | null;
  confidence: number | null;
  origin: string | null;
  meta: string | null;
  t_created: string;
  t_expired: string | null;
  t_valid: string | null;
  t_invalid: string | null;
  _extract: IEdgeExtract;
}

/** A backlog-item row, narrowed with its meta already cast to {@link IRawItemMeta}. */
export interface IItemRow extends IRawNodeRow {
  itemMeta: IRawItemMeta;
}

/** A backlog-audit-event row, narrowed with its meta already cast to {@link IRawAuditMeta}. */
export interface IAuditEventRow extends IRawNodeRow {
  auditMeta: IRawAuditMeta;
}
