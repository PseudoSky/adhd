/**
 * server.mcp.spec.ts — SPEC.md §7 DoD clause 3 (MCP variant). Per AGENTS.md
 * "Proving an MCP server works — drive the real tools, never a bypass": this
 * spawns the REAL BUILT server (`dist/index.js` via
 * `src/test/fixtures/mcp-stdio-entry.js`) as a genuine child process and
 * drives it with a real `@modelcontextprotocol/sdk` `Client` over the real
 * `StdioClientTransport` — never an in-process call into `mcpPlugin.run()`'s
 * internals (which would skip exactly the transport/tool-registration layer
 * this test exists to prove).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createItem } from './client.js';
import { buildBacklogEnv } from './env.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY_SCRIPT = join(HERE, 'test', 'fixtures', 'mcp-stdio-entry.js');

describe('startBacklogServer — live MCP stdio mount, real @modelcontextprotocol/sdk client', () => {
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

  it('tools/list advertises listItems/createItem/getItem; callTool listItems returns real data', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-mcp-'));
    const repo = 'PseudoSky/mcp-test';

    // Seed real data BEFORE spawning the server subprocess (which will open
    // its own exclusive connection to the same file).
    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem({ store: seedStore, env: seedEnv }, { family: 'BUG-MCP', title: 'via mcp', body: 'x', repo });
    closeGraphBacklogStore(seedStore);

    transport = new StdioClientTransport({ command: 'node', args: [ENTRY_SCRIPT, adhdRoot], cwd: adhdRoot });
    client = new Client({ name: 'backlog-mcp-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    // Tool names are `backlog_<snake_export_name>`, NOT bare
    // `listItems`/`createItem`/`getItem` — `apigen-plugin-mcp`'s canonical
    // tool-name projection names tools via `project(op).mcp.name` (namespace
    // + path segments, snake_cased). `extractClientOperations()` (server.ts)
    // extracts with `dropFileSegment: true`, so the `client.d.ts` extraction
    // artifact (`'client_d'`, formerly BUG-APIGEN-OPENAPI-ROUTE-PATH-
    // MISMATCH-001 / BUG-BACKLOG-CANONICAL-NAMING-CLIENT-D-SEGMENT-001) no
    // longer appears in the tool name.
    expect(toolNames).toEqual(
      expect.arrayContaining(['backlog_list_items', 'backlog_create_item', 'backlog_get_item'])
    );

    const result = await client.callTool({
      name: 'backlog_list_items',
      arguments: { data: { filter: { repo, family: 'BUG-MCP' } } },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]?.text ?? '[]') as Array<{ humanId: string; title: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.humanId).toBe(seeded.item.humanId);
    expect(parsed[0]?.title).toBe('via mcp');
  }, 30_000);

  it('callTool createItem via MCP actually persists — a follow-up getItem call sees it', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-mcp-create-'));
    const repo = 'PseudoSky/mcp-create-test';

    transport = new StdioClientTransport({ command: 'node', args: [ENTRY_SCRIPT, adhdRoot], cwd: adhdRoot });
    client = new Client({ name: 'backlog-mcp-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    // See the tool-name note in the previous test — real tool names are
    // `backlog_<snake_export_name>`, not bare `createItem`/`getItem`.
    const createResult = await client.callTool({
      name: 'backlog_create_item',
      arguments: { data: { input: { family: 'BUG-MCPCREATE', title: 'created via mcp', body: 'x', repo } } },
    });
    const createContent = createResult.content as Array<{ type: string; text: string }>;
    const created = JSON.parse(createContent[0]?.text ?? '{}') as { item: { humanId: string } };
    expect(created.item.humanId).toBe('BUG-MCPCREATE-001');

    const getResult = await client.callTool({
      name: 'backlog_get_item',
      arguments: { data: { repo, humanId: created.item.humanId } },
    });
    const getContent = getResult.content as Array<{ type: string; text: string }>;
    const got = JSON.parse(getContent[0]?.text ?? '{}') as { title: string };
    expect(got.title).toBe('created via mcp');
  }, 30_000);
});
