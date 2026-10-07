import type { ExecutionContext } from './domain.js';
import type { ProviderFailure, TripView } from './provider-failure.js';

/**
 * One failure-event family `<domain>:<verb>` over a closed verb vocabulary
 * (SPEC §5.2). "blocked" is a *disposition* of a failure, not an event kind.
 */
export const FAILURE_VERBS = [
  'attempt_failed',
  'failed',
  'tripped',
  'recovered',
] as const;
export type FailureVerb = (typeof FAILURE_VERBS)[number];

/**
 * Open registry: a domain registers by declaration-merging this interface with
 * its typed failure value, and calling {@link registerFailureDomain} at runtime.
 */
export interface FailureDomainMap {
  provider: ProviderFailure;
}
export type FailureDomain = keyof FailureDomainMap;
export type FailureEventKey = `${FailureDomain}:${FailureVerb}`;

const registeredDomains = new Set<string>(['provider']);

/**
 * Register a failure domain at runtime (pair with a `declare module` merge of
 * {@link FailureDomainMap} for the type). Idempotent.
 */
export function registerFailureDomain<D extends FailureDomain>(domain: D): void {
  registeredDomains.add(domain);
}

/**
 * True iff `k` is `<registered domain>:<FAILURE_VERBS member>`. Total: never throws.
 */
export function isFailureEventKey(k: string): k is FailureEventKey {
  if (typeof k !== 'string') return false;
  const i = k.indexOf(':');
  if (i <= 0 || k.indexOf(':', i + 1) !== -1) return false;
  return (
    registeredDomains.has(k.slice(0, i)) &&
    (FAILURE_VERBS as readonly string[]).includes(k.slice(i + 1))
  );
}

export interface FailureEventBase<D extends FailureDomain> {
  domain: D;
  failure: FailureDomainMap[D];
  /** The taskId, or the trip key for `tripped` / `recovered`. */
  correlationId: string;
  /** ISO-8601. */
  at: string;
  /** Absent for events with no task (clear-from-host-tool). */
  executionContext?: ExecutionContext;
}
export interface AttemptFailedPayload<D extends FailureDomain>
  extends FailureEventBase<D> {
  attempt: number;
  disposition: 'retrying' | 'failed_over';
}
export interface FailedPayload<D extends FailureDomain>
  extends FailureEventBase<D> {
  disposition: 'terminal' | 'suspended' | 'held' | 'refused';
}
export interface TrippedPayload<D extends FailureDomain>
  extends FailureEventBase<D> {
  trip: TripView;
}
export interface RecoveredPayload<D extends FailureDomain>
  extends FailureEventBase<D> {
  trip: TripView;
  reason: 'probe_ok' | 'cleared' | 'expired';
}
