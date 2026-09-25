/**
 * serve.e2e.ts — `.mcp.json` wires a `backlog` stdio entry that spawns
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
import { rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildBacklogApigenPackage,
  resolveExpectedMcpToolNames,
} from './server.js';
import { buildBacklogEnv, resolveBacklogDbPath } from './env.js';
import {
  openTestIssueStore,
  seedProject,
} from './test/helpers/open-test-issue-store.js';
import type { IOutcomeEnvelope } from './envelope.js';
import type { IIssueCard } from './query/types.js';
import type { ICreateIssueResult } from './write/create-issue.js';
// STATE.md A15: this file previously used a local `adhdRoot` (mkdtempSync)
// as the spawn's `cwd` ONLY — never wired to `ADHD_ROOT`/`--namespace
// sandbox` — so the real machine's global `embedding.enabled: true`
// config.yaml still resolved through, silently paying a real ONNX/fastembed
// model load per invocation (confirmed by direct reproduction: real
// CoreML/onnxruntime warnings). Moved onto the canonical sandbox helper,
// which mints a real isolated `adhdRoot` AND writes `embedding.enabled:
// false` before this file's `serve` subprocess ever starts.
import {
  mintBacklogSandbox,
  runBacklogBin,
  stdioSpawnOptionsForSandbox,
  type SandboxHandle,
} from './test/helpers/spawn-backlog-bin.js';

/** See install.e2e.ts's identical helper doc comment. */
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
  let sandbox: SandboxHandle | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    client = undefined;
    transport = undefined;
    if (sandbox) rmSync(sandbox.adhdRoot, { recursive: true, force: true });
    sandbox = undefined;
  });

  it('starts a real MCP stdio server via `serve --transport mcp`; tools/list + a real create/get round-trip work', async () => {
    sandbox = mintBacklogSandbox();

    // `project` is resolved-only — `create` never mints one (SPEC.md §1/
    // §6.1) — so seed it through the real store BEFORE the server subprocess
    // opens its own connection to the same file. `resolveBacklogDbPath` given
    // the SAME `adhdRoot`+`namespace:'sandbox'` resolves the identical file
    // the spawned `serve --transport mcp` process below will open. Deliberately
    // NO `scope: 'project'` override here (a real, disclosed environment-
    // builder bug this task found: `resolveRoots`'s `project`-scope branch
    // resolves its base purely from `findProjectRoot(cwd)`, never honoring
    // `adhdRoot` — the exact opposite of the `global`/`system` bases, which
    // DO honor it. `scope: 'project'` + `adhdRoot` therefore silently
    // resolves to the WRONG directory whenever an ancestor of `cwd` happens
    // to carry a stray `.git`/`.adhd`/`adhd.environment.yaml` marker. Filed;
    // not fixed here — CRITICAL blast radius, shared by every
    // `@adhd/environment-builder` consumer, out of this task's scope.
    // `buildBacklogEnv`'s own default scope is `'global'`, which DOES honor
    // `adhdRoot` correctly — matching `cli.spec.ts`'s own proven convention
    // of never combining an explicit `scope` with `--namespace sandbox`.
    const seedEnv = buildBacklogEnv({
      adhdRoot: sandbox.adhdRoot,
      namespace: 'sandbox',
    });
    seedEnv.ensureDirs();
    const dbPath = resolveBacklogDbPath(seedEnv);
    const seedStore = await openTestIssueStore(dbPath);
    const { projectUid } = await seedProject(
      seedStore,
      'serve-cli-mcp-test-project'
    );
    await seedStore.close();

    // Exactly the invocation `.mcp.json` itself performs (`serve --transport
    // mcp`) — routed through the canonical sandbox helper (STATE.md A15) so
    // this real subprocess never touches the machine's global
    // `~/.adhd/backlog/production/config.yaml` (`embedding.enabled: true`).
    transport = new StdioClientTransport(
      stdioSpawnOptionsForSandbox(sandbox, ['serve', '--transport', 'mcp'])
    );
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
        data: {
          input: {
            title: 'created via serve cli',
            body: 'x',
            project: projectUid,
            by: 'serve.spec',
          },
        },
      },
    });
    const createContent = createResult.content as Array<{
      type: string;
      text: string;
    }>;
    // Real observed shape: the outcome envelope `{ ok, data }`, where `data`
    // is `ICreateIssueResult` — the new `uid` lives at `data.uid` directly.
    const created = JSON.parse(
      createContent[0]?.text ?? '{}'
    ) as IOutcomeEnvelope<ICreateIssueResult>;
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
    const getContent = getResult.content as Array<{
      type: string;
      text: string;
    }>;
    const got = JSON.parse(
      getContent[0]?.text ?? '{}'
    ) as IOutcomeEnvelope<IIssueCard>;
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error('unreachable — checked above');
    expect(got.data.title).toBe('created via serve cli');
  }, 30_000);

  it('BUG-033: `serve --help` prints usage and exits 0 — never a raw unhandled-exception stack trace', () => {
    const result = runBacklogBin(['serve', '--help']);
    sandbox = result.sandboxRoot
      ? ({ adhdRoot: result.sandboxRoot } as SandboxHandle)
      : undefined;
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/backlog serve/);
    // The defect this proves fixed: a raw stack trace (`at file:///…`,
    // ten-plus frames of minified dist) instead of the one-line usage text.
    expect(result.stderr).not.toMatch(/at file:/);
    expect(result.stderr).not.toMatch(/\.js:\d+:\d+/);
  });

  it('rejects an unknown --transport value rather than silently defaulting', () => {
    const result = runBacklogBin(['serve', '--transport', 'bogus']);
    sandbox = result.sandboxRoot
      ? ({ adhdRoot: result.sandboxRoot } as SandboxHandle)
      : undefined;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--transport/);
  });
});
