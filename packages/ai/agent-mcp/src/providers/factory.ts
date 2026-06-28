import type { McpServerConfig, ProviderConfig } from "../validation/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claudecli.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

/**
 * Creates an LLM provider from a ProviderConfig discriminated union.
 *
 * @param mcpServers - The agent's MCP server configs. Only used by ClaudeCliProvider
 *   to build the --mcp-config inline JSON passed to the claude subprocess.
 */
export function createProvider(
    providerConfig: ProviderConfig,
    mcpServers?: Record<string, McpServerConfig>
): LLMProvider {
    switch (providerConfig.type) {
        case "anthropic":
            return new AnthropicProvider(providerConfig);
        case "claudecli":
            return new ClaudeCliProvider(providerConfig, mcpServers ?? {});
        case "openai":
            return new OpenAIProvider(providerConfig);
        default: {
            const exhaustive: never = providerConfig;
            throw new Error(`Unknown provider type: ${(exhaustive as { type: string }).type}`);
        }
    }
}
