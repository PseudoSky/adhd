import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  FAILURE_VERBS,
  isFailureEventKey,
  registerFailureDomain,
  errorCodeForFailureClass,
  PROVIDER_FAILURE_ERROR_CODE,
  HookRegistry,
} from './index.js';
import type {
  FailureEventKey,
  FailureDomainMap,
  HookEvent,
  HookEventMap,
  HitlSuspendKind,
  ProviderFailure,
  ProviderFailureClass,
  AttemptFailedPayload,
  FailedPayload,
  TrippedPayload,
  RecoveredPayload,
  AgentMcpErrorCode,
  ExecutionContext,
  PartialBinding,
  BindingRetryConfig,
} from './index.js';

// Generality proof (5e72d493 AC7): a second domain is registered by
// declaration-merging FailureDomainMap + one runtime registration. No consumer
// code changes.
interface IToolFailure {
  tool: string;
}
declare module './failure-events.js' {
  interface FailureDomainMap {
    tool: IToolFailure;
  }
}

describe('5e72d493 AC7 - isFailureEventKey', () => {
  it('accepts exactly provider:{attempt_failed,failed,tripped,recovered}', () => {
    const accepted = FAILURE_VERBS.map((v) => `provider:${v}`);
    expect(accepted).toEqual([
      'provider:attempt_failed',
      'provider:failed',
      'provider:tripped',
      'provider:recovered',
    ]);
    for (const k of accepted) expect(isFailureEventKey(k)).toBe(true);
  });

  it('rejects task:failed, provider:blocked, and malformed keys', () => {
    for (const k of [
      'task:failed',
      'provider:blocked',
      'provider:',
      ':failed',
      'provider',
      'provider:failed:extra',
      'Provider:failed',
      '',
      'pre:model_request',
    ]) {
      expect(isFailureEventKey(k), k).toBe(false);
    }
  });

  it('is total on non-string input', () => {
    for (const k of [undefined, null, 3, {}, []] as unknown[]) {
      expect(isFailureEventKey(k as string)).toBe(false);
    }
  });

  it('a second domain registered by declaration merge makes its keys valid', () => {
    expect(isFailureEventKey('tool:failed')).toBe(false);
    registerFailureDomain('tool');
    for (const v of FAILURE_VERBS) expect(isFailureEventKey(`tool:${v}`)).toBe(true);
    expect(isFailureEventKey('tool:blocked')).toBe(false);
    expect(isFailureEventKey('task:failed')).toBe(false);
    expectTypeOf<'tool:failed'>().toExtend<FailureEventKey>();
    expectTypeOf<FailureDomainMap['tool']>().toEqualTypeOf<IToolFailure>();
  });
});

/**
 * 5e72d493 AC7 negative control: the same acceptance assertion that the real
 * `isFailureEventKey` satisfies must go RED on deliberately-wrong validators.
 */
describe('5e72d493 AC7 - negative controls (assertions have teeth)', () => {
  const assertAC7 = (isKey: (k: string) => boolean) => {
    for (const v of FAILURE_VERBS) expect(isKey(`provider:${v}`)).toBe(true);
    expect(isKey('task:failed')).toBe(false);
    expect(isKey('provider:blocked')).toBe(false);
  };
  it('the real validator satisfies the assertion', () => {
    assertAC7(isFailureEventKey);
  });
  it('NC: accepting any verb (provider:blocked) goes RED', () => {
    expect(() => assertAC7((k) => k.startsWith('provider:'))).toThrow();
  });
  it('NC: accepting any domain (task:failed) goes RED', () => {
    expect(() => assertAC7((k) => k.endsWith(':failed') || (FAILURE_VERBS as readonly string[]).includes(k.split(':')[1] ?? ''))).toThrow();
  });
  it('NC: a validator that ignores the registry (rejects every domain but provider, even a registered one) cannot pass the generality proof', () => {
    registerFailureDomain('tool');
    const hardcoded = (k: string) => k.startsWith('provider:') && (FAILURE_VERBS as readonly string[]).includes(k.slice(9));
    expect(isFailureEventKey('tool:failed')).toBe(true);
    expect(hardcoded('tool:failed')).toBe(false);
  });
});

