import type { ExecutionContext, IHookRegistry, ProviderSelection } from "@adhd/agent-base-types";
import type { ProviderRegistry } from "@adhd/agent-core-provider";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { McpServerConfig } from "../validation/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claudecli.js";
import { withProviderHooks } from "./hooked-provider.js";
import { OpenAIProvider } from "./openai.js";
import {
    resolveWireModel,
    selectionToProviderConfig,
    type ClaudecliExtras,
} from "./resolve-selection.js";
import type { LLMProvider } from "./types.js";

/**
 * Construct the LLM provider for a resolved {@link ProviderSelection}.
 *
 * `selection.modelRef` is resolved to the provider-native wire string through
 * `registry` here, at construction (a canonical slug becomes e.g.
 * `claude-sonnet-4-6`; a legacy wire string passes through). There is no
 * default branch that invents a provider: an unknown `providerType` throws.
 *
 * When `options.hooks` AND `options.executionContext` are both supplied the provider is wrapped so a
 * failed call emits `provider:failed` (c536ce29 TRC-AC25); otherwise the bare provider is returned
 * and behaviour is unchanged.
 */
export function createProvider(
    selection: ProviderSelection,
    mcpServers?: Record<string, McpServerConfig>,
    engineConfig?: EngineConfig,
    engineLogger?: EngineLogger,
    options?: {
        registry?: ProviderRegistry;
        claudecli?: ClaudecliExtras;
        hooks?: IHookRegistry;
        executionContext?: ExecutionContext;
    }
): LLMProvider {
    const wireModel = resolveWireModel(selection, options?.registry);
    const providerConfig = selectionToProviderConfig(selection, wireModel, options?.claudecli);
    const provider = bareProvider();
    const { hooks, executionContext } = options ?? {};
    return hooks !== undefined && executionContext !== undefined
        ? withProviderHooks(provider, {
              hooks,
              executionContext,
              providerType: providerConfig.type,
              modelRef: selection.modelRef,
              wireModel: wireModel ?? selection.modelRef,
          })
        : provider;

    function bareProvider(): LLMProvider {
        switch (providerConfig.type) {
            case "anthropic":
                return new AnthropicProvider(providerConfig, engineConfig ?? {} as EngineConfig, engineLogger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger);
            case "claudecli":
                return new ClaudeCliProvider(providerConfig, mcpServers ?? {}, undefined, engineConfig, engineLogger);
            case "openai":
                return new OpenAIProvider(providerConfig, engineConfig ?? {} as EngineConfig);
            default: {
                const exhaustive: never = providerConfig;
                throw new Error(`Unknown provider type: ${(exhaustive as { type: string }).type}`);
            }
        }
    }
}
