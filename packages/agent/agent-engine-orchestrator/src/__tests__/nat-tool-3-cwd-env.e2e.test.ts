/**
 * nat-tool-3-cwd-env.e2e.test.ts — ADR-0008 D9 (NAT-TOOL-3).
 *
 * Thread `McpServerConfig.cwd` and the injected `subprocessEnv()` through the
 * engine's MCP client layer into the spawned stdio child, and run `claude` in
 * the configured task-time cwd so a claude-spawned MCP child inherits it.
 *
 * Every acceptance criterion is proven by a REAL subprocess spawn (no mock of
 * the unit under test); each assertion FAILS if its fix is reverted, as noted
 * on the assertion. The claude boundary is a real stub executable (the LLM is
 * the only thing stubbed — the provider, its spawn, and process inheritance are
 * all real), so this suite runs by default with no paid service.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClientRegistry } from '../clients/registry.js';
import { ClaudeCliProvider } from '../providers/claudecli.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { ExecutionContext, McpServerConfig } from '../validation/index.js';
import type { InProcessToolHandler } from '../clients/in-process.js';
import type { ProviderChatRequest } from '../providers/types.js';

const SERVER_FIXTURE = fileURLToPath(
  new URL('./fixtures/cwd-env-server.mjs', import.meta.url)
);
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

const ctx = {} as ExecutionContext;
const noopHandler: InProcessToolHandler = (async () => ({})) as unknown as InProcessToolHandler;
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function engineConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: '' },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({}),
    resolveEnvName: (() => undefined) as unknown as EngineConfig['resolveEnvName'],
    isEnvNameAllowed: () => true,
    ...overrides,
  } as EngineConfig;
}

async function callToolText(
  client: { callTool: (tool: string, args: unknown) => Promise<unknown> },
  tool: string
): Promise<string> {
  const content = (await client.callTool(tool, {})) as Array<{ type: string; text?: string }>;
  return content.map((b) => b.text ?? '').join('');
}

function stdioServer(
  overrides: Partial<Extract<McpServerConfig, { transport: 'stdio' }>> = {}
): McpServerConfig {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [SERVER_FIXTURE],
    ...overrides,
  } as McpServerConfig;
}

function registryFor(
  servers: Record<string, McpServerConfig>,
  config?: EngineConfig
): McpClientRegistry {
  return new McpClientRegistry(servers, undefined, [], noopHandler, ctx, config, logger);
}

const dirs: string[] = [];
/** A real, symlink-resolved temp dir so the child's `process.cwd()` matches. */
function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('NAT-TOOL-3 — cwd/env through the engine MCP client (ADR-0008 D9)', () => {
  it('AC1: a stdio server configured cwd:<dir> runs in <dir> (real spawn)', async () => {
    const dir = freshDir('adhd-nat3-ac1-');
    const registry = registryFor({ probe: stdioServer({ cwd: dir }) }, engineConfig());
    try {
      const client = await registry.getClient('probe');
      // REVERT-FAILING: drop `cwd: this.serverConfig.cwd` from StdioMcpClient ->
      // the child inherits the vitest runner cwd, not `dir`.
      expect(await callToolText(client, 'get_cwd')).toBe(dir);
    } finally {
      await registry.closeAll();
    }
  });

  it('AC2: subprocessEnv() values reach the spawned child via the registry (real spawn)', async () => {
    const registry = registryFor(
      { probe: stdioServer() },
      engineConfig({ subprocessEnv: () => ({ ADHD_TEST_CWD_ENV: 'from-subprocessenv' }) })
    );
    try {
      const client = await registry.getClient('probe');
      // REVERT-FAILING: if the registry does not forward EngineConfig to
      // StdioMcpClient, subprocessEnv() is {} and the child reads ''.
      expect(await callToolText(client, 'get_env')).toBe('from-subprocessenv');
    } finally {
      await registry.closeAll();
    }
  });

  it('AC4: a server with no cwd still inherits the parent process cwd (real spawn)', async () => {
    const registry = registryFor({ probe: stdioServer() }, engineConfig());
    try {
      const client = await registry.getClient('probe');
      // REVERT-FAILING: introducing a DEFAULT cwd for stdio children would break
      // this pre-existing inheritance behavior.
      expect(await callToolText(client, 'get_cwd')).toBe(process.cwd());
    } finally {
      await registry.closeAll();
    }
  });

  it('AC4b: EngineConfig.cwd does NOT override a server that declares no cwd', async () => {
    // Guards the tempting-but-wrong "fall back to the engine cwd" fix: the
    // ADR scopes stdio children by their OWN cwd only, and inherits otherwise.
    const engineDir = freshDir('adhd-nat3-ac4b-');
    const registry = registryFor({ probe: stdioServer() }, engineConfig({ cwd: engineDir }));
    try {
      const client = await registry.getClient('probe');
      expect(await callToolText(client, 'get_cwd')).toBe(process.cwd());
    } finally {
      await registry.closeAll();
    }
  });

  it('AC3: a claude-spawned MCP child inherits the configured cwd (real stub spawn)', async () => {
    const dir = freshDir('adhd-nat3-ac3-');
    const selfOut = join(dir, 'claude-self.json');
    const childReport = join(dir, 'mcp-child-cwd.txt');
    chmodSync(FAKE_CLAUDE, 0o755);

    const provider = new ClaudeCliProvider(
      { type: 'claudecli', claudePath: FAKE_CLAUDE, model: 'claude-haiku-4-5' },
      { probe: stdioServer({ env: { ADHD_PROBE_MARKER: '1' } }) },
      undefined,
      engineConfig({
        cwd: dir,
        subprocessEnv: () => ({
          ADHD_FAKE_CLAUDE_OUT: selfOut,
          ADHD_FAKE_CLAUDE_CHILD_REPORT: childReport,
        }),
      }),
      logger
    );

    const request: ProviderChatRequest = {
      messages: [{ role: 'user', content: 'run' } as ProviderChatRequest['messages'][number]],
    };
    const response = await provider.chat(request);
    expect(response.message.content).toBe('OK');

    const self = JSON.parse(readFileSync(selfOut, 'utf8')) as {
      cwd: string;
      mcpConfig: { mcpServers: Record<string, { command: string }> };
    };
    // `claude` itself was spawned in the configured cwd...
    expect(self.cwd).toBe(dir);
    // ...the MCP entry was emitted into the --mcp-config it received...
    expect(self.mcpConfig.mcpServers['probe'].command).toBe(process.execPath);
    // ...and the MCP child `claude` launched (with an INHERITED cwd) reports it.
    // REVERT-FAILING: drop `cwd: this.config.cwd` from the `claude` spawn -> both
    // `self.cwd` and the child's report fall back to the vitest runner cwd.
    expect(readFileSync(childReport, 'utf8').trim()).toBe(dir);
  });
});
