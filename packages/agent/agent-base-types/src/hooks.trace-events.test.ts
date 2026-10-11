import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { HookRegistry } from './registry.js';
import type {
  HookEvent,
  HookEventMap,
  PermissionDecisionPayload,
  HitlSuspendPayload,
  HitlResumePayload,
  SessionClosedPayload,
  ExecutionContext,
  Session,
  PermissionAction,
  AskResolution,
} from './index.js';

/** The pre-TRACE-1 event surface, frozen. */
type ExistingEvents =
  | 'task:start'
  | 'pre:model_request'
  | 'post:model_response'
  | 'pre:tool_call'
  | 'post:tool_call'
  | 'transform:tool_result'
  | 'budget:warning'
  | 'budget:block'
  | 'message:appended'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled'
  | 'session:created'
  | 'agent:mutated';
type NewEvents =
  | 'permission:decision'
  | 'hitl:suspend'
  | 'hitl:resume'
  | 'session:closed';
/** Added additively by the provider-failure family (5e72d493 PF-1). */
type ProviderFailureEvents =
  | 'provider:attempt_failed'
  | 'provider:failed'
  | 'provider:tripped'
  | 'provider:recovered';
/** Added additively as typed, task-event-persisted warnings (20772a0b AC1). */
type TaskEventWarningEvents = 'budget:unpriced_model' | 'provider:builtin_bypass';

const ctx = {} as ExecutionContext;
const session = {} as Session;

