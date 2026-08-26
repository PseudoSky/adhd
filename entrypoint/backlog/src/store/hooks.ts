/**
 * hooks.ts — FEAT-BACKLOG-001: a minimal lifecycle-hook registry, dispatched
 * from every commit point in the item write path (`crud.ts`, `lifecycle.ts`,
 * `claim.ts`). No enrichment/plugin/notification mechanism existed anywhere
 * on the write path before this — every write was a dead end a caller could
 * observe only by polling.
 *
 * Deliberately NOT a module-level singleton: a global registry would leak
 * hooks across every concurrently-open `GraphBacklogStore` in the same
 * process (in particular, across parallel test files sharing this module).
 * Registries are instead keyed on the store object itself via a `WeakMap`,
 * so registering a hook never requires a field on `GraphBacklogStore` (a
 * type this module does not own) and a store that is garbage-collected takes
 * its registry with it.
 *
 * Every dispatch is fire-and-forget and try/catch isolated (both the
 * synchronous throw case and the rejected-promise case): a hook that throws
 * or rejects can never fail, delay, or roll back the write that triggered
 * it. This is enrichment, not a transaction participant — a hook that needs
 * transactional guarantees does not belong here.
 */
import type { BacklogItem, BacklogStatus } from '../model.js';
import type { GraphBacklogStore } from './graph-backlog-store.js';

export type BacklogHookEvent =
  | { readonly type: 'itemCreated'; readonly item: BacklogItem }
  | { readonly type: 'itemUpdated'; readonly item: BacklogItem }
  | { readonly type: 'itemTransitioned'; readonly item: BacklogItem; readonly from: BacklogStatus | undefined; readonly to: BacklogStatus; readonly by: string }
  | { readonly type: 'itemResolved'; readonly item: BacklogItem; readonly by: string }
  | { readonly type: 'itemClaimed'; readonly nodeId: number; readonly by: string; readonly status: string }
  | { readonly type: 'itemReleased'; readonly nodeId: number; readonly by: string };

export type BacklogHook = (event: BacklogHookEvent) => void | Promise<void>;

const registries = new WeakMap<GraphBacklogStore, BacklogHook[]>();

/**
 * Registers `hook` against `store`, returning an unregister function.
 * Multiple registrations of the SAME function reference are independent —
 * calling the returned unregister function removes exactly the one
 * registration it was returned from.
 */
export function registerBacklogHook(store: GraphBacklogStore, hook: BacklogHook): () => void {
  const list = registries.get(store);
  if (list) {
    list.push(hook);
  } else {
    registries.set(store, [hook]);
  }
  let removed = false;
  return () => {
    if (removed) return; // idempotent — a second call is a no-op, not a double-splice
    removed = true;
    const current = registries.get(store);
    if (!current) return;
    const idx = current.indexOf(hook);
    if (idx !== -1) current.splice(idx, 1);
  };
}

/**
 * Fires `event` at every hook registered on `store`, in registration order.
 * Never throws and never returns a value a caller could accidentally await
 * into blocking on hook completion — dispatch is intentionally
 * "fire-and-forget": a caller that wants to know when hooks finished is
 * using the wrong primitive.
 */
export function dispatchBacklogHook(store: GraphBacklogStore, event: BacklogHookEvent): void {
  const hooks = registries.get(store);
  if (!hooks || hooks.length === 0) return;
  for (const hook of hooks) {
    try {
      const result = hook(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error(`backlog: hook rejected for event "${event.type}":`, err);
        });
      }
    } catch (err) {
      console.error(`backlog: hook threw for event "${event.type}":`, err);
    }
  }
}
