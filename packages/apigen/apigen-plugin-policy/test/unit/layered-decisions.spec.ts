// guards: The apigen policy Layer decides wrongly across global, project and local layers: wrong layer wins, inheritance is not stopped by an explicit empty list, or a denied call still runs.
// tier: S
// cites: S4.1 layered decisions through the apigen Layer (last layer that sets a value wins, inheritance, deny beats allow).

import { describe, expect, it } from 'vitest';
import type { Layer } from '@adhd/apigen-engine-runtime';
import { makePolicyPlugin, PolicyAttributes } from '../../src/index';
import { createHost, refusal } from '../helpers/harness';
import { demoLayers, layer, realDecider, GLOBAL, LOCAL, PROJECT, SHARED, WORK } from '../helpers/policies';

/** The Layer over a real policy-core-client decider compiled from the given layers. */
function host(layers = demoLayers()): ReturnType<typeof createHost> {
  return createHost(makePolicyPlugin({ decider: realDecider(layers), onError: () => undefined }));
}

/** What an auth layer writes: the attributes the policy decides on. */
const as = (attributes: Record<string, unknown>) => ({ attributes });

describe('Feature: Layers - global, then project, then local, decided through the apigen Layer', () => {
  it('@S4.1 @happy the last layer that sets a value wins: the refund ceiling follows support (local 20), release (global 0)', async () => {
    const h = host();

    // support: local default 20 beats project 50 beats global 0.
    expect(await h.invoke('refunds/issue', { amount: 20 }, as({ role: 'support' }))).toBe('refund-ran');
    const over = await refusal(h.invoke('refunds/issue', { amount: 21 }, as({ role: 'support' })));
    expect(over.code).toBe('permission_denied');
    expect(h.ran.map((r) => r.args)).toEqual([[20]]);

    // release: only the global default sets max_refund (0); the project default sets repos instead.
    expect(await h.invoke('refunds/issue', { amount: 0 }, as({ role: 'release' }))).toBe('refund-ran');
    expect((await refusal(h.invoke('refunds/issue', { amount: 1 }, as({ role: 'release' })))).code).toBe('permission_denied');
  });

  it('@S4.1 @happy the shared folder is inherited from the global layer by a developer', async () => {
    const h = host();
    const dev = as({ role: 'dev', read_roots: [WORK] });
    expect(await h.invoke('files/read', { path: `${SHARED}/guide.md` }, dev)).toBe('read-ran');
    expect(await h.invoke('files/read', { path: `${WORK}/readme.md` }, dev)).toBe('read-ran');
    expect(h.ran).toHaveLength(2);
  });

  it('@S4.1 @edge an explicit empty list stops inheriting: a reviewer loses the shared folder, a dev keeps it', async () => {
    const h = host();
    const read = { path: `${SHARED}/guide.md` };
    const reviewer = await refusal(h.invoke('files/read', read, as({ role: 'reviewer', read_roots: [WORK] })));
    expect(reviewer.code).toBe('permission_denied');
    expect(h.ran).toHaveLength(0);
    expect(await h.invoke('files/read', read, as({ role: 'dev', read_roots: [WORK] }))).toBe('read-ran');
    // The reviewer still reads inside the project read root: only the inherited folder was dropped.
    expect(await h.invoke('files/read', { path: `${WORK}/readme.md` }, as({ role: 'reviewer', read_roots: [WORK] }))).toBe('read-ran');
  });

  it('@S4.1 @edge a value the caller supplied is final: max_refund 5 beats the support default of 20', async () => {
    const h = host();
    const supplied = as({ role: 'support', max_refund: 5 });
    expect(await h.invoke('refunds/issue', { amount: 5 }, supplied)).toBe('refund-ran');
    expect((await refusal(h.invoke('refunds/issue', { amount: 6 }, supplied))).code).toBe('permission_denied');
    expect(h.ran).toHaveLength(1);
  });

  it('@S4.1 @negative a deny in a higher layer cannot be lifted by a lower one, and the operation never runs', async () => {
    const h = host();
    const dev = as({ role: 'dev', read_roots: [WORK] });
    const denied = await refusal(h.invoke('files/read', { path: `${SHARED}/.env` }, dev));
    expect(denied.code).toBe('permission_denied');
    expect(denied.message).toContain('denied by permission global:1');
    expect(h.ran).toHaveLength(0);

    // Negative control inside the test: without the global deny the local allow of ".env" lets the same call through.
    const noDeny = host([
      layer('global', { ...GLOBAL, permissions: GLOBAL.permissions.filter((p) => !('effect' in p)) }),
      layer('project', PROJECT),
      layer('local', LOCAL),
    ]);
    expect(await noDeny.invoke('files/read', { path: `${SHARED}/.env` }, dev)).toBe('read-ran');
  });

  it('@S4.1 @edge layers are ordered global, project, local whatever order the host lists them', async () => {
    const shuffled = [layer('local', LOCAL), layer('project', PROJECT), layer('global', GLOBAL)];
    const h = host(shuffled);
    expect(await h.invoke('refunds/issue', { amount: 20 }, as({ role: 'support' }))).toBe('refund-ran');
    expect((await refusal(h.invoke('refunds/issue', { amount: 21 }, as({ role: 'support' })))).code).toBe('permission_denied');
  });

  it('@S4.1 @happy attributes written by an earlier Layer reach the decider: the auth layer is declared before the policy Layer (LP-14)', async () => {
    const h = host();
    const auth: Layer = async (call, next) => {
      call.ctx.set(PolicyAttributes, new PolicyAttributes({ role: 'support' }));
      return next();
    };
    // An envelope write is not an attribute channel: a layer that forges it gets the role-less global ceiling.
    const forger: Layer = async (call, next) => {
      call.envelope['attributes'] = { role: 'support' };
      return next();
    };
    expect((await refusal(h.invoke('refunds/issue', { amount: 20 }, { before: [forger] }))).code).toBe('permission_denied');
    expect(await h.invoke('refunds/issue', { amount: 20 }, { before: [auth] })).toBe('refund-ran');
    expect((await refusal(h.invoke('refunds/issue', { amount: 21 }, { before: [auth] }))).code).toBe('permission_denied');
    // Declared AFTER the policy Layer the attributes arrive too late: no role means the global ceiling, so 20 is refused.
    const late = createHost(makePolicyPlugin({ decider: realDecider(), onError: () => undefined }));
    expect((await refusal(late.invoke('refunds/issue', { amount: 20 }, {}))).code).toBe('permission_denied');
  });

  it('@S4.1 @edge an allow with a forced value merges it into the arguments the operation receives', async () => {
    const h = host();
    const dev = as({ role: 'dev', read_roots: [WORK] });
    expect(await h.invoke('files/write', { path: `${WORK}/out.txt`, overwrite: true }, dev)).toBe('write-ran');
    expect(h.ran).toEqual([{ fn: 'files/write', args: [`${WORK}/out.txt`, false] }]);
  });

  it('@S4.1 @negative no attributes at all: the global default role-less caller is refused a developer-only read', async () => {
    const h = host();
    expect((await refusal(h.invoke('files/read', { path: `${WORK}/readme.md` }))).code).toBe('permission_denied');
    expect(h.ran).toHaveLength(0);
  });

  it('@S4.1 @negative an aborted call is refused by the real decider before the operation runs', async () => {
    const h = host();
    const controller = new AbortController();
    controller.abort();
    const error = await refusal(h.invoke('files/read', { path: `${SHARED}/guide.md` }, { ...as({ role: 'dev', read_roots: [WORK] }), signal: controller.signal }));
    expect(error.code).toBe('permission_denied');
    expect(error.message).toBe('the request was aborted');
    expect(h.ran).toHaveLength(0);
  });
});
