/**
 * views/sessions.ts — `query {view:"sessions"}` (91a8c640, S11.S1; B-AC5) and
 * the session/op-event reads `timeline` (B-AC7) is built on.
 *
 * A session's `endedAt` is the explicit `meta.endedAt` if one was ever
 * recorded, else the `t` of its latest op-event (there is no end verb: a
 * session "ends" when it stops acting). Reads only.
 */
import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import { BacklogValidationError } from '../../write/errors.js';
import type { IIssueQueryInput, ISessionSummary } from '../types.js';

/** Raised when a `timeline` names a session id that does not exist (maps to `item_not_found`). */
export class SessionNotFoundError extends Error {
  readonly code = 'E_SESSION_NOT_FOUND' as const;
  constructor(readonly sessionId: string) {
    super(`session "${sessionId}" not found`);
    this.name = 'SessionNotFoundError';
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** `sessionId` -> node, over every live session node. */
export async function loadSessions(graph: GraphBackend): Promise<Map<string, NodeRecord>> {
  const nodes = await graph.queryNodes({ kind: 'session', liveOnly: true });
  const out = new Map<string, NodeRecord>();
  for (const n of nodes) {
    const id = str(n.metadata?.['sessionId']);
    if (id !== undefined && !out.has(id)) out.set(id, n);
  }
  return out;
}

/** child sessionId -> parent sessionId, from the live `child_of_session` edges. */
export async function loadParents(
  graph: GraphBackend,
  sessions: ReadonlyMap<string, NodeRecord>
): Promise<Map<string, string>> {
  const byRowid = new Map<number, string>();
  for (const [id, n] of sessions) byRowid.set(n.id, id);
  const edges = await graph.getEdges({ rel: 'child_of_session' });
  const out = new Map<string, string>();
  for (const e of edges) {
    const child = byRowid.get(e.src);
    const parent = byRowid.get(e.dst);
    if (child !== undefined && parent !== undefined) out.set(child, parent);
  }
  return out;
}

export interface IOpEventRow {
  sessionId: string;
  agent: string;
  op: string;
  targetUid: string;
  delta: Record<string, unknown>;
  t: string;
  rowid: number;
}

/** Every op-event of the given sessions, ordered by `(t, rowid)`. */
export async function loadOpEvents(
  graph: GraphBackend,
  sessions: ReadonlyMap<string, NodeRecord>,
  sessionIds: ReadonlySet<string>
): Promise<IOpEventRow[]> {
  const rows: IOpEventRow[] = [];
  const edges = await graph.getEdges({ rel: 'in_session' });
  const wanted = new Set<number>();
  for (const id of sessionIds) {
    const n = sessions.get(id);
    if (n) wanted.add(n.id);
  }
  const eventIds = edges.filter((e) => wanted.has(e.dst)).map((e) => e.src);
  if (eventIds.length === 0) return rows;
  const nodes = await graph.getNodesByIds(eventIds);
  for (const n of nodes) {
    if (n.kind !== 'op_event' || n.tInvalid) continue;
    const m = n.metadata ?? {};
    const sessionId = str(m['sessionId']);
    const t = str(m['t']);
    if (sessionId === undefined || t === undefined) continue;
    rows.push({
      sessionId,
      agent: str(m['agent']) ?? '',
      op: str(m['op']) ?? n.name ?? '',
      targetUid: str(m['targetUid']) ?? '',
      delta: (m['delta'] !== null && typeof m['delta'] === 'object' ? m['delta'] : {}) as Record<string, unknown>,
      t,
      rowid: n.id,
    });
  }
  rows.sort((a, b) => a.t.localeCompare(b.t) || a.rowid - b.rowid);
  return rows;
}

/** `view:'sessions'` — list sessions, filterable by `sessionId`, `agent`, `parentSessionId`. */
export async function querySessions(
  graph: GraphBackend,
  input: IIssueQueryInput
): Promise<{ items: ISessionSummary[]; total: number; hasMore: boolean; limit: number }> {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new BacklogValidationError('limit', `must be a positive integer <= 1000, got ${limit}`);
  }
  const f = input.filter ?? {};
  const sessions = await loadSessions(graph);
  const parents = await loadParents(graph, sessions);
  const events = await loadOpEvents(graph, sessions, new Set(sessions.keys()));
  const lastOp = new Map<string, string>();
  for (const e of events) lastOp.set(e.sessionId, e.t); // ordered ascending: last wins

  const all: ISessionSummary[] = [];
  for (const [sessionId, n] of sessions) {
    const m = n.metadata ?? {};
    const agent = str(m['agent']) ?? '';
    const parent = parents.get(sessionId) ?? null;
    if (f.sessionId !== undefined && sessionId !== f.sessionId) continue;
    if (f.agent !== undefined && agent !== f.agent) continue;
    if (f.parentSessionId !== undefined && parent !== f.parentSessionId) continue;
    all.push({
      sessionId,
      agent,
      startedAt: str(m['startedAt']) ?? n.tCreated,
      endedAt: str(m['endedAt']) ?? lastOp.get(sessionId) ?? null,
      parentSessionId: parent,
    });
  }
  all.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.sessionId.localeCompare(b.sessionId));
  return { items: all.slice(0, limit), total: all.length, hasMore: all.length > limit, limit };
}
