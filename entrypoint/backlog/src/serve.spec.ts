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
    // INTERFACE_v2 AC-5 collapsed the 38 flat v1 verbs onto SIX `backlog_*`
    // data verbs (`client.ts`'s only exports — `get`/`query`/`create`/
    // `update`/`relate`/`admin`) plus the un-namespaced batch-dispatch tool
    // `apigen-plugin-batch` mounts (`batch_action`). `backlog_create_item`/
    // `backlog_get_item`/`backlog_list_items` are v1 names — those ops moved
    // to `ops-v1.ts` and are no longer mounted on any transport (ops-v1.ts
    // header, client.ts header). Verified live against `install.e2e.spec.ts`'s
    // real-spawned-server ground truth for the 7-tool surface.
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ['backlog_admin', 'backlog_create', 'backlog_get', 'backlog_query', 'backlog_relate', 'backlog_update', 'batch_action'].sort()
    );

    // `create(ctx, input: IBacklogCreateInput)` is a single non-`ctx` param,
    // so apigen's MCP mount wraps it as `{ data: { input: <the param> } }`
    // (the "apigen calling convention" — observed directly from
    // `backlog_create`'s real `tools/list` inputSchema, whose
    // `description` states it, and from a real `callTool` round-trip against
    // the spawned server below). `IBacklogCreateInput` itself carries a
    // FIELD also named `input` (the create payload) plus the required `by`
    // attribution (INTERFACE_v2 §7.5 — every mutation needs one), hence the
    // double `input.input` nesting.
    const createResult = await client.callTool({
      name: 'backlog_create',
      arguments: {
        data: { input: { input: { family: 'BUG-SERVECLI', title: 'created via serve cli', body: 'x', repo }, by: 'serve.spec' } },
      },
    });
    const createContent = createResult.content as Array<{ type: string; text: string }>;
    // Real observed shape: the §7.1 outcome envelope `{ ok, data }`, where
    // `data` is `ICreateOutcome` — `humanId` lives at `data.humanId`
    // directly, never nested under a `data.item.humanId` (BUG-BACKLOG-V2-
    // ENVELOPE-DATA-STRIPPED-001 / cli-envelope.spec.ts covers the envelope
    // itself; this asserts the MCP transport carries the same shape).
    const created = JSON.parse(createContent[0]?.text ?? '{}') as {
      ok: boolean;
      data: { created: boolean; humanId: string; item: { humanId: string } };
    };
    expect(created.ok).toBe(true);
    expect(created.data.created).toBe(true);
    expect(created.data.humanId).toBe('BUG-SERVECLI-001');

    // `get(ctx, input: IBacklogGetOptions)`'s single param is also named
    // `input`, but `IBacklogGetOptions` has no nested `input` field of its
    // own, so this is a single level of `data.input` wrapping (unlike
    // `create`'s double nesting above).
    const getResult = await client.callTool({
      name: 'backlog_get',
      arguments: { data: { input: { repo, humanId: created.data.humanId } } },
    });
    const getContent = getResult.content as Array<{ type: string; text: string }>;
    const got = JSON.parse(getContent[0]?.text ?? '{}') as { ok: boolean; data: { title: string } };
    expect(got.ok).toBe(true);
    expect(got.data.title).toBe('created via serve cli');
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
