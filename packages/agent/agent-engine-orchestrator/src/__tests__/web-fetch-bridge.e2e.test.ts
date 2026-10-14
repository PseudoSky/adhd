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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClientRegistry } from '../clients/registry.js';
import type { InProcessToolHandler } from '../clients/in-process.js';
import { ClaudeCliProvider } from '../providers/claudecli.js';
import type { EngineConfig, EngineLogger, WireRequestFn } from '../interfaces.js';
import { request as httpRequest } from 'node:http';
import type { ProviderChatRequest } from '../providers/types.js';
import type { ExecutionContext } from '../validation/index.js';
import { WEB_FETCH_TOOL } from '../tools/web-fetch.js';
import { LAB_PUBLIC_IP, lab, labUrl } from './fixtures/web-fetch-lab.js';

// The fixture is on loopback, which the SSRF guard refuses by design (bc799330). It is addressed by a public-looking
// name instead: see fixtures/web-fetch-lab.ts for exactly what is (and is not) substituted.
vi.mock('node:dns/promises', async () => {
  const { LAB_PUBLIC_IP: ip } = await import('./fixtures/web-fetch-lab.js');
  return { lookup: async () => [{ address: ip, family: 4 }] };
});
vi.mock('node:http', async (orig) => {
  const actual = await orig<typeof import('node:http')>();
  const { labRequest } = await import('./fixtures/web-fetch-lab.js');
  return { ...actual, request: labRequest(actual.request) };
});

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

let hits = 0;
/** Starts the fixture; returns its loopback URL (what a model could try) and the public-looking-name URL the lab maps to it. */
async function fixtureServer(): Promise<{ loopbackUrl: string; namedUrl: string }> {
  const s = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  lab.port = port;
  lab.seen = [];
  hits = 0;
  return { loopbackUrl: `http://127.0.0.1:${port}/page`, namedUrl: labUrl(port) };
}

async function runClaudecli(url: string, wireRequest?: WireRequestFn) {
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
  const registry = new McpClientRegistry({}, undefined, [], noopHandler, ctx, { ...engine, wire: wireRequest ? ({ request: wireRequest } as unknown as EngineConfig['wire']) : undefined } as EngineConfig, logger);
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
    const self = await runClaudecli((await fixtureServer()).namedUrl);
    // NEGATIVE CONTROL: without the registry registration `toolListing.web` is undefined (red).
    expect(self.toolNames).toEqual(['mcp__web__web_fetch']);
    const listed = self.toolListing['web']![0]!;
    expect(JSON.stringify({ description: listed.description, inputSchema: listed.inputSchema })).toBe(
      JSON.stringify({ description: WEB_FETCH_TOOL.description, inputSchema: WEB_FETCH_TOOL.inputSchema })
    );
    expect(listed.name).toBe(WEB_FETCH_TOOL.name);
  });

  it('R6B-web AC4: a tools/call against a local HTTP fixture returns the title and the text', async () => {
    const { namedUrl: url } = await fixtureServer();
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
    // bc799330 AC2 (real socket): the engine asked for the VALIDATED public IP, with the original name as Host.
    expect(hits).toBe(1);
    expect(lab.seen).toHaveLength(1);
    expect(lab.seen[0]!.host).toBe(LAB_PUBLIC_IP);
    expect((lab.seen[0]!.headers as Record<string, string>)['host']).toBe(new URL(url).host);
  });

  it('49cec55e AC4: through the real bridge the registry routes the pinned request through the host wire.request seam (the wire-log hook), to the validated IP', async () => {
    const { namedUrl: url } = await fixtureServer();
    const seen: Array<{ host?: string | null; hostHeader: string; protocol: string }> = [];
    const self = await runClaudecli(url, (o) => {
      seen.push({ host: o.host, hostHeader: String((o.headers as Record<string, string>)['host']), protocol: o.protocol });
      return httpRequest(o); // the mocked node:http request: the lab maps the validated public IP onto the fixture
    });
    expect(self.results[0]!.isError).toBe(false);
    // NEGATIVE CONTROL: if the registry stops forwarding wire.request, `seen` stays empty (red).
    expect(seen).toEqual([{ host: LAB_PUBLIC_IP, hostHeader: new URL(url).host, protocol: 'http:' }]);
  });

  it('bc799330 AC1/AC6: through the real bridge a call to the fixture by its LOOPBACK address is refused as isError, naming the class, and the fixture is never hit', async () => {
    const { loopbackUrl } = await fixtureServer();
    const self = await runClaudecli(loopbackUrl);
    expect(self.results).toHaveLength(1);
    expect(self.results[0]!.isError).toBe(true);
    expect(self.results[0]!.text).toMatch(/127\.0\.0\.1 is a loopback address/);
    expect(hits).toBe(0);
    expect(lab.seen).toHaveLength(0);
  });

  it('R6B-web AC4: a refused call surfaces as isError through the bridge (non-http scheme)', async () => {
    const self = await runClaudecli('file:///etc/hosts');
    expect(self.results[0]!.isError).toBe(true);
    expect(self.results[0]!.text).toContain('only http and https');
  });
});
