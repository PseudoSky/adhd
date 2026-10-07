import type {
  PartialBinding,
  ProviderConfig,
  ProviderSelection,
  ProviderType,
} from '@adhd/agent-base-types';
import type { ProviderRegistry } from '@adhd/agent-core-provider';
import { ToolError } from '../validation/errors.js';

/**
 * Sentinel `modelRef` meaning "use the provider's own default model" (a
 * `claudecli` agent that names no model, or an agent whose model is supplied by
 * an `env.model` pointer). It keeps `ProviderSelection.modelRef` non-null while
 * letting a legacy provider block that never named a model keep working.
 */
export const PROVIDER_DEFAULT_MODEL = '';

/** The four tiers of the selection chain, highest precedence first. */
export interface SelectionTiers {
  /** Per-task override. */
  task?: PartialBinding | null;
  /** The session-held live binding (set by `session_update`). */
  session?: PartialBinding | null;
  /** The agent definition's own (optional) binding. */
  agent?: PartialBinding | null;
  /** The host-wide default (EngineConfig.defaultSelection). */
  global?: PartialBinding | null;
}

/**
 * Resolve the chain `task ?? session ?? agent ?? global` into ONE
 * {@link ProviderSelection}, or `null` when no tier supplies a provider type
 * and a model (the caller fails closed with `NO_PROVIDER_SELECTED`).
 *
 * Resolution is per field, first tier wins: a session that only sets `modelRef`
 * overrides the agent's model while the agent's `providerType` still applies.
 * A tier that names a DIFFERENT `providerType` than the winner is skipped
 * entirely for every other field — one provider's model/baseURL/env is never
 * sent to another provider.
 *
 * There is no implicit default: nothing here ever invents `claudecli`.
 */
export function resolveSelection(tiers: SelectionTiers): ProviderSelection | null {
  const ordered = [tiers.task, tiers.session, tiers.agent, tiers.global].filter(
    (t): t is PartialBinding => t != null
  );
  const providerType = ordered.find((t) => t.providerType !== undefined)?.providerType;
  if (providerType === undefined) return null;

  const compatible = ordered.filter(
    (t) => t.providerType === undefined || t.providerType === providerType
  );
  const merged: PartialBinding = {};
  for (const tier of compatible) {
    for (const key of Object.keys(tier) as (keyof PartialBinding)[]) {
      if (tier[key] !== undefined && merged[key] === undefined) {
        (merged as Record<string, unknown>)[key] = tier[key];
      }
    }
  }
  if (merged.modelRef === undefined) return null;
  return { ...merged, providerType, modelRef: merged.modelRef };
}

/**
 * {@link resolveSelection} that throws `NO_PROVIDER_SELECTED` instead of
 * returning `null` — the fail-closed form every construction site uses.
 */
export function requireSelection(tiers: SelectionTiers): ProviderSelection {
  const selection = resolveSelection(tiers);
  if (selection === null) {
    throw new ToolError(
      'NO_PROVIDER_SELECTED',
      'No provider was selected: the task, session, agent and host-default tiers ' +
        'supplied no provider type and model. Set one with session_update ' +
        '(provider + model), give the agent a provider, or configure a host default. ' +
        'There is no implicit default provider.'
    );
  }
  return selection;
}

/** The agent-definition tier: a legacy {@link ProviderConfig} viewed as a binding. */
export function providerConfigToBinding(
  config: ProviderConfig | undefined
): PartialBinding | undefined {
  if (!config) return undefined;
  const binding: PartialBinding = {
    providerType: config.type,
    modelRef: config.model ?? PROVIDER_DEFAULT_MODEL,
  };
  if (config.timeoutMs !== undefined) binding.timeoutMs = config.timeoutMs;
  if (config.models !== undefined) binding.models = config.models;
  if (config.billingScope !== undefined) binding.billingScope = config.billingScope;
  if (config.tripwire !== undefined) binding.tripwire = config.tripwire;
  if (config.type !== 'claudecli') {
    if (config.env !== undefined) binding.env = config.env;
    if (config.maxTokens !== undefined) binding.maxTokens = config.maxTokens;
    if (config.temperature !== undefined) binding.temperature = config.temperature;
    if (config.retryConfig !== undefined) binding.retryConfig = config.retryConfig;
  }
  if (config.type === 'openai' && config.baseURL !== undefined) {
    binding.baseURL = config.baseURL;
  }
  return binding;
}

/** Registry platform whose binding table maps canonical refs for a provider. */
export function platformForProvider(providerType: ProviderType): string | undefined {
  switch (providerType) {
    case 'anthropic':
      return 'claude_api';
    case 'claudecli':
      return 'claude_code';
    default:
      return undefined;
  }
}

