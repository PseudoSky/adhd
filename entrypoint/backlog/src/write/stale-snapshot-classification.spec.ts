/**
 * 1687b889 AC3 — the `Database snapshot is stale` driver error is the
 * deferred-mode downgrade's expected, loud signature; it is never produced on
 * the production `BEGIN IMMEDIATE` path.
 *
 * Evidence (claim.e2e.ts, run on this tree): the CONTROL case (immediate)
 * passed 6/6 with zero unexpected errors; the NEGATIVE CONTROL
 * (`ADHD_BACKLOG_UNSAFE_TX_MODE=deferred`) produced
 * `step failed: Database snapshot is stale. You must rollback and retry the
 * whole transaction.` on the losing writer 4/4. A deferred `BEGIN` takes no
 * lock; the claim's first read pins a snapshot, a peer commits, and the
 * writer's read->write upgrade is refused by the driver. `BEGIN IMMEDIATE`
 * takes the RESERVED lock before any read, so the snapshot cannot go stale.
 *
 * Pinned here, at the single classification point
 * ({@link classifyDriverError} + {@link executeWriteTransaction}):
 *  1. The signature classifies as an unclassified, non-contention `E_IO`
 *     (`WriteIOError`) — deliberately NOT mapped to `E_CONTENTION`. Mapping it
 *     would make `executeWriteTransaction` auto-retry the downgrade, so the
 *     negative control could no longer observe the stripped guarantee.
 *  2. It is surfaced once, never retried.
 *  3. Writes open `immediate` unless the env override is set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { WriteIOError, classifyDriverError } from './errors.js';
import { executeWriteTransaction, type IWriteStoreHandle } from './tx.js';

/** The exact driver error shape captured from the Turso adapter (`code: 'GenericFailure'`). */
function staleSnapshotError(): Error {
  return Object.assign(
    new Error(
      'step failed: Database snapshot is stale. You must rollback and retry the whole transaction.'
    ),
    { code: 'GenericFailure' }
  );
}

function fakeHandle(
  behaviour: () => never | void,
  modes: unknown[],
  calls: { n: number }
): IWriteStoreHandle {
  const adapter = {
    transaction: async (_fn: unknown, opts?: { mode?: string }) => {
      calls.n += 1;
      modes.push(opts?.mode);
      return behaviour();
    },
  } as unknown as StoreAdapter;
  return { adapter, typePolicy: {} as never };
}

describe('1687b889 AC3 — stale-snapshot signature classification', () => {
  const prior = process.env['ADHD_BACKLOG_UNSAFE_TX_MODE'];
  afterEach(() => {
    if (prior === undefined) delete process.env['ADHD_BACKLOG_UNSAFE_TX_MODE'];
    else process.env['ADHD_BACKLOG_UNSAFE_TX_MODE'] = prior;
  });

  it('classifies as a retryable-flagged E_IO, not E_CONTENTION', () => {
    const c = classifyDriverError(staleSnapshotError());
    expect(c.code).toBe('E_IO');
    expect(c.retryable).toBe(true);
  });

  it('surfaces as WriteIOError on the FIRST attempt (no auto-retry), carrying the raw driver text', async () => {
    delete process.env['ADHD_BACKLOG_UNSAFE_TX_MODE'];
    const calls = { n: 0 };
    const modes: unknown[] = [];
    const handle = fakeHandle(
      () => {
        throw staleSnapshotError();
      },
      modes,
      calls
    );
    const err = await executeWriteTransaction(handle, async () => 1).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(WriteIOError);
    expect((err as WriteIOError).causeMessage).toMatch(
      /Database snapshot is stale/
    );
    expect(calls.n).toBe(1);
  });

  it('opens every write in immediate mode by default and deferred only via the explicit env override', async () => {
    const calls = { n: 0 };
    const modes: unknown[] = [];
    const handle = fakeHandle(() => undefined, modes, calls);
    delete process.env['ADHD_BACKLOG_UNSAFE_TX_MODE'];
    await executeWriteTransaction(handle, async () => 1);
    process.env['ADHD_BACKLOG_UNSAFE_TX_MODE'] = 'deferred';
    await executeWriteTransaction(handle, async () => 1);
    expect(modes).toEqual(['immediate', 'deferred']);
  });
});
