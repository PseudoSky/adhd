/**
 * dispatch-native-tooling.e2e.test.ts — NAT-TOOL-5 (ADR-0008 D4), live AC.
 *
 * DEFAULT-RUNNING, hermetic proof through the REAL dispatch host path:
 * `buildProductionAgentMcpRunner` → a real spawned `@adhd/agent-mcp` over stdio
 * JSON-RPC → the stored definition, read back from the registry. No model call
 * is made (`agent_create` / `agent_update` / `agent_read` only), so nothing is
 * env-gated.
 *
 * ACs:
 *  1. A dispatch-created agent launched from `/P` (the scratch cwd) is stored with
 *     an fs root `/P` and a shell child cwd `/P`, plus backlog + memory servers.
 *  2. `ensureAgent` re-asserts the CURRENT cwd on an already-existing agent:
 *     creating from `/A` then dispatching the same agent from `/B` re-roots the
 *     stored map at `/B` (a reused agent never keeps the previous root).
 *
 * Hermetic: isolated `cwd` + fake `$HOME` + temp `ADHD_AGENT_DATABASE_PATH`
 * (ADR-0008 D11 — agent-mcp's `loadEnvHierarchy` loads `<cwd>/.env` with
 * `override:true` and would otherwise clobber pinned env).
 */
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DispatchUnit } from '@adhd/dispatch-base-spec';
import type { McpServerConfig } from '@adhd/agent-base-types';

import { buildProductionAgentMcpRunner } from '../lib/core.js';
import {
  AGENT_MCP_DIST,
  assertAgentMcpBuilt,
  buildChildEnv,
  cleanupScratch,
  mkFakeHome,
  mkScratch,
} from './helpers/agent-mcp-registry.js';

beforeAll(() => assertAgentMcpBuilt());
afterAll(() => cleanupScratch());

const UNIT = {
  agent_name: 'nat-tool-5-agent',
  provider: null,
  systemPrompt: 'You are a dispatched agent.',
} as unknown as DispatchUnit;

function stdio(map: Record<string, McpServerConfig>, key: string): Extract<McpServerConfig, { transport: 'stdio' }> {
  const cfg = map[key];
  if (!cfg || cfg.transport !== 'stdio') throw new Error(`no stdio '${key}' server`);
  return cfg;
}

function fsRoot(map: Record<string, McpServerConfig>): string {
  const args = stdio(map, 'fs').args ?? [];
  const root = args[args.length - 1];
  if (!root) throw new Error('fs server resolved without a root arg');
  return root;
}

/** Build a production dispatch runner pointed at the BUILT agent-mcp, isolated. */
function productionRunner(opts: { cwd: string; dbPath: string; home: string }) {
  return buildProductionAgentMcpRunner(
    {
      ...process.env,
      ADHD_DISPATCH_AGENT_MCP_COMMAND: process.execPath,
      ADHD_DISPATCH_AGENT_MCP_ARGS: AGENT_MCP_DIST,
      // Pin a synthetic backlog entry — the backlog server is never spawned here.
      ADHD_DISPATCH_BACKLOG_MCP_ENTRY: join(opts.cwd, 'synthetic-backlog.js'),
    },
    {
      cwd: opts.cwd,
      createAgentsIfMissing: true,
      env: buildChildEnv({
        HOME: opts.home,
        ADHD_AGENT_DATABASE_PATH: opts.dbPath,
        ADHD_AGENT_SSE_ENABLED: 'false',
        ADHD_AGENT_TRANSPORT: 'stdio',
      }),
    }
  );
}

describe('NAT-TOOL-5 — the dispatch host roots native tooling at the dispatching cwd', () => {
  it('AC1: a dispatch-created agent carries fs root + shell cwd at the cwd, plus backlog + memory', async () => {
    const scratch = mkScratch('nat-tool-5-ac1');
    const home = mkFakeHome(scratch);
    const dbPath = join(scratch, 'registry.db');

    const runner = productionRunner({ cwd: scratch, dbPath, home });
    try {
      await runner.ensureAgent(UNIT);

      const def = await runner.callTool<{ mcpServers?: Record<string, McpServerConfig> }>(
        'agent_read',
        { name: UNIT.agent_name }
      );
      const map = def.mcpServers ?? {};

      expect(Object.keys(map).sort()).toEqual(
        ['agent-mcp', 'backlog', 'fs', 'memory-server', 'shell'].sort()
      );
      // The consumer-visible outcome: the stored map is rooted at the dispatching cwd.
      expect(fsRoot(map)).toBe(scratch);
      expect(stdio(map, 'fs').cwd).toBe(scratch);
      expect(stdio(map, 'shell').cwd).toBe(scratch);
      expect(map['memory-server']).toMatchObject({ transport: 'sse' });
      expect(map['backlog']).toMatchObject({ transport: 'stdio', command: 'node' });
    } finally {
      await runner.close().catch(() => undefined);
    }
  }, 60_000);

  it('AC2: ensureAgent re-asserts the CURRENT cwd on an already-existing agent', async () => {
    const scratchA = mkScratch('nat-tool-5-ac2-a');
    const scratchB = mkScratch('nat-tool-5-ac2-b');
    const homeA = mkFakeHome(scratchA);
    const dbPath = join(scratchA, 'registry.db');

    // First dispatch: create the agent at /A.
    const first = productionRunner({ cwd: scratchA, dbPath, home: homeA });
    try {
      await first.ensureAgent(UNIT);
      const created = await first.callTool<{ mcpServers: Record<string, McpServerConfig> }>(
        'agent_read',
        { name: UNIT.agent_name }
      );
      expect(fsRoot(created.mcpServers)).toBe(scratchA);
    } finally {
      await first.close().catch(() => undefined);
    }

    // Second dispatch: the SAME agent from /B — a real re-assert, not a no-op.
    const second = productionRunner({ cwd: scratchB, dbPath, home: homeA });
    try {
      await second.ensureAgent(UNIT);
      const reused = await second.callTool<{ mcpServers: Record<string, McpServerConfig> }>(
        'agent_read',
        { name: UNIT.agent_name }
      );
      expect(fsRoot(reused.mcpServers)).toBe(scratchB);
      expect(stdio(reused.mcpServers, 'shell').cwd).toBe(scratchB);
    } finally {
      await second.close().catch(() => undefined);
    }
  }, 60_000);
});
