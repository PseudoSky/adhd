import type { ProviderEnvBlock, RetryConfig } from './domain.js';
import type { TripwireConfig } from './provider-failure.js';

/**
 * Canonical model identifier, e.g. `claude_sonnet_4_6`. Never a wire string:
 * the per-platform string (`claude-sonnet-4-6`, `sonnet`, ...) is resolved from
 * the provider registry's binding table via `ProviderRegistry.resolveModelRef`.
 */
export type ModelSlug = string;

/** The closed set of provider families an agent/session/task can bind to. */
export type ProviderType = 'anthropic' | 'openai' | 'claudecli';

/**
 * `RetryConfig` plus the retry window (provider-failure SPEC §2): bounds only
 * *starting a new attempt* and backoff sleeps, never an in-flight healthy attempt.
 */
export interface BindingRetryConfig extends RetryConfig {
  /** Default 120 000 ms. */
  retryWindowMs?: number;
}

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
  retryConfig?: BindingRetryConfig;
  env?: ProviderEnvBlock;
  baseURL?: string;
  /**
   * Operator-set id shared by every key under one spend limit (e.g. an OpenAI
   * org/project id). Becomes `credentialScope`; absent => the key itself.
   */
  billingScope?: string;
  /** Tripwire tuning (cooldown base/cap, probe lease); typed config, never env. */
  tripwire?: TripwireConfig;
}

/**
 * A fully resolved binding: `providerType` and `modelRef` are non-null. The
 * output of the selection chain `task ?? session ?? agent ?? global`.
 */
export interface ProviderSelection extends PartialBinding {
  providerType: ProviderType;
  modelRef: ModelSlug;
}