describe('da907b90 AC1 — HookEventMap declares the 4 trace events with typed payloads', () => {
  it('HookEvent includes every new event and maps it to its payload', () => {
    expectTypeOf<NewEvents>().toExtend<HookEvent>();
    expectTypeOf<HookEventMap['permission:decision']>().toEqualTypeOf<PermissionDecisionPayload>();
    expectTypeOf<HookEventMap['hitl:suspend']>().toEqualTypeOf<HitlSuspendPayload>();
    expectTypeOf<HookEventMap['hitl:resume']>().toEqualTypeOf<HitlResumePayload>();
    expectTypeOf<HookEventMap['session:closed']>().toEqualTypeOf<SessionClosedPayload>();
  });

  it('a real HookRegistry delivers each new event to its handler with the typed payload', async () => {
    const hooks = new HookRegistry();
    const seen: string[] = [];
    hooks.register('permission:decision', (p) => void seen.push(`perm:${p.action}/${p.resolution}`));
    hooks.register('hitl:suspend', (p) => void seen.push(`suspend:${p.kind}:${p.parkedTaskId}`));
    hooks.register('hitl:resume', (p) => void seen.push(`resume:${p.outcome}`));
    hooks.register('session:closed', () => void seen.push('closed'));

    await hooks.emit('permission:decision', {
      executionContext: ctx, server: 's', tool: 't', callId: 'c1',
      qualifiedToolName: 's__t', action: 'ask', resolution: 'suspend',
    });
    await hooks.emit('hitl:suspend', {
      executionContext: ctx, kind: 'permission_ask', parkedTaskId: 'T1', resumeToken: 'tok',
    });
    await hooks.emit('hitl:resume', { executionContext: ctx, parkedTaskId: 'T1', outcome: 'approved' });
    await hooks.emit('session:closed', { session });
    expect(seen).toEqual(['perm:ask/suspend', 'suspend:permission_ask:T1', 'resume:approved', 'closed']);
  });

  it('new-event handlers are observational: a throwing handler is isolated (swallowed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const hooks = new HookRegistry();
    const after = vi.fn();
    hooks.register('session:closed', () => { throw new Error('boom'); });
    hooks.register('session:closed', after);
    await expect(hooks.emit('session:closed', { session })).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('da907b90 AC2 — the existing events are unchanged (additive-only)', () => {
  it('every pre-existing event is still a HookEvent with an unchanged key set', () => {
    expectTypeOf<ExistingEvents>().toExtend<HookEvent>();
    // Exactly existing ∪ new — nothing renamed, nothing removed, nothing extra.
    expectTypeOf<HookEvent>().toEqualTypeOf<
      ExistingEvents | NewEvents | ProviderFailureEvents | TaskEventWarningEvents
    >();
    expectTypeOf<
      Exclude<HookEvent, NewEvents | ProviderFailureEvents | TaskEventWarningEvents>
    >().toEqualTypeOf<ExistingEvents>();
  });

  it('a real HookRegistry still delivers a pre-existing event', async () => {
    const hooks = new HookRegistry();
    const handler = vi.fn();
    hooks.register('task:cancelled', handler);
    await hooks.emit('task:cancelled', { executionContext: ctx });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('da907b90 AC3 — payload shapes and unknown-event rejection (type-level)', () => {
  it('PermissionDecisionPayload shape', () => {
    expectTypeOf<PermissionDecisionPayload>().toHaveProperty('server').toEqualTypeOf<string>();
    expectTypeOf<PermissionDecisionPayload>().toHaveProperty('tool').toEqualTypeOf<string>();
    expectTypeOf<PermissionDecisionPayload>().toHaveProperty('callId').toEqualTypeOf<string>();
    expectTypeOf<PermissionDecisionPayload>().toHaveProperty('qualifiedToolName').toEqualTypeOf<string>();
    expectTypeOf<PermissionDecisionPayload['action']>().toEqualTypeOf<PermissionAction>();
    expectTypeOf<PermissionDecisionPayload['resolution']>().toEqualTypeOf<'allow' | AskResolution>();
    expectTypeOf<PermissionDecisionPayload['reason']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PermissionDecisionPayload['executionContext']>().toEqualTypeOf<ExecutionContext>();
  });

  it('HitlSuspendPayload shape', () => {
    expectTypeOf<HitlSuspendPayload['kind']>().toEqualTypeOf<
      'request_human_input' | 'permission_ask' | 'escalation' | 'provider_blocked'
    >();
    expectTypeOf<HitlSuspendPayload['parkedTaskId']>().toEqualTypeOf<string>();
    expectTypeOf<HitlSuspendPayload['resumeToken']>().toEqualTypeOf<string>();
    expectTypeOf<HitlSuspendPayload['escalatedFrom']>().toEqualTypeOf<string | undefined>();
  });

  it('HitlResumePayload shape', () => {
    expectTypeOf<HitlResumePayload['outcome']>().toEqualTypeOf<
      'resumed' | 'approved' | 'declined' | 'cancelled'
    >();
    expectTypeOf<HitlResumePayload['parkedTaskId']>().toEqualTypeOf<string>();
  });

  it('SessionClosedPayload shape', () => {
    expectTypeOf<SessionClosedPayload>().toEqualTypeOf<{ session: Session }>();
  });

  it('an unknown event name fails to compile; wrong payloads fail to compile', async () => {
    const hooks = new HookRegistry();
    // @ts-expect-error — 'session:opened' is not a HookEvent
    hooks.register('session:opened', () => undefined);
    // @ts-expect-error — unknown event on emit
    await hooks.emit('hitl:nonsense', {});
    // @ts-expect-error — outcome must be one of the HitlResumeOutcome literals
    await hooks.emit('hitl:resume', { executionContext: ctx, parkedTaskId: 'T', outcome: 'maybe' });
    // @ts-expect-error — resumeToken is required
    await hooks.emit('hitl:suspend', { executionContext: ctx, kind: 'escalation', parkedTaskId: 'T' });
    await hooks.emit('permission:decision', {
      executionContext: ctx, server: 's', tool: 't', callId: 'c', qualifiedToolName: 's__t',
      action: 'ask',
      // @ts-expect-error — resolution cannot be 'ask' (it is 'allow' | AskResolution)
      resolution: 'ask',
    });
    expect(true).toBe(true);
  });
});
