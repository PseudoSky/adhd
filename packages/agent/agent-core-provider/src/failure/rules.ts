/**
 * The deterministic rule table (docs/plan/provider-failure/SPEC.md §1.1), as data.
 * Rules run in array order; first match wins; every outcome is `confidence:'certain'`.
 * Row 16 (stream-event / 200-with-error bodies) is not a rule: `classify.ts`
 * normalizes those onto the same table via `error.type` -> equivalent status.
 * Row 17 (cli-text) has no rows yet (no PF-2.AC4 captures): it routes through the
 * heuristics. Rows 18-19 are terminal fall-throughs implemented in `classify.ts`
 * because they depend on whether a heuristic fired.
 */
import type { FailureScope, ProviderFailureClass, ProviderFailureProviderType } from '@adhd/agent-base-types';

/** Normalized view of a raw error, built once by `classify.ts`. */
export interface RuleContext {
  providerType: ProviderFailureProviderType;
  aborted: boolean;
  /** Real HTTP status, or the status implied by `error.type` for stream events. */
  status: number | undefined;
  /** `error.type` (Anthropic/OpenAI). */
  errorType: string | undefined;
  /** `error.code` (OpenAI) or transport `code` (ECONNRESET...). */
  errorCode: string | undefined;
  /** `error.metadata.error_type` (OpenRouter). */
  metaErrorType: string | undefined;
  /** `error.metadata.limit_source` (OpenRouter 402). */
  limitSource: string | undefined;
  /** Anthropic `error.details.error_code`. */
  detailsErrorCode: string | undefined;
  /** SDK error class name (AbortError, ...). */
  errorName: string | undefined;
  finishReason: string | undefined;
  /** Moderation metadata present (OpenRouter `metadata.reasons` / flagged_input). */
  moderation: boolean;
  isOpenRouter: boolean;
  /** Scrubbed, untruncated message. */
  message: string;
}

export interface RuleOutcome {
  class: ProviderFailureClass;
  scope: FailureScope;
  retryable: boolean;
  resumable: boolean;
}

export interface FailureRule {
  /** SPEC §1.1 row number. */
  row: number;
  id: string;
  test(c: RuleContext): boolean;
  outcome: RuleOutcome;
}

const BILLING: RuleOutcome = { class: 'billing', scope: 'credential', retryable: false, resumable: true };
const RATE: RuleOutcome = { class: 'rate_limited', scope: 'model', retryable: true, resumable: false };
const OVERLOADED: RuleOutcome = { class: 'overloaded', scope: 'model', retryable: true, resumable: false };
const UNAVAILABLE: RuleOutcome = { class: 'unavailable', scope: 'model', retryable: true, resumable: false };
const TIMEOUT: RuleOutcome = { class: 'timeout', scope: 'model', retryable: true, resumable: false };
const INVALID: RuleOutcome = { class: 'invalid_request', scope: 'request', retryable: false, resumable: false };

/**
 * The ONE pinned message rule (SPEC §1.1 row 5, Q4). Anthropic emits no code for
 * the workspace usage-limit 400, so this anchored, exact-sentence match is the
 * sole free-text rule on the http path. The documented message optionally carries
 * a regain-date tail ("You will regain access on <date>."); nothing else may follow.
 * A reworded copy deliberately fails safe to `unknown` (suspected billing) via the
 * heuristics. An upstream request for a structured code is the ADR-0002 fix.
 */
export const PINNED_USAGE_LIMIT_MESSAGE =
  /^You have reached your specified API usage limits\.(?: You will regain access on [^.]+\.)?$/;

const CONTEXT_CODES = new Set(['context_length_exceeded', 'max_tokens_exceeded', 'token_limit_exceeded']);
const OPENAI_BILLING_CODES = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);
const OVERLOAD_MARKERS = new Set(['server_is_overloaded', 'service_unavailable_error', 'provider_overloaded']);
const TRANSPORT_UNAVAILABLE = new Set(['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED']);
const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError', 'APIConnectionTimeoutError']);

const anyMarker = (c: RuleContext, set: ReadonlySet<string>): boolean =>
  [c.errorCode, c.errorType, c.metaErrorType].some((v) => v !== undefined && set.has(v));

