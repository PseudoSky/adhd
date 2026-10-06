import type { ProviderSelection } from "@adhd/agent-base-types";
import type { ProviderRegistry } from "@adhd/agent-core-provider";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { McpServerConfig } from "../validation/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claudecli.js";
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
 */
export function createProvider(
    selection: ProviderSelection,
    mcpServers?: Record<string, McpServerConfig>,
    engineConfig?: EngineConfig,
    engineLogger?: EngineLogger,
    options?: { registry?: ProviderRegistry; claudecli?: ClaudecliExtras }
): LLMProvider {
    const providerConfig = selectionToProviderConfig(
        selection,
        resolveWireModel(selection, options?.registry),
        options?.claudecli
    );
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
