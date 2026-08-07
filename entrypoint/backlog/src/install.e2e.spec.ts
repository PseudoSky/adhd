/**
 * install.e2e.spec.ts — BUG-013, the real proof. Per AGENTS.md "Proving an
 * MCP server works — drive the real tools, never a bypass": this test
 * writes a claude-style AND an opencode-style config via the real `install`
 * function, extracts the EXACT command/args (or command-array) `install.ts`
 * wrote into each, and spawns THAT (locally rewritten to the built
 * `dist/index.js` in place of the network `npx -y @adhd/backlog@latest`
 * form, purely so the test never touches the network / requires a
 * published version — see the per-test note) as a genuine child process,
 * driving it with a real `@modelcontextprotocol/sdk` `Client` over a real
 * `StdioClientTransport`. This proves the config `install` writes actually
 * launches a working MCP server — never an in-process bypass of
 * `mcpPlugin`/`startBacklogServer`.
 *
 * Mirrors `server.mcp.spec.ts`'s proven real-subprocess pattern.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { install, BACKLOG_MCP_NPX_ARGS } from './install.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

describe('BUG-013 — install-written MCP config actually launches a working real server (claude + opencode)', () => {
  let tmp: string | undefined;
  let adhdRoot: string | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    client = undefined;
    transport = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (adhdRoot) rmSync(adhdRoot, { recursive: true, force: true });
    tmp = undefined;
    adhdRoot = undefined;
  });

  it('the exact args install.ts writes are the intended portable npx invocation (assertion on the config content itself, before ever spawning anything)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'backlog-install-e2e-argcheck-'));
    const result = install(['--host', 'claude', '--scope', 'user', '--mcp-only'], tmp, tmp);
    const doc = JSON.parse(readFileSync(result.mcp[0]!.configPath, 'utf8'));
    expect(doc.mcpServers.backlog.command).toBe('npx');
    expect(doc.mcpServers.backlog.args).toEqual([...BACKLOG_MCP_NPX_ARGS]);
    expect(BACKLOG_MCP_NPX_ARGS).toEqual(['-y', '@adhd/backlog@latest', 'serve', '--transport', 'mcp']);
  });

  it('claude-style config: spawning the real dist/index.js serve --transport mcp (the local stand-in for the written npx invocation) advertises all 37 real tools', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'backlog-install-e2e-claude-'));
    const result = install(['--host', 'claude', '--scope', 'user', '--mcp-only'], tmp, tmp);
    const doc = JSON.parse(readFileSync(result.mcp[0]!.configPath, 'utf8')) as {
      mcpServers: { backlog: { command: string; args: string[] } };
    };
    // Real npx invocation form is proven by the config-content assertion
    // above; here we substitute the LOCAL built entry for `serve` so the
    // test never depends on network/publish state, while still driving the
    // ACTUAL args tail (`serve --transport mcp`) the written config
    // specifies — never a bespoke, hand-authored argv.
    const servArgsTail = doc.mcpServers.backlog.args.slice(2); // drop ["serve"]'s own preceding "-y","@adhd/backlog@latest"
    expect(servArgsTail).toEqual(['serve', '--transport', 'mcp']);

    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-install-e2e-claude-adhd-'));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_INDEX, ...servArgsTail],
      cwd: adhdRoot,
      env: { ADHD_BACKLOG_SCOPE: 'project', VITEST: 'true', HOME: process.env['HOME'] ?? '', PATH: process.env['PATH'] ?? '' },
    });
    client = new Client({ name: 'backlog-install-e2e-claude', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    // 37 real tools: every `client.ts` export (36, `backlog_*`) plus the
    // batch-dispatch tool `apigen-plugin-batch` mounts (`batch_action`,
    // deliberately UN-namespaced — confirmed against the real tool list
    // below, not guessed).
    expect(tools.tools.length).toBe(37);
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['backlog_list_items', 'backlog_create_item', 'backlog_get_item', 'batch_action']),
    );
  }, 30_000);

  it('opencode-style config: spawning the real dist/index.js via the written command ARRAY shape advertises all 37 real tools', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'backlog-install-e2e-opencode-'));
    const result = install(['--host', 'opencode', '--scope', 'user', '--mcp-only'], tmp, tmp);
    const doc = JSON.parse(readFileSync(result.mcp[0]!.configPath, 'utf8')) as {
      mcp: { backlog: { type: string; command: string[] } };
    };
    expect(doc.mcp.backlog.type).toBe('local');
    expect(Array.isArray(doc.mcp.backlog.command)).toBe(true);
    // opencode's own `command` array is `["npx", ...BACKLOG_MCP_NPX_ARGS]`
    // (`["npx","-y","@adhd/backlog@latest","serve","--transport","mcp"]`) —
    // drop the network-facing `npx -y @adhd/backlog@latest` head, keep the
    // real `serve --transport mcp` tail this config actually specifies.
    const servArgsTail = doc.mcp.backlog.command.slice(3);
    expect(servArgsTail).toEqual(['serve', '--transport', 'mcp']);

    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-install-e2e-opencode-adhd-'));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_INDEX, ...servArgsTail],
      cwd: adhdRoot,
      env: { ADHD_BACKLOG_SCOPE: 'project', VITEST: 'true', HOME: process.env['HOME'] ?? '', PATH: process.env['PATH'] ?? '' },
    });
    client = new Client({ name: 'backlog-install-e2e-opencode', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.length).toBe(37);
  }, 30_000);
});
