/**
 * R9-hist S0: the provider contract carries optional echo / continuation fields.
 *
 * Additive only: a provider written against the previous contract (no echo fields anywhere)
 * must still satisfy `LLMProvider`, and every new field is optional. The type assertions are
 * enforced by the `typecheck-spec` gate; the runtime assertions drive a real `LLMProvider`
 * implementation through the contract.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  IProviderEcho,
  LLMProvider,
  ProviderChatRequest,
  ProviderChatResponse,
} from '../providers/types.js';

const echo: IProviderEcho = {
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  blocks: [{ type: 'thinking', thinking: '', signature: 'sig' }],
};

const assistant = {
  id: 'm-1',
  sessionId: 's-1',
  role: 'assistant' as const,
  content: 'hi',
  createdAt: new Date(0).toISOString(),
};

describe('R9-hist AC6 - echo fields are additive and optional', () => {
  it('a legacy provider with no echo fields still satisfies LLMProvider', async () => {
    const legacy: LLMProvider = {
      chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => ({
        message: { ...assistant, content: String(req.messages.length) },
        stopReason: 'completed',
      }),
    };
    const res = await legacy.chat({ messages: [] });
    expect(res.echo).toBeUndefined();
    expect(res.echoDegraded).toBeUndefined();
    expect(res.echoReplay).toBeUndefined();
  });

  it('request: echoes is a read-only map keyed by assistant Message.id, beforeContinuation takes the 1-based n', () => {
    expectTypeOf<ProviderChatRequest['echoes']>().toEqualTypeOf<ReadonlyMap<string, IProviderEcho> | undefined>();
    expectTypeOf<ProviderChatRequest['beforeContinuation']>().toEqualTypeOf<
      ((n: number) => Promise<void>) | undefined
    >();
    // A request with neither field is still valid.
    expectTypeOf<{ messages: [] }>().toExtend<ProviderChatRequest>();
  });

  it('response: echo, echoDegraded and echoReplay have the specified shapes', () => {
    expectTypeOf<ProviderChatResponse['echo']>().toEqualTypeOf<IProviderEcho | undefined>();
    expectTypeOf<ProviderChatResponse['echoDegraded']>().toEqualTypeOf<
      { apiMessage: string; echoedMessages: number } | undefined
    >();
    expectTypeOf<ProviderChatResponse['echoReplay']>().toEqualTypeOf<
      { messages: number; bytes: number } | undefined
    >();
  });

  it('an echoing provider round-trips echo through echoes and sees beforeContinuation', async () => {
    const seen: number[] = [];
    const provider: LLMProvider = {
      chat: async (req) => {
        await req.beforeContinuation?.(1);
        const replayed = req.echoes?.get('m-1');
        return {
          message: assistant,
          stopReason: 'completed',
          echo,
          echoReplay: replayed ? { messages: 1, bytes: JSON.stringify(replayed.blocks).length } : undefined,
        };
      },
    };
    const first = await provider.chat({ messages: [] });
    const second = await provider.chat({
      messages: [],
      echoes: new Map([[first.message.id, first.echo as IProviderEcho]]),
      beforeContinuation: async (n) => void seen.push(n),
    });
    expect(first.echoReplay).toBeUndefined();
    expect(second.echoReplay).toEqual({ messages: 1, bytes: JSON.stringify(echo.blocks).length });
    expect(seen).toEqual([1]);
  });
});
