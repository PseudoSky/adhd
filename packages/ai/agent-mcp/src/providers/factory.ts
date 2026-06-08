import type { McpServerConfig, ProviderConfig } from "../validation/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claudecli.js";
import { LMStudioProvider } from "./lmstudio.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

/**
 * Creates an LLM provider from a ProviderConfig discriminated union.
 *
 * @param mcpServers - The agent's MCP server configs. Only used by ClaudeCliProvider
 *   to build the --mcp-config inline JSON passed to the claude subprocess.
 */
export function createProvider(
    config: ProviderConfig,
    mcpServers?: Record<string, McpServerConfig>
): LLMProvider {
    switch (config.type) {
        case "anthropic":
            return new AnthropicProvider(config);
        case "claudecli":
            return new ClaudeCliProvider(config, mcpServers ?? {});
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
