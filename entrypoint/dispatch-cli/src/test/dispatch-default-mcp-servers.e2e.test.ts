/**
 * dispatch-default-mcp-servers.e2e.test.ts — backlog daafe2d3, live AC.
 *
 * DEFAULT-RUNNING, hermetic proof that a dispatch-created agent is born with
 * BOTH the memory-server and backlog `mcpServers` (`defaultDispatchMcpServers()`)
 * — read back from a REAL agent-mcp registry over stdio JSON-RPC, not asserted
 * on a mock. This is the live acceptance criterion for "dispatch agents get
 * memory + backlog"; the model-call half of daafe2d3 lives elsewhere and is the
 * only piece gated (a real model is a paid third-party service).
 *
 * No model call is made (only `agent_create` + `agent_read`), so nothing here
 * is env-gated. Hermetic: isolated `cwd` + fake `$HOME` + temp
 * `ADHD_AGENT_DATABASE_PATH`, so agent-mcp's `loadEnvHierarchy()` can never load
 * a repo-root `.env` and redirect the store.
 */
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DispatchUnit } from '@adhd/dispatch-base-spec';

import { defaultDispatchMcpServers } from '../lib/core.js';
import {
  assertAgentMcpBuilt,
  cleanupScratch,
  makeRunner,
  mkFakeHome,
  mkScratch,
} from './helpers/agent-mcp-registry.js';

beforeAll(() => assertAgentMcpBuilt());
afterAll(() => cleanupScratch());

describe('daafe2d3 — dispatch-created agents get memory-server + backlog (real registry)', () => {
  it('agent_create via defaultDispatchMcpServers yields a definition carrying BOTH servers, read back from the store', async () => {
    const scratch = mkScratch('daafe2d3');
    const home = mkFakeHome(scratch);
    const dbPath = join(scratch, 'registry.db');

    const runner = makeRunner({
      dbPath,
      home,
      cwd: scratch,
      defaultMcpServers: defaultDispatchMcpServers({} as NodeJS.ProcessEnv),
    });
    try {
      // Minimal DispatchUnit shape — ensureAgent only reads these three fields.
      const unit = {
        agent_name: 'dispatch-default-mcp',
        provider: null,
        systemPrompt: 'You are a dispatched agent.',
      } as unknown as DispatchUnit;

      await runner.ensureAgent(unit);

      const def = await runner.callTool<{ mcpServers?: Record<string, unknown> }>(
        'agent_read',
        { name: 'dispatch-default-mcp' }
      );

      // The consumer-visible outcome: the CREATED definition really carries
      // both server entries (not merely that a mock was handed them).
      expect(def.mcpServers).toBeDefined();
      expect(Object.keys(def.mcpServers ?? {}).sort()).toEqual(['backlog', 'memory-server']);
      expect(def.mcpServers?.['memory-server']).toMatchObject({ transport: 'sse' });
      expect(def.mcpServers?.['backlog']).toMatchObject({
        transport: 'stdio',
        command: 'node',
      });
    } finally {
      await runner.close().catch(() => undefined);
    }
  }, 60_000);
});
