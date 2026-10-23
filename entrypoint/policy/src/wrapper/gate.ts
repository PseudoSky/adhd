import { resolve } from 'node:path';
import type { Plugin } from '@adhd/apigen-core-client';
import type { UsePlugin } from '@adhd/apigen-engine-runtime';
import { makePolicyPlugin } from '@adhd/apigen-plugin-policy';
import {
  buildPolicyEnv,
  createDecider,
  createPolicyCtx,
  type IAuditSink,
  type IRuntimeProvider,
} from '@adhd/policy-core-client';
import { createAttributesLayerPlugin } from './attributes-layer';
import type { IAttributesSource } from './attributes-source';
import { tracingPlugin } from './tracing';

/** What the gate needs from the verb. */
export interface IGateDeps {
  readonly specFiles: readonly string[];
  readonly cwd: string;
  /** Walk-up ceiling for project policy discovery (the user's home directory). */
  readonly stopAt?: string;
  readonly attributes: IAttributesSource;
  readonly ports?: { runtime?: IRuntimeProvider; audit?: IAuditSink };
  /** Receives `policy: <path|built-in>` once the policy source is known (D-12). */
  readonly onNote?: (line: string) => void;
}

/**
 * Projects a core `Plugin` onto the `--use` shape the invoker composes: its id and
 * its Layer capability. `UsePlugin` keeps `mount` structural, so a full core
 * `Plugin` (whose `mount` takes a typed `Descriptor`) is not assignable to it;
 * only the Layer participates in the gate, so only the Layer is carried over.
 */
function layerOf(plugin: Plugin<never>): UsePlugin {
  const layer = plugin.capabilities?.layer;
  return layer === undefined ? { id: plugin.id } : { id: plugin.id, capabilities: { layer } };
}

/**
 * Builds the policy ctx (explicit `--spec` files by position, else discovery
 * D-10), the decider, and the Layer stack: the tracing plugin first (one span per
 * dispatched operation, refusals included), then the attributes layer (which
 * writes {@link PolicyAttributes} to the call ctx), then the policy Layer from
 * `makePolicyPlugin` that reads it (LP-14 order).
 *
 * @param deps The spec files, working directory, attributes source and ports.
 * @returns The `--use` plugin stack, outermost first.
 */
export async function buildGate(deps: IGateDeps): Promise<{ usePlugins: UsePlugin[] }> {
  const env = buildPolicyEnv({ projectRoot: deps.cwd });
  let announced: string | undefined;
  const ctx = createPolicyCtx(env, {
    cwd: deps.cwd,
    ...(deps.stopAt !== undefined ? { stopAt: deps.stopAt } : {}),
    ...(deps.specFiles.length > 0 ? { explicit: deps.specFiles.map((file) => resolve(deps.cwd, file)) } : {}),
    ...(deps.ports ?? {}),
    onSource: (label) => {
      if (label === announced) return;
      announced = label;
      deps.onNote?.(label);
    },
  });
  return {
    usePlugins: [layerOf(tracingPlugin), createAttributesLayerPlugin(deps.attributes), layerOf(makePolicyPlugin({ decider: createDecider(ctx) }))],
  };
}
