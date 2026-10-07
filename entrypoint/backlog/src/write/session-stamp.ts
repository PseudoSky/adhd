/**
 * session-stamp.ts — the dependency-free leaf of the session seam: the stamp
 * type and the tx-binding. Lives apart from `session.ts` so `tx.ts` (which
 * binds the stamp) and `audit.ts` (which reads it) can import it without a
 * cycle through the node/edge writers `session.ts` itself needs.
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';

/** The two optional input fields every mutating verb accepts to join a session. */
export interface ISessionStamp {
  /** Opt this call into a session: the session node is ensured and one op-event is appended in the verb's own transaction. */
  sessionId?: string;
  /** The parent session of `sessionId` (a stub parent is created when unknown). A conflicting second parent is `invalid_argument`. */
  parentSessionId?: string;
}

const sessionByTx = new WeakMap<object, ISessionStamp>();

/** Bind a handle's session stamp to the transaction `tx` (called by `executeWriteTransaction`). */
export function bindTxSession(tx: AdapterTransaction, stamp: ISessionStamp | undefined): void {
  if (stamp?.sessionId !== undefined) sessionByTx.set(tx, stamp);
}

/** The session stamp bound to `tx`, if any. */
export function sessionOfTx(tx: AdapterTransaction): ISessionStamp | undefined {
  return sessionByTx.get(tx);
}

