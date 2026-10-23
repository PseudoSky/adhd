/**
 * Request- and response-side trace signals of one model call (R10 S5b), computed from what the adapter
 * actually sent and received. Every function returns `undefined` for a provider that cannot supply the
 * signal: the trace never records a guessed 0 for a figure that does not exist.
 *
 * Content rule: only counts and byte sizes leave this module, never a tool argument, a tool result, or
 * thinking text.
 */
import type { IAnthropicThinking, IProviderEcho, ProviderType } from '@adhd/agent-base-types';
import type { Message } from '../validation/index.js';
import { toOpenAIToolContent } from '../providers/openai.js';
import { toToolResultContent } from '../providers/anthropic-tool-result.js';

/**
 * The `thinking` configuration the Anthropic request was sent with: the configured `type`, or `'none'` when
 * the request carried no `thinking` field (the API default). `undefined` for a provider with no such option.
 */
export function thinkingConfigOf(
  providerType: ProviderType,
  thinking: IAnthropicThinking | undefined
): 'none' | 'adaptive' | 'disabled' | undefined {
  if (providerType !== 'anthropic') return undefined;
  return thinking?.type ?? 'none';
}

/**
 * Thinking content blocks (`thinking` and `redacted_thinking`) in one Anthropic response, counted from the
 * provider-native echo (which keeps every block of a turn that holds any). A response with no echo has none, so
 * 0 is true for Anthropic. `undefined` for a provider that cannot produce thinking blocks (an OpenAI-compatible
 * response is never reported as 0 blocks).
 */
export function thinkingBlocksOf(providerType: ProviderType, echo: IProviderEcho | undefined): number | undefined {
  if (providerType !== 'anthropic') return undefined;
  return (echo?.blocks ?? []).filter((b) => {
    const type = (b as { type?: unknown }).type;
    return type === 'thinking' || type === 'redacted_thinking';
  }).length;
}

/**
 * Bytes of tool-result content the adapter puts on the wire for `messages` (UTF-8 bytes of the model-visible
 * text; an Anthropic image block counts its base64 payload). The same conversion the adapter itself applies, so
 * the figure is what the model was sent, not the stored JSON. `undefined` for claudecli, whose CLI owns its
 * history and whose tool results never travel in the request messages.
 */
export function toolResultBytesInOf(providerType: ProviderType, messages: readonly Message[]): number | undefined {
  if (providerType !== 'anthropic' && providerType !== 'openai') return undefined;
  let bytes = 0;
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const r of message.toolResults ?? []) {
      bytes += providerType === 'openai' ? openaiBytes(r.result) : anthropicBytes(r.result);
    }
  }
  return bytes;
}

function openaiBytes(result: unknown): number {
  return Buffer.byteLength(toOpenAIToolContent(result));
}

function anthropicBytes(result: unknown): number {
  const content = toToolResultContent(result);
  if (content === undefined) return 0;
  if (typeof content === 'string') return Buffer.byteLength(content);
  return content.reduce((n, b) => n + (b.type === 'text' ? Buffer.byteLength(b.text) : Buffer.byteLength(b.source.data)), 0);
}
