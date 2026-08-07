/**
 * serve.spec.ts — MIGRATION.md §4.5: `.mcp.json` wires a `backlog` stdio
 * entry that spawns `node dist/index.js serve --transport mcp` directly (no
 * test-only fixture, no `startBacklogServer` import) — before this command
 * existed, `.mcp.json` would have had nothing real to point at
 * (`startBacklogServer` was only reachable by importing `@adhd/backlog`
 * programmatically, e.g. `test/fixtures/mcp-stdio-entry.js`). This spawns
 * the REAL BUILT bin's `serve` subcommand as a genuine child process and
 * drives it with a real `@modelcontextprotocol/sdk` `Client` — the exact
 * shape `.mcp.json` itself uses — never a bypass (AGENTS.md §7 "Proving an
 * MCP server works").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

describe('backlog serve --transport mcp — the REAL .mcp.json-wired command, real spawned bin', () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let adhdRoot: string | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    client = undefined;
    transport = undefined;
    if (adhdRoot) rmSync(adhdRoot, { recursive: true, force: true });
    adhdRoot = undefined;
  });

  it('starts a real MCP stdio server via `serve --transport mcp`; tools/list + a real createItem/getItem round-trip work', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-serve-cli-mcp-'));
    const repo = 'PseudoSky/serve-cli-mcp-test';

    // Exactly the invocation `.mcp.json` itself performs: `node dist/index.js
    // serve --transport mcp`, no other flags — scope/isolation come from
    // env vars + cwd, same convention `cli.spec.ts`'s `runBin` already
    // proves is real isolation (never the machine's global `~/.adhd/backlog`).
    transport = new StdioClientTransport({
      command: 'node',
      args: [DIST_INDEX, 'serve', '--transport', 'mcp'],
      cwd: adhdRoot,
      env: { ...(process.env as Record<string, string>), ADHD_BACKLOG_SCOPE: 'project' },
    });
    client = new Client({ name: 'backlog-serve-cli-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    // Tool names are `backlog_<snake_export_name>` — `extractClientOperations()`
    // (server.ts) extracts with `dropFileSegment: true`, so no `client.d.ts`
    // extraction-artifact segment (`'client_d'`) leaks into the tool name.
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['backlog_create_item', 'backlog_get_item', 'backlog_list_items'])
    );

    const createResult = await client.callTool({
      name: 'backlog_create_item',
      arguments: { data: { input: { family: 'BUG-SERVECLI', title: 'created via serve cli', body: 'x', repo } } },
    });
    const createContent = createResult.content as Array<{ type: string; text: string }>;
    const created = JSON.parse(createContent[0]?.text ?? '{}') as { item: { humanId: string } };
    expect(created.item.humanId).toBe('BUG-SERVECLI-001');

    const getResult = await client.callTool({
      name: 'backlog_get_item',
      arguments: { data: { repo, humanId: created.item.humanId } },
    });
    const getContent = getResult.content as Array<{ type: string; text: string }>;
    const got = JSON.parse(getContent[0]?.text ?? '{}') as { title: string };
    expect(got.title).toBe('created via serve cli');
  }, 30_000);

  it('rejects an unknown --transport value rather than silently defaulting', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-serve-cli-badtransport-'));
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [DIST_INDEX, 'serve', '--transport', 'bogus'], {
      cwd: adhdRoot,
      env: { ...process.env, ADHD_BACKLOG_SCOPE: 'project' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--transport/);
  });
});
