/**
 * R6B-web AC4 (e2e) — the claudecli loopback bridge advertises and executes the client-side
 * `web_fetch`.
 *
 * Real components: the real `ClaudeCliProvider.chat()`, the real bound loopback bridge, a real
 * `McpClientRegistry`, a real local HTTP server as the fetch target, and the fake `claude`
 * fixture (a real MCP client over the bridge's `--mcp-config`; the only stub is the LLM).
 * Port binding + a spawned process => the `e2e` lane (ADR-0009); nothing is env-gated.
 *
 * Negative control (recorded when authored): removing the registry registration makes both tests
 * red (`toolListing.web` is undefined and the call has no `web` route).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClientRegistry } from '../clients/registry.js';
import type { InProcessToolHandler } from '../clients/in-process.js';
import { ClaudeCliProvider } from '../providers/claudecli.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { ProviderChatRequest } from '../providers/types.js';
import type { ExecutionContext } from '../validation/index.js';
import { WEB_FETCH_TOOL } from '../tools/web-fetch.js';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-mcp.mjs', import.meta.url));
const noopHandler: InProcessToolHandler = (async () => ({})) as unknown as InProcessToolHandler;
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PAGE =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Fixture Title R6B</title></head><body><h1>Fixture Heading</h1><p>Body text from the local fixture.</p></body></html>';

async function fixtureServer(): Promise<string> {
  const s = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/page`;
}

async function runClaudecli(url: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adhd-r6b-web-')));
  dirs.push(dir);
  chmodSync(FAKE_CLAUDE, 0o755);
  const selfOut = join(dir, 'claude-self.json');
  const engine = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 }, sse: { baseUrl: '' }, plugins: { entries: [] },
    cwd: dir,
    wire: { tempDir: join(dir, 'tmp') } as EngineConfig['wire'],
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({ ADHD_FAKE_CLAUDE_OUT: selfOut }),
    resolveEnvName: (() => undefined) as unknown as EngineConfig['resolveEnvName'],
    isEnvNameAllowed: () => true,
  } as unknown as EngineConfig;
  const ctx = {
    agentDefinition: { provider: { type: 'claudecli', model: 'claude-haiku-4-5' }, mcpServers: {} },
  } as unknown as ExecutionContext;
  const registry = new McpClientRegistry({}, undefined, [], noopHandler, ctx, { ...engine, wire: undefined } as EngineConfig, logger);
  const tools = await registry.listAllTools();
  const provider = new ClaudeCliProvider({ type: 'claudecli', claudePath: FAKE_CLAUDE, model: 'claude-haiku-4-5' }, {}, undefined, engine, logger);
  try {
    await provider.chat({
      messages: [{ role: 'user', content: JSON.stringify({ calls: [{ server: 'web', tool: 'web_fetch', args: { url } }] }) }] as ProviderChatRequest['messages'],
      tools,
      // executeTool wired as engine/orchestrator.ts does: registry client.callTool.
      executeTool: async (server, tool, args) => {
        registry.assertToolAllowed(server, tool);
        const client = await registry.getClient(server);
        try { return { result: await client.callTool(tool, args), isError: false }; }
        catch (e) { return { result: e instanceof Error ? e.message : String(e), isError: true }; }
      },
    });
  } finally {
    await registry.closeAll();
  }
  return JSON.parse(readFileSync(selfOut, 'utf8')) as {
    toolNames: string[];
    toolListing: Record<string, Array<{ name: string; description: string; inputSchema: unknown }>>;
    results: Array<{ id: string; text: string; isError: boolean }>;
  };
}

describe('R6B-web AC4 — claudecli bridge serves web_fetch', () => {
  it('R6B-web AC4: bridge tools/list returns web_fetch byte-identical to the shared definition, as mcp__web__web_fetch', async () => {
    const self = await runClaudecli(await fixtureServer());
    // NEGATIVE CONTROL: without the registry registration `toolListing.web` is undefined (red).
    expect(self.toolNames).toEqual(['mcp__web__web_fetch']);
    const listed = self.toolListing['web']![0]!;
    expect(JSON.stringify({ description: listed.description, inputSchema: listed.inputSchema })).toBe(
      JSON.stringify({ description: WEB_FETCH_TOOL.description, inputSchema: WEB_FETCH_TOOL.inputSchema })
    );
    expect(listed.name).toBe(WEB_FETCH_TOOL.name);
  });

  it('R6B-web AC4: a tools/call against a local HTTP fixture returns the title and the text', async () => {
    const url = await fixtureServer();
    const self = await runClaudecli(url);
    expect(self.results).toHaveLength(1);
    expect(self.results[0]!.isError).toBe(false);
    const body = JSON.parse(self.results[0]!.text) as {
      type: string; url: string; content: { source: { data: string }; title: string };
    };
    expect(body.type).toBe('web_fetch_result');
    expect(body.url).toBe(url);
    expect(body.content.title).toBe('Fixture Title R6B');
    expect(body.content.source.data).toContain('title: Fixture Title R6B');
    expect(body.content.source.data).toContain('meta-viewport: width=device-width,initial-scale=1');
    expect(body.content.source.data).toContain('Body text from the local fixture.');
  });

  it('R6B-web AC4: a refused call surfaces as isError through the bridge (non-http scheme)', async () => {
    const self = await runClaudecli('file:///etc/hosts');
    expect(self.results[0]!.isError).toBe(true);
    expect(self.results[0]!.text).toContain('only http and https');
  });
});
