import type {
  ExecutionContext,
  IHookRegistry,
  ProviderFailureProviderType,
} from '@adhd/agent-base-types';
import { classifyProviderError, type RawProviderError } from '@adhd/agent-core-provider';
import { isProviderCallError } from './provider-failure.js';
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from './types.js';

/** What the decorator needs to attribute a failure; all non-secret. */
export interface HookedProviderOptions {
  /** Registry the `provider:*` failure events are emitted on. */
  hooks: IHookRegistry;
  /** The task the wrapped provider serves; becomes the event's `executionContext`. */
  executionContext: ExecutionContext;
  providerType: ProviderFailureProviderType;
  modelRef: string;
  wireModel: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function sourceOf(type: ProviderFailureProviderType, status: number | undefined): RawProviderError['source'] {
  if (type === 'claudecli') return 'cli-text';
  return status === undefined ? 'transport' : 'http';
}

/** Pull the classifier's raw inputs off an SDK / transport error without trusting its shape. */
function rawFromError(err: unknown, opts: HookedProviderOptions, aborted: boolean): RawProviderError {
  const e = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const status = num(e['status']);
  const raw: RawProviderError = {
    providerType: opts.providerType,
    modelRef: opts.modelRef,
    wireModel: opts.wireModel,
    // The credential itself is never visible at this layer; the placeholder is deliberately
    // not derived from any secret.
    credentialKey: 'unresolved',
    credentialScope: 'unresolved',
    source: sourceOf(opts.providerType, status),
    aborted,
    message: err instanceof Error ? err.message : String(err),
  };
  if (status !== undefined) raw.status = status;
  if (typeof e['headers'] === 'object' && e['headers'] !== null) raw.headers = e['headers'] as RawProviderError['headers'];
  if (e['error'] !== undefined) raw.body = e['error'];
  const errorName = err instanceof Error ? err.name : str(e['name']);
  if (errorName !== undefined) raw.errorName = errorName;
  const code = str(e['code']);
  if (code !== undefined) raw.errorCode = code;
  const requestId = str(e['requestID']) ?? str(e['request_id']);
  if (requestId !== undefined) raw.requestId = requestId;
  return raw;
}

/**
 * Decorate `inner` so a failed `chat()` emits `provider:failed` (terminal) on `hooks` before the
 * ORIGINAL error is rethrown unchanged (same object identity).
 *
 * Observational only: it emits no `pre:model_request` / `post:model_response` (the orchestrator
 * already brackets every main model call with those), never alters a successful response, and a
 * failing or throwing hook handler can never change what the caller sees.
 *
 * Only `provider:failed` is emitted: this layer performs a single attempt, so it observes no
 * retry/failover (`provider:attempt_failed`) and owns no trip state (`tripped` / `recovered`).
 */
export function withProviderHooks(inner: LLMProvider, opts: HookedProviderOptions): LLMProvider {
  return {
    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
      try {
        return await inner.chat(request);
      } catch (err) {
        try {
          // An adapter-classified failure carries real credential identity; reclassifying from text would not.
          const failure = isProviderCallError(err)
            ? err.data
            : classifyProviderError(rawFromError(err, opts, request.signal?.aborted === true));
          await opts.hooks.emit('provider:failed', {
            domain: 'provider',
            failure,
            correlationId: opts.executionContext.taskId,
            at: new Date().toISOString(),
            executionContext: opts.executionContext,
            disposition: 'terminal',
          });
        } catch {
          /* observational: never mask the provider's own error */
        }
        throw err;
      }
    },
  };
}
