/**
 * session.ts — the shared session + op-event persistence (91a8c640, S11.S1/S2;
 * B-AC5, B-AC6).
 *
 * ## Model
 *
 * - `session` node, meta `{sessionId, agent, startedAt, endedAt?, parentSessionId?}`,
 *   unique by `meta.sessionId` (resolved by lookup, never minted twice).
 * - `op_event` node, meta `{sessionId, agent, op, targetUid, delta, t}`,
 *   APPEND-ONLY (never updated, never invalidated by this module), linked to its
 *   session by the internal `in_session` edge (`op_event -> session`, `n:1`).
 * - `child_of_session` (`session -> session`, `n:1`) carries the parent chain.
 *
 * All three are internal: none is on `relate`'s public rel union (ADR-0007 D4).
 * `op_event.targetUid` is a meta field, deliberately not an edge — it keeps the
 * log append-only and out of `update`'s successor sweep.
 *
 * ## Opt-in by data
 *
 * A verb input that carries no `sessionId` writes NO session node and NO
 * op-event — there is no env flag. When `sessionId` is present the verb's own
 * `writeAudit` appends exactly one op-event in the SAME transaction (the single
 * seam: a verb cannot forget it, and the log is NOT derived from `auditTrail` —
 * it is a separate node kind with its own edge).
 *
 * ## How the stamp reaches `writeAudit`
 *
 * `executeWriteTransaction` binds the handle's {@link ISessionStamp} to the
 * transaction object ({@link bindTxSession}); `writeAudit` reads it back
 * ({@link sessionOfTx}). Neither the 25 `writeAudit` call sites nor the verbs'
 * transaction bodies carry the stamp explicitly.
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import type { TypePolicy } from '@adhd/sox-graph-store';
import { resolveEdgeKindTx } from './catalog.js';
import { InvalidArgumentError } from './errors.js';
import { writeEdgeTx, writeNodeTx } from './tx.js';
import { type ISessionStamp } from './session-stamp.js';

export { bindTxSession, sessionOfTx, type ISessionStamp } from './session-stamp.js';

/** Pull the stamp fields off any verb input (blank/non-string values are an `invalid_argument`, never silently dropped). */
export function sessionStampOf(input: unknown): ISessionStamp | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const { sessionId, parentSessionId } = input as Record<string, unknown>;
  if (sessionId === undefined && parentSessionId === undefined) return undefined;
  if (sessionId === undefined) {
    throw new InvalidArgumentError('sessionId', 'is required when parentSessionId is given');
  }
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new InvalidArgumentError('sessionId', 'must be a non-blank string');
  }
  if (parentSessionId !== undefined && (typeof parentSessionId !== 'string' || parentSessionId.trim().length === 0)) {
    throw new InvalidArgumentError('parentSessionId', 'must be a non-blank string');
  }
  if (parentSessionId === sessionId) {
    throw new InvalidArgumentError('parentSessionId', 'a session cannot be its own parent');
  }
  return {
    sessionId: sessionId.trim(),
    ...(parentSessionId !== undefined ? { parentSessionId: (parentSessionId as string).trim() } : {}),
  };
}

interface ISessionRow {
  rowid: number;
  uid: string;
}

async function findSessionTx(tx: AdapterTransaction, sessionId: string): Promise<ISessionRow | undefined> {
  const row = await tx.executeGet<ISessionRow>(
    "SELECT rowid, uid FROM node WHERE kind = 'session' AND t_invalid IS NULL AND json_extract(meta, '$.sessionId') = ? ORDER BY rowid ASC LIMIT 1",
    [sessionId]
  );
  return row ?? undefined;
}

async function createSessionTx(
  tx: AdapterTransaction,
  args: { sessionId: string; agent: string; at: string; stub?: boolean }
): Promise<ISessionRow> {
  const node = await writeNodeTx(tx, {
    at: args.at,
    kind: 'session',
    name: args.sessionId,
    content: '',
    metadata: {
      sessionId: args.sessionId,
      agent: args.agent,
      startedAt: args.at,
      ...(args.stub === true ? { stub: true } : {}),
    },
  });
  return { rowid: node.rowid, uid: node.uid };
}

/**
 * Ensure the `session` node for `args.sessionId` exists (create once) and, when
 * `parentSessionId` is given, that the `child_of_session` edge to the parent
 * exists (creating a stub parent if unknown). A second, DIFFERENT parent for an
 * already-parented session is `InvalidArgumentError`.
 */
export async function ensureSessionTx(
  tx: AdapterTransaction,
  typePolicy: TypePolicy,
  args: { sessionId: string; parentSessionId?: string; agent: string; at: string }
): Promise<ISessionRow> {
  let session = await findSessionTx(tx, args.sessionId);
  if (session === undefined) {
    session = await createSessionTx(tx, { sessionId: args.sessionId, agent: args.agent, at: args.at });
  }
  if (args.parentSessionId === undefined) return session;

  let parent = await findSessionTx(tx, args.parentSessionId);
  if (parent === undefined) {
    parent = await createSessionTx(tx, {
      sessionId: args.parentSessionId,
      agent: args.agent,
      at: args.at,
      stub: true,
    });
  }
  const existing = await tx.executeGet<{ dst: number }>(
    "SELECT dst FROM edge WHERE src = ? AND rel = 'child_of_session' AND t_invalid IS NULL",
    [session.rowid]
  );
  if (existing) {
    if (existing.dst !== parent.rowid) {
      throw new InvalidArgumentError(
        'parentSessionId',
        `session "${args.sessionId}" already has a different parent session; a session has exactly one parent`
      );
    }
    return session;
  }
  const rule = await resolveEdgeKindTx(tx, 'child_of_session');
  await writeEdgeTx(tx, {
    at: args.at,
    srcRowid: session.rowid,
    srcUid: session.uid,
    srcKind: 'session',
    dstRowid: parent.rowid,
    dstUid: parent.uid,
    dstKind: 'session',
    rel: 'child_of_session',
    rule,
    typePolicy,
  });
  return session;
}

/**
 * Append ONE op-event to the log: ensure the session, write the `op_event`
 * node, link it `in_session`. Never updates or invalidates an existing event.
 */
export async function appendOpEventTx(
  tx: AdapterTransaction,
  typePolicy: TypePolicy,
  args: {
    session: ISessionStamp & { sessionId: string };
    agent: string;
    op: string;
    targetUid: string;
    delta?: Record<string, unknown>;
    at: string;
  }
): Promise<void> {
  const session = await ensureSessionTx(tx, typePolicy, {
    sessionId: args.session.sessionId,
    ...(args.session.parentSessionId !== undefined ? { parentSessionId: args.session.parentSessionId } : {}),
    agent: args.agent,
    at: args.at,
  });
  const event = await writeNodeTx(tx, {
    at: args.at,
    kind: 'op_event',
    name: args.op,
    content: '',
    metadata: {
      sessionId: args.session.sessionId,
      agent: args.agent,
      op: args.op,
      targetUid: args.targetUid,
      delta: args.delta ?? {},
      t: args.at,
    },
  });
  const rule = await resolveEdgeKindTx(tx, 'in_session');
  await writeEdgeTx(tx, {
    at: args.at,
    srcRowid: event.rowid,
    srcUid: event.uid,
    srcKind: 'op_event',
    dstRowid: session.rowid,
    dstUid: session.uid,
    dstKind: 'session',
    rel: 'in_session',
    rule,
    typePolicy,
  });
}
