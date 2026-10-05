/**
 * Provider SDK client timeout must agree with the orchestrator's per-call
 * budget (36a73117 fix-direction 1 / post-merge bucket-B review).
 *
 * The orchestrator caps each `provider.chat()` with an AbortSignal built from
 * `provider.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS` (300_000). The OpenAI
 * SDK additionally carries its OWN client timeout; when that was hardcoded to
 * 60_000 the raised default was inert for openai/DeepSeek agents — the SDK
 * aborted at 60s before the 300s signal could matter. These tests assert both
 * adapters apply the raised default when `timeoutMs` is unset, and that an
 * explicit `timeoutMs` still wins.
 */
import { describe, expect, it, vi } from 'vitest';

import type { EngineConfig } from '../interfaces.js';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../interfaces.js';

const captured = vi.hoisted(() => ({
  openai: undefined as { timeout?: number } | undefined,
  anthropic: undefined as { timeout?: number } | undefined,
}));

vi.mock('openai', () => {
  class FakeOpenAI {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(opts: any) {
      captured.openai = opts;
    }
    chat = { completions: { create: async () => ({ choices: [] }) } };
  }
  return { default: FakeOpenAI };
});

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(opts: any) {
      captured.anthropic = opts;
    }
    messages = { stream: () => ({ finalMessage: async () => ({ content: [] }) }) };
  }
  return { default: FakeAnthropic };
});

function makeConfig(): EngineConfig {
  return {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: 'http://localhost:0' },
    plugins: { entries: [] },
    getProviderConfig: (opts) => ({
      secret: opts.provider === 'anthropic' ? 'sk-ant-api-test' : 'sk-test',
      model: opts.inlineModel ?? 'test-model',
    }),
    subprocessEnv: () => ({}),
    resolveEnvName: () => undefined,
    isEnvNameAllowed: (name) => name.startsWith('ADHD_AGENT_'),
  };
}

describe('DEFAULT_PROVIDER_TIMEOUT_MS propagation to provider SDK clients (36a73117)', () => {
  it('exposes the raised 300000ms default', () => {
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(300_000);
  });

  it('OpenAIProvider passes 300000 to the SDK client when provider.timeoutMs is unset', async () => {
    const { OpenAIProvider } = await import('../providers/openai.js');
    captured.openai = undefined;
    new OpenAIProvider({ type: 'openai', model: 'deepseek-v4-flash' }, makeConfig());
    expect(captured.openai?.timeout).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
  });

  it('NEGATIVE CONTROL: an explicit provider.timeoutMs still wins over the default', async () => {
    const { OpenAIProvider } = await import('../providers/openai.js');
    captured.openai = undefined;
    new OpenAIProvider(
      { type: 'openai', model: 'deepseek-v4-flash', timeoutMs: 12_345 },
      makeConfig()
    );
    expect(captured.openai?.timeout).toBe(12_345);
  });

  it('audit: AnthropicProvider also passes 300000 when provider.timeoutMs is unset', async () => {
    const { AnthropicProvider } = await import('../providers/anthropic.js');
    captured.anthropic = undefined;
    new AnthropicProvider({ type: 'anthropic', model: 'claude-sonnet-4-6' }, makeConfig());
    expect(captured.anthropic?.timeout).toBe(DEFAULT_PROVIDER_TIMEOUT_MS);
  });
});
