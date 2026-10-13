/**
 * R10 S0 (types only, additive): the new trace-signal fields and hook events.
 * AC1: every new payload field is optional, so existing payload fixtures compile and behave unchanged.
 * AC3: the three new events are accepted by the real HookRegistry and typed to their payloads.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { HookRegistry } from './registry.js';
import type {
  BackgroundDeliveredPayload,
  DispatchCompletedPayload,
  ExecutionContext,
  HookEvent,
  HookEventMap,
  PostModelResponsePayload,
  PostToolCallPayload,
  PreToolCallPayload,
  TaskStartupPayload,
  ToolDefinition,
} from './index.js';

const ctx = {} as ExecutionContext;

describe('R10 S0 AC1: new fields are optional (pre-existing fixtures compile and run unchanged)', () => {
  it('R10 S0 AC1: a pre-R10 PreToolCallPayload / PostToolCallPayload / PostModelResponsePayload literal is still valid', () => {
    const pre: PreToolCallPayload = { executionContext: ctx, toolName: 's__t', callId: 'c1', toolInput: {} };
    const post: PostToolCallPayload = {
      executionContext: ctx,
      toolName: 's__t',
      callId: 'c1',
      toolInput: {},
      result: 'ok',
      isError: false,
      estResultTokens: 1,
    };
    const model: PostModelResponsePayload = { executionContext: ctx, stopReason: 'end_turn', toolCallCount: 0, computeMs: 5 };
    expect(pre.concurrencyClass).toBeUndefined();
    expect(post.errorClass).toBeUndefined();
    expect(model.thinkingConfig).toBeUndefined();
  });

  it('R10 S0 AC1: the new fields carry exactly the spec 7.1 types', () => {
    expectTypeOf<PreToolCallPayload['concurrencyClass']>().toEqualTypeOf<'safe' | 'barrier' | 'unordered' | undefined>();
    expectTypeOf<PreToolCallPayload['turnIndex']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PreToolCallPayload['groupIndex']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PreToolCallPayload['queuedMs']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PostToolCallPayload['errorClass']>().toEqualTypeOf<
      'none' | 'policy_rejected' | 'arg_mismatch' | 'arg_coerced' | 'exit_nonzero' | 'tool_error' | undefined
    >();
    expectTypeOf<PostToolCallPayload['resultBytes']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PostToolCallPayload['noteAppended']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<PostModelResponsePayload['ttfbMs']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PostModelResponsePayload['thinkingConfig']>().toEqualTypeOf<'none' | 'adaptive' | 'disabled' | undefined>();
    expectTypeOf<PostModelResponsePayload['thinkingBlocks']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PostModelResponsePayload['toolResultBytesIn']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<PostModelResponsePayload['turnIndex']>().toEqualTypeOf<number | undefined>();
  });

  it('R10 S0 AC1: ToolDefinition.annotations is optional and a bare ToolDefinition still compiles', () => {
    const bare: ToolDefinition = { name: 'a__b', description: 'd', inputSchema: {} };
    const annotated: ToolDefinition = { ...bare, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } };
    expect(bare.annotations).toBeUndefined();
    expectTypeOf(annotated.annotations).toEqualTypeOf<
      { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } | undefined
    >();
  });
});

describe('R10 S0 AC3: task:startup, dispatch:completed and background:delivered are real hook events', () => {
  it('R10 S0 AC3: the events are members of HookEvent and map to their payloads', () => {
    expectTypeOf<'task:startup' | 'dispatch:completed' | 'background:delivered'>().toExtend<HookEvent>();
    expectTypeOf<HookEventMap['task:startup']>().toEqualTypeOf<TaskStartupPayload>();
    expectTypeOf<HookEventMap['dispatch:completed']>().toEqualTypeOf<DispatchCompletedPayload>();
    expectTypeOf<HookEventMap['background:delivered']>().toEqualTypeOf<BackgroundDeliveredPayload>();
    expectTypeOf<TaskStartupPayload>().toEqualTypeOf<{
      executionContext: ExecutionContext;
      mcpConnectMs: Record<string, number>;
      toolsReadyMs: number;
      queueWaitMs?: number;
      sessionMs?: number;
      toolCount: number;
    }>();
    expectTypeOf<DispatchCompletedPayload>().toEqualTypeOf<{
      executionContext: ExecutionContext;
      kind: 'task' | 'tasks_batch' | 'agent_task' | 'result';
      mode: 'sync' | 'background';
      childTaskIds: string[];
      toolCallId?: string;
      parentBlockedMs: number;
      waitMs?: number;
    }>();
    expectTypeOf<BackgroundDeliveredPayload>().toEqualTypeOf<{
      executionContext: ExecutionContext;
      childTaskId: string;
      latencyMs: number;
      consumedVia: 'delivery' | 'result';
    }>();
  });

  it('R10 S0 AC3: a real HookRegistry registers and delivers each new event with its typed payload', async () => {
    const reg = new HookRegistry();
    const startup = vi.fn();
    const dispatched = vi.fn();
    const delivered = vi.fn();
    reg.register('task:startup', startup);
    reg.register('dispatch:completed', dispatched);
    reg.register('background:delivered', delivered);
    const s: TaskStartupPayload = { executionContext: ctx, mcpConnectMs: { fs: 12 }, toolsReadyMs: 30, queueWaitMs: 1, sessionMs: 2, toolCount: 7 };
    const d: DispatchCompletedPayload = { executionContext: ctx, kind: 'task', mode: 'background', childTaskIds: ['t1'], parentBlockedMs: 0 };
    const b: BackgroundDeliveredPayload = { executionContext: ctx, childTaskId: 't1', latencyMs: 40, consumedVia: 'delivery' };
    // R10 S5b AC2: the engine measures neither figure, so a payload without them is a valid TaskStartupPayload (no cast).
    const unmeasured: TaskStartupPayload = { executionContext: ctx, mcpConnectMs: {}, toolsReadyMs: 30, toolCount: 7 };
    await reg.emit('task:startup', unmeasured);
    await reg.emit('task:startup', s);
    await reg.emit('dispatch:completed', d);
    await reg.emit('background:delivered', b);
    expect(startup).toHaveBeenCalledWith(unmeasured);
    expect(startup).toHaveBeenCalledWith(s);
    expect(dispatched).toHaveBeenCalledWith(d);
    expect(delivered).toHaveBeenCalledWith(b);
  });
});
