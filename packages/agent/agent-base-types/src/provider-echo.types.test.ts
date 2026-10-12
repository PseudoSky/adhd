/**
 * R9-hist S0: `IProviderEcho` is a side record, never a field of `Message`.
 *
 * Type-level contract (enforced by the `typecheck-spec` gate) plus a runtime shape check
 * that the barrel exports the type and that a captured echo survives a JSON round-trip.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { IProviderEcho, Message } from './index.js';

describe('R9-hist AC9 - IProviderEcho is not part of Message', () => {
  it('Message carries no echo/thinking/server-block field', () => {
    expectTypeOf<Message>().not.toHaveProperty('echo');
    expectTypeOf<Message>().not.toHaveProperty('blocks');
    expectTypeOf<Message>().not.toHaveProperty('thinking');
    expectTypeOf<keyof Message>().toEqualTypeOf<
      'id' | 'sessionId' | 'role' | 'content' | 'toolCalls' | 'toolResults' | 'createdAt'
    >();
  });
});

describe('R9-hist AC1 - IProviderEcho shape', () => {
  it('is exported from the barrel with provider fixed to anthropic and ordered verbatim blocks', () => {
    expectTypeOf<IProviderEcho['provider']>().toEqualTypeOf<'anthropic'>();
    expectTypeOf<IProviderEcho['model']>().toEqualTypeOf<string>();
    expectTypeOf<IProviderEcho['blocks']>().toEqualTypeOf<ReadonlyArray<Record<string, unknown>>>();

    // @ts-expect-error only the anthropic provider replays an echo
    const wrongProvider: IProviderEcho = { provider: 'openai', model: 'm', blocks: [] };
    expect(wrongProvider.provider).toBe('openai');
  });

  it('a real thinking + server_tool_use + result turn is JSON-round-trip stable (what persistence stores)', () => {
    const echo: IProviderEcho = {
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      blocks: [
        { type: 'thinking', thinking: '', signature: 'sig-abc' },
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url: 'https://example.com' } },
        { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_fetch_result', url: 'https://example.com' } },
        { type: 'text', text: 'done' },
      ],
    };
    expect(JSON.parse(JSON.stringify(echo))).toEqual(echo);
  });
});
