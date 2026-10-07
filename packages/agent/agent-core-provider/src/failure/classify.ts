/**
 * Deterministic provider-failure classifier (docs/plan/provider-failure/SPEC.md §1.1).
 * Pure and total: `classifyProviderError` never throws and makes no I/O. It imports
 * no provider SDK; the engine extracts a {@link RawProviderError} from whatever the
 * SDK/CLI threw and hands it here.
 */
import type {
  FailureSource,
  ProviderFailure,
  ProviderFailureClass,
  ProviderFailureProviderType,
} from '@adhd/agent-base-types';
import { classifyHeuristically, scrubSecrets, truncate } from './heuristics.js';
import {
  FAILURE_RULES,
  INVALID_REQUEST_OUTCOME,
  INVALID_REQUEST_STATUSES,
  UNAVAILABLE_OUTCOME,
  type RuleContext,
  type RuleOutcome,
} from './rules.js';
import { parseRetryAfter, type RetryHeaders } from './retry-after.js';

/** Bump when a rule changes meaning; stored on every failure (SPEC §1.1 drift canary). */
export const CLASSIFIER_VERSION = 1;

/** What the engine extracts from an SDK / CLI / transport error. All fields optional but identity. */
export interface RawProviderError {
  providerType: ProviderFailureProviderType;
  modelRef: string;
  wireModel: string;
  credentialKey: string;
  /** `billingScope ?? credentialKey`. */
  credentialScope: string;
  source: FailureSource;
  /** The caller's `signal.aborted` at failure time (row 1). */
  aborted?: boolean;
  /** HTTP status (absent for transport / CLI / stream events). */
  status?: number;
  headers?: RetryHeaders;
  /** Parsed JSON error body (object) or raw text. */
  body?: unknown;
  /** SDK error class name, e.g. `AbortError`. */
  errorName?: string;
  /** Transport error code, e.g. `ECONNRESET`. Falls back to `body.error.code`. */
  errorCode?: string;
  message?: string;
  /** Request host (OpenRouter detection: `openrouter.ai`). */
  host?: string;
  requestId?: string;
  toolUseEmitted?: boolean;
  /** Clock for HTTP-date `retry-after`; defaults to `Date.now()`. */
  nowMs?: number;
}

/** The classifier's output IS the persisted value; `attempts`/`hops` are filled by the engine. */
export type ClassifiedFailure = ProviderFailure;

/** Index-signature-safe property read. */
const at = (o: Record<string, unknown> | undefined, k: string): unknown => (o ? o[k] : undefined);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  return typeof v === 'number' ? String(v) : undefined;
};

/** Row 16: status implied by an Anthropic/OpenAI `error.type` when no HTTP status exists. */
const STATUS_BY_ERROR_TYPE: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

function bodyText(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}

function normalize(raw: RawProviderError): RuleContext & { providerErrorType?: string; providerErrorCode?: string; bodyText?: string } {
  const body = isObj(raw.body) ? raw.body : undefined;
  // Anthropic: {type:'error', error:{...}}; OpenAI: {error:{...}}; some SDKs hand the inner object.
  const inner = at(body, 'error');
  const err = isObj(inner) ? inner : body;
  const metaRaw = at(err, 'metadata');
  const meta = isObj(metaRaw) ? metaRaw : undefined;
  const detailsRaw = at(err, 'details');
  const details = isObj(detailsRaw) ? detailsRaw : undefined;
  const rawType = str(at(err, 'type'));
  const errorType = rawType === 'error' ? undefined : rawType;
  const status = raw.status ?? (errorType === undefined ? undefined : STATUS_BY_ERROR_TYPE[errorType]);
  const message = scrubSecrets(raw.message ?? str(at(err, 'message')) ?? (typeof raw.body === 'string' ? raw.body : ''));
  const host = (raw.host ?? '').toLowerCase();
  const errorCode = raw.errorCode ?? str(at(err, 'code'));
  const metaErrorType = str(at(meta, 'error_type'));
  const text = bodyText(raw.body);
  return {
    providerType: raw.providerType,
    aborted: raw.aborted === true,
    status,
    errorType,
    errorCode,
    metaErrorType,
    limitSource: str(at(meta, 'limit_source')),
    detailsErrorCode: str(at(details, 'error_code')),
    errorName: raw.errorName,
    finishReason: str(at(body, 'finish_reason')) ?? str(at(err, 'finish_reason')),
    moderation: !!meta && (at(meta, 'reasons') !== undefined || at(meta, 'flagged_input') !== undefined),
    isOpenRouter: host === 'openrouter.ai' || host.endsWith('.openrouter.ai'),
    message,
    providerErrorType: errorType ?? metaErrorType,
    providerErrorCode: errorCode,
    bodyText: text === undefined ? undefined : scrubSecrets(text),
  };
}

