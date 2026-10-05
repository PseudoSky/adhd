/**
 * Built-in provider-native web tools (backlog 1abd2d84).
 *
 * `@adhd/agent-core-provider`'s `emit-tools.ts` already knows how to emit a
 * type-tagged server-side tool, but its own header says wiring it into the
 * live provider path is "agent-mcp-refactor's job". This module is that
 * wiring: the default dispatched-agent toolset for a provider that supports
 * native web tools (currently Anthropic) includes `web_search` and
 * `web_fetch`, executed by the provider — no client-side executor needed.
 *
 * The type tags are the versioned Anthropic server-tool identifiers. They are
 * the exact strings the Anthropic API expects (`web_search_20250305`,
 * `web_fetch_20250910`); a provider that does not recognize them must not be
 * handed them, which is why `serverSideToolsForProvider` gates on provider
 * type.
 */
import type { ServerSideTool } from './types.js';

/** Anthropic's server-executed web search + fetch tools. */
export const ANTHROPIC_NATIVE_WEB_TOOLS: readonly ServerSideTool[] = [
  { type: 'web_search_20250305', name: 'web_search' },
  { type: 'web_fetch_20250910', name: 'web_fetch' },
];

/**
 * The server-side tools to advertise for a provider.
 *
 * @param providerType - the agent's provider type (e.g. `'anthropic'`).
 * @param enabled      - `nativeWebTools !== false` on the agent definition.
 *                       When `false`, returns `[]` (caller opt-out).
 */
export function serverSideToolsForProvider(
  providerType: string,
  enabled: boolean
): ServerSideTool[] {
  if (!enabled) return [];
  if (providerType === 'anthropic') {
    return ANTHROPIC_NATIVE_WEB_TOOLS.map((t) => ({ ...t }));
  }
  return [];
}
