/**
 * bc799330 AC6 - the SSRF correction, verified per adapter through the REAL registry -> WebFetchClient chain.
 *
 * | adapter                       | how web_fetch is exposed                                                    | driven here by                      |
 * | claudecli                     | registry advertises `web__web_fetch`; `bridgeableTools` hands it to the     | registry.executeTool-equivalent     |
 * |                               | loopback MCP bridge (the bridge e2e/taskpath e2e drive the subprocess)      | (assertToolAllowed+getClient+call)  |
 * | openai-compatible (DeepSeek)  | registry advertises `web__web_fetch`; openai.ts `toOpenAITools` sends it,   | real OpenAIProvider.chat over a     |
 * |                               | `resolveToolCallName` maps the model's call back to {web, web_fetch}        | faked wire.fetch, then the registry |
 * | anthropic                     | NOT offered: the provider gets the server tool `web_fetch_20250910`          | registry.listAllTools (absent)      |
 *
 * Only libraries that touch the network are mocked (`node:dns/promises`, `node:http`, `node:https`), so the
 * registry, the client, the resolver call and the pinned request code all run for real.
 */
import { describe, expect, it, vi } from 'vitest';

import { McpClientRegistry } from '../clients/registry.js';
import type { InProcessToolHandler } from '../clients/in-process.js';
import type { EngineConfig } from '../interfaces.js';
import { OpenAIProvider } from '../providers/openai.js';
import { bridgeableTools } from '../providers/claudecli-tool-bridge.js';
import { ANTHROPIC_NATIVE_WEB_TOOLS } from '../providers/server-side-tools.js';
import type { ProviderChatResponse } from '../providers/types.js';
import type { ExecutionContext } from '../validation/index.js';
import { PUBLIC_IP, stubNet, type IStubNet } from './fixtures/web-fetch-net.js';

const hold = vi.hoisted(() => ({ net: undefined as IStubNet | undefined }));

vi.mock('node:dns/promises', () => ({ lookup: async (host: string) => hold.net!.resolve(host) }));
vi.mock('node:http', async (orig) => ({ ...(await orig<typeof import('node:http')>()), request: (o: never) => hold.net!.request(o) }));
vi.mock('node:https', async (orig) => ({ ...(await orig<typeof import('node:https')>()), request: (o: never) => hold.net!.request(o) }));

const noopHandler: InProcessToolHandler = (async () => ({})) as unknown as InProcessToolHandler;

function ctxFor(providerType: string): ExecutionContext {
  return {
    taskId: 't', sessionId: 's', agentName: 'a', recursionDepth: 0, toolCallCount: 0,
    agentDefinition: { name: 'a', provider: { type: providerType, model: 'm' }, mcpServers: {} },
  } as unknown as ExecutionContext;
}
const registryFor = (providerType: string, engine?: Partial<EngineConfig>) =>
  new McpClientRegistry({}, undefined, [], noopHandler, ctxFor(providerType), engine as EngineConfig | undefined);

/** What orchestrator.ts / the claudecli bridge do for one call: gate, resolve the client, call, fold a throw into isError. */
async function executeTool(reg: McpClientRegistry, server: string, tool: string, args: unknown): Promise<{ result: unknown; isError: boolean }> {
  reg.assertToolAllowed(server, tool);
  const client = await reg.getClient(server);
  try {
    return { result: await client.callTool(tool, args), isError: false };
  } catch (e) {
    return { result: e instanceof Error ? e.message : String(e), isError: true };
  }
}

const html = () => new Response('<title>Public Page</title><p>public body</p>', { status: 200, headers: { 'content-type': 'text/html' } });

/** Model-chosen destinations that must never be reachable, with the class the refusal must name. */
const INTERNAL: Array<[url: string, dns: Record<string, string[]>, cls: RegExp]> = [
  ['http://169.254.169.254/latest/meta-data/iam/security-credentials/', {}, /link-local/],
  ['http://127.0.0.1:8080/admin', {}, /loopback/],
  ['http://[::1]:3000/', {}, /loopback/],
  ['http://10.0.0.5/', {}, /private \(RFC1918\)/],
  ['http://localhost:3845/mcp', { localhost: ['127.0.0.1'] }, /localhost resolves to 127\.0\.0\.1, which is a loopback address/],
  ['http://metadata.internal.example/', { 'metadata.internal.example': ['169.254.169.254'] }, /link-local/],
];