function build(
  raw: RawProviderError,
  ctx: ReturnType<typeof normalize>,
  outcome: RuleOutcome,
  extra: Partial<ProviderFailure>
): ProviderFailure {
  const ra = parseRetryAfter(raw.headers, raw.nowMs);
  const f: ProviderFailure = {
    v: 1,
    class: outcome.class,
    scope: outcome.scope,
    // `x-should-retry: false` overrides a retryable verdict (SPEC §2.3).
    retryable: ra.shouldRetry === false ? false : outcome.retryable,
    resumable: outcome.resumable,
    confidence: 'certain',
    providerType: raw.providerType,
    modelRef: raw.modelRef,
    wireModel: raw.wireModel,
    credentialKey: raw.credentialKey,
    credentialScope: raw.credentialScope,
    message: truncate(ctx.message, 500),
    source: raw.source,
    attempts: [],
    hops: [],
    classifierVersion: CLASSIFIER_VERSION,
    ...extra,
  };
  if (ra.retryAfterMs !== undefined) f.retryAfterMs = ra.retryAfterMs;
  if (raw.status !== undefined) f.status = raw.status;
  if (ctx.providerErrorType !== undefined) f.providerErrorType = ctx.providerErrorType;
  if (ctx.providerErrorCode !== undefined) f.providerErrorCode = ctx.providerErrorCode;
  if (raw.requestId !== undefined) f.requestId = raw.requestId;
  if (raw.toolUseEmitted !== undefined) f.toolUseEmitted = raw.toolUseEmitted;
  return f;
}

function unknownFailure(raw: RawProviderError, ctx: ReturnType<typeof normalize>): ProviderFailure {
  const h = classifyHeuristically({
    status: ctx.status,
    errorName: ctx.errorName,
    providerErrorType: ctx.providerErrorType,
    providerErrorCode: ctx.providerErrorCode,
    message: ctx.message,
    bodyText: ctx.bodyText,
  });
  return build(
    raw,
    ctx,
    { class: 'unknown', scope: 'request', retryable: false, resumable: false },
    {
      confidence: h.confidence,
      ...(h.suspectedClass ? { suspectedClass: h.suspectedClass as ProviderFailureClass } : {}),
      evidence: h.evidence,
    }
  );
}

/**
 * Classify one provider error. Rules run in SPEC §1.1 order; the first match wins
 * with `confidence:'certain'`. Anything else goes to the heuristics, which only ever
 * return `class:'unknown'`. Never throws.
 */
export function classifyProviderError(raw: RawProviderError): ClassifiedFailure {
  try {
    const ctx = normalize(raw);

    if (raw.source !== 'cli-text') {
      for (const rule of FAILURE_RULES) {
        if (rule.test(ctx)) return build(raw, ctx, rule.outcome, {});
      }
      // Row 18 + 19: a heuristic token hit keeps the failure `unknown` (precedence guard S1).
      const h = classifyHeuristically({
        status: ctx.status,
        errorName: ctx.errorName,
        providerErrorType: ctx.providerErrorType,
        providerErrorCode: ctx.providerErrorCode,
        message: ctx.message,
        bodyText: ctx.bodyText,
      });
      if (!h.tokenFired) {
        if (ctx.status !== undefined && INVALID_REQUEST_STATUSES.has(ctx.status)) {
          return build(raw, ctx, INVALID_REQUEST_OUTCOME, {});
        }
        if (ctx.status !== undefined && ctx.status >= 500) {
          return build(raw, ctx, UNAVAILABLE_OUTCOME, {});
        }
      }
    }
    // Row 17 (cli-text) has no pinned patterns yet (no PF-2.AC4 captures): heuristics only.
    return unknownFailure(raw, ctx);
  } catch {
    return safeFallback(raw);
  }
}

/** Last-resort value so the classifier is total even for hostile inputs (getters that throw, cycles). */
function safeFallback(raw: RawProviderError): ProviderFailure {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    v: 1,
    class: 'unknown',
    scope: 'request',
    retryable: false,
    resumable: false,
    confidence: 'low',
    evidence: { matchedTokens: [] },
    providerType: raw?.providerType ?? 'openai',
    modelRef: s(raw?.modelRef),
    wireModel: s(raw?.wireModel),
    credentialKey: s(raw?.credentialKey),
    credentialScope: s(raw?.credentialScope),
    message: '',
    source: raw?.source ?? 'transport',
    attempts: [],
    hops: [],
    classifierVersion: CLASSIFIER_VERSION,
  };
}
