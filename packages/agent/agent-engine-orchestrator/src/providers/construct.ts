import type { AgentDefinition, ExecutionContext, IHookRegistry, PartialBinding } from '@adhd/agent-base-types';
import type { ProviderRegistry } from '@adhd/agent-core-provider';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import { createProvider } from './factory.js';
import {
  claudecliExtras,
  providerConfigToBinding,
  requireSelection,
  resolveWireModel,
} from './resolve-selection.js';
import type { LLMProvider } from './types.js';

type Selection = NonNullable<ExecutionContext['selection']>;

/**
 * Resolve the provider selection for one task: the chain
 * `task ?? session ?? agent ?? global` resolved ONCE, fail closed with
 * `NO_PROVIDER_SELECTED` when no tier supplies a provider and model, and the
 * model ref resolved through the registry to its provider-native wire string.
 *
 * Call this BEFORE creating any task/session rows and BEFORE building the
 * {@link ExecutionContext}: a task with no provider must be refused up front,
 * never left half-created. Stamp the result on the context as `selection` and
 * `wireModel`.
 */
export function resolveTaskSelection(args: {
  agentDefinition: AgentDefinition;
  /** The session-held live binding, when the session store exposes one. */
  sessionBinding?: PartialBinding | null;
  taskBinding?: PartialBinding | null;
  config: EngineConfig;
  registry?: ProviderRegistry;
}): { selection: Selection; wireModel?: string } {
  const selection = requireSelection({
    task: args.taskBinding,
    session: args.sessionBinding,
    agent: providerConfigToBinding(args.agentDefinition.provider),
    global: args.config.defaultSelection,
  });
  const wireModel = resolveWireModel(selection, args.registry);
  return { selection, ...(wireModel !== undefined && { wireModel }) };
}

/** Build the LLM provider for an already-resolved selection. */
export function buildProviderForSelection(args: {
  agentDefinition: AgentDefinition;
  selection: Selection;
  config: EngineConfig;
  logger: EngineLogger;
  registry?: ProviderRegistry;
  /** With `executionContext`, wraps the provider so failures emit `provider:failed`. */
  hooks?: IHookRegistry;
  executionContext?: ExecutionContext;
}): LLMProvider {
  // 9ed453c1 CWD (ADR-0008 D9): the provider is spawned in the TASK-TIME
  // dispatching cwd, not the host-global EngineConfig.cwd. `executionContext.cwd`
  // is the effective cwd (caller-supplied, inherited from the parent, or the
  // persisted cwd on a restart/DAG redispatch); absent => the host config stands.
  const taskCwd = args.executionContext?.cwd;
  const config: EngineConfig =
    taskCwd !== undefined && taskCwd !== '' && taskCwd !== args.config.cwd
      ? { ...args.config, cwd: taskCwd }
      : args.config;
  return createProvider(
    args.selection,
    args.agentDefinition.mcpServers,
    config,
    args.logger,
    {
      registry: args.registry,
      claudecli: claudecliExtras(args.agentDefinition.provider),
      hooks: args.hooks,
      executionContext: args.executionContext,
    }
  );
}
