import type { ILayerInput, LayerName } from '../../index';

/** One layer handed to the client, labelled so error messages name it. */
export function layer(name: LayerName, document: unknown, source = `memory:${name}`): ILayerInput {
  return { name, source, document };
}

/**
 * The library-first demo policy (S1): attributes `{role, read_roots}`, default
 * role `guest`, a `files.read` allow within `read_roots`, a `files.*` deny on
 * `.env`, and a developer-only `files.write` allow that forces `overwrite=false`.
 */
export const WORKSPACE_DOCUMENT = {
  version: 1,
  attributes: { role: 'name', read_roots: 'paths' },
  defaults: [{ set: { role: 'guest' } }],
  permissions: [
    { tool: 'files.read', args: { path: { _within: '$attributes.read_roots' } } },
    { tool: 'files.*', effect: 'deny', args: { path: { _regex: '(^|/)\\.env$' } } },
    {
      tool: 'files.write',
      context: { role: { _eq: 'dev' } },
      args: { path: { _within: '$attributes.read_roots' } },
      set: { overwrite: false },
    },
  ],
} as const;

/** `WORKSPACE_DOCUMENT` as the single project layer. */
export const WORKSPACE_POLICY: ILayerInput[] = [layer('project', WORKSPACE_DOCUMENT)];