/** Marker for rule 5 so it is greppable and fixture-pinned. */
export const PINNED_MESSAGE_RULE = 'PINNED_MESSAGE_RULE';

export const FAILURE_RULES: readonly FailureRule[] = [
  { row: 1, id: 'aborted', test: (c) => c.aborted, outcome: { class: 'cancelled', scope: 'request', retryable: false, resumable: false } },
  { row: 2, id: 'openrouter-in-flight-budget', test: (c) => c.isOpenRouter && c.limitSource === 'openrouter_in_flight_budget', outcome: RATE },
  { row: 2, id: 'openrouter-credits', test: (c) => c.isOpenRouter && (c.limitSource === 'openrouter_credits' || c.limitSource === 'openrouter_key_limit' || c.status === 402), outcome: BILLING },
  { row: 3, id: 'anthropic-billing-error', test: (c) => c.providerType === 'anthropic' && c.errorType === 'billing_error', outcome: BILLING },
  { row: 4, id: 'anthropic-enforced-spend-limit', test: (c) => c.status === 429 && c.detailsErrorCode === 'enforced_spend_limit_reached', outcome: BILLING },
  {
    row: 5,
    id: PINNED_MESSAGE_RULE,
    test: (c) =>
      c.providerType === 'anthropic' &&
      c.status === 400 &&
      c.errorType === 'invalid_request_error' &&
      PINNED_USAGE_LIMIT_MESSAGE.test(c.message),
    outcome: BILLING,
  },
  { row: 6, id: 'openai-billing', test: (c) => (c.errorCode !== undefined && OPENAI_BILLING_CODES.has(c.errorCode)) || c.errorType === 'insufficient_quota', outcome: BILLING },
  { row: 7, id: 'rate-limited', test: (c) => c.status === 429, outcome: RATE },
  {
    row: 8,
    id: 'overloaded',
    test: (c) =>
      (c.providerType === 'anthropic' && (c.status === 529 || c.errorType === 'overloaded_error')) ||
      (anyMarker(c, OVERLOAD_MARKERS) && (c.status === 503 || c.status === undefined)),
    outcome: OVERLOADED,
  },
  { row: 9, id: 'auth', test: (c) => c.status === 401, outcome: { class: 'auth', scope: 'credential', retryable: false, resumable: true } },
  {
    row: 10,
    id: 'content-policy',
    test: (c) =>
      c.errorCode === 'content_policy_violation' ||
      c.errorType === 'content_policy_violation' ||
      c.errorType === 'refusal' ||
      c.finishReason === 'refusal' ||
      (c.status === 403 && c.moderation),
    outcome: { class: 'content_policy', scope: 'request', retryable: false, resumable: false },
  },
  { row: 11, id: 'permission', test: (c) => c.status === 403, outcome: { class: 'permission', scope: 'credential', retryable: false, resumable: true } },
  {
    row: 12,
    id: 'context-length',
    test: (c) => [c.errorCode, c.errorType, c.metaErrorType].some((v) => v !== undefined && CONTEXT_CODES.has(v)),
    outcome: { class: 'context_length', scope: 'request', retryable: false, resumable: false },
  },
  {
    row: 13,
    id: 'timeout',
    test: (c) => c.status === 408 || c.status === 504 || c.errorCode === 'ETIMEDOUT' || (c.errorName !== undefined && TIMEOUT_NAMES.has(c.errorName)),
    outcome: TIMEOUT,
  },
  { row: 14, id: 'conflict', test: (c) => c.status === 409, outcome: UNAVAILABLE },
  { row: 15, id: 'openrouter-503-not-overloaded', test: (c) => c.isOpenRouter && c.status === 503, outcome: INVALID },
  {
    row: 15,
    id: 'unavailable',
    test: (c) => c.status === 500 || c.status === 502 || c.status === 503 || (c.errorCode !== undefined && TRANSPORT_UNAVAILABLE.has(c.errorCode)),
    outcome: UNAVAILABLE,
  },
];

/** Row 18: statuses that are deterministic `invalid_request` when no heuristic token fired. */
export const INVALID_REQUEST_STATUSES: ReadonlySet<number> = new Set([400, 404, 413, 422]);
export { INVALID as INVALID_REQUEST_OUTCOME, UNAVAILABLE as UNAVAILABLE_OUTCOME };