/**
 * The provider-native model string for a selection. A canonical slug with a
 * registry binding resolves to its wire string; a ref with no binding (a legacy
 * wire string migrated verbatim into `modelRef`, or any openai model — openai
 * has no binding table) passes through unchanged. A canonical slug is never
 * sent on the wire when a binding exists. `undefined` = provider default model.
 */
export function resolveWireModel(
  selection: ProviderSelection,
  registry?: ProviderRegistry
): string | undefined {
  if (selection.modelRef === PROVIDER_DEFAULT_MODEL) return undefined;
  const platform = platformForProvider(selection.providerType);
  if (!registry || platform === undefined) return selection.modelRef;
  try {
    return registry.resolveModelRef(selection.modelRef, platform);
  } catch (err) {
    if ((err as { code?: string }).code === 'MODEL_BINDING_NOT_FOUND') {
      return selection.modelRef;
    }
    throw err;
  }
}

/** claudecli-only knobs that have no slot on `PartialBinding`; carried from the agent. */
export type ClaudecliExtras = Pick<
  Extract<ProviderConfig, { type: 'claudecli' }>,
  'claudePath' | 'allowedBuiltinTools' | 'systemPromptIsAgentSpec'
>;

/** Extract {@link ClaudecliExtras} from an agent's own provider block. */
export function claudecliExtras(config: ProviderConfig | undefined): ClaudecliExtras {
  if (config?.type !== 'claudecli') return {};
  const { claudePath, allowedBuiltinTools, systemPromptIsAgentSpec } = config;
  return {
    ...(claudePath !== undefined && { claudePath }),
    ...(allowedBuiltinTools !== undefined && { allowedBuiltinTools }),
    ...(systemPromptIsAgentSpec !== undefined && { systemPromptIsAgentSpec }),
  };
}

/** Build the wire {@link ProviderConfig} a provider class consumes from a selection. */
export function selectionToProviderConfig(
  selection: ProviderSelection,
  wireModel: string | undefined,
  extras: ClaudecliExtras = {}
): ProviderConfig {
  switch (selection.providerType) {
    case 'anthropic':
      return {
        type: 'anthropic',
        ...(wireModel !== undefined && { model: wireModel }),
        ...(selection.env !== undefined && { env: selection.env }),
        ...(selection.temperature !== undefined && { temperature: selection.temperature }),
        ...(selection.maxTokens !== undefined && { maxTokens: selection.maxTokens }),
        ...(selection.timeoutMs !== undefined && { timeoutMs: selection.timeoutMs }),
        ...(selection.retryConfig !== undefined && { retryConfig: selection.retryConfig }),
      };
    case 'openai':
      return {
        type: 'openai',
        ...(wireModel !== undefined && { model: wireModel }),
        ...(selection.env !== undefined && { env: selection.env }),
        ...(selection.baseURL !== undefined && { baseURL: selection.baseURL }),
        ...(selection.temperature !== undefined && { temperature: selection.temperature }),
        ...(selection.maxTokens !== undefined && { maxTokens: selection.maxTokens }),
        ...(selection.timeoutMs !== undefined && { timeoutMs: selection.timeoutMs }),
        ...(selection.retryConfig !== undefined && { retryConfig: selection.retryConfig }),
      };
    case 'claudecli':
      return {
        type: 'claudecli',
        ...(wireModel !== undefined && { model: wireModel }),
        ...(selection.timeoutMs !== undefined && { timeoutMs: selection.timeoutMs }),
        ...extras,
      };
    default: {
      const exhaustive: never = selection.providerType;
      throw new ToolError('NO_PROVIDER_SELECTED', `Unknown provider type: ${String(exhaustive)}`);
    }
  }
}

/**
 * The selection an orchestrator dereference should read for `ctx`: the one the
 * task resolved at construction, else the agent tier alone, else fail closed.
 */
export function selectionOf(ctx: {
  selection?: ProviderSelection;
  agentDefinition: { provider?: ProviderConfig };
}): ProviderSelection {
  return (
    ctx.selection ??
    requireSelection({ agent: providerConfigToBinding(ctx.agentDefinition.provider) })
  );
}

/**
 * The provider-native model string for `ctx`: the wire string resolved at
 * construction, else (a hand-built context with no registry resolution) the
 * selection's own `modelRef`, else `undefined` for the provider default model.
 */
export function wireModelOf(ctx: {
  selection?: ProviderSelection;
  wireModel?: string;
  agentDefinition: { provider?: ProviderConfig };
}): string | undefined {
  return ctx.wireModel ?? (selectionOf(ctx).modelRef || undefined);
}
