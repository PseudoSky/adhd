import type { IPolicyLayerOptions } from './plugin.js';

/** Options captured by the default export's mount capability (one plugin instance per process). */
export interface IPluginState {
  options?: Partial<IPolicyLayerOptions> & { deciderOptions?: Record<string, unknown> };
}

/**
 * Create the holder the default export uses to carry `--use` options from its
 * `mount.operations` capability (the only place a host hands them over, D-14)
 * to its `layer` capability.
 */
export function createPluginState(): {
  get(): IPluginState['options'];
  set(o: IPluginState['options']): void;
} {
  const state: IPluginState = {};
  return {
    get: () => state.options,
    set: (o) => {
      state.options = o;
    },
  };
}
