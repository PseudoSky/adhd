/**
 * hooks.spec.ts — FEAT-BACKLOG-001: proves every real commit point on the
 * write path (`crud.ts`, `claim.ts`, `lifecycle.ts`) actually fires the
 * matching `BacklogHookEvent`, and that every documented no-op branch
 * (dedupe-suppressed create, id-collision create, `held` claim,
 * `release-noop`) fires NOTHING.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode, updateItemNode } from './crud.js';
import { claimItemNode, releaseClaimNode, renewClaimNode } from './claim.js';
import { transitionStatusNode, resolveItemNode } from './lifecycle.js';
import { dispatchBacklogHook, registerBacklogHook, type BacklogHookEvent } from './hooks.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';

const REPO = 'PseudoSky/hooks-test';

function recorder(store: GraphBacklogStore): { events: BacklogHookEvent[]; unregister: () => void } {
  const events: BacklogHookEvent[] = [];
  const unregister = registerBacklogHook(store, (event) => {
    events.push(event);
  });
  return { events, unregister };
}

describe('backlog lifecycle hooks (FEAT-BACKLOG-001)', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('hooks-spec');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('createItemNode fires itemCreated on a real create, never on a dedupe-suppressed or id-collision no-op', async () => {
    const { events } = recorder(tmp.store);

    const created = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 'a genuinely new bug', body: 'x', repo: REPO });
    expect(created.created).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'itemCreated', item: { humanId: created.item.humanId } });

    // Dedupe-suppressed: same title/body — no fresh write, so no hook.
    const dup = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 'a genuinely new bug', body: 'x', repo: REPO });
    expect(dup.created).toBe(false);
    expect(events).toHaveLength(1);

    // idOverride collision: request the SAME humanId again — no fresh write.
    const collided = await createItemNode(tmp.store, {
      family: 'BUG-HOOK',
      title: 'irrelevant',
      body: 'irrelevant',
      repo: REPO,
      idOverride: created.item.humanId,
    });
    expect(collided.created).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('updateItemNode fires itemUpdated only after the write commits', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 't', body: 'b', repo: REPO });
    const { events } = recorder(tmp.store);

    const updated = await updateItemNode(tmp.store, REPO, created.item.humanId, { title: 'renamed' });
    expect(updated.title).toBe('renamed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'itemUpdated', item: { title: 'renamed' } });
  });

  it('claimItemNode fires itemClaimed on claimed/renewed/reclaimed-stale, never on held (a refusal, zero write)', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 't', body: 'b', repo: REPO });
    const { events } = recorder(tmp.store);

    const first = await claimItemNode(tmp.store, created.item.nodeId, 'agent:a');
    expect(first.status).toBe('claimed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'itemClaimed', status: 'claimed', by: 'agent:a' });

    // Contended: a different claimant within the stale window is refused —
    // no write, so no hook.
    const held = await claimItemNode(tmp.store, created.item.nodeId, 'agent:b');
    expect(held.status).toBe('held');
    expect(events).toHaveLength(1);

    // Same claimant renews — a real write, fires again.
    const renewed = await claimItemNode(tmp.store, created.item.nodeId, 'agent:a');
    expect(renewed.status).toBe('renewed');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'itemClaimed', status: 'renewed', by: 'agent:a' });
  });

  it('renewClaimNode always fires itemClaimed (no contention check, ever)', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 't', body: 'b', repo: REPO });
    const { events } = recorder(tmp.store);

    await renewClaimNode(tmp.store, created.item.nodeId, 'agent:a');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'itemClaimed', by: 'agent:a' });
  });

  it('releaseClaimNode fires itemReleased on a real release, never on release-noop', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 't', body: 'b', repo: REPO });
    await claimItemNode(tmp.store, created.item.nodeId, 'agent:a');
    const { events } = recorder(tmp.store);

    const released = await releaseClaimNode(tmp.store, created.item.nodeId, 'agent:a');
    expect(released.status).toBe('released');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'itemReleased', by: 'agent:a' });

    // Already unclaimed — release-noop, no hook.
    const noop = await releaseClaimNode(tmp.store, created.item.nodeId, 'agent:a');
    expect(noop.status).toBe('release-noop');
    expect(events).toHaveLength(1);
  });

  it('transitionStatusNode fires itemTransitioned; resolveItemNode fires BOTH itemTransitioned and itemResolved, in that order', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 't', body: 'b', repo: REPO });
    const { events } = recorder(tmp.store);

    await transitionStatusNode(tmp.store, REPO, created.item.humanId, 'BLOCKED', { by: 'x' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'itemTransitioned', from: 'OPEN', to: 'BLOCKED', by: 'x' });

    await resolveItemNode(tmp.store, REPO, created.item.humanId, 'FIXED', {
      by: 'x',
      citations: [{ file: 'src/x.ts' }],
    });
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ type: 'itemTransitioned', from: 'BLOCKED', to: 'FIXED', by: 'x' });
    expect(events[2]).toMatchObject({ type: 'itemResolved', item: { status: 'FIXED' }, by: 'x' });
  });

  it('a rejected transition (citation gate) never fires any hook — a rejected write is not a partial write', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 't', body: 'b', repo: REPO });
    const { events } = recorder(tmp.store);

    await expect(transitionStatusNode(tmp.store, REPO, created.item.humanId, 'FIXED', { by: 'x' })).rejects.toThrow();
    expect(events).toHaveLength(0);
  });

  it('unregister stops a hook from firing on subsequent events', async () => {
    const { events, unregister } = recorder(tmp.store);
    const created = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 't1', body: 'b', repo: REPO });
    expect(events).toHaveLength(1);

    unregister();
    await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 't2 different', body: 'c', repo: REPO });
    expect(events).toHaveLength(1);
    expect(created.item.humanId).toContain('BUG-HOOK');
  });

  it('a hook that throws synchronously never breaks the write it observed (fire-and-forget, isolated)', async () => {
    registerBacklogHook(tmp.store, () => {
      throw new Error('boom — a misbehaving hook');
    });
    const created = await createItemNode(tmp.store, { family: 'BUG-HOOK', title: 'survives a throwing hook', body: 'b', repo: REPO });
    expect(created.created).toBe(true);
  });

  it('dispatchBacklogHook on a store with zero registered hooks is a silent no-op', () => {
    expect(() => dispatchBacklogHook(tmp.store, { type: 'itemUpdated', item: {} as never })).not.toThrow();
  });
});
