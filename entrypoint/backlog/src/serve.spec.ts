/**
 * serve.spec.ts — `.mcp.json` wires a `backlog` stdio entry that spawns
 * `node dist/index.js serve --transport mcp` directly (no
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
import { buildBacklogApigenPackage, resolveExpectedMcpToolNames } from './server.js';
import { buildBacklogEnv, resolveBacklogDbPath } from './env.js';
import { openTestIssueStore, seedProject } from './test/helpers/open-test-issue-store.js';
import type { IOutcomeEnvelope } from './envelope.js';
import type { IIssueCard } from './query/types.js';
import type { ICreateIssueResult } from './write/create-issue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

/** See install.e2e.spec.ts's identical helper doc comment. */
async function expectedMcpToolNames(): Promise<string[]> {
  const { operations } = await buildBacklogApigenPackage(() => {
    throw new Error('expectedMcpToolNames: store must never be opened just to enumerate tool names');
  });
  return resolveExpectedMcpToolNames(operations);
}

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

  it('starts a real MCP stdio server via `serve --transport mcp`; tools/list + a real create/get round-trip work', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-serve-cli-mcp-'));

    // `project` is resolved-only — `create` never mints one (SPEC.md §1/
    // §6.1) — so seed it through the real store BEFORE the server subprocess
    // opens its own connection to the same file. `resolveBacklogDbPath` given
    // the same scope/`adhdRoot` resolves the identical file the spawned
    // `serve --transport mcp` process below will open.
    const seedEnv = buildBacklogEnv({ scope: 'project', cwd: adhdRoot, adhdRoot });
    seedEnv.ensureDirs();
    const dbPath = resolveBacklogDbPath(seedEnv);
    const seedStore = await openTestIssueStore(dbPath);
    const { projectUid } = await seedProject(seedStore, 'serve-cli-mcp-test-project');
    await seedStore.close();

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
    // Live-derived (not hardcoded) — see `expectedMcpToolNames()` above /
    // `resolveExpectedMcpToolNames`'s doc comment (server.ts). Tracks
    // whatever `client.ts` + the mounted plugins actually advertise instead
    // of a literal array that silently goes stale on the next export change.
    const expected = await expectedMcpToolNames();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(expected);

    // `create(ctx, input: ICreateIssueInput)` is a single non-`ctx` param, so
    // apigen's MCP mount wraps it as `{ data: { input: <the flat create
    // payload> } }` (the "apigen calling convention" — observed directly from
    // `backlog_create`'s real `tools/list` inputSchema and from a real
    // `callTool` round-trip against the spawned server below). The flat
    // payload carries `title`/`body`/`project`/`by` directly — no `item`
    // wrapper, no `family`/`repo` (identity is the global `uid`; there is no
    // human-readable id in this data model).
    const createResult = await client.callTool({
      name: 'backlog_create',
      arguments: {
        data: { input: { title: 'created via serve cli', body: 'x', project: projectUid, by: 'serve.spec' } },
      },
    });
    const createContent = createResult.content as Array<{ type: string; text: string }>;
    // Real observed shape: the outcome envelope `{ ok, data }`, where `data`
    // is `ICreateIssueResult` — the new `uid` lives at `data.uid` directly.
    const created = JSON.parse(createContent[0]?.text ?? '{}') as IOutcomeEnvelope<ICreateIssueResult>;
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable — checked above');
    expect(created.data.created).toBe(true);
    const createdUid = created.data.uid;
    expect(createdUid).toBeTruthy();

    // `get(ctx, input: IIssueGetInput)`'s single param is also named `input`,
    // and `IIssueGetInput` has no nested `input` field of its own, so this is
    // a single level of `data.input` wrapping (unlike `create`'s payload
    // above, which is itself a flat object).
    const getResult = await client.callTool({
      name: 'backlog_get',
      arguments: { data: { input: { uid: createdUid } } },
    });
    const getContent = getResult.content as Array<{ type: string; text: string }>;
    const got = JSON.parse(getContent[0]?.text ?? '{}') as IOutcomeEnvelope<IIssueCard>;
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('unreachable — checked above');
    expect(got.data.title).toBe('created via serve cli');
  }, 30_000);

  it('BUG-033: `serve --help` prints usage and exits 0 — never a raw unhandled-exception stack trace', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-serve-cli-help-'));
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [DIST_INDEX, 'serve', '--help'], {
      cwd: adhdRoot,
      env: { ...process.env, ADHD_BACKLOG_SCOPE: 'project' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/backlog serve/);
    // The defect this proves fixed: a raw stack trace (`at file:///…`,
    // ten-plus frames of minified dist) instead of the one-line usage text.
    expect(result.stderr).not.toMatch(/at file:/);
    expect(result.stderr).not.toMatch(/\.js:\d+:\d+/);
  });

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
