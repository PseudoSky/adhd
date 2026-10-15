/**
 * views/timeline.ts — the `timeline` verb's read (91a8c640, S11.S3/S4; B-AC7):
 * "what did session S do, and what did its children do", from the append-only
 * op-event log (NOT from `auditTrail`).
 *
 * The descendant walk follows `child_of_session` in reverse, bounded at depth
 * {@link MAX_SESSION_DEPTH} with a visited set so a cyclic or pathological
 * chain terminates. Ops are ordered by `(t, rowid)`; `touched` is the distinct
 * `targetUid` set over ALL the session set's ops (not just the page).
 *
 * Without a `sessionId` the view covers EVERY session's ops whose `t` falls in
 * the window `[since, now]` (default: the last {@link DEFAULT_TIMELINE_WINDOW_DAYS}
 * days). The window keeps an unscoped read bounded on a long-lived store; pass
 * `since` to widen or narrow it.
 */
import type { GraphBackend, NodeRecord } from '@adhd/sox-graph-store';
import { BacklogValidationError } from '../../write/errors.js';
import { loadOpEvents, loadParents, loadSessions, SessionNotFoundError } from './sessions.js';
import type { IOpEventRow } from './sessions.js';

export const MAX_SESSION_DEPTH = 16;
export const DEFAULT_TIMELINE_LIMIT = 500;
export const MAX_TIMELINE_LIMIT = 5000;
/** Lookback applied when `sessionId` is omitted and no `since` is given. */
export const DEFAULT_TIMELINE_WINDOW_DAYS = 7;

export interface ITimelineInput {
  /** The session to report on. Omitted ⇒ every session's ops within the window (see `since`). */
  sessionId?: string;
  /** Include descendant sessions' ops (default true). Ignored when `sessionId` is omitted. */
  includeChildren?: boolean;
  /** Max ops in the page (default 500, max 5000). */
  limit?: number;
  /** Opaque cursor: the previous page's `nextCursor`. */
  after?: string;
  /**
   * ISO-8601 lower bound of the all-sessions window. Only valid when `sessionId`
   * is omitted. Default: {@link DEFAULT_TIMELINE_WINDOW_DAYS} days before now.
   */
  since?: string;
}

export interface ITimelineOp {
  sessionId: string;
  agent: string;
  op: string;
  targetUid: string;
  delta: Record<string, unknown>;
  t: string;
}

export interface ITimelineSession {
  sessionId: string;
  agent: string;
  startedAt: string;
  endedAt?: string;
  parentSessionId?: string;
}

export interface ITimelineResult {
  /** The reported session, or `null` when `sessionId` was omitted (all-sessions mode). */
  session: ITimelineSession | null;
  /** Descendant session ids (empty when `includeChildren:false` or in all-sessions mode). */
  children: string[];
  ops: ITimelineOp[];
  /** Distinct `targetUid`s over every op of the session set (or window). */
  touched: string[];
  hasMore: boolean;
  nextCursor?: string;
  /** `true` only when descendant sessions exist below depth {@link MAX_SESSION_DEPTH} and were NOT walked — the child set is then incomplete, never silently so. */
  truncated?: true;
  /** Present only in all-sessions mode: the inclusive lower bound (ISO-8601, UTC) that was applied. */
  window?: { since: string };
}

/** Validates `limit` and returns the effective page size. */
function resolveLimit(raw: number | undefined): number {
  const limit = raw ?? DEFAULT_TIMELINE_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_TIMELINE_LIMIT) {
    throw new BacklogValidationError('limit', `must be a positive integer <= ${MAX_TIMELINE_LIMIT}, got ${limit}`);
  }
  return limit;
}