describe('bc799330 AC6: claudecli', () => {
  it('bc799330 AC6: the tool is offered to the bridge, and every internal destination is refused through the registry call path', async () => {
    for (const [url, dns, cls] of INTERNAL) {
      hold.net = stubNet(async () => html(), dns);
      const reg = registryFor('claudecli');
      const tools = await reg.listAllTools();
      expect(bridgeableTools(tools).map((t) => t.name), 'offered to the claudecli bridge').toContain('web__web_fetch');
      const out = await executeTool(reg, 'web', 'web_fetch', { url });
      expect(out.isError, url).toBe(true);
      expect(String(out.result), url).toMatch(cls);
      expect(hold.net.requests, `${url}: no connection`).toHaveLength(0);
    }
  });

  it('bc799330 AC6: a public page is fetched through the same path, connected to the validated IP', async () => {
    hold.net = stubNet(async () => html(), { 'news.example.com': ['203.0.113.9'] });
    const out = await executeTool(registryFor('claudecli'), 'web', 'web_fetch', { url: 'https://news.example.com/a' });
    expect(out.isError).toBe(false);
    expect(JSON.stringify(out.result)).toContain('public body');
    expect(hold.net.requests.map((r) => r.host)).toEqual(['203.0.113.9']);
    expect(hold.net.resolved).toEqual(['news.example.com']);
  });

  it('bc799330 AC6: restricted mode (EngineConfig.webFetch.allowedDomains) refuses an allow-listed name that resolves private', async () => {
    hold.net = stubNet(async () => html(), { 'wiki.corp.example': ['192.168.4.4'] });
    const reg = registryFor('claudecli', { webFetch: { allowedDomains: ['*.corp.example'] } });
    const out = await executeTool(reg, 'web', 'web_fetch', { url: 'https://wiki.corp.example/' });
    expect(out.isError).toBe(true);
    expect(String(out.result)).toMatch(/wiki\.corp\.example resolves to 192\.168\.4\.4, which is a private \(RFC1918\) address/);
    expect(hold.net.requests).toHaveLength(0);
  });

  it('bc799330 AC6: the registry-forwarded wire fetch can no longer be used as the transport (it would resolve a second time)', async () => {
    hold.net = stubNet(async () => html());
    let wireCalls = 0;
    const reg = registryFor('claudecli', { wire: { fetch: (async () => { wireCalls += 1; return html(); }) as unknown as typeof fetch } as never });
    const out = await executeTool(reg, 'web', 'web_fetch', { url: 'https://example.com/' });
    expect(out.isError).toBe(false);
    expect(wireCalls).toBe(0);
    expect(hold.net.requests).toHaveLength(1);
  });
});

describe('bc799330 AC6: OpenAI-compatible (openai.ts / DeepSeek)', () => {
  /** A real OpenAIProvider.chat over a faked wire.fetch whose completion is the model calling web__web_fetch. */
  async function modelCallsWebFetch(url: string, tools: Awaited<ReturnType<McpClientRegistry['listAllTools']>>) {
    let sentTools: Array<{ function: { name: string } }> = [];
    const fetchSeam = (async (_u: unknown, init?: RequestInit) => {
      sentTools = (JSON.parse(String(init?.body)) as { tools: typeof sentTools }).tools;
      return new Response(
        JSON.stringify({
          id: 'x', object: 'chat.completion', created: 0, model: 'deepseek-flash',
          choices: [{
            index: 0, finish_reason: 'tool_calls',
            message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web__web_fetch', arguments: JSON.stringify({ url }) } }] },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    const config = {
      server: { contextLimit: 0, defaultMaxTokens: 8192 },
      wire: { fetch: fetchSeam },
      getProviderConfig: () => ({ secret: 'sk-test', model: 'deepseek-flash', baseURL: 'http://deepseek.invalid/v1' }),
    } as unknown as EngineConfig;
    const res: ProviderChatResponse = await new OpenAIProvider({ type: 'openai', model: 'deepseek-flash' } as never, config).chat({
      messages: [{ id: 'm1', role: 'user', content: 'fetch it' }] as never,
      tools,
    });
    return { res, sentTools };
  }

  it('bc799330 AC6: the model call web__web_fetch(internal url) goes openai.ts -> registry and is refused for every internal destination', async () => {
    for (const [url, dns, cls] of INTERNAL) {
      hold.net = stubNet(async () => html(), dns);
      const reg = registryFor('openai');
      const tools = await reg.listAllTools();
      const { res, sentTools } = await modelCallsWebFetch(url, tools);
      expect(sentTools.map((t) => t.function.name), 'offered on the wire').toContain('web__web_fetch');
      const call = res.message.toolCalls![0]!;
      expect([call.server, call.tool]).toEqual(['web', 'web_fetch']);
      const out = await executeTool(reg, call.server, call.tool, call.arguments);
      expect(out.isError, url).toBe(true);
      expect(String(out.result), url).toMatch(cls);
      expect(hold.net.requests, `${url}: no connection`).toHaveLength(0);
    }
  });

  it('bc799330 AC6: the same model call for a public URL is fetched, connected to the validated IP', async () => {
    hold.net = stubNet(async () => html(), { 'docs.example.org': [PUBLIC_IP] });
    const reg = registryFor('openai');
    const { res } = await modelCallsWebFetch('https://docs.example.org/guide', await reg.listAllTools());
    const call = res.message.toolCalls![0]!;
    const out = await executeTool(reg, call.server, call.tool, call.arguments);
    expect(out.isError).toBe(false);
    expect(JSON.stringify(out.result)).toContain('public body');
    expect(hold.net.requests.map((r) => r.host)).toEqual([PUBLIC_IP]);
  });
});

describe('bc799330 AC6: anthropic does not use this tool', () => {
  it('bc799330 AC6: the anthropic provider keeps the server tool (executed by Anthropic) and is never offered web__web_fetch', async () => {
    hold.net = stubNet(async () => html());
    const reg = registryFor('anthropic');
    expect((await reg.listAllTools()).map((t) => t.name)).not.toContain('web__web_fetch');
    expect(ANTHROPIC_NATIVE_WEB_TOOLS).toContainEqual({ type: 'web_fetch_20250910', name: 'web_fetch' });
    expect(hold.net.requests).toHaveLength(0);
  });
});
