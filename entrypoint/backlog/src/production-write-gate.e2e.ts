/**
 * production-write-gate.e2e.ts — the S02 AC14 production-write gate proved
 * through the REAL, BUILT consumer paths, in a genuinely
 * PRODUCTION-classifying process.
 *
 * WHY this file exists (the gap that let a CRITICAL through): the S02 AC14
 * gate shipped with `write/lifecycle.spec.ts` proving it ONLY against a
 * hand-built handle (`productionHandle`), and `cli.e2e.ts` spawning the real
 * bin ONLY under `--namespace sandbox` (which classifies NON-production, so
 * the gate is inert there). No test ever booted the real transport in a
 * production-classifying process, so the `serve` transport's failure to
 * RECEIVE the CLI's `--allow-production-write` opt-in was invisible: `serve`
 * armed the gate with `allowProductionWrite: false` unconditionally and
 * refused EVERY write, including `.mcp.json`'s own configured server. This
 * e2e closes that gap permanently.
 *
 * PRODUCTION-CLASSIFYING, YET ISOLATED. `isLiveProductionStore` (`env.ts`) is
 * a conjunction of five signals; `productionClassifyingEnv` below hits all
 * five by construction: namespace `production` (the default), scope `global`
 * (the default — the project-scope pin is REMOVED), no explicit `adhdRoot`,
 * no ambient `ADHD_ROOT`, and no `db.path` override. The store is kept off the
 * real machine because `HOME` is redirected to a throwaway temp root (the
 * canonical `buildIsolatedEnv` redirect) — and `HOME` is deliberately NOT one
 * of the five signals, so redirecting it isolates the data WITHOUT changing
 * the classification. That is exactly the live shape `.mcp.json` runs in.
 *
 * REAL TRANSPORTS, NEVER A BYPASS (AGENTS.md "Proving an MCP server works"):
 *  - one-shot: `node dist/index.js <verb> --input …` — the real CLI bin.
 *  - serve:    `node dist/index.js serve --transport mcp` driven by a real
 *              `@modelcontextprotocol/sdk` Client over `StdioClientTransport`
 *              — the same command `.mcp.json` names, never an in-process call.
 *
 * TEETH (RED-before / GREEN-after): at the pre-fix HEAD, `serve` never
 * received the opt-in, so the two `serve` assertions of the "WITHOUT" test
 * FAIL (a write that must be refused SUCCEEDS). After the fix they pass. The
 * "WITH" tests fail if the opt-in ever stops being threaded. Nothing here
 * mocks the store or the transport.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildIsolatedEnv } from './test/helpers/spawn-isolated-bin.js';
import {
  callToolJson,
  DIST_INDEX,
  type IMcpHost,
} from './test/helpers/spawn-mcp-host.js';
import { spawnTimeoutMs } from './test/helpers/spawn-timeout.js';

/**
 * The child env that makes `isLiveProductionStore` true while keeping the
 * store off the real machine:
 *
 *   - `buildIsolatedEnv` copies the parent env MINUS the ambient redirect keys
 *     (`ADHD_ROOT` / `ADHD_BACKLOG_DATABASE_PATH` / `SOX_ECOSYSTEM_HOME` /
 *     `APIGEN_IR_CACHE_FILE`) and pins `HOME` to the temp root — so no ambient
 *     export can leak the child onto the real `~/.adhd`.
 *   - `ADHD_BACKLOG_SCOPE=project` (the pin `buildIsolatedEnv` adds) is
 *     DELETED, and `ADHD_ENV_SCOPE` too, so scope falls through to the
 *     `global` default — the production signal.
 */
function productionClassifyingEnv(home: string): Record<string, string> {
  const env = buildIsolatedEnv(home, { VITEST: 'true' });
  delete env['ADHD_BACKLOG_SCOPE'];
  delete env['ADHD_ENV_SCOPE'];
  return env;
}

interface IOneShotResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the real built CLI bin under the production-classifying env. */
function runOneShot(args: string[], home: string): IOneShotResult {
  const res = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd: home,
    env: productionClassifyingEnv(home),
    encoding: 'utf8',
    timeout: spawnTimeoutMs(),
  });
  if (res.error) {
    throw new Error(
      `spawn failed for ${DIST_INDEX} ${JSON.stringify(args)}: ${String(
        res.error
      )}`
    );
  }
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/** The CLI prints its outcome envelope as the LAST line of the stream. */
function lastJsonLine(text: string): {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
} {
  return JSON.parse(text.trim().split('\n').pop() ?? '{}') as {
    ok?: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
}

let homes: string[] = [];
let hosts: IMcpHost[] = [];

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'backlog-prod-gate-'));
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const host of hosts) await host.close();
  hosts = [];
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

