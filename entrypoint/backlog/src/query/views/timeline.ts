/**
 * views/timeline.ts — the `timeline` verb's read (91a8c640, S11.S3/S4; B-AC7):
 * "what did session S do, and what did its children do", from the append-only
 * op-event log (NOT from `auditTrail`).
 *
 * The descendant walk follows `child_of_session` in reverse, bounded at depth
 * {@link MAX_SESSION_DEPTH} with a visited set so a cyclic or pathological
 * chain terminates. Ops are ordered by `(t, rowid)`; `touched` is the distinct
 * `targetUid` set over ALL the session set's ops (not just the page).
 */
import type { GraphBackend } from '@adhd/sox-graph-store';
import { BacklogValidationError } from '../../write/errors.js';
import { loadOpEvents, loadParents, loadSessions, SessionNotFoundError } from './sessions.js';

export const MAX_SESSION_DEPTH = 16;
export const DEFAULT_TIMELINE_LIMIT = 500;
export const MAX_TIMELINE_LIMIT = 5000;

export interface ITimelineInput {
  /** The session to report on. */
  sessionId: string;
  /** Include descendant sessions' ops (default true). */
  includeChildren?: boolean;
  /** Max ops in the page (default 500, max 5000). */
  limit?: number;
  /** Opaque cursor: the previous page's `nextCursor`. */
  after?: string;
}

export interface ITimelineOp {
  sessionId: string;
  agent: string;
  op: string;
  targetUid: string;
  delta: Record<string, unknown>;
  t: string;
}

export interface ITimelineResult {
  session: {
    sessionId: string;
    agent: string;
    startedAt: string;
    endedAt?: string;
    parentSessionId?: string;
  };
  /** Descendant session ids (empty when `includeChildren:false`). */
  children: string[];
  ops: ITimelineOp[];
  /** Distinct `targetUid`s over every op of the session set. */
  touched: string[];
  hasMore: boolean;
  nextCursor?: string;
}

export async function timeline(graph: GraphBackend, input: ITimelineInput): Promise<ITimelineResult> {
  if (typeof input.sessionId !== 'string' || input.sessionId.trim().length === 0) {
    throw new BacklogValidationError('sessionId', 'is required');
  }
  const limit = input.limit ?? DEFAULT_TIMELINE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_TIMELINE_LIMIT) {
    throw new BacklogValidationError('limit', `must be a positive integer <= ${MAX_TIMELINE_LIMIT}, got ${limit}`);
  }
  const sessions = await loadSessions(graph);
  const root = sessions.get(input.sessionId);
  if (root === undefined) throw new SessionNotFoundError(input.sessionId);
  const parents = await loadParents(graph, sessions);

  const include = input.includeChildren !== false;
  const set = new Set<string>([input.sessionId]);
  const children: string[] = [];
  if (include) {
    const byParent = new Map<string, string[]>();
    for (const [child, parent] of parents) byParent.set(parent, [...(byParent.get(parent) ?? []), child]);
    let frontier = [input.sessionId];
    for (let depth = 0; depth < MAX_SESSION_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const child of (byParent.get(id) ?? []).sort()) {
          if (set.has(child)) continue;
          set.add(child);
          children.push(child);
          next.push(child);
        }
      }
      frontier = next;
    }
  }

  const events = await loadOpEvents(graph, sessions, set);
  const touched = [...new Set(events.map((e) => e.targetUid))].sort();

  let start = 0;
  if (input.after !== undefined) {
    const idx = events.findIndex((e) => `${e.t}#${e.rowid}` === input.after);
    if (idx < 0) throw new BacklogValidationError('after', 'is not a cursor from this timeline');
    start = idx + 1;
  }
  const page = events.slice(start, start + limit);
  const hasMore = start + limit < events.length;
  const rootMeta = root.metadata ?? {};
  const parent = parents.get(input.sessionId);
  const lastT = events.length > 0 ? events[events.length - 1]!.t : undefined;
  const endedAt =
    typeof rootMeta['endedAt'] === 'string'
      ? (rootMeta['endedAt'] as string)
      : events.filter((e) => e.sessionId === input.sessionId).pop()?.t ?? lastT;
  return {
    session: {
      sessionId: input.sessionId,
      agent: typeof rootMeta['agent'] === 'string' ? (rootMeta['agent'] as string) : '',
      startedAt: typeof rootMeta['startedAt'] === 'string' ? (rootMeta['startedAt'] as string) : root.tCreated,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(parent !== undefined ? { parentSessionId: parent } : {}),
    },
    children,
    ops: page.map(({ sessionId, agent, op, targetUid, delta, t }) => ({ sessionId, agent, op, targetUid, delta, t })),
    touched,
    hasMore,
    ...(hasMore && page.length > 0
      ? { nextCursor: `${page[page.length - 1]!.t}#${page[page.length - 1]!.rowid}` }
      : {}),
  };
}
