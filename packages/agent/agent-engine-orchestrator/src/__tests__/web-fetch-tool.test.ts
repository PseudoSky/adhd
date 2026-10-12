/**
 * R6B-web — the engine-native `web_fetch` tool (tools/web-fetch.ts) and its advertisement.
 *
 * R6B-web AC1: C's web_fetch is Anthropic's SERVER tool (`{type:'web_fetch_20250910',name:'web_fetch'}`,
 *   no description/schema on the wire); a provider that cannot take server tools must get a
 *   client-side tool instead.
 * R6B-web AC2: the registry advertises ONE shared definition to claudecli / OpenAI-compatible
 *   providers, never to a provider that already gets the server tools, and never when
 *   `nativeWebTools:false`.
 * R6B-web AC4: byte-identity against the shared constant; negative controls are the "absent" cases.
 */
import { describe, expect, it } from 'vitest';

import { McpClientRegistry } from '../clients/registry.js';
import type { InProcessToolHandler } from '../clients/in-process.js';
import type { EngineConfig } from '../interfaces.js';
import type { ExecutionContext } from '../validation/index.js';
import {
  WEB_FETCH_MAX_TEXT_CHARS,
  WEB_FETCH_SERVER,
  WEB_FETCH_TOOL,
  WEB_FETCH_TRUNCATION_MARKER,
  WebFetchClient,
  executeWebFetch,
  extractHtml,
  hostAllowed,
  webFetchAdvertised,
} from '../tools/web-fetch.js';
import { bridgeableTools } from '../providers/claudecli-tool-bridge.js';
import { ANTHROPIC_NATIVE_WEB_TOOLS } from '../providers/server-side-tools.js';

const noopHandler: InProcessToolHandler = (async () => ({})) as unknown as InProcessToolHandler;

function ctxFor(providerType: string, extra: Record<string, unknown> = {}): ExecutionContext {
  return {
    taskId: 't',
    sessionId: 's',
    agentName: 'a',
    recursionDepth: 0,
    toolCallCount: 0,
    agentDefinition: { name: 'a', provider: { type: providerType, model: 'm' }, mcpServers: {}, ...extra },
  } as unknown as ExecutionContext;
}

const registryFor = (providerType: string, extra: Record<string, unknown> = {}, engine?: Partial<EngineConfig>) =>
  new McpClientRegistry({}, undefined, [], noopHandler, ctxFor(providerType, extra), engine as EngineConfig | undefined);

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
}

