import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { McpServerConfig, ProviderConfig } from "../validation/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claudecli.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

export function createProvider(
    providerConfig: ProviderConfig,
    mcpServers?: Record<string, McpServerConfig>,
    engineConfig?: EngineConfig,
    engineLogger?: EngineLogger
): LLMProvider {
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
