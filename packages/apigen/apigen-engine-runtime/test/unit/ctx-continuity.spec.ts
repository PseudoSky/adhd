/**
 * guards: a mount handler sees a fresh empty ctx instead of the per-call map the --use Layers wrote, so a key set by an outer Layer (e.g. policy attributes) is lost on mount operations
 * tier: S
 * cites: REMEDIATION-PLAN T-R3 (scenario "a ctx key set by an outer layer is visible to a mount handler"; behaviour change 3)
 * tags: contract
 * teeth: red: change `ctx: fullCall.ctx` to `ctx: new LayerContext()` in dispatchForPlan's coreCall (guarded temporary edit, restored) and run `npx vitest run src/test/ctx-continuity.spec.ts` in packages/apigen/apigen-engine-runtime -> exit 1; the mount result is undefined instead of "core"
 */
import { describe, expect, it } from 'vitest';
import type { MountedOperation, Segment } from '@adhd/apigen-core-client';
import { createPackageInvoker, type UsePlugin } from '../../src/lib/package-invoker';
import { dispatchForPlan } from '../../src/lib/dispatch-for-plan';
import { buildOpPlan } from '../../src/lib/op-plan';

class PolicyAttributes {
  constructor(readonly value: string) {}
}

const seg = (raw: string): Segment => ({ raw, words: [raw] });

function mountOp(handler: MountedOperation['handler']): MountedOperation {
  return {
    id: '_meta/whoami',
    host: 'ts',
    namespace: seg('_meta'),
    path: [seg('whoami')],
    kind: 'action',
    async: false,
    streaming: false,
    safe: true,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
    handler,
  };
}

const outerLayer = (value: string): UsePlugin => ({
  id: `outer-${value}`,
  capabilities: {
    layer: {
      layer: async (call, next) => {
        call.ctx.set(PolicyAttributes, new PolicyAttributes(value));
        return next();
      },
    },
  },
});

describe('dispatchForPlan ctx continuity (T-R3)', () => {
  it('a mounted operation reads the key an outer layer set', async () => {
    const op = mountOp((call) => call.ctx.get(PolicyAttributes)?.value);
    const invoke = createPackageInvoker({}, [outerLayer('core')]);
    const result = await dispatchForPlan(
      buildOpPlan({ op, transport: 'cli' }),
      invoke,
      { envelope: {}, domainArgs: {} },
      { fns: {}, schemas: {} }
    );
    expect(result).toBe('core');
  });

  it('the innermost layer write wins, and two calls do not share a ctx', async () => {
    const op = mountOp((call) => call.ctx.get(PolicyAttributes)?.value ?? 'unset');
    const invoke = createPackageInvoker({}, [outerLayer('outer'), outerLayer('inner')]);
    const plan = buildOpPlan({ op, transport: 'cli' });
    const first = await dispatchForPlan(plan, invoke, { envelope: {}, domainArgs: {} }, { fns: {}, schemas: {} });
    expect(first).toBe('inner');
    const bare = createPackageInvoker({}, []);
    const second = await dispatchForPlan(plan, bare, { envelope: {}, domainArgs: {} }, { fns: {}, schemas: {} });
    expect(second).toBe('unset');
  });

  it('hands the mount handler the abort signal and the data the transport supplied', async () => {
    const controller = new AbortController();
    const op = mountOp((call) => ({ data: call.data, signal: call.signal, transport: call.transport }));
    const result = await dispatchForPlan(
      buildOpPlan({ op, transport: 'cli' }),
      createPackageInvoker({}, []),
      { envelope: {}, domainArgs: { a: 1 }, signal: controller.signal },
      { fns: {}, schemas: {} }
    );
    expect(result).toEqual({ data: { a: 1 }, signal: controller.signal, transport: 'cli' });
  });
});
