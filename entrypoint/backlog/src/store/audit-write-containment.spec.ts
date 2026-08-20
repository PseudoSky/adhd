/**
 * audit-write-containment.spec.ts —
 * BUG-BACKLOG-AUDIT-WRITE-FAILS-COMMITTED-CLAIM-001.
 *
 * `claimItemNode`/`transitionStatusNode` commit their state change inside
 * `mutateMetadata`'s retried `.immediate()` transaction, and only THEN write
 * the audit event (`audit-log.ts`, deliberately outside that transaction).
 * That post-commit write had no busy-retry and no containment, so a
 * busy/locked bounce propagated out to the caller AFTER the claim was already
 * durable — the caller was told it failed to claim an item it now owned, and
 * walked away leaving the item locked until the stale-claim timeout.
 *
 * WHY A FAULT INJECTION AND NOT THE RACE. This reproduced live in
 * `concurrency-scale.spec.ts` under 20-way contention, but only ~1 run in 5 —
 * which is precisely why it was mis-attributed to that test's own timing
 * margin and once "fixed" by widening a timeout. Injecting the exact error
 * shape the stack showed (turso's `GenericFailure` / "database is locked",
 * thrown from `SqliteGraphBackend.writeNode` on the audit-event node) makes
 * the defect deterministic, so it can never regress back into a flake.
 *
 * The assertions below are the two halves of the contract:
 *   1. the call does NOT throw — a committed change is reported as success;
 *   2. the change is actually durable — proving the operation really did
 *      commit before the audit write failed, so (1) is not just swallowing a
 *      genuine failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';
import { claimItemNode } from './claim.js';
import { transitionStatusNode } from './lifecycle.js';
import { findItemNode } from './query.js';
import { BACKLOG_AUDIT_EVENT_TAG } from './audit-log.js';
import { toBacklogItem } from './mapping.js';

const REPO = 'PseudoSky/audit-write-containment';

/** The exact error shape the live stack produced: turso's busy/locked bounce. */
function busyError(): Error & { code: string } {
  const err = new Error('database is locked') as Error & { code: string };
  err.code = 'GenericFailure';
  return err;
}

/**
 * Makes EVERY audit-event node write fail with a busy error, leaving all
 * other writes (the actual state change) untouched. Returns a restore fn.
 *
 * Targeting the audit write specifically — rather than failing the whole
 * store — is what proves the containment is scoped: the state change must
 * still commit normally through its own path.
 */
function breakAuditWrites(tmp: TmpStore): () => void {
  const real = tmp.store.graph.writeNode.bind(tmp.store.graph);
  tmp.store.graph.writeNode = (async (content: string, meta: { tags?: readonly string[] }) => {
    if (meta?.tags?.includes(BACKLOG_AUDIT_EVENT_TAG)) throw busyError();
    return real(content, meta as never);
  }) as typeof tmp.store.graph.writeNode;
  return () => {
    tmp.store.graph.writeNode = real;
  };
}

describe('BUG-BACKLOG-AUDIT-WRITE-FAILS-COMMITTED-CLAIM-001 — a failed audit write never fails a committed change', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('audit-write-containment');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('claimItemNode: the claim is reported as SUCCESS and is durable, even though its audit write bounced', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-AUDITC', title: 'claim target', body: 'b', repo: REPO });
    const humanId = created.item.humanId;

    const restore = breakAuditWrites(tmp);
    let result: Awaited<ReturnType<typeof claimItemNode>> | undefined;
    let threw: unknown;
    try {
      result = await claimItemNode(tmp.store, created.item.nodeId, 'agent:probe');
    } catch (err) {
      threw = err;
    } finally {
      restore();
    }

    // (1) Reported as the success it is. Before the fix this threw
    // `database is locked` — the caller's ONLY signal — while the row below
    // already said `agent:probe`.
    expect(threw, `claim must not surface the audit write's failure, got: ${threw instanceof Error ? threw.message : String(threw)}`).toBeUndefined();
    expect(result?.status).toBe('claimed');

    // (2) ...and genuinely durable, read back through a fresh query, so (1)
    // cannot be satisfied by swallowing a claim that never happened.
    const node = await findItemNode(tmp.store, REPO, humanId);
    expect(node, 'the claimed item must still exist').not.toBeNull();
    expect(toBacklogItem(node!).claimedBy).toBe('agent:probe');
  });

  it('transitionStatusNode: the transition is reported as SUCCESS and is durable, even though its audit write bounced', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-AUDITC', title: 'transition target', body: 'b', repo: REPO });
    const humanId = created.item.humanId;

    const restore = breakAuditWrites(tmp);
    let threw: unknown;
    try {
      await transitionStatusNode(tmp.store, REPO, humanId, 'IN_PROGRESS', { by: 'agent:probe' });
    } catch (err) {
      threw = err;
    } finally {
      restore();
    }

    expect(threw, `transition must not surface the audit write's failure, got: ${threw instanceof Error ? threw.message : String(threw)}`).toBeUndefined();

    const node = await findItemNode(tmp.store, REPO, humanId);
    expect(toBacklogItem(node!).status).toBe('IN_PROGRESS');
  });

  it('a TRANSIENT audit bounce is retried, not dropped — the event still lands', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-AUDITC', title: 'retry target', body: 'b', repo: REPO });

    // Fail only the FIRST audit write. `withImmediateRetry` must absorb it and
    // the event must still be persisted — containment is the last resort, not
    // the first response, so a single blip never costs an audit event.
    const real = tmp.store.graph.writeNode.bind(tmp.store.graph);
    let failures = 0;
    tmp.store.graph.writeNode = (async (content: string, meta: { tags?: readonly string[] }) => {
      if (meta?.tags?.includes(BACKLOG_AUDIT_EVENT_TAG) && failures === 0) {
        failures += 1;
        throw busyError();
      }
      return real(content, meta as never);
    }) as typeof tmp.store.graph.writeNode;

    try {
      await claimItemNode(tmp.store, created.item.nodeId, 'agent:probe');
    } finally {
      tmp.store.graph.writeNode = real;
    }

    expect(failures, 'the injected bounce must actually have fired, or this test is vacuous').toBe(1);
    const events = await tmp.store.graph.queryNodes({ kind: 'generic', tags: [BACKLOG_AUDIT_EVENT_TAG] });
    expect(events.length, 'the retried audit event must still be persisted').toBeGreaterThan(0);
  });
});
