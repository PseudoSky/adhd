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
import { createItem } from './ops-v1.js';
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

  it('tools/list advertises the six v2 verbs (get/query/create/update/relate/admin) + batch_action; callTool backlog_query returns real data', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-mcp-'));
    const repo = 'PseudoSky/mcp-test';

    // Seed real data BEFORE spawning the server subprocess (which will open
    // its own exclusive connection to the same file).
    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const seedStore = await openGraphBacklogStore(seedEnv.files.db);
    const seeded = await createItem({ store: seedStore, env: seedEnv }, { family: 'BUG-MCP', title: 'via mcp', body: 'x', repo });
    await closeGraphBacklogStore(seedStore);

    transport = new StdioClientTransport({ command: 'node', args: [ENTRY_SCRIPT, adhdRoot], cwd: adhdRoot });
    client = new Client({ name: 'backlog-mcp-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    // INTERFACE_v2 §10.0 / AC-0 — the mounted surface is the SIX consolidated
    // verbs (`BACKLOG_V2_VERBS` in server.ts), each projected to
    // `backlog_<verb>` by `apigen-plugin-mcp`'s canonical tool-name
    // projection (namespace + path segment, snake_cased), plus the
    // un-namespaced `batch_action` synthetic mount. The old flat
    // `backlog_list_items`/`backlog_create_item`/`backlog_get_item` verbs
    // (v1) are no longer mounted at all — `ops-v1.ts` is barrel-only now.
    expect(toolNames).toEqual(
      expect.arrayContaining(['backlog_get', 'backlog_query', 'backlog_create', 'backlog_update', 'backlog_relate', 'backlog_admin'])
    );

    // Empirically observed shape (MCP wraps the single non-ctx client.ts
    // parameter under `data`, and that parameter is itself named `input` in
    // `query()`'s signature, so the arg is `data.input.filter`, NOT
    // `data.filter`): `backlog_query`'s content block carries the §7.1
    // outcome envelope `{ ok, data: { view, items }, meta }` — `items`, not a
    // bare array, and each card is the terse default projection (humanId,
    // kind, title, status — no body).
    const result = await client.callTool({
      name: 'backlog_query',
      arguments: { data: { input: { filter: { repo, family: 'BUG-MCP' } } } },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]?.text ?? '{}') as {
      ok: boolean;
      data: { view: string; items: Array<{ humanId: string; title: string }> };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.items).toHaveLength(1);
    expect(parsed.data.items[0]?.humanId).toBe(seeded.item.humanId);
    expect(parsed.data.items[0]?.title).toBe('via mcp');
  }, 30_000);

  it('callTool backlog_create via MCP actually persists — a follow-up backlog_get call sees it', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-mcp-create-'));
    const repo = 'PseudoSky/mcp-create-test';

    transport = new StdioClientTransport({ command: 'node', args: [ENTRY_SCRIPT, adhdRoot], cwd: adhdRoot });
    client = new Client({ name: 'backlog-mcp-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    // See the tool-name note in the previous test — real tool names are
    // `backlog_<verb>`, not bare/flat `createItem`/`getItem`. `by` is
    // mandatory on every mutation (INTERFACE_v2 §7.5, `assertAttribution` in
    // client.ts) and the envelope wraps the create outcome under `data`.
    const createResult = await client.callTool({
      name: 'backlog_create',
      arguments: {
        data: { input: { input: { family: 'BUG-MCPCREATE', title: 'created via mcp', body: 'x', repo }, by: 'mcp-test-client' } },
      },
    });
    const createContent = createResult.content as Array<{ type: string; text: string }>;
    const created = JSON.parse(createContent[0]?.text ?? '{}') as { ok: boolean; data: { humanId: string } };
    expect(created.ok).toBe(true);
    expect(created.data.humanId).toBe('BUG-MCPCREATE-001');

    const getResult = await client.callTool({
      name: 'backlog_get',
      arguments: { data: { input: { repo, humanId: created.data.humanId } } },
    });
    const getContent = getResult.content as Array<{ type: string; text: string }>;
    const got = JSON.parse(getContent[0]?.text ?? '{}') as { ok: boolean; data: { title: string } };
    expect(got.ok).toBe(true);
    expect(got.data.title).toBe('created via mcp');
  }, 30_000);
});