/** Resolves `since` to a normalised UTC ISO-8601 instant, defaulting to the lookback window. */
function resolveSince(raw: string | undefined, now: number): string {
  if (raw === undefined) {
    return new Date(now - DEFAULT_TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new BacklogValidationError('since', `must be an ISO-8601 instant, got ${JSON.stringify(raw)}`);
  return new Date(parsed).toISOString();
}

/** Applies the `after` cursor and the page size to an ordered op list. */
function pageOf(
  events: readonly IOpEventRow[],
  after: string | undefined,
  limit: number
): { page: IOpEventRow[]; hasMore: boolean; nextCursor?: string } {
  let start = 0;
  if (after !== undefined) {
    const idx = events.findIndex((e) => `${e.t}#${e.rowid}` === after);
    if (idx < 0) throw new BacklogValidationError('after', 'is not a cursor from this timeline');
    start = idx + 1;
  }
  const page = events.slice(start, start + limit);
  const hasMore = start + limit < events.length;
  const last = page[page.length - 1];
  return {
    page,
    hasMore,
    ...(hasMore && last !== undefined ? { nextCursor: `${last.t}#${last.rowid}` } : {}),
  };
}

function opsOf(page: readonly IOpEventRow[]): ITimelineOp[] {
  return page.map(({ sessionId, agent, op, targetUid, delta, t }) => ({ sessionId, agent, op, targetUid, delta, t }));
}

/** All-sessions mode: every session's ops with `t >= since`, paged. */
async function windowTimeline(
  graph: GraphBackend,
  sessions: ReadonlyMap<string, NodeRecord>,
  input: ITimelineInput,
  limit: number
): Promise<ITimelineResult> {
  const since = resolveSince(input.since, Date.now());
  const all = await loadOpEvents(graph, sessions, new Set(sessions.keys()));
  const events = all.filter((e) => e.t >= since);
  const touched = [...new Set(events.map((e) => e.targetUid))].sort();
  const { page, hasMore, nextCursor } = pageOf(events, input.after, limit);
  return {
    session: null,
    children: [],
    ops: opsOf(page),
    touched,
    hasMore,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    window: { since },
  };
}

/** Session mode: one session's tree (optionally with descendants), paged. */
async function sessionTimeline(
  graph: GraphBackend,
  sessions: ReadonlyMap<string, NodeRecord>,
  sessionId: string,
  input: ITimelineInput,
  limit: number
): Promise<ITimelineResult> {
  const root = sessions.get(sessionId);
  if (root === undefined) throw new SessionNotFoundError(sessionId);
  const parents = await loadParents(graph, sessions);

  const include = input.includeChildren !== false;
  const set = new Set<string>([sessionId]);
  const children: string[] = [];
  let truncated = false;
  if (include) {
    const byParent = new Map<string, string[]>();
    for (const [child, parent] of parents) byParent.set(parent, [...(byParent.get(parent) ?? []), child]);
    let frontier = [sessionId];
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
    truncated = frontier.some((id) => (byParent.get(id) ?? []).some((c) => !set.has(c)));
  }

  const events = await loadOpEvents(graph, sessions, set);
  const touched = [...new Set(events.map((e) => e.targetUid))].sort();
  const { page, hasMore, nextCursor } = pageOf(events, input.after, limit);

  const rootMeta = root.metadata ?? {};
  const parent = parents.get(sessionId);
  const lastT = events.length > 0 ? events[events.length - 1]!.t : undefined;
  const endedAt =
    typeof rootMeta['endedAt'] === 'string'
      ? (rootMeta['endedAt'] as string)
      : events.filter((e) => e.sessionId === sessionId).pop()?.t ?? lastT;
  return {
    session: {
      sessionId,
      agent: typeof rootMeta['agent'] === 'string' ? (rootMeta['agent'] as string) : '',
      startedAt: typeof rootMeta['startedAt'] === 'string' ? (rootMeta['startedAt'] as string) : root.tCreated,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(parent !== undefined ? { parentSessionId: parent } : {}),
    },
    children,
    ops: opsOf(page),
    touched,
    hasMore,
    ...(truncated ? { truncated: true as const } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

export async function timeline(graph: GraphBackend, input: ITimelineInput): Promise<ITimelineResult> {
  const limit = resolveLimit(input.limit);
  if (input.sessionId === undefined) {
    const sessions = await loadSessions(graph);
    return windowTimeline(graph, sessions, input, limit);
  }
  if (input.sessionId.trim().length === 0) {
    throw new BacklogValidationError('sessionId', 'must not be blank (omit it for every session in the window)');
  }
  if (input.since !== undefined) {
    throw new BacklogValidationError('since', 'applies only when sessionId is omitted');
  }
  const sessions = await loadSessions(graph);
  return sessionTimeline(graph, sessions, input.sessionId, input, limit);
}
