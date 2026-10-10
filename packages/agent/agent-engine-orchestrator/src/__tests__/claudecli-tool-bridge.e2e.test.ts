/**
 * claudecli-tool-bridge.e2e.test.ts — 9ed453c1 BRIDGE (BK5 S2 / F4): each declared MCP tool executes
 * EXACTLY ONCE under the claudecli provider.
 *
 * Real components end to end: the real `ClaudeCliProvider.chat()`, the real loopback bridge (a bound
 * 127.0.0.1 port), a real `McpClientRegistry` driving a real stdio MCP server
 * (fixtures/counting-mcp-server.mjs), and `executeTool` wired exactly as engine/orchestrator.ts does.
 * The only stub is the LLM boundary: fixtures/fake-claude-mcp.mjs behaves like the real CLI with
 * respect to MCP (connects an MCP client to EVERY entry of the `--mcp-config` it is given, calls the
 * tool the "model" asks for, records every stdin line it receives). Spawning + port binding => the
 * `e2e` lane (ADR-0009); nothing is env-gated. The live-model proof is the manual AC-LIVE smoke
 * recorded with the change (paid third party; not a gate).
 *
 * Negative controls (recorded when authored, 9ed453c1): (NC-1) re-adding the real server's stdio
 * entry to the claude `--mcp-config` => AC-1/AC-2/AC-4 go red (counter 2, two server pids); (NC-3)
 * restoring the loop-execute branch => AC-3 goes red (a tool_result line reaches claude's stdin).
 */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { McpClientRegistry } from '../clients/registry.js';
import { ClaudeCliProvider } from '../providers/claudecli.js';
import { startToolBridge } from '../providers/claudecli-tool-bridge.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { ExecutionContext, McpServerConfig } from '../validation/index.js';
import type { InProcessToolHandler } from '../clients/in-process.js';
import type { ProviderChatRequest, ToolDefinition } from '../providers/types.js';

const SERVER_FIXTURE = fileURLToPath(new URL('./fixtures/counting-mcp-server.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-mcp.mjs', import.meta.url));

const ctx = {} as ExecutionContext;
const noopHandler: InProcessToolHandler = (async () => ({})) as unknown as InProcessToolHandler;
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ExecuteTool = NonNullable<ProviderChatRequest['executeTool']>;

interface Harness {
  dir: string;
  counterFile: string;
  pidFile: string;
  stdinLog: string;
  selfOut: string;
  registry: McpClientRegistry;
  tools: ToolDefinition[];
  executeSpy: Mock<ExecuteTool>;
  provider: ClaudeCliProvider;
  engine: EngineConfig;
}

async function harness(opts: { serverOverrides?: Partial<Extract<McpServerConfig, { transport: 'stdio' }>>; mode?: string } = {}): Promise<Harness> {
  const dir = freshDir('adhd-bridge-');
  const counterFile = join(dir, 'counter.txt');
  const pidFile = join(dir, 'pids.txt');
  const stdinLog = join(dir, 'claude-stdin.log');
  const selfOut = join(dir, 'claude-self.json');
  chmodSync(FAKE_CLAUDE, 0o755);

  const engine = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: '' },
    plugins: { entries: [] },
    cwd: dir,
    wire: { tempDir: join(dir, 'tmp') } as EngineConfig['wire'],
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({
      ADHD_FAKE_CLAUDE_OUT: selfOut,
      ADHD_FAKE_CLAUDE_STDIN_LOG: stdinLog,
      ...(opts.mode ? { ADHD_FAKE_CLAUDE_MODE: opts.mode } : {}),
    }),
    resolveEnvName: (() => undefined) as unknown as EngineConfig['resolveEnvName'],
    isEnvNameAllowed: () => true,
  } as unknown as EngineConfig;

  const servers: Record<string, McpServerConfig> = {
    counter: {
      transport: 'stdio',
      command: process.execPath,
      args: [SERVER_FIXTURE],
      env: { COUNTING_COUNTER_FILE: counterFile, COUNTING_PID_FILE: pidFile },
      ...opts.serverOverrides,
    } as McpServerConfig,
  };
  const registry = new McpClientRegistry(servers, undefined, [], noopHandler, ctx, { ...engine, wire: undefined } as EngineConfig, logger);
  const tools = await registry.listAllTools();

  // executeTool wired exactly as engine/orchestrator.ts does (assertToolAllowed + client.callTool).
  const executeSpy = vi.fn<ExecuteTool>(async (server, tool, args) => {
    registry.assertToolAllowed(server, tool);
    const client = await registry.getClient(server);
    try {
      return { result: await client.callTool(tool, args), isError: false };
    } catch (error) {
      return { result: error instanceof Error ? error.message : String(error), isError: true };
    }
  });

  const provider = new ClaudeCliProvider(
    { type: 'claudecli', claudePath: FAKE_CLAUDE, model: 'claude-haiku-4-5' },
    servers,
    undefined,
    engine,
    logger
  );
  return { dir, counterFile, pidFile, stdinLog, selfOut, registry, tools, executeSpy, provider, engine };
}