/** Boot the real built MCP stdio server under the production-classifying env. */
async function connectProductionServe(
  home: string,
  extraArgs: string[] = []
): Promise<IMcpHost> {
  const argv = [DIST_INDEX, 'serve', '--transport', 'mcp', ...extraArgs];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: argv,
    cwd: home,
    env: productionClassifyingEnv(home),
  });
  const client = new Client(
    { name: 'backlog-prod-gate-e2e', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  return {
    client,
    argv,
    async close() {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}

describe('S02 AC14 — production-write gate over the REAL transports (production-classifying)', () => {
  it('ONE-SHOT: a production write is REFUSED without --allow-production-write and nothing is persisted', () => {
    const home = newHome();
    const name = `gate-oneshot-refused-${process.pid}`;

    const res = runOneShot(
      ['upsert-project', '--input', JSON.stringify({ name, by: 'gate-e2e' })],
      home
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).not.toBe(
      0
    );
    // A one-shot dispatched verb prints its outcome envelope on STDOUT
    // (success and failure alike) — unlike the apigen CLI-output path's
    // pre-dispatch rejections, which go to stderr.
    const env = lastJsonLine(res.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('precondition_failed');
    expect(env.error?.message ?? '').toContain('PRODUCTION');

    // Consumer-visible: the refused project is genuinely absent.
    const q = runOneShot(
      ['query', '--input', JSON.stringify({ view: 'projects' })],
      home
    );
    expect(q.status, `stderr:\n${q.stderr}`).toBe(0);
    expect(q.stdout).not.toContain(name);
  }, 120_000);

  it('ONE-SHOT: --allow-production-write opens the write and the item IS persisted', () => {
    const home = newHome();
    const name = `gate-oneshot-allowed-${process.pid}`;

    const res = runOneShot(
      [
        '--allow-production-write',
        'upsert-project',
        '--input',
        JSON.stringify({ name, by: 'gate-e2e' }),
      ],
      home
    );
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);
    expect(lastJsonLine(res.stdout).ok).toBe(true);

    const q = runOneShot(
      ['query', '--input', JSON.stringify({ view: 'projects' })],
      home
    );
    expect(q.status, `stderr:\n${q.stderr}`).toBe(0);
    expect(q.stdout).toContain(name);
  }, 120_000);

  it('SERVE (real MCP stdio): a production write is REFUSED without --allow-production-write — the CRITICAL regression guard', async () => {
    const home = newHome();
    const host = await connectProductionServe(home);
    hosts.push(host);
    const name = `gate-serve-refused-${process.pid}`;

    const call = await callToolJson(host.client, 'backlog_upsert_project', {
      data: { input: { name, by: 'gate-e2e' } },
    });
    expect(call.isError).toBeFalsy();
    expect(call.envelope.ok).toBe(false);
    expect(call.envelope.error?.code).toBe('precondition_failed');
    expect(call.envelope.error?.message ?? '').toContain('PRODUCTION');

    // Not persisted on the real serving path either.
    const q = await callToolJson(host.client, 'backlog_query', {
      data: { input: { view: 'projects' } },
    });
    expect(q.envelope.ok).toBe(true);
    expect(JSON.stringify(q.envelope.data)).not.toContain(name);
  }, 120_000);

  it('SERVE (real MCP stdio): --allow-production-write opens the write — the .mcp.json opt-in path', async () => {
    const home = newHome();
    const host = await connectProductionServe(home, ['--allow-production-write']);
    hosts.push(host);
    const name = `gate-serve-allowed-${process.pid}`;

    const call = await callToolJson(host.client, 'backlog_upsert_project', {
      data: { input: { name, by: 'gate-e2e' } },
    });
    expect(call.isError).toBeFalsy();
    expect(call.envelope.ok).toBe(true);

    const q = await callToolJson(host.client, 'backlog_query', {
      data: { input: { view: 'projects' } },
    });
    expect(q.envelope.ok).toBe(true);
    expect(JSON.stringify(q.envelope.data)).toContain(name);
  }, 120_000);
});