describe('5e72d493 - HookEventMap additive provider-failure surface', () => {
  it('declares the four provider failure events with typed payloads; existing events unchanged', () => {
    expectTypeOf<'provider:attempt_failed' | 'provider:failed' | 'provider:tripped' | 'provider:recovered'>().toExtend<HookEvent>();
    expectTypeOf<HookEventMap['provider:attempt_failed']>().toEqualTypeOf<AttemptFailedPayload<'provider'>>();
    expectTypeOf<HookEventMap['provider:failed']>().toEqualTypeOf<FailedPayload<'provider'>>();
    expectTypeOf<HookEventMap['provider:tripped']>().toEqualTypeOf<TrippedPayload<'provider'>>();
    expectTypeOf<HookEventMap['provider:recovered']>().toEqualTypeOf<RecoveredPayload<'provider'>>();
    expectTypeOf<'task:failed' | 'hitl:suspend' | 'permission:decision' | 'session:closed'>().toExtend<HookEvent>();
    expectTypeOf<'provider_blocked' | 'request_human_input' | 'permission_ask' | 'escalation'>().toExtend<HitlSuspendKind>();
  });

  it('a real HookRegistry delivers provider:failed with the typed failure', async () => {
    const hooks = new HookRegistry();
    const seen: string[] = [];
    hooks.register('provider:failed', (p) => void seen.push(`${p.disposition}:${p.failure.class}`));
    await hooks.emit('provider:failed', {
      domain: 'provider',
      failure: { class: 'billing' } as ProviderFailure,
      correlationId: 't1',
      at: new Date(0).toISOString(),
      disposition: 'suspended',
      executionContext: {} as ExecutionContext,
    });
    expect(seen).toEqual(['suspended:billing']);
  });
});

describe('5e72d493 - error-code projection and binding additions', () => {
  it('maps every class (except cancelled) to a code that is a member of AgentMcpErrorCode', () => {
    const classes: ProviderFailureClass[] = [
      'rate_limited', 'overloaded', 'unavailable', 'timeout', 'billing', 'auth',
      'permission', 'invalid_request', 'context_length', 'content_policy', 'cancelled', 'unknown',
    ];
    expect(errorCodeForFailureClass('billing')).toBe('PROVIDER_BILLING');
    expect(errorCodeForFailureClass('context_length')).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(errorCodeForFailureClass('unknown')).toBe('PROVIDER_ERROR');
    expect(errorCodeForFailureClass('cancelled')).toBeUndefined();
    expect(Object.keys(PROVIDER_FAILURE_ERROR_CODE).sort()).toEqual(
      classes.filter((c) => c !== 'cancelled').sort()
    );
    expectTypeOf<'PROVIDER_BILLING' | 'PROVIDER_OVERLOADED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_INVALID_REQUEST' | 'PROVIDER_CONTENT_POLICY' | 'PROVIDER_PERMISSION'>().toExtend<AgentMcpErrorCode>();
  });

  it('PartialBinding gains optional billingScope/tripwire/retryWindowMs without breaking existing literals', () => {
    const legacy: PartialBinding = { providerType: 'openai', retryConfig: { retries: 1, minTimeout: 1, maxTimeout: 2, factor: 2 } };
    const extended: PartialBinding = {
      billingScope: 'org_123',
      tripwire: { baseMs: 1000, maxMs: 60_000, probeLeaseMs: 5000 },
      retryConfig: { retries: 1, minTimeout: 1, maxTimeout: 2, factor: 2, retryWindowMs: 90_000 },
    };
    expect(legacy.billingScope).toBeUndefined();
    expect(extended.retryConfig?.retryWindowMs).toBe(90_000);
    expectTypeOf<BindingRetryConfig['retryWindowMs']>().toEqualTypeOf<number | undefined>();
  });
});
