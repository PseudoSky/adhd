import { resolve } from 'node:path';
import type { UsePlugin } from '@adhd/apigen-engine-runtime';
import { createPolicyLayerPlugin } from '@adhd/apigen-plugin-policy';
import {
  buildPolicyEnv,
  createDecider,
  createPolicyCtx,
  type IAuditSink,
  type IRuntimeProvider,
} from '@adhd/policy-core-client';
import { createAttributesLayerPlugin } from './attributes-layer';
import type { IAttributesSource } from './attributes-source';

/** What the gate needs from the verb. */
export interface IGateDeps {
  readonly specFiles: readonly string[];
  readonly cwd: string;
  readonly attributes: IAttributesSource;
  readonly ports?: { runtime?: IRuntimeProvider; audit?: IAuditSink };
  /** Receives `policy: <path|built-in>` once the policy source is known (D-12). */
  readonly onNote?: (line: string) => void;
}

/**
 * Builds the policy ctx (explicit `--spec` files by position, else discovery
 * D-10), the decider, and the Layer stack in LP-14 order: the attributes layer
 * first (outermost), then the policy Layer that reads what it wrote.
 */
export async function buildGate(deps: IGateDeps): Promise<{ usePlugins: UsePlugin[] }> {
  const env = buildPolicyEnv({ projectRoot: deps.cwd });
  let announced: string | undefined;
  const ctx = createPolicyCtx(env, {
    cwd: deps.cwd,
    ...(deps.specFiles.length > 0 ? { explicit: deps.specFiles.map((file) => resolve(deps.cwd, file)) } : {}),
    ...(deps.ports ?? {}),
    onSource: (label) => {
      if (label === announced) return;
      announced = label;
      deps.onNote?.(label);
    },
  });
  return {
    usePlugins: [createAttributesLayerPlugin(deps.attributes), createPolicyLayerPlugin({ decider: createDecider(ctx) })],
  };
}