function promptFor(calls: Array<{ server: string; tool: string; args?: unknown }>): ProviderChatRequest['messages'] {
  return [{ role: 'user', content: JSON.stringify({ calls }) } as ProviderChatRequest['messages'][number]];
}

const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

interface SelfRecord {
  mcpConfig: { mcpServers: Record<string, { type: string; url?: string; command?: string; headers?: Record<string, string>; env?: unknown }> };
  mcpConfigRaw: string;
  configMode: number | null;
  argv: string[];
  envValues: string[];
  toolNames: string[];
  results: Array<{ id: string; text: string; isError: boolean }>;
}
const readSelf = (h: Harness): SelfRecord => JSON.parse(readFileSync(h.selfOut, 'utf8')) as SelfRecord;

async function portRefuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}

describe('9ed453c1 BRIDGE — claudecli tools execute exactly once', () => {
  it('9ed453c1 BRIDGE AC-1: one bump through provider.chat() => counter has exactly 1 line and the model sees seq=1', async () => {
    const h = await harness();
    try {
      const res = await h.provider.chat({
        messages: promptFor([{ server: 'counter', tool: 'bump' }]),
        tools: h.tools,
        executeTool: h.executeSpy,
      });
      // REVERT-FAILING (NC-1): real stdio entry back in --mcp-config => 2 lines.
      expect(lines(h.counterFile)).toHaveLength(1);
      expect(readSelf(h).results).toEqual([{ id: 'toolu_1', text: 'seq=1', isError: false }]);
      expect(res.message.content).toBe('seq=1');
      expect(h.executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await h.registry.closeAll();
    }
  });

  it('9ed453c1 BRIDGE AC-2: three sequential bumps => counter 3, results seq 1,2,3 in order', async () => {
    const h = await harness();
    try {
      await h.provider.chat({
        messages: promptFor([{ server: 'counter', tool: 'bump' }, { server: 'counter', tool: 'bump' }, { server: 'counter', tool: 'bump' }]),
        tools: h.tools,
        executeTool: h.executeSpy,
      });
      expect(lines(h.counterFile)).toHaveLength(3);
      expect(readSelf(h).results.map((r) => r.text)).toEqual(['seq=1', 'seq=2', 'seq=3']);
    } finally {
      await h.registry.closeAll();
    }
  });

  it('9ed453c1 BRIDGE AC-3: claude receives exactly one stdin line (the prompt) and no tool_result', async () => {
    const h = await harness();
    try {
      await h.provider.chat({ messages: promptFor([{ server: 'counter', tool: 'bump' }]), tools: h.tools, executeTool: h.executeSpy });
      const stdin = lines(h.stdinLog);
      // REVERT-FAILING (NC-3): the loop-execute branch writes a synthetic tool_result here.
      expect(stdin).toHaveLength(1);
      expect(JSON.parse(stdin[0]!).type).toBe('user');
      expect(stdin.join('\n')).not.toContain('tool_result');
    } finally {
      await h.registry.closeAll();
    }
  });

  it('9ed453c1 BRIDGE AC-4: exactly one counting-mcp-server process runs (the engine registry client\'s)', async () => {
    const h = await harness();
    try {
      await h.provider.chat({ messages: promptFor([{ server: 'counter', tool: 'bump' }]), tools: h.tools, executeTool: h.executeSpy });
      // REVERT-FAILING (NC-1): claude would spawn its own copy => 2 pids.
      expect(lines(h.pidFile)).toHaveLength(1);
    } finally {
      await h.registry.closeAll();
    }
  });

  it('9ed453c1 BRIDGE AC-5: a denied tool is refused once by the allowlist, bridge returns isError, counter stays 0', async () => {
    const h = await harness({ serverOverrides: { disallowedTools: ['bump'] } });
    try {
      // The registry hides `bump` from listAllTools, so advertise it by hand to force the call to
      // reach executeTool, where assertToolAllowed must refuse it.
      const tools: ToolDefinition[] = [
        { name: 'counter__bump', description: 'bump', inputSchema: { type: 'object', properties: {} } },
      ];
      const throwing = vi.fn<ExecuteTool>(async (server, tool) => {
        h.registry.assertToolAllowed(server, tool);
        return { result: 'unreachable', isError: false };
      });
      await h.provider.chat({ messages: promptFor([{ server: 'counter', tool: 'bump' }]), tools, executeTool: throwing });
      expect(throwing).toHaveBeenCalledTimes(1);
      expect(readSelf(h).results[0]).toMatchObject({ isError: true });
      expect(readSelf(h).results[0]!.text).toMatch(/disallowed by server config/);
      expect(lines(h.counterFile)).toHaveLength(0);
    } finally {
      await h.registry.closeAll();
    }
  });

  it('9ed453c1 BRIDGE AC-6: names reach the model as mcp__<server>__<tool>; only advertised tools exist', async () => {
    const h = await harness();
    try {
      const onlyBump = h.tools.filter((t) => t.name === 'counter__bump');
      await h.provider.chat({ messages: promptFor([{ server: 'counter', tool: 'bump' }]), tools: onlyBump, executeTool: h.executeSpy });
      expect(readSelf(h).toolNames).toEqual(['mcp__counter__bump']);
    } finally {
      await h.registry.closeAll();
    }
  });

  it('9ed453c1 BRIDGE AC-6: tools/list on a bridge route returns exactly the advertised tools with their schemas', async () => {
    const tools: ToolDefinition[] = [
      { name: 'a__one', description: 'first', inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
      { name: 'a__two', description: 'second', inputSchema: { type: 'object', properties: {} } },
      { name: 'b__other', description: 'other server', inputSchema: { type: 'object', properties: {} } },
    ];
    const bridge = await startToolBridge({ tools, executeTool: async () => ({ result: 'ok', isError: false }), logger });
    try {
      expect(bridge.serverNames).toEqual(['a', 'b']);
      const client = new Client({ name: 't', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp/a`), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }));
      const listed = (await client.listTools()).tools;
      expect(listed.map((t) => t.name)).toEqual(['one', 'two']);
      expect(listed[0]).toMatchObject({ description: 'first', inputSchema: tools[0]!.inputSchema });
      await client.close();
    } finally {
      await bridge.close();
    }
  });

  it('9ed453c1 BRIDGE AC-7: missing/wrong bearer => 401, foreign Host => 403, executeTool never called', async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => ({ result: 'ok', isError: false }));
    const bridge = await startToolBridge({
      tools: [{ name: 'a__one', description: 'd', inputSchema: { type: 'object' } }],
      executeTool,
      logger,
    });
    const port = Number(new URL(bridge.baseUrl).port);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'one', arguments: {} } });
    const post = (headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/mcp/a', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } },
          (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); }
        );
        req.on('error', reject);
        req.end(body);
      });
    try {
      expect(await post({})).toBe(401);
      expect(await post({ Authorization: 'Bearer wrong' })).toBe(401);
      expect(await post({ Authorization: `Bearer ${bridge.token}`, Host: 'evil.example:80' })).toBe(403);
      expect(executeTool).not.toHaveBeenCalled();
      expect(bridge.calls()).toBe(0);
      // Sanity: the same request with the right credentials is accepted and does execute.
      expect(await post({ Authorization: `Bearer ${bridge.token}` })).toBe(200);
      expect(executeTool).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.close();
    }
  });

  it('9ed453c1 BRIDGE AC-8: the bridge port is closed after chat() resolves, rejects, and aborts; ports/tokens are not reused', async () => {
    const ports: number[] = [];
    const tokens: string[] = [];
    const observe = (h: Harness): void => {
      const entry = Object.values(readSelf(h).mcpConfig.mcpServers)[0]!;
      ports.push(Number(new URL(entry.url!).port));
      tokens.push(entry.headers!['Authorization']!);
    };

    // resolves
    const ok = await harness();
    try {
      await ok.provider.chat({ messages: promptFor([{ server: 'counter', tool: 'bump' }]), tools: ok.tools, executeTool: ok.executeSpy });
      observe(ok);
      expect(await portRefuses(ports[0]!)).toBe(true);
    } finally { await ok.registry.closeAll(); }

    // rejects (claude returns an is_error result)
    const bad = await harness({ mode: 'fail' });
    try {
      await expect(
        bad.provider.chat({ messages: promptFor([]), tools: bad.tools, executeTool: bad.executeSpy })
      ).rejects.toThrow(/PROVIDER_ERROR/);
      observe(bad);
      expect(await portRefuses(ports[1]!)).toBe(true);
    } finally { await bad.registry.closeAll(); }

    // aborts (claude connected and is hanging)
    const hang = await harness({ mode: 'hang' });
    try {
      const ac = new AbortController();
      const pending = hang.provider.chat({ messages: promptFor([]), tools: hang.tools, executeTool: hang.executeSpy, signal: ac.signal });
      const settled = pending.then(() => 'resolved', () => 'rejected');
      // Bounded wait for the fake to have connected (it records its config once connected).
      const deadline = Date.now() + 15_000;
      while (!existsSync(hang.selfOut) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(existsSync(hang.selfOut)).toBe(true);
      ac.abort();
      expect(await settled).toBe('rejected');
      observe(hang);
      expect(await portRefuses(ports[2]!)).toBe(true);
    } finally { await hang.registry.closeAll(); }

    expect(new Set(ports).size).toBe(3);
    expect(new Set(tokens).size).toBe(3);
  }, 60_000);

  it('9ed453c1 BRIDGE AC-9: --mcp-config holds only 0600 bridge http entries; no advertised tools => inline empty config, no port', async () => {
    const h = await harness({ serverOverrides: { env: { COUNTING_COUNTER_FILE: 'SECRET-ENV-VALUE' } } });
    try {
      await h.provider.chat({ messages: promptFor([]), tools: h.tools, executeTool: h.executeSpy });
      const self = readSelf(h);
      expect(self.configMode).toBe(0o600);
      const entries = Object.entries(self.mcpConfig.mcpServers);
      expect(entries.map(([n]) => n)).toEqual(['counter']);
      expect(entries[0]![1].type).toBe('http');
      expect(entries[0]![1].command).toBeUndefined();
      expect(JSON.stringify(self.mcpConfig)).not.toContain('SECRET-ENV-VALUE');
      expect(entries[0]![1].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/counter$/);
    } finally {
      await h.registry.closeAll();
    }

    const none = await harness();
    try {
      await none.provider.chat({ messages: promptFor([]) });
      const self = readSelf(none);
      expect(self.mcpConfigRaw).toBe('{"mcpServers":{}}');
      expect(self.configMode).toBeNull();
    } finally {
      await none.registry.closeAll();
    }
  });

  it('9ed453c1 BRIDGE AC-10: MCP tools advertised without executeTool => PROVIDER_ERROR and claude is never spawned', async () => {
    const h = await harness();
    try {
      await expect(
        h.provider.chat({ messages: promptFor([{ server: 'counter', tool: 'bump' }]), tools: h.tools })
      ).rejects.toThrow(/PROVIDER_ERROR.*executeTool/);
      expect(existsSync(h.selfOut)).toBe(false);
      expect(lines(h.counterFile)).toHaveLength(0);
    } finally {
      await h.registry.closeAll();
    }
  });

  it('9ed453c1 BLIND F6a: a hung tool call is bounded per call — the model gets a clear isError result and the chat completes', async () => {
    const h = await harness();
    try {
      const hung = vi.fn<ExecuteTool>(() => new Promise(() => { /* never settles */ }));
      const provider = new ClaudeCliProvider(
        { type: 'claudecli', claudePath: FAKE_CLAUDE, model: 'claude-haiku-4-5', timeoutMs: 400 },
        {},
        undefined,
        h.engine,
        logger
      );
      const started = Date.now();
      await provider.chat({ messages: promptFor([{ server: 'counter', tool: 'bump' }]), tools: h.tools, executeTool: hung });
      expect(hung).toHaveBeenCalledTimes(1);
      const [result] = readSelf(h).results;
      expect(result).toMatchObject({ isError: true });
      expect(result!.text).toMatch(/Tool 'bump' on server 'counter' timed out after 400ms/);
      // Bounded by the per-call limit, not by the 60s MCP-client default or the outer signal.
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await h.registry.closeAll();
    }
  }, 60_000);

  it('9ed453c1 BLIND F6a: startToolBridge honours callTimeoutMs and a call that finishes in time is untouched', async () => {
    const tools: ToolDefinition[] = [
      { name: 'a__slow', description: 'slow', inputSchema: { type: 'object', properties: {} } },
      { name: 'a__fast', description: 'fast', inputSchema: { type: 'object', properties: {} } },
    ];
    const bridge = await startToolBridge({
      tools,
      callTimeoutMs: 150,
      logger,
      executeTool: async (_s, tool) =>
        tool === 'slow' ? new Promise(() => { /* never settles */ }) : { result: 'fast-ok', isError: false },
    });
    try {
      const client = new Client({ name: 't', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp/a`), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }));
      const slow = await client.callTool({ name: 'slow', arguments: {} });
      expect(slow.isError).toBe(true);
      expect(JSON.stringify(slow.content)).toContain('timed out after 150ms');
      const fast = await client.callTool({ name: 'fast', arguments: {} });
      expect(fast.isError).not.toBe(true);
      expect(JSON.stringify(fast.content)).toContain('fast-ok');
      await client.close();
    } finally {
      await bridge.close();
    }
  }, 30_000);

  it('9ed453c1 BLIND F6c: the bearer token is never in the spawned claude argv or env (ps-visible); --mcp-config is a 0600 file path', async () => {
    const h = await harness();
    try {
      await h.provider.chat({ messages: promptFor([{ server: 'counter', tool: 'bump' }]), tools: h.tools, executeTool: h.executeSpy });
      const self = readSelf(h);
      const auth = self.mcpConfig.mcpServers['counter']!.headers?.['Authorization'] ?? '';
      const token = auth.replace(/^Bearer /, '');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      // The token is in the config FILE (the only carrier) ...
      expect(self.configMode).toBe(0o600);
      // ... and --mcp-config's argv value is that file's path, never inline JSON.
      const at = self.argv.indexOf('--mcp-config');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(self.argv[at + 1]!.trimStart().startsWith('{')).toBe(false);
      // REVERT-FAILING: passing the config inline (or exporting the token) puts it in argv/env.
      expect(self.argv.join('\u0000')).not.toContain(token);
      for (const v of self.envValues) expect(v).not.toContain(token);
    } finally {
      await h.registry.closeAll();
    }
  }, 60_000);
});
