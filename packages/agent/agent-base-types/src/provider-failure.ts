import type { AgentMcpErrorCode } from './errors.js';
import type { TokenUsage } from './domain.js';

/**
 * Provider-failure taxonomy (docs/plan/provider-failure/SPEC.md §1).
 *
 * One typed value, {@link ProviderFailure}, produced by ONE deterministic
 * classifier (`@adhd/agent-core-provider`), carried on `ToolError.data` and
 * persisted on the task row. Pure types + two total helpers; no runtime deps.
 */

/** What kind of provider failure this is. `failure.class` is the source of truth. */
export type ProviderFailureClass =
  | 'rate_limited'
  | 'overloaded'
  | 'unavailable'
  | 'timeout'
  | 'billing'
  | 'auth'
  | 'permission'
  | 'invalid_request'
  | 'context_length'
  | 'content_policy'
  | 'cancelled'
  | 'unknown';

/** How far a failure reaches: one request, one model on a credential, or a whole credential. */
export type FailureScope = 'request' | 'model' | 'credential';

/** `'certain'` for every deterministic classifier rule; heuristics yield `high|medium|low`. */
export type Confidence = 'certain' | 'high' | 'medium' | 'low';

/** Provider families a failure can originate from (mirrors `ProviderType`). */
export type ProviderFailureProviderType = 'anthropic' | 'openai' | 'claudecli';

/** Where the classifier saw the failure. `'trip'` = refused locally, no provider call made. */
export type FailureSource = 'http' | 'stream-event' | 'cli-text' | 'transport' | 'trip';

/** Raw evidence attached ONLY to `class:'unknown'` failures (scrubbed). */
export interface FailureEvidence {
  matchedTokens: string[];
  status?: number;
  errorName?: string;
  /** At most 300 chars, secrets scrubbed. */
  bodySnippet?: string;
}

/** Reference to the tripwire entry a failure opened or was refused by (SPEC §9). */
export interface TripRef {
  key: string;
  generation: number;
  /** ISO-8601. */
  recheckAt: string;
  state: 'open' | 'half_open';
}

/** One model-call attempt, as persisted in the `PROVIDER_ATTEMPT` task event (SPEC §5.1). */
export interface AttemptSummary {
  n: number;
  modelRef: string;
  wireModel: string;
  providerType: ProviderFailureProviderType;
  credentialKey: string;
  credentialScope: string;
  outcome: 'ok' | ProviderFailureClass | 'skipped_trip';
  status?: number;
  providerErrorType?: string;
  retryAfterMs?: number;
  backoffMs?: number;
  durationMs: number;
  requestId?: string;
  usage?: TokenUsage;
  failoverFrom?: string;
  evidence?: FailureEvidence;
}

/** One hop a failure travelled up the dispatch chain (SPEC §4). */
export interface FailureHop {
  taskId: string;
  agentName?: string;
  role: 'origin' | 'child-of' | 'unit' | 'root';
  /** ISO-8601. */
  at: string;
}

/** The typed provider failure (SPEC §1). */
export interface ProviderFailure {
  readonly v: 1;
  class: ProviderFailureClass;
  scope: FailureScope;
  /** A LATER identical call plausibly succeeds without human action. */
  retryable: boolean;
  /** Succeeds after a human/time action (top-up, key rotation, window reset). */
  resumable: boolean;
  confidence: Confidence;
  /** Only when `class==='unknown'` (SPEC §1.3). */
  suspectedClass?: ProviderFailureClass;
  /** Only when `class==='unknown'`. */
  evidence?: FailureEvidence;
  /** Raw, uncapped provider hint (SPEC §2.3). */
  retryAfterMs?: number;
  providerType: ProviderFailureProviderType;
  status?: number;
  providerErrorType?: string;
  providerErrorCode?: string;
  requestId?: string;
  modelRef: string;
  wireModel: string;
  /** sha256(providerType|baseURL|secretEnvName) truncated; never a secret. */
  credentialKey: string;
  /** `billingScope ?? credentialKey`: the unit that shares spend/auth fate (SPEC §9.2). */
  credentialScope: string;
  /** Truncated to 500 chars, secrets scrubbed. */
  message: string;
  source: FailureSource;
  /** claudecli side-effect guard (SPEC §2.2). */
  toolUseEmitted?: boolean;
  /** Last 8 attempts on the task row; the full list lives in `task_events`. */
  attempts: AttemptSummary[];
  hops: FailureHop[];
  trip?: TripRef;
  classifierVersion: number;
}

/** Bounded copy for `dispatch_log` / list views (SPEC §1, review S2). */
export interface ProviderFailureSummary {
  class: ProviderFailureClass;
  scope: FailureScope;
  retryable: boolean;
  resumable: boolean;
  confidence: Confidence;
  status?: number;
  providerErrorType?: string;
  requestId?: string;
  retryAfterMs?: number;
  credentialScope: string;
  /** At most 200 chars. */
  message: string;
  attemptCount: number;
  lastAttempt?: AttemptSummary;
  hopCount: number;
  trip?: TripRef;
}

/** Shared-state view of one provider trip (SPEC §9.1 `provider_trips` row; timestamps ISO-8601). */
export interface TripView {
  key: string;
  providerType: ProviderFailureProviderType;
  credentialScope: string;
  wireModel?: string;
  class: ProviderFailureClass;
  scope: FailureScope;
  state: 'open' | 'half_open' | 'closed';
  /** Monotonic CAS token, +1 on every transition. */
  generation: number;
  consecutiveTrips: number;
  openedAt: string;
  recheckAt: string;
  probeOwner?: string;
  probeUntil?: string;
  lastFailure: ProviderFailureSummary;
  openedBy: string;
  closedBy?: string;
  closedReason?: 'probe_ok' | 'cleared' | 'expired';
  updatedAt: string;
}

/** Operator-tunable tripwire knobs on a provider binding (typed config, never env; SPEC §9.3). */
export interface TripwireConfig {
  /** Overrides the per-class cooldown base. */
  baseMs?: number;
  /** Cooldown cap. Default 15 minutes. */
  maxMs?: number;
  /** Half-open probe lease. Default 120 000 ms. */
  probeLeaseMs?: number;
}

/**
 * Compatibility projection `failure.class` -> `ErrorCode` (SPEC §1.2). `cancelled`
 * has no code: it rides the existing cancel path.
 */
export const PROVIDER_FAILURE_ERROR_CODE: Readonly<
  Record<Exclude<ProviderFailureClass, 'cancelled'>, AgentMcpErrorCode>
> = {
  rate_limited: 'PROVIDER_RATE_LIMITED',
  overloaded: 'PROVIDER_OVERLOADED',
  unavailable: 'PROVIDER_UNAVAILABLE',
  timeout: 'PROVIDER_TIMEOUT',
  billing: 'PROVIDER_BILLING',
  auth: 'PROVIDER_AUTH_ERROR',
  permission: 'PROVIDER_PERMISSION',
  invalid_request: 'PROVIDER_INVALID_REQUEST',
  context_length: 'CONTEXT_WINDOW_EXCEEDED',
  content_policy: 'PROVIDER_CONTENT_POLICY',
  unknown: 'PROVIDER_ERROR',
};

/** Map a failure class to its wire `ErrorCode`; `undefined` for `cancelled`. */
export function errorCodeForFailureClass(
  c: ProviderFailureClass
): AgentMcpErrorCode | undefined {
  return c === 'cancelled' ? undefined : PROVIDER_FAILURE_ERROR_CODE[c];
}
