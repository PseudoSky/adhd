import type { ILayerInput } from '../spec';

/**
 * Layer arrays a source guarantees to be immutable and identity-stable: the
 * same array object is returned for as long as nothing under it changed, and
 * its documents are frozen. `ctx.policy()` uses this to skip hashing and
 * compiling when a source hands back the array it handed back last time.
 */
const stable = new WeakSet<object>();

/** Marks `layers` as an immutable, identity-stable result and returns it. */
export function markStableLayers(layers: readonly ILayerInput[]): readonly ILayerInput[] {
  stable.add(layers);
  return layers;
}

/** True when `layers` was marked by {@link markStableLayers}. */
export function isStableLayers(layers: readonly ILayerInput[]): boolean {
  return stable.has(layers);
}
