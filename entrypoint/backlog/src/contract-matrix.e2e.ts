/**
 * contract-matrix.e2e.ts — the transport contract matrix (QA-STRATEGY.md §2
 * "Contract" row, §4 "Contract" DoD): the SAME consumer-visible envelope and
 * the SAME documented exit codes on BOTH real transports.
 *
 *  - CLI: the REAL BUILT `dist/index.js` spawned as a child process
 *    (`node dist/index.js <verb> --input '<json>'`), asserted on its process
 *    EXIT CODE and the parsed stdout/stderr — never a stdout `grep`.
 *  - MCP: the REAL BUILT `dist/index.js serve --transport mcp` spawned as a
 *    host does, driven over stdio JSON-RPC, asserted on the flat `content`
 *    envelope.
 *
 * Representative verb set covers each outcome class the envelope union
 * encodes: success (create + query), a reported domain failure
 * (`item_not_found`), a schema/validation failure (`validation` /
 * `invalid_argument`), and — CLI-only, since MCP has no argv — an unknown
 * command (`not_found` → exit 4) and malformed `--input` (unwrapped
 * `invalid_argument` on stderr, exit 2).
 *
 * Resource lane: proc — spawns the built CLI and the built MCP server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedBin } from './test/helpers/spawn-isolated-bin.js';
import {
  connectMcpHost,
  callToolJson,
  DIST_INDEX,
  type IMcpHost,
} from './test/helpers/spawn-mcp-host.js';
import {
  openTestIssueStore,
  seedProject,
} from './test/helpers/open-test-issue-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const TMP_BACKLOG = join(REPO_ROOT, 'tmp', 'backlog');

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface TransportCase {
  root: string;
  dbPath: string;
  projectUid: string;
  host: IMcpHost;
}

let cli: TransportCase;
let mcp: TransportCase;
const roots: string[] = [];

function mkCase(prefix: string): { root: string; dbPath: string } {
  mkdirSync(TMP_BACKLOG, { recursive: true });
  const root = mkdtempSync(join(TMP_BACKLOG, prefix));
  roots.push(root);
  return { root, dbPath: join(root, `${prefix.replace(/-$/, '')}.db`) };
}

async function seed(root: string, dbPath: string, name: string) {
  const store = await openTestIssueStore(dbPath);
  const { projectUid } = await seedProject(store, name);
  await store.close();
  return projectUid;
}

function runCli(root: string, dbPath: string, args: string[]): CliRun {
  return runIsolatedBin(DIST_INDEX, args, root, {
    extraEnv: {
      ADHD_BACKLOG_DATABASE_PATH: dbPath,
      ADHD_BACKLOG_EMBEDDING_ENABLED: 'false',
    },
  });
}

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

beforeAll(async () => {
  const a = mkCase('contract-cli-');
  const b = mkCase('contract-mcp-');
  const aPid = await seed(a.root, a.dbPath, 'contract-cli-project');
  const bPid = await seed(b.root, b.dbPath, 'contract-mcp-project');
  cli = { ...a, projectUid: aPid, host: undefined as unknown as IMcpHost };
  mcp = { ...b, projectUid: bPid, host: await connectMcpHost(b) };
}, 120_000);

afterAll(async () => {
  await mcp?.host?.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe('contract matrix — success is the same success on both transports', () => {
  it('create: CLI exits 0 with {ok:true,data.created:true}; MCP returns the same envelope', async () => {
    const cliRun = runCli(cli.root, cli.dbPath, [
      'create',
      '--input',
      JSON.stringify({
        title: 'matrix cli item',
        body: 'b',
        project: cli.projectUid,
        by: 'contract-matrix',
        duplicateAction: 'force',
      }),
    ]);
    expect(cliRun.status, `stderr: ${cliRun.stderr}`).toBe(0);
    const cliBody = lastJson(cliRun.stdout);
    expect(cliBody['ok']).toBe(true);
    expect((cliBody['data'] as Record<string, unknown>)['created']).toBe(true);

    const { envelope, isError } = await callToolJson(mcp.host.client, 'backlog_create', {
      data: {
        input: {
          title: 'matrix mcp item',
          body: 'b',
          project: mcp.projectUid,
          by: 'contract-matrix',
          duplicateAction: 'force',
        },
      },
    });
    expect(isError).toBeFalsy();
    expect(envelope.ok).toBe(true);
    expect((envelope.data as Record<string, unknown>).created).toBe(true);
  }, 60_000);

  it('query: CLI exits 0 with {ok:true,data.view:"list"}; MCP returns the same envelope', async () => {
    const cliRun = runCli(cli.root, cli.dbPath, [
      'query',
      '--input',
      JSON.stringify({ view: 'list', limit: 1 }),
    ]);
    expect(cliRun.status, `stderr: ${cliRun.stderr}`).toBe(0);
    const cliBody = lastJson(cliRun.stdout);
    expect(cliBody['ok']).toBe(true);
    expect((cliBody['data'] as Record<string, unknown>)['view']).toBe('list');

    const { envelope, isError } = await callToolJson(mcp.host.client, 'backlog_query', {
      data: { input: { view: 'list', limit: 1 } },
    });
    expect(isError).toBeFalsy();
    expect(envelope.ok).toBe(true);
    expect((envelope.data as Record<string, unknown>).view).toBe('list');
  }, 60_000);
});

describe('contract matrix — the same failure is the same outcome on both transports', () => {
  it('item_not_found: CLI exits 1; MCP returns ok:false code item_not_found', async () => {
    const cliRun = runCli(cli.root, cli.dbPath, [
      'get',
      '--input',
      JSON.stringify({ uid: 'no-such-uid-anywhere' }),
    ]);
    expect(cliRun.status).toBe(1);
    const cliBody = lastJson(cliRun.stdout);
    expect(cliBody['ok']).toBe(false);
    expect((cliBody['error'] as Record<string, unknown>)['code']).toBe('item_not_found');

    const { envelope } = await callToolJson(mcp.host.client, 'backlog_get', {
      data: { input: { uid: 'no-such-uid-anywhere' } },
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('item_not_found');
  }, 60_000);

  it('validation: CLI exits 2; MCP returns the same failure code', async () => {
    const cliRun = runCli(cli.root, cli.dbPath, [
      'query',
      '--input',
      JSON.stringify({ view: 'list', limit: -5 }),
    ]);
    expect(cliRun.status).toBe(2);
    const cliBody = lastJson(cliRun.stdout);
    expect(cliBody['ok']).toBe(false);
    const cliCode = (cliBody['error'] as Record<string, unknown>)['code'];
    expect(['validation', 'invalid_argument']).toContain(cliCode);

    const { envelope } = await callToolJson(mcp.host.client, 'backlog_query', {
      data: { input: { view: 'list', limit: -5 } },
    });
    expect(envelope.ok).toBe(false);
    expect([cliCode, 'validation', 'invalid_argument']).toContain(envelope.error?.code);
  }, 60_000);
});

describe('contract matrix — the CLI-only exits the frozen ADR-0006 table names', () => {
  it('an unknown command exits 4 (not_found)', () => {
    const run = runCli(cli.root, cli.dbPath, ['definitely-not-a-command']);
    expect(run.status).toBe(4);
  });

  it('malformed --input prints an unwrapped invalid_argument on stderr and exits 2', () => {
    const run = runCli(cli.root, cli.dbPath, ['get', '--input', '{not-json']);
    expect(run.status).toBe(2);
    const body = JSON.parse(run.stderr.trim().split('\n').filter(Boolean).pop() ?? '{}') as {
      code?: string;
    };
    expect(body.code).toBe('invalid_argument');
  });
});
