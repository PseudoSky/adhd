import type { ProviderConfig } from "../validation/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { LMStudioProvider } from "./lmstudio.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

/**
 * Creates an LLM provider from a ProviderConfig discriminated union.
 */
export function createProvider(config: ProviderConfig): LLMProvider {
    switch (config.type) {
        case "anthropic":
            return new AnthropicProvider(config);
        case "openai":
            return new OpenAIProvider(config);
        case "lmstudio":
            return new LMStudioProvider(config);
        default: {
            const exhaustive: never = config;
            throw new Error(`Unknown provider type: ${(exhaustive as { type: string }).type}`);
        }
    }
}