describe('R6B-web AC2/AC4 — advertisement (B gets the tool, C is unchanged)', () => {
  it('R6B-web AC4: claudecli advertises web__web_fetch whose definition is byte-identical to the shared WEB_FETCH_TOOL', async () => {
    const reg = registryFor('claudecli');
    const tool = (await reg.listAllTools()).find((t) => t.name === `${WEB_FETCH_SERVER}__web_fetch`);
    expect(tool).toBeDefined();
    // NEGATIVE CONTROL: with the registration removed from McpClientRegistry this is undefined (red).
    const shared = JSON.stringify({ description: WEB_FETCH_TOOL.description, inputSchema: WEB_FETCH_TOOL.inputSchema });
    expect(JSON.stringify({ description: tool!.description, inputSchema: tool!.inputSchema })).toBe(shared);
    expect(tool).toEqual(webFetchAdvertised());
  });

  it('R6B-web AC2: the advertised tool survives bridgeableTools (it reaches the claudecli loopback bridge)', async () => {
    const tools = await registryFor('claudecli').listAllTools();
    expect(bridgeableTools(tools).map((t) => t.name)).toContain('web__web_fetch');
  });

  it('R6B-web AC2: an OpenAI-compatible provider gets the same tool (non-Anthropic providers work)', async () => {
    const tools = await registryFor('openai').listAllTools();
    expect(tools.map((t) => t.name)).toEqual(['web__web_fetch']);
  });

  it('R6B-web AC2: anthropic (arm C) gets NO client-side duplicate: it keeps the server tools only', async () => {
    const tools = await registryFor('anthropic').listAllTools();
    expect(tools.map((t) => t.name)).not.toContain('web__web_fetch');
    expect(ANTHROPIC_NATIVE_WEB_TOOLS.map((t) => t.name)).toContain('web_fetch');
  });

  it('R6B-web AC2: nativeWebTools:false removes it for claudecli too (opt-out is honored)', async () => {
    const tools = await registryFor('claudecli', { nativeWebTools: false }).listAllTools();
    expect(tools.map((t) => t.name)).not.toContain('web__web_fetch');
  });

  it('R6B-web AC2: an agent that declares its own "web" MCP server keeps it (no shadowing)', async () => {
    const reg = new McpClientRegistry(
      { web: { transport: 'stdio', command: 'x' } as never },
      undefined, [], noopHandler, ctxFor('claudecli')
    );
    await expect(reg.getClient('web')).rejects.toBeDefined(); // would spawn `x`, not return the native client
  });

  it('R6B-web AC2: a context with no selection does not throw and gets no tool (engine fails closed elsewhere)', async () => {
    const reg = new McpClientRegistry({}, undefined, [], noopHandler, {} as ExecutionContext);
    expect(await reg.listAllTools()).toEqual([]);
  });

  it('R6B-web AC2: resolveToolName routes web__web_fetch to the native client', async () => {
    const reg = registryFor('claudecli');
    await reg.listAllTools();
    expect(reg.resolveToolName('web__web_fetch')).toEqual({ server: 'web', tool: 'web_fetch' });
    expect(await reg.getClient('web')).toBeInstanceOf(WebFetchClient);
  });
});

