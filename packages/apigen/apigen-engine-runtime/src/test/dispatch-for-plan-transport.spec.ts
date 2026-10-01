/**
 * AC0.2 — `dispatchForPlan` stamps `plan.transport` onto the runtime `Call` it
 * hands to `invoke`, for BOTH the source-op and the mount-op path.
 *
 * This is the contract seam the tracing plugin depends on: the engine supplies
 * `transport`; the plugin never hunts for it. A spy `InvokeFn` captures the
 * exact `fullCall` dispatchForPlan passes downstream, so removing the stamp
 * (or hardcoding a literal) flips these assertions RED.
 *
 * Deliberately uses NON-http transports ('grpc'/'cli') so a `'http'` fallback
 * cannot pass by accident (same teeth contract as the transport-stamping F3
 * assertion in op-plan.spec.ts).
 */

import { describe, expect, it } from 'vitest';
import type { MountedOperation, Operation, Segment } from '@adhd/apigen-core-client';
import type { ComposedSchemas } from '../lib/types';
import { buildOpPlan } from '../lib/op-plan';
import { dispatchForPlan } from '../lib/dispatch-for-plan';
import type { Call as RuntimeCall, InvokeFn, InvokeOptions } from '../lib/invoke';

function seg(raw: string, words: string[]): Segment {
  return { raw, words };
}

const srcOp: Operation = {
  id: 'transform/humanize/humanize-bytes',
  host: 'ts',
  namespace: seg('transform', ['transform']),
  path: [seg('humanize', ['humanize']), seg('humanizeBytes', ['humanize', 'bytes'])],
  kind: 'action',
  async: true,
  streaming: false,
  safe: true,
  input: {},
  output: {},
  envelope: {},
  typeText: null,
};

const srcSchema: ComposedSchemas[string] = {
  input: { type: 'object', properties: { data: { type: 'object', properties: {} } } },
  output: {},
} as unknown as ComposedSchemas[string];

function makeMountOp(id: string, handler: MountedOperation['handler']): MountedOperation {
  return {
    id,
    host: 'ts',
    namespace: seg('_meta', ['meta']),
    path: [seg(id.split('/')[1] ?? id, [id.split('/')[1] ?? id])],
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

/** Captures the `fullCall` that dispatchForPlan passes to `invoke`. */
function capturingInvoke(sink: { call?: RuntimeCall }): InvokeFn {
  return async (_id, call) => {
    sink.call = call;
    return 'ok';
  };
}

const emptyOpts: InvokeOptions = { fns: {}, schemas: {} };

describe('dispatchForPlan — transport stamping (AC0.2)', () => {
  it('stamps fullCall.transport = plan.transport for a source op (RED if the stamp is removed)', async () => {
    const plan = buildOpPlan({ op: srcOp, schema: srcSchema, transport: 'grpc' });
    const sink: { call?: RuntimeCall } = {};

    await dispatchForPlan(
      plan,
      capturingInvoke(sink),
      { envelope: {}, domainArgs: {} },
      emptyOpts
    );

    expect(sink.call).toBeDefined();
    expect(sink.call!.transport).toBe('grpc');
    expect(sink.call!.transport).toBe(plan.transport);
    // A hardcoded 'http' fallback would fail here.
    expect(sink.call!.transport).not.toBe('http');
  });

  it('stamps fullCall.transport = plan.transport for a mount op (RED if the stamp is removed)', async () => {
    const mountOp = makeMountOp('_meta/version', async () => ({ version: '1.0.0' }));
    const plan = buildOpPlan({ op: mountOp, transport: 'cli' });
    const sink: { call?: RuntimeCall } = {};

    await dispatchForPlan(
      plan,
      capturingInvoke(sink),
      { envelope: {}, domainArgs: {} },
      emptyOpts
    );

    expect(sink.call).toBeDefined();
    expect(sink.call!.transport).toBe('cli');
    expect(sink.call!.transport).toBe(plan.transport);
    expect(sink.call!.transport).not.toBe('http');
  });
});
