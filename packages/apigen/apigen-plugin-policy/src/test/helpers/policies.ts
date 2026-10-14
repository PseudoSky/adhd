import type { ILayerInput, LayerName } from '@adhd/policy-core-client';
import { createDecider, createMemoryCtx } from '@adhd/policy-core-client';
import type { IPolicyDecider } from '../../index';

/** The demo's shared folder. Paths are absolute strings; the Layer tests never touch the disk. */
export const SHARED = '/demo/shared';
export const WORK = '/demo/work';

/** Global layer of demo B4.1: shared read root, `.env` deny, refund ceiling 0. */
export const GLOBAL = {
  version: 1,
  attributes: { shared_read_roots: 'paths', repos: 'names', max_refund: 'number' },
  defaults: [{ set: { shared_read_roots: [SHARED], repos: [], max_refund: 0 } }],
  permissions: [
    { tool: 'files.read', args: { path: { _within: '$attributes.shared_read_roots' } } },
    { tool: 'files.*', effect: 'deny', args: { path: { _regex: '(^|/)\\.env$' } } },
  ],
};

/** Project layer: role-driven defaults, a developer/reviewer read permission and a refund ceiling check. */
export const PROJECT = {
  version: 1,
  attributes: { role: 'name', read_roots: 'paths', shared_read_roots: 'paths', repos: 'names', max_refund: 'number' },
  defaults: [
    { where: { role: { _eq: 'support' } }, set: { max_refund: 50 } },
    { where: { role: { _eq: 'release' } }, set: { repos: ['acme/shop'] } },
    { where: { role: { _eq: 'reviewer' } }, set: { shared_read_roots: [] } },
  ],
  permissions: [
    { tool: 'files.read', context: { role: { _in: ['dev', 'reviewer'] } }, args: { path: { _within: '$attributes.read_roots' } } },
    { tool: 'files.write', context: { role: { _eq: 'dev' } }, args: { path: { _within: '$attributes.read_roots' } }, set: { overwrite: false } },
    { tool: 'refunds.issue', args: { amount: { _lte: '$attributes.max_refund' } } },
  ],
};

/** Local layer: a lower ceiling for support, and an allow on `.env` that must not lift the global deny. */
export const LOCAL = {
  version: 1,
  attributes: { role: 'name', max_refund: 'number' },
  defaults: [{ where: { role: { _eq: 'support' } }, set: { max_refund: 20 } }],
  permissions: [{ tool: 'files.read', effect: 'allow', args: { path: { _regex: '\\.env$' } } }],
};

export function layer(name: LayerName, document: unknown): ILayerInput {
  return { name, source: `memory:${name}`, document };
}

/** The three demo layers, in the order a host passes them (global, project, local). */
export function demoLayers(): ILayerInput[] {
  return [layer('global', GLOBAL), layer('project', PROJECT), layer('local', LOCAL)];
}

/** A real policy-core-client decider over `layers`: the Layer's actual dependency, no stand-in. */
export function realDecider(layers: ILayerInput[] = demoLayers()): IPolicyDecider {
  return createDecider(createMemoryCtx({ layers }));
}

/** A real decider whose policy cannot load (unsupported version): every decision must be a denial. */
export function unloadableDecider(): IPolicyDecider {
  return createDecider(createMemoryCtx({ layers: [layer('project', { version: 9, permissions: [] })] }));
}
