import type { ProviderEnvBlock, RetryConfig } from './domain.js';

/**
 * Canonical model identifier, e.g. `claude_sonnet_4_6`. Never a wire string:
 * the per-platform string (`claude-sonnet-4-6`, `sonnet`, ...) is resolved from
 * the provider registry's binding table via `ProviderRegistry.resolveModelRef`.
 */
export type ModelSlug = string;

/** The closed set of provider families an agent/session/task can bind to. */
export type ProviderType = 'anthropic' | 'openai' | 'claudecli';

/**
 * A provider binding where every field is optional. This is the single shape
 * shared by every layer that can contribute to provider selection (task,
 * session, agent definition, global default) and by the dispatch DAG's
 * `providers` map — one representation, camelCase end to end.
 *
 * Credentials are env-var NAME pointers inside `env`, never values.
 */
export interface PartialBinding {
  providerType?: ProviderType;
  /** Canonical model id (or, for legacy dispatch DAGs, a wire model string). */
  modelRef?: ModelSlug;
  /** Ordered fallback list of canonical model ids (consumed by D-G(4)). */
  models?: ModelSlug[];
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  retryConfig?: RetryConfig;
  env?: ProviderEnvBlock;
  baseURL?: string;
}

/**
 * A fully resolved binding: `providerType` and `modelRef` are non-null. The
 * output of the selection chain `task ?? session ?? agent ?? global`.
 */
export interface ProviderSelection extends PartialBinding {
  providerType: ProviderType;
  modelRef: ModelSlug;
}
