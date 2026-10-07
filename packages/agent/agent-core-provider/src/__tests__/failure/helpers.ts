import type { ProviderFailureProviderType } from '@adhd/agent-base-types';
import type { RawProviderError } from '../../failure/index.js';

export const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

/** Build a RawProviderError with fixed identity fields. */
export function raw(
  providerType: ProviderFailureProviderType,
  over: Partial<RawProviderError>
): RawProviderError {
  return {
    providerType,
    modelRef: `${providerType}/model`,
    wireModel: 'wire-model',
    credentialKey: 'ck_abc',
    credentialScope: 'ck_abc',
    source: 'http',
    nowMs: NOW,
    ...over,
  };
}

/** Anthropic wire body: `{type:'error', error:{type, message, details?}}`. */
export const anthropicBody = (type: string, message: string, details?: Record<string, unknown>) => ({
  type: 'error',
  error: { type, message, ...(details ? { details } : {}) },
});

/** OpenAI wire body: `{error:{code,type,message}}`. */
export const openaiBody = (o: { code?: string; type?: string; message?: string }) => ({
  error: { message: 'm', ...o },
});
