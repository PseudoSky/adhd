/**
 * agents-import.e2e.test.ts — backlog 09e84a88, end-to-end.
 *
 * DEFAULT-RUNNING, hermetic proof that the real `dispatch-cli agents import`
 * command round-trips a persona into a temp `ADHD_AGENT_DATABASE_PATH` registry
 * over the REAL agent-mcp boundary (`agent_read` returns the source body), and
 * that a subsequently DELETED persona is `AGENT_NOT_FOUND` with no fallback.
 *
 * The CLI is spawned as a real child process (`npx tsx bin/cli.ts agents import
 * <dir>`) — the way a human dispatcher runs it. Its nested agent-mcp is pointed
 * at the LOCAL built entry via `ADHD_DISPATCH_AGENT_MCP_COMMAND`/`_ARGS` (rather
 * than `npx -y @adhd/agent-mcp`), and the child is spawned with an isolated
 * `cwd` + fake `$HOME` so no repo-root `.env` can redirect the registry.
 *
 * No model call is made, so nothing here is env-gated (AGENTS.md §7).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AGENT_MCP_DIST,
  assertAgentMcpBuilt,
  buildChildEnv,
  cleanupScratch,
  FALLBACK_CLI_PATH,
  makeRunner,
  mkFakeHome,
  mkScratch,
  TSCONFIG_BASE,
} from './helpers/agent-mcp-registry.js';

beforeAll(() => assertAgentMcpBuilt());
afterAll(() => cleanupScratch());

describe('09e84a88 — dispatch-cli agents import round-trips into a temp registry', () => {
  it('imports a persona (agent_read returns its body) and a deleted persona is AGENT_NOT_FOUND', async () => {
    const scratch = mkScratch('agents-import');
    const home = mkFakeHome(scratch);
    const dbPath = join(scratch, 'registry.db');

    const personaDir = join(scratch, 'personas');
    mkdirSync(personaDir, { recursive: true });
    const BODY = 'You are an imported persona.\n\nDo the imported thing.';
    writeFileSync(
      join(personaDir, 'imported-persona.md'),
      `---\nname: imported-persona\ndescription: "An imported persona"\nmodel: sonnet\n---\n\n${BODY}\n`,
      'utf8'
    );

    // Drive the REAL CLI as a child process. The nested agent-mcp inherits this
    // process's cwd, so the isolated cwd is what keeps
    // `ADHD_AGENT_DATABASE_PATH` authoritative.
    const cliEnv = buildChildEnv({
      HOME: home,
      ADHD_AGENT_DATABASE_PATH: dbPath,
      ADHD_AGENT_SSE_ENABLED: 'false',
      ADHD_AGENT_TRANSPORT: 'stdio',
      // Point the CLI's AgentMcpRunner at the LOCAL built agent-mcp instead of
      // `npx -y @adhd/agent-mcp` (network / published version).
      ADHD_DISPATCH_AGENT_MCP_COMMAND: process.execPath,
      ADHD_DISPATCH_AGENT_MCP_ARGS: AGENT_MCP_DIST,
    });
    const res = spawnSync(
      'npx',
      ['tsx', '--tsconfig', TSCONFIG_BASE, FALLBACK_CLI_PATH, 'agents', 'import', personaDir],
      { cwd: scratch, env: cliEnv, encoding: 'utf8', timeout: 60_000 }
    );
    expect(res.error, String(res.error)).toBeUndefined();
    expect(res.status, `stderr:\n${res.stderr}\nstdout:\n${res.stdout}`).toBe(0);

    const imported = JSON.parse(res.stdout.trim()) as {
      created: string[];
      errors: Array<{ file: string; message: string }>;
    };
    expect(imported.errors).toEqual([]);
    expect(imported.created).toEqual(['imported-persona']);

    // Read back through the SAME real MCP boundary — consumer-visible outcome.
    const runner = makeRunner({ dbPath, home, cwd: scratch });
    try {
      const def = await runner.callTool<{ systemPrompt?: string }>('agent_read', {
        name: 'imported-persona',
      });
      expect(def.systemPrompt).toBe(BODY);

      // Deleting the persona must leave NO fallback: a subsequent read is
      // AGENT_NOT_FOUND (the registry is the only source of truth).
      await runner.callTool('agent_delete', { name: 'imported-persona', force: true });
      await expect(
        runner.callTool('agent_read', { name: 'imported-persona' })
      ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    } finally {
      await runner.close().catch(() => undefined);
    }
  }, 60_000);
});
