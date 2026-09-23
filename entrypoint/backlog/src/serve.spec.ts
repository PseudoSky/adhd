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
import {
  buildBacklogApigenPackage,
  resolveExpectedMcpToolNames,
} from './server.js';
import {
  isolatedSpawnOptions,
  runIsolatedBin,
} from './test/helpers/spawn-isolated-bin.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = join(HERE, '..', 'dist', 'index.js');

/** See install.e2e.spec.ts's identical helper doc comment. */
async function expectedMcpToolNames(): Promise<string[]> {
  const { operations } = await buildBacklogApigenPackage(() => {
    throw new Error(
      'expectedMcpToolNames: store must never be opened just to enumerate tool names'
    );
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

  it('starts a real MCP stdio server via `serve --transport mcp`; tools/list + a real createItem/getItem round-trip work', async () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-serve-cli-mcp-'));
    const repo = 'PseudoSky/serve-cli-mcp-test';

    // Exactly the invocation `.mcp.json` itself performs: `node dist/index.js
    // serve --transport mcp`, no other flags — scope/isolation come from
    // env vars + cwd, same convention `cli.spec.ts`'s `runBin` already
    // proves is real isolation (never the machine's global `~/.adhd/backlog`).
    transport = new StdioClientTransport({
      // `process.execPath` (not `'node'` off PATH) — the same interpreter
      // `runIsolatedBin`/`isolatedSpawnOptions` sites use, so this spec cannot
      // pick up a different Node via an ambient PATH.
      command: process.execPath,
      args: [DIST_INDEX, 'serve', '--transport', 'mcp'],
      // The required `ADHD_BACKLOG_SCOPE=project` + `HOME=<root>` redirect
      // pair (and why the scope alone is not enough) lives in ONE place now —
      // `test/helpers/spawn-isolated-bin.ts`, guarded by its own spec.
      ...isolatedSpawnOptions(adhdRoot),
    });
    client = new Client(
      { name: 'backlog-serve-cli-test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);

    const tools = await client.listTools();
    // Live-derived (not hardcoded) — see `expectedMcpToolNames()` above /
    // `resolveExpectedMcpToolNames`'s doc comment (server.ts). Tracks
    // whatever `client.ts` + the mounted plugins actually advertise instead
    // of a literal array that silently goes stale on the next export change.
    const expected = await expectedMcpToolNames();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(expected);

    // `create(ctx, input: IBacklogCreateInput)` is a single non-`ctx` param,
    // so apigen's MCP mount wraps it as `{ data: { input: <the param> } }`
    // (the "apigen calling convention" — observed directly from
    // `backlog_create`'s real `tools/list` inputSchema, whose
    // `description` states it, and from a real `callTool` round-trip against
    // the spawned server below). `IBacklogCreateInput` itself carries the
    // create payload under `item` (renamed from the old, confusing
    // `input.input` double-nesting) plus the required `by` attribution
    // (INTERFACE_v2 §7.5 — every mutation needs one).
    const createResult = await client.callTool({
      name: 'backlog_create',
      arguments: {
        data: {
          input: {
            item: {
              family: 'BUG-SERVECLI',
              title: 'created via serve cli',
              body: 'x',
              repo,
            },
            by: 'serve.spec',
          },
        },
      },
    });
    const createContent = createResult.content as Array<{
      type: string;
      text: string;
    }>;
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
    const getContent = getResult.content as Array<{
      type: string;
      text: string;
    }>;
    const got = JSON.parse(getContent[0]?.text ?? '{}') as {
      ok: boolean;
      data: { title: string };
    };
    expect(got.ok).toBe(true);
    expect(got.data.title).toBe('created via serve cli');
  }, 30_000);

  it('BUG-033: `serve --help` prints usage and exits 0 — never a raw unhandled-exception stack trace', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-serve-cli-help-'));
    const result = runIsolatedBin(DIST_INDEX, ['serve', '--help'], adhdRoot, {
      timeoutMs: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/backlog serve/);
    // The defect this proves fixed: a raw stack trace (`at file:///…`,
    // ten-plus frames of minified dist) instead of the one-line usage text.
    expect(result.stderr).not.toMatch(/at file:/);
    expect(result.stderr).not.toMatch(/\.js:\d+:\d+/);
  });

  it('rejects an unknown --transport value rather than silently defaulting', () => {
    adhdRoot = mkdtempSync(join(tmpdir(), 'backlog-serve-cli-badtransport-'));
    const result = runIsolatedBin(
      DIST_INDEX,
      ['serve', '--transport', 'bogus'],
      adhdRoot,
      { timeoutMs: 10_000 }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--transport/);
  });
});
