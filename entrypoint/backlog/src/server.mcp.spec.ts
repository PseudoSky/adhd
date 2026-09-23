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
import { createIssue } from './write/create-issue.js';
import {
  openTestIssueStore,
  seedProject,
} from './test/helpers/open-test-issue-store.js';
import { buildBacklogEnv, resolveBacklogDbPath } from './env.js';
import type { IOutcomeEnvelope } from './envelope.js';
import type { IIssueCard, IIssueQueryResult } from './query/types.js';
import type { ICreateIssueResult } from './write/create-issue.js';

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

  it('tools/list advertises the mounted verbs (get/query/create/update/relate/…); callTool backlog_query returns real data', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-mcp-'));

    // Seed real data BEFORE spawning the server subprocess (which will open
    // its own exclusive connection to the same file). `resolveBacklogDbPath`
    // resolves the exact same file `startBacklogServer` will open below,
    // given the same `adhdRoot`/scope.
    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const dbPath = resolveBacklogDbPath(seedEnv);
    const seedStore = await openTestIssueStore(dbPath);
    const { projectUid } = await seedProject(seedStore, 'mcp-test-project');
    const seeded = await createIssue(seedStore, {
      project: projectUid,
      title: 'via mcp',
      body: 'x',
      by: 'mcp-spec-seed',
    });
    await seedStore.close();
    if (!seeded.uid) throw new Error('seed createIssue did not return a uid');
    const seededUid = seeded.uid;

    transport = new StdioClientTransport({
      command: 'node',
      args: [ENTRY_SCRIPT, adhdRoot],
      cwd: adhdRoot,
    });
    client = new Client(
      { name: 'backlog-mcp-test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    // The mounted surface is the operation set `api.ts` exports (`BACKLOG_VERBS`
    // in server.ts), each projected to `backlog_<verb>` by `apigen-plugin-mcp`'s
    // canonical tool-name projection (namespace + path segment, snake_cased).
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'backlog_get',
        'backlog_query',
        'backlog_create',
        'backlog_update',
        'backlog_relate',
      ])
    );

    // `backlog_query`'s content block carries the outcome envelope
    // `{ ok, data: { view, items }, meta? }` — the MCP transport wraps the
    // single non-ctx `query()` parameter under `data`, and that parameter is
    // itself named `input` in `query()`'s signature, so the arg is
    // `data.input.filter`, NOT `data.filter`.
    const result = await client.callTool({
      name: 'backlog_query',
      arguments: { data: { input: { filter: { project: projectUid } } } },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(
      content[0]?.text ?? '{}'
    ) as IOutcomeEnvelope<IIssueQueryResult>;
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable — checked above');
    if (parsed.data.view !== 'list') throw new Error('expected view:"list"');
    expect(parsed.data.items).toHaveLength(1);
    expect(parsed.data.items[0]?.uid).toBe(seededUid);
    expect(parsed.data.items[0]?.title).toBe('via mcp');
  }, 30_000);

  it('callTool backlog_create via MCP actually persists — a follow-up backlog_get call sees it', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-server-mcp-create-'));

    // The `project` a real `create` call resolves against must already
    // exist (SPEC: `project` is resolved-only, never minted by `create`),
    // so seed it through the same real store path before the server starts.
    const seedEnv = buildBacklogEnv({
      scope: 'project',
      cwd: adhdRoot,
      adhdRoot,
    });
    seedEnv.ensureDirs();
    const dbPath = resolveBacklogDbPath(seedEnv);
    const seedStore = await openTestIssueStore(dbPath);
    const { projectUid } = await seedProject(
      seedStore,
      'mcp-create-test-project'
    );
    await seedStore.close();

    transport = new StdioClientTransport({
      command: 'node',
      args: [ENTRY_SCRIPT, adhdRoot],
      cwd: adhdRoot,
    });
    client = new Client(
      { name: 'backlog-mcp-test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);

    // Real tool names are `backlog_<verb>`, not bare/flat `createItem`/
    // `getItem`. `by` is mandatory attribution on every mutation and the
    // envelope wraps the create outcome under `data`.
    const createResult = await client.callTool({
      name: 'backlog_create',
      arguments: {
        data: {
          input: {
            title: 'created via mcp',
            body: 'x',
            project: projectUid,
            by: 'mcp-test-client',
          },
        },
      },
    });
    const createContent = createResult.content as Array<{
      type: string;
      text: string;
    }>;
    const created = JSON.parse(
      createContent[0]?.text ?? '{}'
    ) as IOutcomeEnvelope<ICreateIssueResult>;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable — checked above');
    expect(created.data.created).toBe(true);
    const createdUid = created.data.uid;
    expect(createdUid).toBeTruthy();

    const getResult = await client.callTool({
      name: 'backlog_get',
      arguments: { data: { input: { uid: createdUid } } },
    });
    const getContent = getResult.content as Array<{
      type: string;
      text: string;
    }>;
    const got = JSON.parse(
      getContent[0]?.text ?? '{}'
    ) as IOutcomeEnvelope<IIssueCard>;
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('unreachable — checked above');
    expect(got.data.title).toBe('created via mcp');
  }, 30_000);
});