describe('R6B-web AC2 — executor shape and constraints (stub fetch, no network)', () => {
  const fixed = () => new Date('2026-10-12T00:00:00.000Z');

  it('R6B-web AC2: returns the Anthropic-shaped web_fetch_result with url, meta, title and text', async () => {
    const html =
      '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Example Domain</title>' +
      '<style>body{x:y}</style></head><body><h1>Example Domain</h1><p>This domain is for use in &amp; examples.</p></body></html>';
    const out = await executeWebFetch({ url: 'https://example.com' }, { fetchImpl: async () => htmlResponse(html), now: fixed });
    expect(out).toEqual({
      type: 'web_fetch_result',
      url: 'https://example.com/',
      retrieved_at: '2026-10-12T00:00:00.000Z',
      content: {
        type: 'document',
        source: {
          type: 'text',
          media_type: 'text/plain',
          data: '---\nmeta-viewport: width=device-width,initial-scale=1\ntitle: Example Domain\n---\n\nExample Domain\nThis domain is for use in & examples.',
        },
        title: 'Example Domain',
      },
    });
  });

  it('R6B-web AC2: output over the text cap ends with the explicit truncation marker', async () => {
    const big = `<title>t</title><p>${'x'.repeat(WEB_FETCH_MAX_TEXT_CHARS + 50)}</p>`;
    const out = (await executeWebFetch({ url: 'http://a.test/' }, { fetchImpl: async () => htmlResponse(big), now: fixed })) as {
      content: { source: { data: string } };
    };
    expect(out.content.source.data.endsWith(WEB_FETCH_TRUNCATION_MARKER)).toBe(true);
    expect(out.content.source.data.length).toBeLessThan(WEB_FETCH_MAX_TEXT_CHARS + 200);
  });

  it('R6B-web AC2: a short page carries no truncation marker (negative control for the marker)', async () => {
    const out = JSON.stringify(await executeWebFetch({ url: 'http://a.test/' }, { fetchImpl: async () => htmlResponse('<p>hi</p>') }));
    expect(out).not.toContain('content truncated');
  });

  it('R6B-web AC2: non-http(s) URLs, bad input and non-2xx / binary responses are errors', async () => {
    const f = async () => htmlResponse('x');
    await expect(executeWebFetch({ url: 'file:///etc/passwd' }, { fetchImpl: f })).rejects.toThrow(/only http and https/);
    await expect(executeWebFetch({ url: 'nope' }, { fetchImpl: f })).rejects.toThrow(/valid absolute URL/);
    await expect(executeWebFetch({}, { fetchImpl: f })).rejects.toThrow(/"url"/);
    await expect(
      executeWebFetch({ url: 'http://a.test/' }, { fetchImpl: async () => new Response('no', { status: 404, statusText: 'Not Found' }) })
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      executeWebFetch({ url: 'http://a.test/' }, { fetchImpl: async () => new Response('x', { headers: { 'content-type': 'image/png' } }) })
    ).rejects.toThrow(/unsupported content type/);
  });

  it('R6B-web AC2: egress policy denies a host outside allowedDomains and never calls fetch', async () => {
    let called = 0;
    const f = (async () => { called += 1; return htmlResponse('x'); }) as unknown as typeof fetch;
    await expect(executeWebFetch({ url: 'https://evil.test/' }, { allowedDomains: ['example.com'], fetchImpl: f })).rejects.toThrow(/egress denied/);
    expect(called).toBe(0);
    // control: the allowed host goes through
    await executeWebFetch({ url: 'https://www.example.com/' }, { allowedDomains: ['*.example.com'], fetchImpl: f });
    expect(called).toBe(1);
  });

  it('R6B-web AC2: a redirect to a denied host is refused (every hop is policed)', async () => {
    const f = (async (u: URL | string) =>
      String(u).includes('example.com')
        ? new Response(null, { status: 302, headers: { location: 'https://evil.test/' } })
        : htmlResponse('x')) as unknown as typeof fetch;
    await expect(executeWebFetch({ url: 'https://example.com/' }, { allowedDomains: ['example.com'], fetchImpl: f })).rejects.toThrow(/egress denied: evil\.test/);
  });

  it('R6B-web AC2: hostAllowed matches exact, wildcard (not the bare suffix) and ignores :port', () => {
    expect(hostAllowed('example.com', ['example.com:443'])).toBe(true);
    expect(hostAllowed('a.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('xexample.com', ['*.example.com'])).toBe(false);
  });

  it('R6B-web AC2: extractHtml drops script/style/comments and decodes entities', () => {
    const r = extractHtml('<title> A &amp; B </title><script>evil()</script><!-- c --><p>one</p><p>two &#65;</p>');
    expect(r.title).toBe('A & B');
    expect(r.text).toBe('one\ntwo A');
  });

  it('R6B-web AC2: WebFetchClient lists exactly the shared tool and rejects unknown tools', async () => {
    const c = new WebFetchClient({ fetchImpl: async () => htmlResponse('<p>x</p>') });
    expect(await c.listTools()).toEqual([
      { name: WEB_FETCH_TOOL.name, description: WEB_FETCH_TOOL.description, inputSchema: WEB_FETCH_TOOL.inputSchema },
    ]);
    await expect(c.callTool('other', {})).rejects.toThrow(/Unknown tool/);
  });
});

describe('R6B-web AC2 — host egress config reaches the registry client', () => {
  it('R6B-web AC2: EngineConfig.webFetch.allowedDomains is enforced by the advertised tool', async () => {
    const reg = registryFor('claudecli', {}, {
      webFetch: { allowedDomains: ['example.com'] },
      wire: { fetch: (async () => htmlResponse('<p>x</p>')) as unknown as typeof fetch } as never,
    });
    await reg.listAllTools();
    const client = await reg.getClient('web');
    await expect(client.callTool('web_fetch', { url: 'https://evil.test/' })).rejects.toThrow(/egress denied/);
    await expect(client.callTool('web_fetch', { url: 'https://example.com/' })).resolves.toMatchObject({ type: 'web_fetch_result' });
  });
});
